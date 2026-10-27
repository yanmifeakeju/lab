import { Business } from "@pay-tty/core/business"
import { PayableAccounts } from "@pay-tty/core/ledger"
import { Effect, Schema } from "effect"

/** The business has no payable account yet, so no balance to read. */
export class NotOpenedError extends Schema.TaggedError<NotOpenedError>()(
  "BusinessBalance.NotOpenedError",
  { id: Business.ID },
) {}

/**
 * The balance of the business's payable account in its primary ledger, as
 * the ledger has it. The only ledger served is the primary one, so callers
 * name the business, not an account.
 */
export const businessBalance = Effect.fn("businessBalance")(function* (business: Business.Info) {
  const { slug, payableAccountRef } = business.primaryLedger

  if (payableAccountRef === null) {
    return yield* new NotOpenedError({ id: business.id })
  }

  const accounts = yield* PayableAccounts.Service

  return yield* accounts.balance({ accountRef: payableAccountRef, ledger: slug }).pipe(
    Effect.annotateLogs({ businessId: business.id }),
  )
})
