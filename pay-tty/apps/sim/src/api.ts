// The sim's published API, as a real provider publishes its docs: its paths,
// its request and answer shapes, the callback it sends, and how calls are
// authorized and callbacks signed. Amounts travel as decimal text, never as a
// float.

import { Schema } from "effect"

export { Signature } from "./signature.ts"

export const sendPath = "/payouts"

/** The lookup route, as the sim serves it. */
export const lookupRoute = `${sendPath}/:reference`

export const lookupPath = (reference: string) => `${sendPath}/${encodeURIComponent(reference)}`

export const SendRequest = Schema.Struct({
  reference: Schema.String.check(Schema.isPattern(/^\S{1,255}$/)),
  ledger: Schema.String.check(Schema.isPattern(/\S/)),
  currency: Schema.String,
  amount: Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,15}$/)),
  destination: Schema.Struct({
    bankCode: Schema.String.check(Schema.isPattern(/^[0-9]{3}$/)),
    accountNumber: Schema.String.check(Schema.isPattern(/^[0-9]{10}$/)),
    accountName: Schema.String.check(Schema.isPattern(/\S/)),
  }),
})

/** The sim's reference for a payout: never blank. */
export const Ref = Schema.String.check(Schema.isPattern(/\S/))

/** A send taken: 201 the first time, 200 on a repeat. */
export const Accepted = Schema.Struct({ reference: Schema.String, providerRef: Ref })

/** A lookup's answer, 200. A final one carries the ref; a pending one may not. */
export const Found = Schema.Union([
  Schema.Struct({ reference: Schema.String, status: Schema.Literal("pending"), providerRef: Schema.optional(Ref) }),
  Schema.Struct({ reference: Schema.String, status: Schema.Literals(["paid", "failed"]), providerRef: Ref }),
])

export const ErrorBody = Schema.Struct({ error: Schema.Struct({ code: Schema.String }) })

export const errors = {
  unauthorized: "unauthorized",
  invalidPayout: "invalid_payout",
  referenceReused: "reference_reused",
  notFound: "not_found",
  internal: "internal_server_error",
} as const

/** A lookup of a reference the sim never took, 404. */
export const NotFound = Schema.Struct({ error: Schema.Struct({ code: Schema.Literal(errors.notFound) }) })

export const Outcome = Schema.Literals(["paid", "failed"])

export const Callback = Schema.Struct({
  reference: Schema.String,
  outcome: Outcome,
  providerRef: Ref,
})

export * as Api from "./api.ts"
