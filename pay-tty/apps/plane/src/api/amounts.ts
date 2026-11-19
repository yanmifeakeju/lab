import { Common } from "@pay-tty/core/common"
import { Schema } from "effect"

export const inLedgerMinorUnits = { description: "In minor units of the ledger's currency." }

/**
 * A positive amount in minor units, as a JSON number: every amount is a safe
 * integer, so none loses precision on the way. `unit` says whose currency.
 */
export const amountIn = (unit: { readonly description: string }) =>
  Schema.Int.check(
    Schema.isGreaterThan(0).annotate({ expected: "a positive integer" }),
    Schema.isLessThanOrEqualTo(Number(Common.maxAmount)).annotate({ expected: "a safe integer" }),
  ).annotate(unit)

export const LedgerAmount = amountIn(inLedgerMinorUnits)
