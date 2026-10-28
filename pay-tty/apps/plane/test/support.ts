import { LedgerClient } from "@pay-tty/core/ledger"
import { CreatePayableAccountRequestJson, PostJournalEntryRequestJson } from "@pay-tty/ledger-client"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { ulid } from "ulid"

import { Token } from "../src/token/token.ts"

export const secret = () => crypto.getRandomValues(new Uint8Array(32))

// Signing moved from "previous" to "current"; "previous" still verifies
// within the overlap. A token under any other key id is rejected.
export const current = new Token.Key({ id: "current", secret: secret() })

export const previous = new Token.Key({ id: "previous", secret: secret() })

export const keys = new Token.Keys({ signing: current, verifying: [previous, current] })

export type Payload = CreatePayableAccountRequestJson

// What the ledger does with a create request. The ledger is a separate
// service, so it's the one thing these tests fake, at the HTTP boundary:
// the generated client and its decoding still run.
export type Reply =
  | { readonly status: number; readonly body: object }
  // Sent as is with a JSON content type, for answers that aren't JSON at all.
  | { readonly status: number; readonly raw: string }
  | "unreachable"

export const created = (payload: Payload): Reply => ({
  status: 201,
  body: {
    holder_reference: `hld_${ulid()}`,
    reference: `acct_${ulid()}`,
    ledger_slug: payload.ledger,
    external_id: payload.external_id,
    name: payload.name,
    kind: "payable",
    status: "open",
    closed_at: null,
    available: 0,
    balances: { debits_pending: 0, credits_pending: 0, debits_posted: 0, credits_posted: 0 },
    created_at: "2026-01-01T00:00:00Z",
  },
})

// Like the ledger: a repeat for the same business and ledger gets the account
// created first. It outlives any local transaction, as the real one does.
export const remembering = () => {
  const accounts = new Map<string, Reply>()

  return (payload: Payload): Reply => {
    const key = `${payload.ledger}:${payload.external_id}`
    const reply = accounts.get(key) ?? created(payload)

    accounts.set(key, reply)

    return reply
  }
}

export const failing = (status: number, code: string): Reply => ({
  status,
  body: { message: "The ledger could not complete the request.", error: { code } },
})

// A 400 the ledger's contract allows, so the client decodes it.
export const invalid: Reply = {
  status: 400,
  body: {
    message: "Request validation failed.",
    error: {
      code: "validation_error",
      details: [{ location: "body", field: "name", code: "invalid_value", message: "name is invalid" }],
    },
  },
}

/** A journal entry posted under its idempotency key. */
export interface Entry {
  readonly key: string
  readonly payload: PostJournalEntryRequestJson
}

// Like the ledger: a repeat of a key gets the entry it first posted, with 200.
export const posting = () => {
  const posted = new Map<string, { readonly body: object }>()

  return ({ key, payload }: Entry): Reply => {
    const first = posted.get(key)

    if (first !== undefined) {
      return { status: 200, body: first.body }
    }

    const body = {
      journal_ref: `jrn_${ulid()}`,
      ledger_slug: payload.ledger,
      kind: payload.kind,
      state: "posted",
      description: payload.description,
      effective_at: payload.effective_at ?? "2026-01-01T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
    }

    posted.set(key, { body })

    return { status: 201, body }
  }
}

const respond = (request: HttpClientRequest.HttpClientRequest, answer: Reply) =>
  answer === "unreachable"
    ? Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description: "connection refused" }),
      }),
    )
    : Effect.succeed(HttpClientResponse.fromWeb(
      request,
      "raw" in answer
        ? new Response(answer.raw, { status: answer.status, headers: { "content-type": "application/json" } })
        : Response.json(answer.body, { status: answer.status }),
    ))

const isAccount = Schema.is(Schema.Struct({ reference: Schema.String }))

/** A statement read: the account and every query parameter sent. */
export interface StatementRead {
  readonly accountRef: string
  readonly query: Readonly<Record<string, string>>
}

// What the ledger serves for a statement of this account, from these lines
// taken into it, oldest first.
export const statementOf = (
  read: StatementRead,
  lines: ReadonlyArray<{
    readonly journalRef: string
    readonly lineNumber: number
    readonly line: PostJournalEntryRequestJson["lines"][number]
  }>,
): Reply => {
  let balance = 0

  const movements = lines.flatMap(({ journalRef, lineNumber, line }) => {
    const direction = line.credit_account_ref === read.accountRef
      ? "credit"
      : line.debit_account_ref === read.accountRef ? "debit" : undefined

    if (direction === undefined) {
      return []
    }

    balance += direction === "credit" ? line.amount : -line.amount

    return [{
      journal_reference: journalRef,
      line_number: lineNumber,
      kind: "payment",
      direction,
      amount: line.amount,
      balance_after: balance,
      description: "Payment received",
      purpose: line.purpose,
      recorded_at: "2026-10-09T09:15:00Z",
    }]
  })

  return {
    status: 200,
    body: {
      account: { reference: read.accountRef, holder_reference: `hld_${ulid()}`, name: "Acme Ltd" },
      period: { from: read.query["from"] ?? "2026-09-28T10:00:00Z", to: "2026-10-28T09:59:00Z" },
      opening_balance: 0,
      closing_balance: balance,
      entries: read.query["order"] === "desc" ? movements.reverse() : movements,
      page: { limit: 50, previous_cursor: null, next_cursor: null },
    },
  }
}

