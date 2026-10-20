import assert from "node:assert/strict"
import { test } from "node:test"

import { NodeHttpServer } from "@effect/platform-node"
import { Business } from "@pay-tty/core/business"
import { Database, layer as DatabaseLayer } from "@pay-tty/core/database"
import { Catalog } from "@pay-tty/core/catalog"
import { Currency } from "@pay-tty/core/currency"
import { Ledger } from "@pay-tty/core/ledger"
import { Payments } from "@pay-tty/core/payments"
import { Principal } from "@pay-tty/core/principal"
import { Testing } from "@pay-tty/core/testing"
import { Clock, Effect, Encoding, Layer, Schema, type Scope } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { decodeJwt, type JWTHeaderParameters, type JWTPayload, SignJWT } from "jose"
import { ulid } from "ulid"

import { BusinessInfo, BusinessLedger } from "../src/api/business/routes.ts"
import { MeResponse } from "../src/api/me/routes.ts"
import { CustomerChoosesPricing, FixedPricing, PaymentLink, PaymentLinkList, PaymentStats } from "../src/api/payment_links/routes.ts"
import { PayableLink, Payment as PayPayment } from "../src/api/pay/routes.ts"
import { SessionResponse } from "../src/api/session/routes.ts"
import { ApiLive } from "../src/api/server.ts"
import { AuthenticationLive } from "../src/api/middleware/authentication.ts"
import { UnknownErrorResponse } from "../src/api/middleware/defect.ts"
import { BusinessLedger as BusinessLedgerService } from "../src/ledger/business-ledger.ts"
import { Token } from "../src/token/token.ts"
import { created as accountCreated, current, failing, fakeLedger, invalid, keys, previous, secret, type FakeLedger, type Payload, type Reply } from "./support.ts"


// The core services over the test database, for preparing businesses and
// reading back what plane stored.
const domain = Layer.mergeAll(Principal.layer, Business.layer).pipe(
  Layer.provideMerge(Catalog.layer),
  Layer.provideMerge(DatabaseLayer),
)

interface ServerOptions {
  readonly ledger?: FakeLedger
  // A stand-in for what the ledger endpoint sees, to inject local failures.
  readonly businesses?: Business.Interface
  // A stand-in catalog for creating businesses.
  readonly catalog?: Catalog.Interface
}

// The server as bin/api.ts composes it, with the ledger faked. Requests run
// on the handler's own runtime, outside any test transaction, so every test
// commits under identities of its own.
const server = (options: ServerOptions = {}) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const ledger = options.ledger ?? fakeLedger()

      const ledgerEndpoint = BusinessLedgerService.layer.pipe(
        Layer.provide(ledger.layer),
        Layer.provide(
          options.businesses === undefined ? Business.layer : Layer.succeed(Business.Service, options.businesses),
        ),
      )

      return {
        ledger,
        app: HttpRouter.toWebHandler(
          Layer.mergeAll(ApiLive, UnknownErrorResponse).pipe(
            Layer.provideMerge(
              Layer.mergeAll(AuthenticationLive, ledgerEndpoint),
            ),
            Layer.provideMerge(Token.layerFrom(keys)),
            Layer.provideMerge(Layer.mergeAll(Principal.layer, Business.layer, Payments.layer)),
            Layer.provideMerge(
              options.catalog === undefined ? Catalog.layer : Layer.succeed(Catalog.Service, options.catalog),
            ),
            Layer.provideMerge(DatabaseLayer),
            Layer.provideMerge(NodeHttpServer.layerHttpServices),
          ),
          { disableLogger: true },
        ),
      }
    }),
    ({ app }) => Effect.promise(() => app.dispose()),
  )

type Server = Effect.Success<ReturnType<typeof server>>

type Body = string | number | boolean | null | ReadonlyArray<Body> | { readonly [key: string]: Body }

interface Call {
  readonly method: "GET" | "POST" | "PUT"
  readonly path: string
  readonly body?: { readonly [key: string]: Body }
  readonly authorization?: string | undefined
  readonly headers?: Readonly<Record<string, string>>
}

const Json = Schema.fromJsonString(Schema.Unknown)

const send = Effect.fnUntraced(function* (server: Server, call: Call) {
  const body = call.body === undefined ? null : yield* Schema.encodeUnknownEffect(Json)(call.body)

  const headers = new Headers({ ...call.headers, "content-type": "application/json" })

  if (call.authorization !== undefined) {
    headers.set("authorization", call.authorization)
  }

  const response = yield* Effect.promise(() =>
    server.app.handler(new Request(`http://plane.test${call.path}`, { method: call.method, headers, body })),
  )

  const text = yield* Effect.promise(() => response.text())

  // A route that doesn't exist answers without a body.
  return { status: response.status, json: text === "" ? null : yield* Schema.decodeEffect(Json)(text) }
})

// Excess keys fail decoding, so a camel-case leak or any field outside the
// contract is caught, not dropped.
const strict = { onExcessProperty: "error" } as const

const fingerprint = () => `SHA256:${ulid()}`

// The gateway's exchange: an asserted identity for an access token.
const exchange = Effect.fnUntraced(function* (server: Server, sub: string) {
  const { status, json } = yield* send(server, { method: "POST", path: "/session", body: { issuer: "ssh", sub } })

  assert.equal(status, 200)

  // Exactly the token fields, whether or not the principal has a business.
  const session = yield* Schema.decodeUnknownEffect(SessionResponse)(json, strict)

  return { session, authorization: `Bearer ${session.access_token}` }
})

// Decoded strictly, so a 401 or a malformed body fails the test here.
const me = (server: Server, authorization: string, extra: Partial<Call> = {}) =>
  send(server, { method: "GET", path: "/me", authorization, ...extra }).pipe(
    Effect.flatMap(({ status, json }) =>
      Effect.map(Schema.decodeUnknownEffect(MeResponse)(json, strict), (body) => ({ status, json, body })),
    ),
  )

const createBusiness = (server: Server, authorization: string | undefined, extra: Partial<Call> = {}) =>
  send(server, { method: "POST", path: "/business", body: { name: "Acme Ltd" }, authorization, ...extra })

// A successful create, decoded strictly.
const created = (server: Server, authorization: string, extra: Partial<Call> = {}) =>
  createBusiness(server, authorization, extra).pipe(
    Effect.flatMap(({ status, json }) =>
      Effect.map(Schema.decodeUnknownEffect(BusinessInfo)(json, strict), (body) => ({ status, json, body })),
    ),
  )

const openAccount = (server: Server, authorization: string, extra: Partial<Call> = {}) =>
  send(server, { method: "POST", path: "/account", authorization, ...extra })

// A successful account opening, decoded strictly.
const opened = (server: Server, authorization: string, extra: Partial<Call> = {}) =>
  openAccount(server, authorization, extra).pipe(
    Effect.flatMap(({ status, json }) =>
      Effect.map(Schema.decodeUnknownEffect(BusinessInfo)(json, strict), (body) => ({ status, json, body })),
    ),
  )

const fixedLink = { title: "Consulting", pricing: { mode: "fixed", amount_minor: 250_000 } }

const createLink = (
  server: Server,
  authorization: string | undefined,
  body: { readonly [key: string]: Body },
  idempotencyKey: string | undefined,
) =>
  send(server, {
    method: "POST",
    path: "/payment_links",
    body,
    authorization,
    headers: idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey },
  })

// A link creation that succeeded, decoded strictly.
const createdLink = Effect.fnUntraced(function* (
  server: Server,
  authorization: string,
  body: { readonly [key: string]: Body },
  idempotencyKey: string,
) {
  const { status, json } = yield* createLink(server, authorization, body, idempotencyKey)

  return { status, json, body: yield* Schema.decodeUnknownEffect(PaymentLink)(json, strict) }
})

const ErrorBody = Schema.Struct({ message: Schema.String, error: Schema.Struct({ code: Schema.String }) })

// A caller with a freshly created business, ready for its ledger.
const withBusiness = Effect.fnUntraced(function* (server: Server) {
  const sub = fingerprint()
  const { authorization } = yield* exchange(server, sub)
  const business = yield* created(server, authorization)

  return { sub, authorization, id: business.body.id }
})

// The principal behind an exchanged fingerprint, and its business if any.
const stored = Effect.fnUntraced(function* (sub: string) {
  const principals = yield* Principal.Service
  const businesses = yield* Business.Service

  const principal = yield* principals.find({ issuer: "ssh", subject: sub })

  assert.ok(principal !== undefined)

  return { principal, business: yield* businesses.findByPrincipal(principal.id) }
})

const unauthorized = { message: "A valid access token is required.", error: { code: "unauthorized" } }

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | Principal.Service | Business.Service | Database>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(domain)))

