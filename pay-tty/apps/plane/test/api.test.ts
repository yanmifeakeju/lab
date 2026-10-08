import assert from "node:assert/strict"
import { test } from "node:test"

import { NodeHttpServer } from "@effect/platform-node"
import { Business } from "@pay-tty/core/business"
import { Database, layer as DatabaseLayer } from "@pay-tty/core/database"
import { Catalog } from "@pay-tty/core/catalog"
import { Currency } from "@pay-tty/core/currency"
import { Ledger } from "@pay-tty/core/ledger"
import { Principal } from "@pay-tty/core/principal"
import { Testing } from "@pay-tty/core/testing"
import { Clock, Effect, Encoding, Layer, Schema, type Scope } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { decodeJwt, type JWTHeaderParameters, type JWTPayload, SignJWT } from "jose"
import { ulid } from "ulid"

import { BusinessInfo, BusinessLedger } from "../src/api/routes/business.ts"
import { MeResponse } from "../src/api/routes/me.ts"
import { SessionResponse } from "../src/api/routes/session.ts"
import { ApiLive } from "../src/api/handlers/index.ts"
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
            Layer.provideMerge(Layer.mergeAll(AuthenticationLive, ledgerEndpoint)),
            Layer.provideMerge(Token.layerFrom(keys)),
            Layer.provideMerge(Layer.mergeAll(Principal.layer, Business.layer)),
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

interface Call {
  readonly method: "GET" | "POST" | "PUT"
  readonly path: string
  readonly body?: Readonly<Record<string, string | number | null>>
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

  return { session, authorization: `Bearer ${session.accessToken}` }
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

const ledgerPath = (businessId: string) => `/business/${encodeURIComponent(businessId)}/ledger`

const openLedger = (server: Server, authorization: string, businessId: string, extra: Partial<Call> = {}) =>
  send(server, { method: "POST", path: ledgerPath(businessId), authorization, ...extra })

// A successful ledger creation, decoded strictly.
const opened = (server: Server, authorization: string, businessId: string, extra: Partial<Call> = {}) =>
  openLedger(server, authorization, businessId, extra).pipe(
    Effect.flatMap(({ status, json }) =>
      Effect.map(Schema.decodeUnknownEffect(BusinessInfo)(json, strict), (body) => ({ status, json, body })),
    ),
  )

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

void test("publishes exactly /health, /session, /me, /business, and its ledger", () =>
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
      assert.deepEqual(Object.keys(paths).sort(), ["/business", "/business/{businessId}/ledger", "/health", "/me", "/session"])
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

      assert.deepEqual(Object.keys(paths["/business/{businessId}/ledger"] ?? {}), ["post"])

      const ledger = paths["/business/{businessId}/ledger"]?.["post"]

      assert.deepEqual(ledger?.security, paths["/me"]?.["get"]?.security)
      assert.equal(ledger?.requestBody, undefined)
      assert.deepEqual(
        (yield* Schema.decodeUnknownEffect(Body)(ledger?.responses["200"])).content["application/json"].schema.$ref,
        "#/components/schemas/BusinessInfoEncoded",
      )

      for (const code of ["401", "404", "409", "502", "503"]) {
        assert.ok(code in (ledger?.responses ?? {}), code)
      }
    }),
  ))

void test("a session exchange issues a bearer token and creates only the principal", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { session, authorization } = yield* exchange(plane, fingerprint())

      assert.equal(session.tokenType, "Bearer")
      assert.equal(session.expiresIn, 900)
      assert.match(decodeJwt(session.accessToken).sub ?? "", /^prn_/)
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

      assert.equal(decodeJwt(second.session.accessToken).sub, decodeJwt(first.session.accessToken).sub)
      assert.notEqual(decodeJwt(other.session.accessToken).sub, decodeJwt(first.session.accessToken).sub)
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
      assert.equal(first.body.id, decodeJwt(session.accessToken).sub)
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

void test("repeating POST /business returns the business unchanged, whatever name is sent", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const sub = fingerprint()
      const { authorization } = yield* exchange(plane, sub)

      const first = yield* created(plane, authorization)
      const again = yield* created(plane, authorization, { body: { name: "Renamed Ltd" } })

      assert.equal(again.status, 200)
      assert.deepEqual(again.json, first.json)

      const { business } = yield* stored(sub)

      assert.ok(business !== undefined)
      assert.equal(business.name, "Acme Ltd")
      assert.equal(business.status, "created")
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

        // Nor does a repeat asking for the other country change it.
        const again = yield* created(plane, authorization, { body: { name: "Acme", country_code: country === "US" ? "NG" : "US" } })

        assert.deepEqual(again.json, response.json)
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
      const response = yield* created(plane, authorization, { body: { name: "Other Ltd" } })

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
      const { authorization } = yield* exchange(plane, fingerprint())

      const responses = yield* Effect.all(
        Array.from({ length: 8 }, (_, index) => created(plane, authorization, { body: { name: `Acme ${index}` } })),
        { concurrency: "unbounded" },
      )

      assert.equal(new Set(responses.map(({ body }) => body.id)).size, 1)
      assert.equal(new Set(responses.map(({ body }) => body.name)).size, 1)
      assert.equal((yield* me(plane, authorization)).body.business?.id, responses[0]?.body.id)
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

void test("identity fields in the body, query, or headers can't choose the owner", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const caller = fingerprint()
      const victim = fingerprint()
      const { authorization } = yield* exchange(plane, caller)
      const victimSession = yield* exchange(plane, victim)
      const victimId = decodeJwt(victimSession.session.accessToken).sub ?? ""

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

      const response = yield* opened(plane, authorization, id)
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

      const response = yield* opened(plane, authorization, id)
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
      assert.deepEqual((yield* opened(plane, authorization, id)).json, response.json)
      assert.deepEqual((yield* created(plane, authorization, { body: { name: "Other", country_code: "NG" } })).json, response.json)
      assert.equal(plane.ledger.requests.length, 1)
    })),
  ))

