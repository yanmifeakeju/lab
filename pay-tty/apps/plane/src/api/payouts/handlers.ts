import { Business } from "@pay-tty/core/business"
import { Payouts } from "@pay-tty/core/payouts"
import { Effect } from "effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"

import { api } from "../api.ts"
import { accountNotOpened, Conflict, invalidCursor, invalidField, NotFound } from "../errors.ts"
import { CurrentBusiness } from "../middleware/business.ts"
import { bankList, confirmedPayout, createdPayout, payout, payoutPage, payoutSettings } from "./routes.ts"

const unavailable = (error: Payouts.UnavailableError) =>
  new Conflict({
    message: `Payouts aren't available in ${error.currency} yet.`,
    error: { code: "payouts_unavailable" },
  })

// Reading or changing settings fails the same ways.
const settingsErrors = {
  "Payouts.SettingsNotFoundError": () => Effect.fail(accountNotOpened),
  "Payouts.UnavailableError": (error: Payouts.UnavailableError) => Effect.fail(unavailable(error)),
}

const invalidBank = (error: Payouts.BankError) =>
  invalidField("body", "destination.bank_code", `this bank doesn't take payouts in ${error.currency}`)

const invalidAmount = (error: Payouts.AmountError) => invalidField("body", "amount", error.message)

const automatic = new Conflict({
  message: "Payouts are automatic. Switch to manual to request one.",
  error: { code: "payouts_automatic" },
})

const mismatch = "A payout doesn't match the ledger"

const supportCorrects = "Support will correct it before you can request another."

const mismatched = new Conflict({
  message: `${mismatch}. ${supportCorrects}`,
  error: { code: "payout_ledger_mismatch" },
})

const expired = new Conflict({
  message: "This payout wasn't confirmed in time. Request a new one.",
  error: { code: "payout_expired" },
})

// Another business's payout is as unknown as one that doesn't exist.
const notFound = new NotFound({ message: "Payout not found.", error: { code: "not_found" } })

// Every payout route acts on the business's primary ledger, the only one it holds.
const target = (business: Business.Info) => [business.id, business.primaryLedger.slug] as const

export const PayoutsLive = HttpApiBuilder.group(api, "payouts", (handlers) =>
  handlers
    .handle("listBanks", () =>
      Effect.gen(function* () {
        const service = yield* Payouts.Service

        return bankList(yield* service.banks(...target(yield* CurrentBusiness)).pipe(Effect.catchTags(settingsErrors)))
      }))
    .handle("getPayoutSettings", () =>
      Effect.gen(function* () {
        const service = yield* Payouts.Service

        const settings = yield* service.settings(...target(yield* CurrentBusiness)).pipe(Effect.catchTags(settingsErrors))

        return payoutSettings(settings)
      }))
    .handle("changePayoutSettings", ({ payload }) =>
      Effect.gen(function* () {
        const service = yield* Payouts.Service
        const { destination } = payload

        const change = new Payouts.Change({
          mode: payload.mode,
          destination: {
            bankCode: destination.bank_code,
            accountNumber: destination.account_number,
          },
        })

        const settings = yield* service.changeSettings(...target(yield* CurrentBusiness), change).pipe(
          Effect.catchTags({
            ...settingsErrors,
            "Payouts.BankError": (error) => Effect.fail(invalidBank(error)),
          }),
        )

        return payoutSettings(settings)
      }))
    .handle("createPayout", ({ payload }) =>
      Effect.gen(function* () {
        const service = yield* Payouts.Service

        const created = yield* service.create(...target(yield* CurrentBusiness), BigInt(payload.amount)).pipe(
          Effect.tapError((error) => Effect.logInfo("payout not created", error)),
          Effect.catchTags({
            ...settingsErrors,
            "Payouts.AutomaticError": () => Effect.fail(automatic),
            "Payouts.NoPayoutAccountError": () =>
              new Conflict({ message: "Save a payout account first.", error: { code: "no_payout_account" } }),
            "Payouts.LedgerMismatchError": () => Effect.fail(mismatched),
            "Payouts.DraftsFullError": () =>
              new Conflict({
                message: "Too many payouts are waiting to be confirmed. Wait a moment for them to expire, then try again.",
                error: { code: "payout_drafts_full" },
              }),
            "Payouts.AmountError": (error) => Effect.fail(invalidAmount(error)),
          }),
        )

        return createdPayout(created)
      }))
    .handle("confirmPayout", ({ params }) =>
      Effect.gen(function* () {
        const service = yield* Payouts.Service
        const business = yield* CurrentBusiness

        const confirmed = yield* service.confirm(business.id, params.payout_id).pipe(
          Effect.tapError((error) => Effect.logInfo("payout not confirmed", error)),
          Effect.catchTags({
            "Payouts.PayoutNotFoundError": () => Effect.fail(notFound),
            "Payouts.ExpiredError": () => Effect.fail(expired),
            "Payouts.CancelledError": () =>
              new Conflict({ message: "This payout was cancelled. Request a new one.", error: { code: "payout_cancelled" } }),
            "Payouts.AutomaticError": () =>
              new Conflict({
                message: "Payouts are automatic, so this payout was cancelled. Plane pays you out daily.",
                error: { code: "payouts_automatic" },
              }),
            "Payouts.LedgerMismatchError": () =>
              new Conflict({
                message: `${mismatch}, so this payout was cancelled. ${supportCorrects}`,
                error: { code: "payout_ledger_mismatch" },
              }),
            "Payouts.RulesChangedError": () =>
              new Conflict({
                message: "Payout rules changed since this payout was created. Request a new one.",
                error: { code: "payout_rules_changed" },
              }),
          }),
        )

        return confirmedPayout(confirmed)
      }))
    .handle("listPayouts", ({ query }) =>
      Effect.gen(function* () {
        const service = yield* Payouts.Service
        const business = yield* CurrentBusiness

        const page = yield* service.list(business.id, query.before ?? null).pipe(
          Effect.catchTag("Payouts.CursorError", () => invalidCursor("payout")),
        )

        return payoutPage(page)
      }))
    .handle("getPayout", ({ params }) =>
      Effect.gen(function* () {
        const service = yield* Payouts.Service
        const business = yield* CurrentBusiness

        const found = yield* service.get(business.id, params.payout_id).pipe(
          Effect.catchTag("Payouts.PayoutNotFoundError", () => Effect.fail(notFound)),
        )

        return payout(found)
      })))