// The seed configures no US ledger. This stands one in as the US default for
// the effect, then leaves the US without one again; the row stays, since
// businesses refer to it.
const withUsDefault = <A, E, R>(use: (ledger: Ledger.Slug) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const ledger = Ledger.Slug.make(`usd_test_${ulid().toLowerCase()}`)

    yield* Testing.addLedger(ledger, "USD", 2, "US")

    return yield* Testing.makeCountryDefault(ledger).pipe(
      Effect.andThen(use(ledger)),
      Effect.ensuring(Testing.clearCountryDefault("US")),
    )
  })

void test("serves health without a token", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()

      assert.deepEqual(yield* send(plane, { method: "GET", path: "/health" }), { status: 200, json: { status: "ok" } })
    }),
  ))

void test("publishes exactly /health, /session, /me, /business, /account, /payment_links, and the /pay routes", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { status, json } = yield* send(plane, { method: "GET", path: "/openapi.json" })

      // Just the JSON body's schema reference, where an operation has one.
      const Body = Schema.Struct({
        content: Schema.Struct({ "application/json": Schema.Struct({ schema: Schema.Struct({ $ref: Schema.String }) }) }),
      })

      const Operation = Schema.Struct({
        security: Schema.optional(Schema.Unknown),
        requestBody: Schema.optional(Body),
        responses: Schema.Record(Schema.String, Schema.Unknown),
      })

      const { paths, components } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          paths: Schema.Record(Schema.String, Schema.Record(Schema.String, Operation)),
          components: Schema.Struct({
            schemas: Schema.Struct({
              CreateBusinessRequestEncoded: Schema.Struct({
                properties: Schema.Struct({ country_code: Schema.Unknown }),
                required: Schema.Array(Schema.String),
              }),
            }),
          }),
        }),
      )(json)

      assert.equal(status, 200)
      assert.deepEqual(Object.keys(paths).sort(), [
        "/account",
        "/business",
        "/health",
        "/me",
        "/pay/payment_links/{share_token}",
        "/pay/payment_links/{share_token}/payments",
        "/pay/payment_links/{share_token}/payments/{payment_id}/simulate",
        "/payment_links",
        "/session",
      ])
      assert.deepEqual(Object.keys(paths["/me"] ?? {}), ["get"])
      assert.deepEqual(Object.keys(paths["/business"] ?? {}), ["post"])

      const create = paths["/business"]?.["post"]

      // Secured like /me; the exchange isn't.
      assert.notDeepEqual(paths["/me"]?.["get"]?.security, [])
      assert.deepEqual(create?.security, paths["/me"]?.["get"]?.security)
      assert.deepEqual(paths["/session"]?.["post"]?.security, [])
      assert.equal(create?.requestBody?.content["application/json"].schema.$ref, "#/components/schemas/CreateBusinessRequestEncoded")

      // The country is optional, one of the listed codes, and Nigeria by default.
      const request = components.schemas.CreateBusinessRequestEncoded

      assert.deepEqual(request.properties.country_code, { type: "string", enum: ["NG", "US"], default: "NG" })
      assert.deepEqual(request.required, ["name"])
      assert.ok("503" in (create?.responses ?? {}))

      // The business itself, not wrapped.
      const success = yield* Schema.decodeUnknownEffect(Body)(create?.responses["200"])

      assert.equal(success.content["application/json"].schema.$ref, "#/components/schemas/BusinessInfoEncoded")

      // Neither route names the business; the caller's token does.
      assert.deepEqual(Object.keys(paths["/account"] ?? {}), ["post"])

      const ledger = paths["/account"]?.["post"]

      assert.deepEqual(ledger?.security, paths["/me"]?.["get"]?.security)
      assert.equal(ledger?.requestBody, undefined)
      assert.deepEqual(
        (yield* Schema.decodeUnknownEffect(Body)(ledger?.responses["200"])).content["application/json"].schema.$ref,
        "#/components/schemas/BusinessInfoEncoded",
      )

      for (const code of ["401", "409", "502", "503"]) {
        assert.ok(code in (ledger?.responses ?? {}), code)
      }

      assert.deepEqual(Object.keys(paths["/payment_links"] ?? {}).sort(), ["get", "post"])

      const links = paths["/payment_links"]?.["post"]

      assert.deepEqual(links?.security, paths["/me"]?.["get"]?.security)
      assert.deepEqual(paths["/payment_links"]?.["get"]?.security, paths["/me"]?.["get"]?.security)
      assert.equal(links?.requestBody?.content["application/json"].schema.$ref, "#/components/schemas/CreatePaymentLinkRequestEncoded")

      // A new link is a 201 and a repeat a 200, with the same body.
      assert.equal(
        (yield* Schema.decodeUnknownEffect(Body)(links?.responses["201"])).content["application/json"].schema.$ref,
        "#/components/schemas/CreatedPaymentLinkEncoded",
      )
      assert.equal(
        (yield* Schema.decodeUnknownEffect(Body)(links?.responses["200"])).content["application/json"].schema.$ref,
        "#/components/schemas/PaymentLinkEncoded",
      )

      for (const code of ["400", "401", "409"]) {
        assert.ok(code in (links?.responses ?? {}), code)
      }

      // A customer holds no token: the share token is the credential.
      const customer = [
        paths["/pay/payment_links/{share_token}"]?.["get"],
        paths["/pay/payment_links/{share_token}/payments"]?.["post"],
        paths["/pay/payment_links/{share_token}/payments/{payment_id}/simulate"]?.["post"],
      ]

      for (const operation of customer) {
        assert.deepEqual(operation?.security, [])
        assert.ok("404" in (operation?.responses ?? {}))
      }
    }),
  ))

void test("a session exchange issues a bearer token and creates only the principal", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { session, authorization } = yield* exchange(plane, fingerprint())

      assert.equal(session.token_type, "Bearer")
      assert.equal(session.expires_in, 900)
      assert.match(decodeJwt(session.access_token).sub ?? "", /^prn_/)
      assert.equal((yield* me(plane, authorization)).body.business, null)
    }),
  ))

void test("repeated exchanges for one identity name the same principal", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const sub = fingerprint()

      const first = yield* exchange(plane, sub)
      const second = yield* exchange(plane, sub)
      const other = yield* exchange(plane, fingerprint())

      assert.equal(decodeJwt(second.session.access_token).sub, decodeJwt(first.session.access_token).sub)
      assert.notEqual(decodeJwt(other.session.access_token).sub, decodeJwt(first.session.access_token).sub)
    }),
  ))

void test("/me names a new session's stored principal, with no business", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const sub = fingerprint()
      const { session, authorization } = yield* exchange(plane, sub)

      const first = yield* me(plane, authorization)
      const { principal } = yield* stored(sub)

      assert.equal(first.status, 200)
      assert.equal(first.body.id, decodeJwt(session.access_token).sub)
      assert.equal(first.body.id, principal.id)
      assert.equal(first.body.created_at, principal.createdAt.toISOString())
      assert.equal(first.body.business, null)

      // Another exchange and read name the same principal, created when it was.
      const again = yield* exchange(plane, sub)

      assert.deepEqual((yield* me(plane, again.authorization)).json, first.json)
    }),
  ))

void test("POST /business without a country records a created Nigerian NGN business and returns it as /me does", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const sub = fingerprint()
      const { authorization } = yield* exchange(plane, sub)

      // Currency and ledger are the server's: these are dropped.
      const response = yield* created(plane, authorization, {
        body: { name: "Acme Ltd", currency_code: "USD", currency: "USD", ledger: "usd_us", primary_ledger: "usd_us" },
      })

      const { business } = yield* stored(sub)

      assert.ok(business !== undefined)
      assert.equal(response.status, 200)
      assert.equal(business.primaryLedger.slug, "ngn_ng")
      assert.deepEqual(response.json, {
        id: business.id,
        name: "Acme Ltd",
        country_code: "NG",
        currency_code: "NGN",
        holder_ref: null,
        status: "created",
        ledger: null,
        created_at: business.createdAt.toISOString(),
        updated_at: business.updatedAt.toISOString(),
      })
      assert.match(response.body.id, /^biz_/)
      // Recorded only: the ledger wasn't asked.
      assert.equal(plane.ledger.requests.length, 0)
      assert.deepEqual((yield* me(plane, authorization)).body.business, response.body)
    }),
  ))

const renamed = {
  status: 409,
  json: { message: "This account already has a business with a different name or country.", error: { code: "conflict" } },
}

void test("repeating POST /business returns the business unchanged; another name or country conflicts", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const sub = fingerprint()
      const { authorization } = yield* exchange(plane, sub)

      const first = yield* created(plane, authorization)

      // Omitting the country and sending NG are the same request.
      for (const body of [{ name: "Acme Ltd" }, { name: "Acme Ltd", country_code: "NG" }]) {
        const again = yield* created(plane, authorization, { body })

        assert.equal(again.status, 200)
        assert.deepEqual(again.json, first.json)
      }

      const changed = {
        "another name": { name: "Renamed Ltd" },
        "another country": { name: "Acme Ltd", country_code: "US" },
        "another case": { name: "acme ltd" },
      }

      for (const [reason, body] of Object.entries(changed)) {
        assert.deepEqual(yield* createBusiness(plane, authorization, { body }), renamed, reason)
      }

      assert.deepEqual((yield* me(plane, authorization)).body.business, first.body)
    }),
  ))