void test("ledger creation ignores a caller-supplied ledger, currency, name, or reference", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const { authorization, id } = yield* withBusiness(plane)

      const response = yield* opened(plane, authorization, id, {
        path: `${ledgerPath(id)}?ledger=usd_us&currency_code=USD`,
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
      const { authorization, id } = yield* withBusiness(plane)

      const first = yield* opened(plane, authorization, id)
      const again = yield* opened(plane, authorization, id)

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

      const response = yield* opened(plane, authorization, id)

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
      const { sub, authorization, id } = yield* withBusiness(failing)

      const first = yield* openLedger(failing, authorization, id)

      assert.equal(first.status, 500)

      const interrupted = (yield* stored(sub)).business

      assert.equal(interrupted?.status, "created")
      assert.equal(interrupted.holderRef, null)
      assert.equal(interrupted.primaryLedger.payableAccountRef, null)

      const plane = yield* server({ ledger })
      const resumed = yield* opened(plane, authorization, id)
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

      assert.equal((yield* openLedger(failing, existing.authorization, existing.id)).status, 500)

      const original = (yield* stored(existing.sub)).business?.primaryLedger.slug
      const moved = Ledger.Slug.make(`ngn_moved_${ulid().toLowerCase()}`)

      assert.ok(original !== undefined)

      // Committed, so it is put back for the tests after this one.
      yield* Testing.addLedger(moved, "NGN", 2, "NG")

      const plane = yield* server({ ledger })

      const { retried, later } = yield* Effect.gen(function* () {
        yield* Testing.makeCountryDefault(moved)

        const retried = yield* opened(plane, existing.authorization, existing.id)
        const later = yield* withBusiness(plane)

        return { retried, later: yield* opened(plane, later.authorization, later.id) }
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
      const { authorization, id } = yield* withBusiness(plane)

      const responses = yield* Effect.all(
        Array.from({ length: 8 }, () => opened(plane, authorization, id)),
        { concurrency: "unbounded" },
      )

      assert.ok(responses.every(({ body }) => body.status === "active"))
      assert.equal(new Set(responses.map(({ json }) => JSON.stringify(json))).size, 1)
      assert.deepEqual((yield* me(plane, authorization)).body.business, responses[0]?.body)
    }),
  ))

void test("another principal's or an unknown business is not found, before the ledger is asked", () =>
  run(
    Effect.gen(function* () {
      const plane = yield* server()
      const owner = yield* withBusiness(plane)
      const other = yield* withBusiness(plane)
      const stranger = yield* exchange(plane, fingerprint())

      const notFound = { message: "No such business.", error: { code: "not_found" } }

      assert.deepEqual(yield* openLedger(plane, other.authorization, owner.id), { status: 404, json: notFound })
      assert.deepEqual(yield* openLedger(plane, stranger.authorization, owner.id), { status: 404, json: notFound })
      assert.deepEqual(yield* openLedger(plane, owner.authorization, `biz_${ulid()}`), { status: 404, json: notFound })
      assert.deepEqual(yield* openLedger(plane, owner.authorization, "not-an-id"), { status: 404, json: notFound })
      assert.equal(plane.ledger.requests.length, 0)
      assert.equal((yield* me(plane, owner.authorization)).body.business?.status, "created")
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

      assert.equal((yield* opened(plane, first.authorization, first.id)).body.ledger?.payable_account_ref, reference)

      const before = (yield* stored(second.sub)).business

      assert.deepEqual(yield* openLedger(plane, second.authorization, second.id), {
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
        const { sub, authorization, id } = yield* withBusiness(plane)

        const response = yield* openLedger(plane, authorization, id)
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
        const { authorization, id } = yield* withBusiness(plane)

        yield* openLedger(plane, authorization, id)

        const retried = yield* opened(yield* server(), authorization, id)

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
      const principal = decodeJwt(session.accessToken).sub ?? ""

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

      const routes: ReadonlyArray<Pick<Call, "method" | "path" | "body">> = [
        { method: "GET", path: "/me" },
        { method: "POST", path: "/business", body: { name: "Acme Ltd" } },
        { method: "POST", path: ledgerPath(`biz_${ulid()}`) },
      ]

      for (const route of routes) {
        for (const [reason, token] of Object.entries(rejected)) {
          const response = yield* send(plane, { ...route, authorization: `Bearer ${token}` })

          assert.deepEqual(response, { status: 401, json: unauthorized }, `${route.path}: ${reason}`)
        }

        for (const header of [undefined, "", "Bearer", `Basic ${session.accessToken}`]) {
          const response = yield* send(plane, { ...route, authorization: header })

          assert.deepEqual(response, { status: 401, json: unauthorized }, `${route.path}: authorization: ${header}`)
        }
      }

      // None of the rejected creates went through for the real principal.
      assert.equal((yield* me(plane, authorization)).body.business, null)
    }),
  ))