export interface FakeLedger {
  // Payable account creations, and what the ledger answered each.
  readonly requests: ReadonlyArray<Payload>
  readonly replies: ReadonlyArray<Reply>
  readonly entries: ReadonlyArray<Entry>
  // The account refs read, in order.
  readonly reads: ReadonlyArray<string>
  readonly statements: ReadonlyArray<StatementRead>
  readonly layer: Layer.Layer<LedgerClient.Service>
}

export const fakeLedger = (
  reply: (payload: Payload) => Reply = remembering(),
  post: (entry: Entry) => Reply = posting(),
  // Left out, an account read answers with the account as created, its
  // posted credits and debits summed from the entries the ledger took.
  read?: (accountRef: string) => Reply,
  // Left out, a statement lists the account's lines from the entries taken.
  statement?: (read: StatementRead) => Reply,
): FakeLedger => {
  const requests: Array<Payload> = []
  const replies: Array<Reply> = []
  const entries: Array<Entry> = []
  const taken: Array<Entry> = []
  const reads: Array<string> = []
  const statements: Array<StatementRead> = []
  const journals = new Map<Entry, string>()

  // Accounts the ledger created, by ref, as it answered.
  const opened = new Map<string, object>()

  const held = (accountRef: string): Reply => {
    const account = opened.get(accountRef)

    if (account === undefined) {
      return failing(404, "account_not_found")
    }

    const lines = taken.flatMap((entry) => entry.payload.lines)

    const sum = (side: "debit_account_ref" | "credit_account_ref") =>
      lines.filter((line) => line[side] === accountRef).reduce((total, line) => total + line.amount, 0)

    const credits = sum("credit_account_ref")
    const debits = sum("debit_account_ref")

    return {
      status: 200,
      body: {
        ...account,
        available: credits - debits,
        balances: { debits_pending: 0, credits_pending: 0, debits_posted: debits, credits_posted: credits },
      },
    }
  }

  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* Effect.orDie(HttpClientRequest.toWeb(request))
      const path = new URL(web.url).pathname

      if (web.method === "GET" && path.startsWith("/accounts/") && path.endsWith("/statement")) {
        const statementRead = {
          accountRef: decodeURIComponent(path.slice("/accounts/".length, -"/statement".length)),
          query: Object.fromEntries(new URL(web.url).searchParams),
        }

        statements.push(statementRead)

        const listed = taken.flatMap((entry) =>
          entry.payload.lines.map((line, index) => ({ journalRef: journals.get(entry) ?? "", lineNumber: index + 1, line })))

        return yield* respond(request, (statement ?? ((read) => statementOf(read, listed)))(statementRead))
      }

      if (web.method === "GET" && path.startsWith("/accounts/")) {
        const accountRef = decodeURIComponent(path.slice("/accounts/".length))

        reads.push(accountRef)

        return yield* respond(request, (read ?? held)(accountRef))
      }

      const body = yield* Effect.promise(() => web.json())
      let answer: Reply

      if (path === "/entries") {
        const entry = {
          key: web.headers.get("idempotency-key") ?? "",
          payload: yield* Effect.orDie(Schema.decodeUnknownEffect(PostJournalEntryRequestJson)(body)),
        }

        answer = post(entry)

        entries.push(entry)

        if (answer !== "unreachable" && answer.status === 201) {
          taken.push(entry)

          if ("body" in answer && Schema.is(Schema.Struct({ journal_ref: Schema.String }))(answer.body)) {
            journals.set(entry, answer.body.journal_ref)
          }
        }
      } else {
        const payload = yield* Effect.orDie(Schema.decodeUnknownEffect(CreatePayableAccountRequestJson)(body))

        answer = reply(payload)

        requests.push(payload)

        replies.push(answer)

        if (answer !== "unreachable" && "body" in answer && isAccount(answer.body)) {
          opened.set(answer.body.reference, answer.body)
        }
      }

      return yield* respond(request, answer)
    }),
  )

  return {
    requests,
    replies,
    entries,
    reads,
    statements,
    // Configured here, so the tests need no LEDGER_BASE_URL.
    layer: LedgerClient.layer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ LEDGER_BASE_URL: "http://ledger.test" }))),
      Layer.orDie,
    ),
  }
}