void test("POST /business saves an explicit country with its currency and default ledger", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()

      const check = Effect.fnUntraced(function* (country: Business.Country, currency: string, ledger: string) {
        const sub = fingerprint()
        const { authorization } = yield* exchange(plane, sub)

        // A caller's currency never overrides the country's.
        const response = yield* created(plane, authorization, {
          body: { name: "Acme", country_code: country, currency_code: country === "US" ? "NGN" : "USD" },
        })

        const { business } = yield* stored(sub)

        assert.equal(response.body.country_code, country)
        assert.equal(response.body.currency_code, currency)
        assert.equal(response.body.status, "created")
        assert.equal(response.body.ledger, null)
        assert.equal(business?.primaryLedger.slug, ledger)
        assert.equal(business.primaryLedger.payableAccountRef, null)
        assert.deepEqual((yield* me(plane, authorization)).body.business, response.body)

        // A repeat asking for the other country conflicts.
        assert.deepEqual(
          yield* createBusiness(plane, authorization, { body: { name: "Acme", country_code: country === "US" ? "NG" : "US" } }),
          renamed,
        )
      })

      yield* check("NG", "NGN", "ngn_ng")
      yield* withUsDefault((ledger) => check("US", "USD", ledger))

      assert.equal(plane.ledger.requests.length, 0)
    }),
  ))

void test("POST /business in a country with no default ledger is unavailable, creating nothing and never falling back", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { authorization } = yield* exchange(plane, fingerprint())

      assert.deepEqual(yield* createBusiness(plane, authorization, { body: { name: "Acme Inc", country_code: "US" } }), {
        status: 503,
        json: { message: "Businesses can't be created in this country yet.", error: { code: "country_unavailable" } },
      })
      assert.equal((yield* me(plane, authorization)).body.business, null)
      assert.equal(plane.ledger.requests.length, 0)
    }),
  ))

void test("POST /business rejects a country that is null, blank, malformed, or unlisted, and creates nothing", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { authorization } = yield* exchange(plane, fingerprint())

      for (const country of [null, "", " ", "ng", "Ng", "NGA", "USA", "NGN", "USD", "GB", 42]) {
        const { status, json } = yield* createBusiness(plane, authorization, { body: { name: "Acme Ltd", country_code: country } })

        const error = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ message: Schema.String, error: Schema.Struct({ code: Schema.Literal("validation_error") }) }),
        )(json)

        assert.equal(status, 400, String(country))
        assert.equal(error.error.code, "validation_error", String(country))
      }

      assert.equal((yield* me(plane, authorization)).body.business, null)
    }),
  ))

void test("POST /business returns an existing active business without touching it", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const businesses = yield* Business.Service
      const sub = fingerprint()
      const { authorization } = yield* exchange(plane, sub)
      const details = new Business.Details({ name: "Active Ltd", countryCode: "NG" })
      const active = yield* businesses.create((yield* stored(sub)).principal.id, details)
      const account = new Business.PayableAccount({ holderRef: `hld_${ulid()}`, accountRef: `acct_${ulid()}` })

      yield* businesses.recordPayableAccount(active.id, active.primaryLedger.slug, account)

      const before = yield* businesses.activate(active.id)
      const response = yield* created(plane, authorization, { body: { name: "Active Ltd" } })

      assert.equal(response.body.id, active.id)
      assert.equal(response.body.name, "Active Ltd")
      assert.equal(response.body.status, "active")
      assert.equal(response.body.holder_ref, account.holderRef)
      assert.equal(response.body.updated_at, before.updatedAt.toISOString())
      assert.deepEqual(
        response.body.ledger,
        new BusinessLedger({ slug: "ngn_ng", currency: "NGN", scale: 2, payable_account_ref: account.accountRef }),
      )
      assert.deepEqual(response.body, (yield* me(plane, authorization)).body.business)
    }),
  ))

void test("concurrent POST /business for one principal settles on one business", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const same = yield* exchange(plane, fingerprint())

      const responses = yield* Effect.all(
        Array.from({ length: 8 }, () => created(plane, same.authorization)),
        { concurrency: "unbounded" },
      )

      assert.equal(new Set(responses.map(({ body }) => body.id)).size, 1)
      assert.equal((yield* me(plane, same.authorization)).body.business?.id, responses[0]?.body.id)

      // Differing names: one wins, and the rest learn theirs wasn't created.
      const differing = yield* exchange(plane, fingerprint())

      const races = yield* Effect.all(
        Array.from({ length: 8 }, (_, index) => createBusiness(plane, differing.authorization, { body: { name: `Acme ${index}` } })),
        { concurrency: "unbounded" },
      )

      const winners = races.filter(({ status }) => status === 200)

      assert.equal(winners.length, 1)

      for (const race of races.filter(({ status }) => status !== 200)) {
        assert.deepEqual(race, renamed)
      }

      const winner = yield* Schema.decodeUnknownEffect(BusinessInfo)(winners[0]?.json)

      assert.deepEqual((yield* me(plane, differing.authorization)).body.business, winner)
    }),
  ))

void test("concurrent callers each create and read only their own business", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()

      const callers = yield* Effect.forEach(Array.from({ length: 6 }, (_, index) => index), (index) =>
        Effect.map(exchange(plane, fingerprint()), ({ authorization }) => ({ authorization, name: `Business ${index}` })),
      )

      const createdNames = yield* Effect.forEach(
        callers,
        ({ authorization, name }) => Effect.map(created(plane, authorization, { body: { name } }), ({ body }) => body.name),
        { concurrency: "unbounded" },
      )

      const read = yield* Effect.forEach(callers, ({ authorization }) => Effect.map(me(plane, authorization), ({ body }) => body), {
        concurrency: "unbounded",
      })

      assert.deepEqual(createdNames, callers.map(({ name }) => name))
      assert.deepEqual(
        read.map((body) => body.business?.name),
        callers.map(({ name }) => name),
      )
      assert.equal(new Set(read.map((body) => body.business?.id)).size, callers.length)
    }),
  ))

void test("POST /business rejects an invalid name with a 400 and creates nothing", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { authorization } = yield* exchange(plane, fingerprint())

      const invalid = {
        missing: {},
        "not a string": { name: 42 },
        null: { name: null },
        empty: { name: "" },
        "whitespace only": { name: " \t\n " },
        "256 characters": { name: "a".repeat(256) },
      }

      for (const [reason, body] of Object.entries(invalid)) {
        const { status, json } = yield* createBusiness(plane, authorization, { body })

        const error = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ message: Schema.String, error: Schema.Struct({ code: Schema.Literal("validation_error") }) }),
        )(json)

        assert.equal(status, 400, reason)
        assert.equal(error.error.code, "validation_error", reason)
      }

      assert.equal((yield* me(plane, authorization)).body.business, null)

      // The bound itself is accepted.
      assert.equal((yield* created(plane, authorization, { body: { name: "a".repeat(255) } })).body.name.length, 255)
    }),
  ))

void test("POST /business trims the name, so a repeat differing only in surrounding whitespace is the same request", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const sub = fingerprint()
      const { authorization } = yield* exchange(plane, sub)

      const first = yield* created(plane, authorization, { body: { name: " \tAcme Ltd\u3000\n" } })

      assert.equal(first.body.name, "Acme Ltd")
      assert.equal((yield* stored(sub)).business?.name, "Acme Ltd")
      assert.deepEqual((yield* created(plane, authorization, { body: { name: "Acme Ltd " } })).json, first.json)

      // Surrounding whitespace doesn't count toward the limit.
      const other = yield* exchange(plane, fingerprint())
      const padded = yield* created(plane, other.authorization, { body: { name: `  ${"a".repeat(255)}  ` } })

      assert.equal(padded.body.name.length, 255)
    }),
  ))

void test("identity fields in the body, query, or headers can't choose the owner", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const caller = fingerprint()
      const victim = fingerprint()
      const { authorization } = yield* exchange(plane, caller)
      const victimSession = yield* exchange(plane, victim)
      const victimId = decodeJwt(victimSession.session.access_token).sub ?? ""

      const response = yield* created(plane, authorization, {
        path: `/business?issuer=ssh&sub=${encodeURIComponent(victim)}&principal_id=${victimId}`,
        body: { name: "Acme Ltd", issuer: "ssh", sub: victim, subject: victim, principal_id: victimId, id: "biz_x" },
        headers: { "x-principal-id": victimId, "x-sub": victim },
      })

      assert.equal(response.status, 200)
      assert.equal((yield* stored(caller)).business?.id, response.body.id)
      assert.equal((yield* me(plane, victimSession.authorization)).body.business, null)

      const claimed = yield* me(plane, authorization, {
        path: `/me?issuer=ssh&sub=${encodeURIComponent(victim)}&id=${victimId}`,
        headers: { "x-principal-id": victimId, "x-sub": victim },
      })

      assert.notEqual(claimed.body.id, victimId)
      assert.equal(claimed.body.business?.id, response.body.id)
    }),
  ))

