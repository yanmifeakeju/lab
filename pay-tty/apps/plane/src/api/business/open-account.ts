import { Business } from "@pay-tty/core/business"
import { Database } from "@pay-tty/core/database"
import { PayableAccounts } from "@pay-tty/core/ledger"
import { Effect, Schema } from "effect"

/** The business's recorded state rules the request out. */
export class ConflictError extends Schema.TaggedError<ConflictError>()(
  "OpenAccount.ConflictError",
  { reason: Schema.String },
) {}

/**
 * Opens the business's payable account in the primary ledger saved when it
 * was created, records it, and activates the business. Repeating it returns
 * the business as it is; a failure leaves it created, with nothing recorded.
 */
export const openAccount = Effect.fn("openAccount")(
  function* (business: Business.Info) {
    const businesses = yield* Business.Service

    if (business.status === "active") {
      return business
    }

    // Recorded before an interruption: finish without asking the ledger.
    if (business.primaryLedger.payableAccountRef !== null) {
      return yield* businesses.activate(business.id)
    }

    const accounts = yield* PayableAccounts.Service
    const database = yield* Database

    // Saved at creation, so a retry asks for the same account even if the
    // country's default has moved since.
    const ledger = business.primaryLedger.slug

    const account = yield* accounts.open({ ledger, externalId: business.id, name: business.name }).pipe(
      Effect.annotateLogs({ businessId: business.id }),
    )

    // Opened only once the ledger has answered, so no transaction waits on
    // it. The holder, account, and activation commit together.
    return yield* database
      .transaction(
        Effect.gen(function* () {
          yield* businesses.recordPayableAccount(
            business.id,
            ledger,
            new Business.PayableAccount({ holderRef: account.holderRef, accountRef: account.accountRef }),
          )

          return yield* businesses.activate(business.id)
        }),
      )
      .pipe(
        Effect.catchTag("Business.ConflictError", (conflict) => new ConflictError({ reason: conflict.message })),
      )
  },
  // A business is never deleted, so a missing one is a bug.
  Effect.catchTag("Business.NotFoundError", Effect.die),
)