void test("only POST /business creates", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { authorization } = yield* exchange(plane, fingerprint())

      for (const call of [
        { method: "GET", path: "/business", authorization },
        { method: "PUT", path: "/business", body: { name: "Acme Ltd" }, authorization },
      ] satisfies ReadonlyArray<Call>) {
        const { status } = yield* send(plane, call)

        assert.ok(status === 404 || status === 405, `${call.method} /business: ${status}`)
      }

      assert.equal((yield* me(plane, authorization)).body.business, null)
    }),
  ))

void test("session, business, then ledger leaves an active NG business in NGN that /me agrees with", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { sub, authorization, id } = yield* withBusiness(plane)

      const response = yield* opened(plane, authorization)
      const { business } = yield* stored(sub)
      const reply = plane.ledger.replies[0]

      assert.ok(business !== undefined)
      assert.ok(reply !== undefined && reply !== "unreachable" && "body" in reply && "reference" in reply.body && "holder_reference" in reply.body)
      assert.deepEqual(plane.ledger.requests, [{ ledger: "ngn_ng", external_id: id, name: "Acme Ltd" }])
      assert.equal(response.status, 200)
      assert.deepEqual(response.json, {
        id,
        name: "Acme Ltd",
        country_code: "NG",
        currency_code: "NGN",
        holder_ref: reply.body.holder_reference,
        status: "active",
        ledger: { slug: "ngn_ng", currency: "NGN", scale: 2, payable_account_ref: reply.body.reference },
        created_at: business.createdAt.toISOString(),
        updated_at: business.updatedAt.toISOString(),
      })
      assert.deepEqual((yield* me(plane, authorization)).body.business, response.body)
    }),
  ))

void test("with a US default configured, a US business opens its account there, in USD", () =>
  run(
    withUsDefault(Effect.fnUntraced(function* (usd) {
      const plane = yield* server()
      const sub = fingerprint()
      const { authorization } = yield* exchange(plane, sub)
      const { id } = (yield* created(plane, authorization, { body: { name: "Acme Inc", country_code: "US" } })).body

      const response = yield* opened(plane, authorization)
      const reply = plane.ledger.replies[0]

      assert.ok(reply !== undefined && reply !== "unreachable" && "body" in reply && "reference" in reply.body)
      assert.deepEqual(plane.ledger.requests, [{ ledger: usd, external_id: id, name: "Acme Inc" }])
      assert.equal(response.body.status, "active")
      assert.equal(response.body.country_code, "US")
      assert.equal(response.body.currency_code, "USD")
      assert.deepEqual(
        response.body.ledger,
        new BusinessLedger({ slug: usd, currency: "USD", scale: 2, payable_account_ref: String(reply.body.reference) }),
      )
      assert.deepEqual((yield* me(plane, authorization)).body.business, response.body)

      // Repeating either step changes nothing.
      assert.deepEqual((yield* opened(plane, authorization)).json, response.json)
      assert.deepEqual((yield* created(plane, authorization, { body: { name: "Acme Inc", country_code: "US" } })).json, response.json)
      assert.deepEqual(yield* createBusiness(plane, authorization, { body: { name: "Acme Inc", country_code: "NG" } }), renamed)
      assert.equal(plane.ledger.requests.length, 1)
    })),
  ))

void test("ledger creation ignores a caller-supplied ledger, currency, name, or reference", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { authorization, id } = yield* withBusiness(plane)

      const response = yield* opened(plane, authorization, {
        path: "/account?ledger=usd_us&currency_code=USD",
        body: { ledger: "usd_us", currency_code: "USD", name: "Other Ltd", holder_ref: "hld_x", payable_account_ref: "acct_x" },
        headers: { "x-ledger": "usd_us" },
      })

      assert.deepEqual(plane.ledger.requests, [{ ledger: "ngn_ng", external_id: id, name: "Acme Ltd" }])
      assert.equal(response.body.name, "Acme Ltd")
      assert.equal(response.body.currency_code, "NGN")
      assert.equal(response.body.ledger?.slug, "ngn_ng")
      assert.notEqual(response.body.holder_ref, "hld_x")
      assert.notEqual(response.body.ledger.payable_account_ref, "acct_x")
    }),
  ))

void test("repeating ledger creation returns the business unchanged without asking the ledger", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { authorization } = yield* withBusiness(plane)

      const first = yield* opened(plane, authorization)
      const again = yield* opened(plane, authorization)

      assert.deepEqual(again.json, first.json)
      assert.equal(plane.ledger.requests.length, 1)
      // Nor does creating it again change it.
      assert.deepEqual((yield* created(plane, authorization)).json, first.json)
    }),
  ))

void test("an account recorded before an interruption is activated without asking the ledger", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const businesses = yield* Business.Service
      const { sub, authorization, id } = yield* withBusiness(plane)
      const account = new Business.PayableAccount({ holderRef: `hld_${ulid()}`, accountRef: `acct_${ulid()}` })
      const ledger = (yield* stored(sub)).business?.primaryLedger.slug

      assert.ok(ledger !== undefined)

      yield* businesses.recordPayableAccount(Business.ID.make(id), ledger, account)

      const response = yield* opened(plane, authorization)

      assert.equal(response.body.status, "active")
      assert.equal(response.body.ledger?.payable_account_ref, account.accountRef)
      assert.equal(plane.ledger.requests.length, 0)
    }),
  ))

void test("an account created before a local failure is recorded on retry", () =>
  run(
    Effect.gen(function* () {
      const businesses = yield* Business.Service
      // One ledger across both servers: its account outlives the rollback.
      const ledger = fakeLedger()

      // Fails after the account is recorded, inside the same transaction.
      const lost = Business.Service.of({ ...businesses, activate: () => Effect.die(new Error("connection lost")) })

      const failing = yield* server({ ledger, businesses: lost })
      const { sub, authorization } = yield* withBusiness(failing)

      const first = yield* openAccount(failing, authorization)

      assert.equal(first.status, 500)

      const interrupted = (yield* stored(sub)).business

      assert.equal(interrupted?.status, "created")
      assert.equal(interrupted.holderRef, null)
      assert.equal(interrupted.primaryLedger.payableAccountRef, null)

      const plane = yield* server({ ledger })
      const resumed = yield* opened(plane, authorization)
      const reply = ledger.replies[0]

      assert.ok(reply !== undefined && reply !== "unreachable" && "body" in reply && "reference" in reply.body && "holder_reference" in reply.body)
      assert.equal(resumed.body.status, "active")
      assert.equal(resumed.body.holder_ref, reply.body.holder_reference)
      assert.equal(resumed.body.ledger?.payable_account_ref, reply.body.reference)
      assert.equal(ledger.requests.length, 2)
      assert.deepEqual(ledger.requests[0], ledger.requests[1])
    }),
  ))

void test("a moved country default applies to new businesses, not to an existing one or its retry", () =>
  run(
    Effect.gen(function* () {
      const businesses = yield* Business.Service
      const ledger = fakeLedger()
      const lost = Business.Service.of({ ...businesses, activate: () => Effect.die(new Error("connection lost")) })

      // The ledger opens the account, then the local transaction fails.
      const failing = yield* server({ ledger, businesses: lost })
      const existing = yield* withBusiness(failing)

      assert.equal((yield* openAccount(failing, existing.authorization)).status, 500)

      const original = (yield* stored(existing.sub)).business?.primaryLedger.slug
      const moved = Ledger.Slug.make(`ngn_moved_${ulid().toLowerCase()}`)

      assert.ok(original !== undefined)

      // Committed, so it is put back for the tests after this one.
      yield* Testing.addLedger(moved, "NGN", 2, "NG")

      const plane = yield* server({ ledger })

      const { retried, later } = yield* Effect.gen(function* () {
        yield* Testing.makeCountryDefault(moved)

        const retried = yield* opened(plane, existing.authorization)
        const later = yield* withBusiness(plane)

        return { retried, later: yield* opened(plane, later.authorization) }
      }).pipe(Effect.ensuring(Effect.orDie(Testing.makeCountryDefault(original))))

      assert.equal(retried.body.status, "active")
      assert.equal(retried.body.ledger?.slug, original)
      assert.equal(later.body.ledger?.slug, moved)
      assert.deepEqual(
        ledger.requests.map((request) => request.ledger),
        [original, original, moved],
      )
    }),
  ))

void test("concurrent ledger creation for one business settles on one account", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { authorization } = yield* withBusiness(plane)

      const responses = yield* Effect.all(
        Array.from({ length: 8 }, () => opened(plane, authorization)),
        { concurrency: "unbounded" },
      )

      assert.ok(responses.every(({ body }) => body.status === "active"))
      assert.equal(new Set(responses.map(({ json }) => JSON.stringify(json))).size, 1)
      assert.deepEqual((yield* me(plane, authorization)).body.business, responses[0]?.body)
    }),
  ))

void test("a caller without a business is told to create one, before the ledger is asked", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const stranger = yield* exchange(plane, fingerprint())

      assert.deepEqual(yield* openAccount(plane, stranger.authorization), {
        status: 409,
        json: { message: "Create a business first.", error: { code: "business_required" } },
      })
      assert.equal(plane.ledger.requests.length, 0)
      assert.equal((yield* me(plane, stranger.authorization)).body.business, null)
    }),
  ))

void test("an account the ledger already gave another business is a conflict, and nothing changes", () =>
  run(
    Effect.gen(function* () {
      // Every business gets the same account back.
      const reference = `acct_${ulid()}`

      const plane = yield* server({
        ledger: fakeLedger((payload) => {
          const reply = accountCreated(payload)

          return reply !== "unreachable" && "body" in reply ? { status: reply.status, body: { ...reply.body, reference } } : reply
        }),
      })

      const first = yield* withBusiness(plane)
      const second = yield* withBusiness(plane)

      assert.equal((yield* opened(plane, first.authorization)).body.ledger?.payable_account_ref, reference)

      const before = (yield* stored(second.sub)).business

      assert.deepEqual(yield* openAccount(plane, second.authorization), {
        status: 409,
        json: { message: "The business's recorded ledger state conflicts with this request.", error: { code: "conflict" } },
      })
      assert.deepEqual((yield* stored(second.sub)).business, before)
    }),
  ))

void test("a ledger failure is an error response and leaves the business created", () =>
  run(
    Effect.gen(function* () {
      // A created account with some fields reported differently.
      const misreported = (fields: Readonly<Record<string, string | null>>) => (payload: Payload): Reply => {
        const reply = accountCreated(payload)

        return reply !== "unreachable" && "body" in reply ? { status: reply.status, body: { ...reply.body, ...fields } } : reply
      }

      const cases: ReadonlyArray<readonly [string, (payload: Payload) => Reply, number, string]> = [
        ["unreachable", () => "unreachable", 503, "ledger_unavailable"],
        ["ledger 500", () => failing(500, "internal_server_error"), 503, "ledger_unavailable"],
        ["holder conflict", () => failing(409, "holder_conflict"), 409, "ledger_rejected"],
        ["ledger closed", () => failing(409, "ledger_closed"), 409, "ledger_rejected"],
        // Plane sent what the ledger won't take, which the caller can't fix.
        ["ledger 400", () => invalid, 500, "internal_server_error"],
        ["schema-invalid", () => ({ status: 201, body: { reference: 1 } }), 502, "ledger_bad_response"],
        ["not JSON", () => ({ status: 201, raw: "not JSON" }), 502, "ledger_bad_response"],
        ["empty body", () => ({ status: 201, raw: "" }), 502, "ledger_bad_response"],
        ["another business's account", misreported({ external_id: `biz_${ulid()}` }), 502, "ledger_bad_response"],
        ["another name", misreported({ name: "Other Ltd" }), 502, "ledger_bad_response"],
        ["another ledger", misreported({ ledger_slug: "usd_us" }), 502, "ledger_bad_response"],
        ["a closed account", misreported({ status: "closed", closed_at: "2026-01-02T00:00:00Z" }), 409, "ledger_rejected"],
      ]

      for (const [reason, reply, status, code] of cases) {
        const plane = yield* server({ ledger: fakeLedger(reply) })
        const { sub, authorization } = yield* withBusiness(plane)

        const response = yield* openAccount(plane, authorization)
        const body = yield* Schema.decodeUnknownEffect(ErrorBody)(response.json)
        const { business } = yield* stored(sub)

        assert.equal(response.status, status, reason)
        assert.equal(body.error.code, code, reason)
        assert.equal(business?.status, "created", reason)
        assert.equal(business.holderRef, null, reason)
        assert.equal(business.primaryLedger.payableAccountRef, null, reason)
      }

      // A failed attempt, unreachable or answering garbage, leaves nothing in
      // the way of the next.
      for (const reply of ["unreachable", { status: 201, raw: "not JSON" }] satisfies ReadonlyArray<Reply>) {
        const plane = yield* server({ ledger: fakeLedger(() => reply) })
        const { authorization } = yield* withBusiness(plane)

        yield* openAccount(plane, authorization)

        const retried = yield* opened(yield* server(), authorization)

        assert.equal(retried.body.status, "active")
      }
    }),
  ))

void test("a missing country default is unavailable and one in another currency a server error, creating nothing", () =>
  run(
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [Catalog.Interface, object]> = [
        [
          { findCountryDefault: () => Effect.undefined },
          {
            status: 503,
            json: { message: "Businesses can't be created in this country yet.", error: { code: "country_unavailable" } },
          },
        ],
        [
          {
            findCountryDefault: () =>
              Effect.succeed(
                new Catalog.Entry({ slug: Ledger.Slug.make("eur_ng"), currency: Currency.Code.make("EUR"), scale: 2 }),
              ),
          },
          {
            status: 500,
            json: { message: "The server could not complete the request.", error: { code: "internal_server_error" } },
          },
        ],
      ]

      for (const [catalog, response] of cases) {
        const plane = yield* server({ catalog })
        const { authorization } = yield* exchange(plane, fingerprint())

        assert.deepEqual(yield* createBusiness(plane, authorization), response)
        assert.equal((yield* me(plane, authorization)).body.business, null)
        assert.equal(plane.ledger.requests.length, 0)
      }
    }),
  ))

// A caller whose business has opened its account, as the terminal requires
// before it offers payment links.
const withActiveBusiness = Effect.fnUntraced(function* (server: Server) {
  const caller = yield* withBusiness(server)

  yield* opened(server, caller.authorization)

  return caller
})

// Never led by a dash, which OpenSSH refuses in a user name.
const shareToken = /^[A-Za-z0-9_][A-Za-z0-9_-]{42}$/

const validation = ({ status, json }: Effect.Success<ReturnType<typeof send>>) =>
  Effect.map(
    Schema.decodeUnknownEffect(
      Schema.Struct({
        message: Schema.String,
        error: Schema.Struct({
          code: Schema.Literal("validation_error"),
          details: Schema.Array(Schema.Struct({ location: Schema.String, field: Schema.String, code: Schema.String })),
        }),
      }),
    )(json),
    (body) => {
      assert.equal(status, 400)

      // One field can fail several checks.
      return [...new Set(body.error.details.map(({ location, field }) => `${location}:${field}`))]
    },
  )

void test("POST /business/:id/payment_links creates a fixed link in the business's currency and scale, and asks no ledger", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { sub, authorization, id } = yield* withActiveBusiness(plane)
      const before = (yield* me(plane, authorization)).body.business

      const { status, json, body } = yield* createdLink(plane, authorization, fixedLink, ulid())

      assert.equal(status, 201)
      assert.match(body.id, /^plink_[0-9A-HJKMNP-TV-Z]{26}$/)
      assert.match(body.share_token, shareToken)
      assert.ok(!body.share_token.includes(body.id.slice(6)))
      assert.deepEqual(json, {
        id: body.id,
        business_id: id,
        title: "Consulting",
        description: null,
        currency_code: "NGN",
        scale: 2,
        pricing: { mode: "fixed", amount_minor: 250_000 },
        share_token: body.share_token,
        created_at: body.created_at,
      })
      assert.ok(!Number.isNaN(Date.parse(body.created_at)))

      // Only the account opening reached the ledger, and the business is as it was.
      assert.equal(plane.ledger.requests.length, 1)
      assert.deepEqual((yield* me(plane, authorization)).body.business, before)
      assert.equal((yield* stored(sub)).business?.status, "active")
    }),
  ))

void test("a customer-chosen link may leave every amount unset; omitted and null settings are the same", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { authorization } = yield* withActiveBusiness(plane)

      const open = yield* createdLink(plane, authorization, {
        title: "Community fundraiser",
        description: "Help equip the library",
        pricing: { mode: "customer_chooses" },
      }, ulid())

      assert.equal(open.status, 201)
      assert.deepEqual(open.body.pricing, new CustomerChoosesPricing({
        mode: "customer_chooses",
        suggested_amount_minor: null,
        minimum_amount_minor: null,
        maximum_amount_minor: null,
      }))
      assert.equal(open.body.description, "Help equip the library")

      const key = ulid()

      const suggested = yield* createdLink(plane, authorization, {
        title: "Tips",
        pricing: { mode: "customer_chooses", suggested_amount_minor: 250_000, minimum_amount_minor: null },
      }, key)

      assert.equal(suggested.status, 201)
      assert.deepEqual(suggested.body.pricing, new CustomerChoosesPricing({
        mode: "customer_chooses",
        suggested_amount_minor: 250_000,
        minimum_amount_minor: null,
        maximum_amount_minor: null,
      }))

      // The same settings spelled the other way are a repeat, not a conflict.
      const repeat = yield* createdLink(plane, authorization, {
        title: "Tips",
        description: null,
        pricing: { mode: "customer_chooses", suggested_amount_minor: 250_000, maximum_amount_minor: null },
      }, key)

      assert.equal(repeat.status, 200)
      assert.deepEqual(repeat.json, suggested.json)

      const bounded = yield* createdLink(plane, authorization, {
        title: "Donation",
        pricing: {
          mode: "customer_chooses",
          suggested_amount_minor: 5_000,
          minimum_amount_minor: 1_000,
          maximum_amount_minor: Number.MAX_SAFE_INTEGER,
        },
      }, ulid())

      assert.deepEqual(bounded.body.pricing, new CustomerChoosesPricing({
        mode: "customer_chooses",
        suggested_amount_minor: 5_000,
        minimum_amount_minor: 1_000,
        maximum_amount_minor: Number.MAX_SAFE_INTEGER,
      }))
    }),
  ))

void test("a retry after a lost response returns the original link; other content under its key conflicts", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { authorization } = yield* withActiveBusiness(plane)
      const key = ulid()

      // The first answer is the one the terminal never saw.
      const first = yield* createdLink(plane, authorization, fixedLink, key)
      const retried = yield* createdLink(plane, authorization, fixedLink, key)

      assert.equal(first.status, 201)
      assert.equal(retried.status, 200)
      assert.deepEqual(retried.json, first.json)

      // Surrounding whitespace and a blank description don't change the content.
      const respaced = yield* createdLink(plane, authorization, { ...fixedLink, title: "  Consulting ", description: "   " }, key)

      assert.equal(respaced.status, 200)
      assert.deepEqual(respaced.json, first.json)

      const changed: ReadonlyArray<{ readonly [key: string]: Body }> = [
        { ...fixedLink, title: "Advice" },
        { ...fixedLink, description: "Hourly" },
        { ...fixedLink, pricing: { mode: "fixed", amount_minor: 250_001 } },
        { ...fixedLink, pricing: { mode: "customer_chooses", suggested_amount_minor: 250_000 } },
      ]

      for (const body of changed) {
        assert.deepEqual(yield* createLink(plane, authorization, body, key), {
          status: 409,
          json: { message: "This idempotency key already created a different payment link.", error: { code: "conflict" } },
        })
      }

      assert.deepEqual((yield* createdLink(plane, authorization, fixedLink, key)).json, first.json)
    }),
  ))

void test("concurrent identical creations settle on one link", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { authorization } = yield* withActiveBusiness(plane)
      const key = ulid()

      const responses = yield* Effect.all(
        Array.from({ length: 8 }, () => createdLink(plane, authorization, fixedLink, key)),
        { concurrency: "unbounded" },
      )

      assert.equal(new Set(responses.map(({ body }) => body.id)).size, 1)
      assert.deepEqual(responses.map(({ status }) => status).sort((a, b) => a - b), [200, 200, 200, 200, 200, 200, 200, 201])
    }),
  ))

void test("a key is scoped to the caller's business; a caller without one is told to create it, and nothing is saved", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const ours = yield* withActiveBusiness(plane)
      const theirs = yield* withActiveBusiness(plane)
      const stranger = yield* exchange(plane, fingerprint())
      const key = ulid()

      assert.deepEqual(yield* createLink(plane, stranger.authorization, fixedLink, key), {
        status: 409,
        json: { message: "Create a business first.", error: { code: "business_required" } },
      })

      // A business ID in the body chooses nothing.
      const mine = yield* createdLink(plane, ours.authorization, { ...fixedLink, business_id: theirs.id }, key)
      const yours = yield* createdLink(plane, theirs.authorization, { ...fixedLink, title: "Theirs" }, key)

      assert.equal(mine.status, 201)
      assert.equal(yours.status, 201)
      assert.notEqual(mine.body.id, yours.body.id)
      assert.equal(mine.body.business_id, ours.id)
      assert.equal(yours.body.business_id, theirs.id)
    }),
  ))

void test("a link takes its currency and scale from the business, whatever the request says", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { authorization, id } = yield* withActiveBusiness(plane)

      const { status, body } = yield* createdLink(plane, authorization, {
        ...fixedLink,
        currency_code: "USD",
        scale: 0,
        url: "https://evil.test/x",
        business_id: `biz_${ulid()}`,
        ledger: "usd_us",
        account_ref: "acct_x",
        status: "active",
        path: "/tmp/business.db",
        pricing: { mode: "fixed", amount_minor: 100, currency: "USD" },
      }, ulid())

      assert.equal(status, 201)
      assert.equal(body.business_id, id)
      assert.equal(body.currency_code, "NGN")
      assert.equal(body.scale, 2)
      assert.match(body.share_token, shareToken)
      assert.deepEqual(body.pricing, new FixedPricing({ mode: "fixed", amount_minor: 100 }))
    }),
  ))

void test("a business whose account isn't open yet still gets links in its saved currency, and stays created", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { sub, authorization } = yield* withBusiness(plane)

      const { status, body } = yield* createdLink(plane, authorization, fixedLink, ulid())

      assert.equal(status, 201)
      assert.equal(body.currency_code, "NGN")
      assert.equal(body.scale, 2)
      assert.equal((yield* stored(sub)).business?.status, "created")
      assert.equal(plane.ledger.requests.length, 0)
    }),
  ))

void test("invalid content or idempotency keys are a 400 naming each field, and save nothing", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { authorization } = yield* withActiveBusiness(plane)

      const fixed = (pricing: { readonly [key: string]: Body }) => ({ ...fixedLink, pricing: { mode: "fixed", ...pricing } })
      const chooses = (pricing: { readonly [key: string]: Body }) => ({ ...fixedLink, pricing: { mode: "customer_chooses", ...pricing } })

      const cases: ReadonlyArray<readonly [string, { readonly [key: string]: Body }, ReadonlyArray<string>]> = [
        ["no title", { pricing: fixedLink.pricing }, ["body:title"]],
        ["blank title", { ...fixedLink, title: "  " }, ["body:title"]],
        ["long title", { ...fixedLink, title: ` ${"x".repeat(256)} ` }, ["body:title"]],
        ["title not a string", { ...fixedLink, title: 5 }, ["body:title"]],
        ["long description", { ...fixedLink, description: "x".repeat(501) }, ["body:description"]],
        ["no pricing", { title: "Consulting" }, ["body:pricing"]],
        ["no mode", { ...fixedLink, pricing: { amount_minor: 100 } }, []],
        ["unknown mode", { ...fixedLink, pricing: { mode: "donation", amount_minor: 100 } }, []],
        ["fixed without amount", fixed({}), ["body:pricing.amount_minor"]],
        ["fixed with null amount", fixed({ amount_minor: null }), ["body:pricing.amount_minor"]],
        ["zero amount", fixed({ amount_minor: 0 }), ["body:pricing.amount_minor"]],
        ["negative amount", fixed({ amount_minor: -100 }), ["body:pricing.amount_minor"]],
        ["fractional amount", fixed({ amount_minor: 1.5 }), ["body:pricing.amount_minor"]],
        ["unsafe amount", fixed({ amount_minor: Number.MAX_SAFE_INTEGER + 1 }), ["body:pricing.amount_minor"]],
        ["amount as a string", fixed({ amount_minor: "100" }), ["body:pricing.amount_minor"]],
        ["fixed with a suggestion", fixed({ amount_minor: 100, suggested_amount_minor: 100 }), ["body:pricing.suggested_amount_minor"]],
        ["fixed with a null minimum", fixed({ amount_minor: 100, minimum_amount_minor: null }), ["body:pricing.minimum_amount_minor"]],
        ["fixed with a maximum", fixed({ amount_minor: 100, maximum_amount_minor: 100 }), ["body:pricing.maximum_amount_minor"]],
        ["customer chooses with an amount", chooses({ amount_minor: 100 }), ["body:pricing.amount_minor"]],
        ["zero suggestion", chooses({ suggested_amount_minor: 0 }), ["body:pricing.suggested_amount_minor"]],
        ["fractional minimum", chooses({ minimum_amount_minor: 0.5 }), ["body:pricing.minimum_amount_minor"]],
        ["inverted bounds", chooses({ minimum_amount_minor: 200, maximum_amount_minor: 100 }), ["body:pricing.maximum_amount_minor"]],
        ["suggestion below the minimum", chooses({ suggested_amount_minor: 99, minimum_amount_minor: 100 }), ["body:pricing.suggested_amount_minor"]],
        ["suggestion above the maximum", chooses({ suggested_amount_minor: 101, maximum_amount_minor: 100 }), ["body:pricing.suggested_amount_minor"]],
      ]

      for (const [reason, body, fields] of cases) {
        const key = ulid()
        const response = yield* createLink(plane, authorization, body, key)
        const details = yield* validation(response)

        // An unmatched mode fails every member; its fields are the union's.
        if (fields.length > 0) {
          assert.deepEqual(details, fields, reason)
        } else {
          assert.ok(details.length > 0 && details.every((detail) => detail.startsWith("body:pricing")), reason)
        }

        // Nothing was saved under the key.
        assert.equal((yield* createdLink(plane, authorization, fixedLink, key)).status, 201, reason)
      }

      for (const key of [undefined, "", " ", "has space", "x".repeat(256), "naïve"]) {
        const response = yield* createLink(plane, authorization, fixedLink, key)

        assert.deepEqual(yield* validation(response), ["header:idempotency-key"], `key ${String(key)}`)
      }

      assert.equal((yield* createdLink(plane, authorization, fixedLink, "x".repeat(255))).status, 201)
    }),
  ))

// A token like plane's, with one thing changed.
const forge = Effect.fnUntraced(function* (
  principal: string,
  change: (token: { header: JWTHeaderParameters; claims: JWTPayload }) => { header: JWTHeaderParameters; claims: JWTPayload },
  key: Uint8Array = current.secret,
) {
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)

  const { header, claims } = change({
    header: { alg: "HS256", typ: "at+jwt", kid: current.id },
    claims: { iss: Token.issuer, aud: Token.audience, sub: principal, iat: now, exp: now + Token.lifetime },
  })

  return yield* Effect.promise(() => new SignJWT(claims).setProtectedHeader(header).sign(key))
})

void test("accepts only tokens plane would have issued", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { session, authorization } = yield* exchange(plane, fingerprint())
      const principal = decodeJwt(session.access_token).sub ?? ""

      const accepted = (token: string) => Effect.map(send(plane, { method: "GET", path: "/me", authorization: `Bearer ${token}` }), ({ status }) => status === 200)

      // A baseline forged token passes, so each rejection below is down to
      // the one thing changed.
      assert.equal(yield* accepted(yield* forge(principal, (token) => token)), true)
      // The previous key still verifies during the rotation overlap.
      assert.equal(yield* accepted(yield* forge(principal, ({ header, claims }) => ({ header: { ...header, kid: previous.id }, claims }), previous.secret)), true)

      const json = (value: Readonly<Record<string, string>>) => Effect.map(Schema.encodeUnknownEffect(Json)(value), Encoding.encodeBase64Url)
      const unsigned = `${yield* json({ alg: "none", typ: "at+jwt" })}.${yield* json({ iss: Token.issuer, aud: Token.audience, sub: principal })}.`

      const rejected = {
        "unsigned (alg none)": unsigned,
        "signed with another secret": yield* forge(principal, (token) => token, secret()),
        "a retired key id": yield* forge(principal, ({ header, claims }) => ({ header: { ...header, kid: "retired" }, claims }), secret()),
        "no key id": yield* forge(principal, ({ header, claims }) => ({ header: { alg: header.alg, typ: "at+jwt" }, claims })),
        "HS384": yield* forge(principal, ({ header, claims }) => ({ header: { ...header, alg: "HS384" }, claims })),
        "another issuer": yield* forge(principal, ({ header, claims }) => ({ header, claims: { ...claims, iss: "ssh" } })),
        "another audience": yield* forge(principal, ({ header, claims }) => ({ header, claims: { ...claims, aud: "ledger" } })),
        "another type": yield* forge(principal, ({ header, claims }) => ({ header: { ...header, typ: "JWT" }, claims })),
        "expired": yield* forge(principal, ({ header, claims }) => ({ header, claims: { ...claims, iat: (claims.iat ?? 0) - 2000, exp: (claims.exp ?? 0) - 2000 } })),
        "a longer lifetime than issued": yield* forge(principal, ({ header, claims }) => ({ header, claims: { ...claims, exp: (claims.iat ?? 0) + 3600 } })),
        "issued in the future": yield* forge(principal, ({ header, claims }) => ({ header, claims: { ...claims, iat: (claims.iat ?? 0) + 120, exp: (claims.iat ?? 0) + 120 + Token.lifetime } })),
        "a fingerprint as subject": yield* forge("SHA256:abc", (token) => token),
        "an unknown principal": yield* forge(`prn_${ulid()}`, (token) => token),
        "garbage": "not-a-token",
      }

      const routes: ReadonlyArray<Pick<Call, "method" | "path" | "body" | "headers">> = [
        { method: "GET", path: "/me" },
        { method: "POST", path: "/business", body: { name: "Acme Ltd" } },
        { method: "POST", path: "/account" },
        { method: "POST", path: "/payment_links", body: fixedLink, headers: { "idempotency-key": ulid() } },
      ]

      for (const route of routes) {
        for (const [reason, token] of Object.entries(rejected)) {
          const response = yield* send(plane, { ...route, authorization: `Bearer ${token}` })

          assert.deepEqual(response, { status: 401, json: unauthorized }, `${route.path}: ${reason}`)
        }

        for (const header of [undefined, "", "Bearer", `Basic ${session.access_token}`]) {
          const response = yield* send(plane, { ...route, authorization: header })

          assert.deepEqual(response, { status: 401, json: unauthorized }, `${route.path}: authorization: ${header}`)
        }
      }

      // None of the rejected creates went through for the real principal.
      assert.equal((yield* me(plane, authorization)).body.business, null)
    }),
  ))

// A merchant's new link, and the token its customers pay it by.
const linkToPay = Effect.fnUntraced(function* (server: Server, body: { readonly [key: string]: Body } = fixedLink) {
  const { authorization } = yield* withActiveBusiness(server)
  const { body: link } = yield* createdLink(server, authorization, body, ulid())

  return { authorization, link, token: link.share_token }
})

const payable = (server: Server, token: string) => send(server, { method: "GET", path: `/pay/payment_links/${token}` })

// A null key sends no idempotency-key header.
const startPayment = (server: Server, token: string, body: { readonly [key: string]: Body }, idempotencyKey: string | null = ulid()) =>
  send(server, {
    method: "POST",
    path: `/pay/payment_links/${token}/payments`,
    body,
    headers: idempotencyKey === null ? {} : { "idempotency-key": idempotencyKey },
  })

// A payment start that succeeded, decoded strictly.
const started = Effect.fnUntraced(function* (
  server: Server,
  token: string,
  body: { readonly [key: string]: Body } = {},
  idempotencyKey: string = ulid(),
) {
  const { status, json } = yield* startPayment(server, token, body, idempotencyKey)

  return { status, json, body: yield* Schema.decodeUnknownEffect(PayPayment)(json, strict) }
})

const simulatePayment = (server: Server, token: string, id: string, outcome: string) =>
  send(server, { method: "POST", path: `/pay/payment_links/${token}/payments/${id}/simulate`, body: { outcome } })

const errorCode = ({ status, json }: Effect.Success<ReturnType<typeof send>>) =>
  Effect.map(Schema.decodeUnknownEffect(ErrorBody)(json), (body) => `${status} ${body.error.code}`)

void test("a customer reads a link by its share token alone, without the merchant's details", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { token } = yield* linkToPay(plane, { ...fixedLink, description: "Two concepts and one revision." })

      const { status, json } = yield* payable(plane, token)

      assert.equal(status, 200)
      assert.deepEqual(yield* Schema.decodeUnknownEffect(PayableLink)(json, strict), new PayableLink({
        business_name: "Acme Ltd",
        title: "Consulting",
        description: "Two concepts and one revision.",
        currency_code: "NGN",
        scale: 2,
        pricing: new FixedPricing({ mode: "fixed", amount_minor: 250_000 }),
        active: true,
      }))

      assert.deepEqual(yield* errorCode(yield* payable(plane, "x".repeat(43))), "404 not_found")
    }),
  ))

void test("a customer starts a pending payment of a fixed link's amount; a repeat returns it", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { token } = yield* linkToPay(plane)
      const key = ulid()

      const first = yield* started(plane, token, {}, key)

      assert.equal(first.status, 201)
      assert.match(first.body.id, /^pay_[0-9A-HJKMNP-TV-Z]{26}$/)
      assert.deepEqual(first.json, {
        id: first.body.id,
        amount_minor: 250_000,
        currency_code: "NGN",
        scale: 2,
        status: "pending",
        created_at: first.body.created_at,
        expires_at: first.body.expires_at,
        completed_at: null,
      })
      assert.equal(
        Date.parse(first.body.expires_at) - Date.parse(first.body.created_at),
        Payments.paymentWindowMinutes * 60_000,
      )

      const repeat = yield* started(plane, token, {}, key)

      assert.equal(repeat.status, 200)
      assert.deepEqual(repeat.json, first.json)

      // Another key is another payment of the same link.
      assert.equal((yield* started(plane, token)).status, 201)
    }),
  ))

void test("the amount must fit the link's pricing, and is checked as a field of the request", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const fixed = yield* linkToPay(plane)

      const bounded = yield* linkToPay(plane, {
        title: "Tip jar",
        pricing: { mode: "customer_chooses", minimum_amount_minor: 1_000, maximum_amount_minor: 5_000 },
      })

      const details = (token: string, body: { readonly [key: string]: Body }) =>
        Effect.flatMap(startPayment(plane, token, body), (response) =>
          Effect.map(
            Schema.decodeUnknownEffect(
              Schema.Struct({
                error: Schema.Struct({ details: Schema.Array(Schema.Struct({ field: Schema.String, code: Schema.String })) }),
              }),
            )(response.json),
            (body) => {
              assert.equal(response.status, 400)

              return body.error.details.map(({ field, code }) => `${field}:${code}`)
            },
          ),
        )

      assert.deepEqual(yield* details(fixed.token, { amount_minor: 250_000 }), ["amount_minor:unknown_field"])
      assert.deepEqual(yield* details(bounded.token, {}), ["amount_minor:required"])
      assert.deepEqual(yield* details(bounded.token, { amount_minor: null }), ["amount_minor:required"])
      assert.deepEqual(yield* details(bounded.token, { amount_minor: 999 }), ["amount_minor:invalid_value"])
      assert.deepEqual(yield* details(bounded.token, { amount_minor: 5_001 }), ["amount_minor:invalid_value"])

      // Malformed requests fail before any link is read.
      for (const [reason, body] of [
        ["zero amount", { amount_minor: 0 }],
        ["fractional amount", { amount_minor: 1.5 }],
        ["amount as a string", { amount_minor: "2500" }],
      ] as const) {
        assert.equal((yield* startPayment(plane, bounded.token, body)).status, 400, reason)
      }

      assert.deepEqual(yield* validation(yield* startPayment(plane, bounded.token, {}, null)), [
        "header:idempotency-key",
      ])

      const chosen = yield* started(plane, bounded.token, { amount_minor: 2_500 })

      assert.equal(chosen.body.amount_minor, 2_500)
    }),
  ))

void test("a simulated outcome ends the payment once; later ones conflict", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { token } = yield* linkToPay(plane)

      for (const outcome of ["succeeded", "failed", "cancelled"] as const) {
        const { body: payment } = yield* started(plane, token)

        const { status, json } = yield* simulatePayment(plane, token, payment.id, outcome)
        const ended = yield* Schema.decodeUnknownEffect(PayPayment)(json, strict)

        assert.equal(status, 200)
        assert.equal(ended.status, outcome)
        assert.ok(ended.completed_at !== null)

        assert.deepEqual(yield* errorCode(yield* simulatePayment(plane, token, payment.id, "succeeded")), "409 not_pending")
      }

      const { body: payment } = yield* started(plane, token)

      assert.equal((yield* simulatePayment(plane, token, payment.id, "refunded")).status, 400)
    }),
  ))

void test("a payment is reached only through its own link's token", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { token } = yield* linkToPay(plane)
      const other = yield* linkToPay(plane)

      const { body: payment } = yield* started(plane, token)

      assert.deepEqual(yield* errorCode(yield* simulatePayment(plane, other.token, payment.id, "succeeded")), "404 not_found")
      assert.deepEqual(yield* errorCode(yield* simulatePayment(plane, token, `pay_${ulid()}`, "succeeded")), "404 not_found")
      assert.deepEqual(yield* errorCode(yield* simulatePayment(plane, "x".repeat(43), payment.id, "succeeded")), "404 not_found")
      assert.deepEqual(yield* errorCode(yield* startPayment(plane, "x".repeat(43), {})), "404 not_found")

      // Still pending, so its own link can end it.
      assert.equal((yield* simulatePayment(plane, token, payment.id, "succeeded")).status, 200)
    }),
  ))

void test("a deactivated link shows as inactive and starts no payment; one under way still completes", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { link, token } = yield* linkToPay(plane)

      const { body: payment } = yield* started(plane, token)

      yield* Testing.deactivateLink(link.id)

      const shown = yield* Schema.decodeUnknownEffect(PayableLink)((yield* payable(plane, token)).json, strict)

      assert.equal(shown.active, false)
      assert.deepEqual(yield* errorCode(yield* startPayment(plane, token, {})), "409 link_inactive")
      assert.equal((yield* simulatePayment(plane, token, payment.id, "succeeded")).status, 200)
    }),
  ))

void test("a payment past its window is refused as expired", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { token } = yield* linkToPay(plane)

      const { body: payment } = yield* started(plane, token)

      yield* Testing.lapsePayment(payment.id)

      assert.deepEqual(yield* errorCode(yield* simulatePayment(plane, token, payment.id, "succeeded")), "409 payment_expired")
      assert.deepEqual(yield* errorCode(yield* simulatePayment(plane, token, payment.id, "cancelled")), "409 payment_expired")
    }),
  ))

void test("paying asks the ledger nothing and needs no merchant token", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { authorization, token } = yield* linkToPay(plane)
      const before = plane.ledger.requests.length

      const { body: payment } = yield* started(plane, token)

      yield* simulatePayment(plane, token, payment.id, "succeeded")

      assert.equal(plane.ledger.requests.length, before)

      // A merchant's token changes nothing about it.
      const withToken = yield* send(plane, { method: "GET", path: `/pay/payment_links/${token}`, authorization })

      assert.deepEqual(withToken, yield* payable(plane, token))
    }),
  ))

const listLinks = (server: Server, authorization: string | undefined) =>
  send(server, { method: "GET", path: "/payment_links", authorization })

// A listing that succeeded, decoded strictly.
const listed = Effect.fnUntraced(function* (server: Server, authorization: string) {
  const { status, json } = yield* listLinks(server, authorization)

  assert.equal(status, 200)

  return yield* Schema.decodeUnknownEffect(PaymentLinkList)(json, strict)
})

void test("GET /payment_links lists the caller's links newest first, with each one's payments and the totals", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { authorization, link: logo, token } = yield* linkToPay(plane)

      const tips = yield* createdLink(plane, authorization, { title: "Tip jar", pricing: { mode: "customer_chooses" } }, ulid())

      const paid = yield* started(plane, token)

      yield* simulatePayment(plane, token, paid.body.id, "succeeded")
      yield* started(plane, token)
      yield* started(plane, tips.body.share_token, { amount_minor: 1_000 })

      const list = yield* listed(plane, authorization)

      assert.deepEqual(list.links.map((link) => link.id), [tips.body.id, logo.id])

      const [tipsSummary, logoSummary] = list.links

      assert.deepEqual(tipsSummary?.pricing, tips.body.pricing)
      assert.equal(tipsSummary?.active, true)
      assert.equal(tipsSummary?.share_token, tips.body.share_token)
      assert.ok(logoSummary !== undefined && logoSummary.stats.last_paid_at !== null)
      assert.deepEqual(
        logoSummary.stats,
        new PaymentStats({
          succeeded: 1,
          failed: 0,
          cancelled: 0,
          expired: 0,
          pending: 1,
          collected_minor: "250000",
          last_paid_at: logoSummary.stats.last_paid_at,
        }),
      )
      assert.equal(tipsSummary?.stats.pending, 1)
      assert.equal(tipsSummary?.stats.collected_minor, "0")

      assert.equal(list.link_count, 2)
      assert.equal(list.active_link_count, 2)
      assert.equal(list.totals.succeeded, 1)
      assert.equal(list.totals.pending, 2)
      assert.equal(list.totals.collected_minor, "250000")
    }),
  ))

void test("GET /payment_links shows only the caller's business, needs one, and needs a token", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const ours = yield* withActiveBusiness(plane)
      const theirs = yield* linkToPay(plane)
      const stranger = yield* exchange(plane, fingerprint())

      const empty = yield* listed(plane, ours.authorization)

      assert.deepEqual(empty.links, [])
      assert.equal(empty.link_count, 0)
      assert.equal(empty.totals.collected_minor, "0")
      assert.deepEqual((yield* listed(plane, theirs.authorization)).links.map((link) => link.id), [theirs.link.id])

      assert.deepEqual(yield* listLinks(plane, stranger.authorization), {
        status: 409,
        json: { message: "Create a business first.", error: { code: "business_required" } },
      })
      assert.deepEqual(yield* listLinks(plane, undefined), { status: 401, json: unauthorized })
    }),
  ))
