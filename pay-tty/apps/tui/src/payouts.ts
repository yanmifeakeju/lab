import type {
  BusinessBalanceEncoded,
  PayoutBankEncoded,
  PayoutDestinationEncoded,
  PayoutEncoded,
  PayoutPageEncoded,
  PayoutSettingsEncoded,
  PayoutSettingsRequestEncoded,
} from "@pay-tty/plane-client"
import { Result } from "effect"
import stringWidth from "string-width"

import { formatMoney, Parsed, parseAmount } from "./money.ts"
import { cell, formatTime, oneLine } from "./payment-link.ts"

export type Payout = PayoutEncoded

export type Page = PayoutPageEncoded

export type Settings = PayoutSettingsEncoded

export type Bank = PayoutBankEncoded

export type Status = Payout["status"]

/**
 * Can still change without the merchant, so its screen follows it: plane moves
 * it on, or one needing attention is rejected by a late refusal or resolved by
 * support.
 */
export const moving = (status: Status) =>
  status === "requested" || status === "held" || status === "sent" || status === "attention"

/** `Available ₦X · Incoming ₦Y · On hold ₦Z`, leaving out the pending figures at zero. */
export const balanceSummary = (figures: BusinessBalanceEncoded) => {
  const money = (minor: string) => formatMoney(BigInt(minor), figures.scale, figures.currency)

  return [
    `Available ${money(figures.available)}`,
    ...(BigInt(figures.incoming) === 0n ? [] : [`Incoming ${money(figures.incoming)}`]),
    ...(BigInt(figures.held) === 0n ? [] : [`On hold ${money(figures.held)}`]),
  ].join(" · ")
}

/** `GTBank ••••6789`. */
export const destinationLabel = (destination: PayoutDestinationEncoded) =>
  `${destination.bank_name} ••••${destination.account_number.slice(-4)}`

/** `Automatic · daily at 00:00 UTC · GTBank ••••6789`, or how to set one up. */
export const settingsLine = (settings: Settings) => {
  const mode = settings.mode === "automatic" ? "Automatic · daily at 00:00 UTC" : "Manual"

  return settings.destination === null ? `${mode} · no payout account` : `${mode} · ${destinationLabel(settings.destination)}`
}

const statusText: Readonly<Record<Status, string>> = {
  created: "created",
  requested: "requested",
  held: "on hold",
  sent: "sent",
  paid: "paid",
  failed: "failed",
  rejected: "rejected",
  cancelled: "cancelled",
  expired: "expired",
  attention: "attention",
}

// A payout under review is marked; the mark is short so the dates keep their
// room. Payouts paused by a payment show no mark here: the payment says so.
const rowStatus = (payout: Payout) => `${statusText[payout.status]}${payout.under_review ? " !" : ""}`

/**
 * Drawn as errors: refused, failed or waiting on a person. Being under review
 * isn't: it needs nothing from the merchant.
 */
export const troubled = (payout: Payout) =>
  payout.status === "rejected" || payout.status === "failed" || payout.status === "attention"

/** The key to the list's mark, when a listed payout carries it. */
export const reviewKey = (payouts: ReadonlyArray<Payout>) =>
  payouts.some((payout) => payout.under_review) ? "! under review · no action needed" : null

/** Each payout's date, status and amount, the amounts right-aligned in one column. */
export const payoutRows = (payouts: ReadonlyArray<Payout>, width: number): ReadonlyArray<string> => {
  const amounts = payouts.map((payout) => formatMoney(BigInt(payout.amount), payout.scale, payout.currency))
  const amountWidth = amounts.reduce((widest, amount) => Math.max(widest, stringWidth(amount)), 0)
  const statuses = payouts.map(rowStatus)
  const statusWidth = Math.max(...Object.values(statusText).map((text) => text.length), ...statuses.map((text) => text.length))
  const dated = 16 + 2 + statusWidth + 2 + amountWidth <= width

  return payouts.map((payout, index) =>
    cell(
      [
        ...(dated ? [cell(`${payout.created_at.slice(0, 10)} ${payout.created_at.slice(11, 16)}`, 16)] : []),
        cell(statuses[index] ?? "", statusWidth),
        cell(amounts[index] ?? "", amountWidth, "end"),
      ].join("  "),
      width,
    ))
}


/** Where the payout stands, in a line the screen refreshes as it moves. */
export const statusLine = (payout: Payout) => {
  switch (payout.status) {
    case "created":
      return payout.expires_at === null
        ? "Not confirmed · nothing moves until it is"
        : `Not confirmed · nothing moves until it is, and it expires at ${expiryTime(payout.expires_at)}`
    case "requested":
      return "Requested · setting the money aside…"
    case "held":
      return "On hold · the money is set aside for this payout"
    case "sent":
      return `Sent to ${destinationLabel(payout.destination)} · waiting for the bank…`
    case "paid":
      return `Paid to ${destinationLabel(payout.destination)}`
    case "failed":
      // Under review the hold may not have been released, so the balance isn't promised.
      return payout.under_review
        ? "Failed · the bank didn't take it"
        : "Failed · the bank didn't take it, so the money is going back to your balance"
    case "rejected":
      return `Rejected: ${payout.reason === "insufficient_funds" ? "insufficient funds" : "it couldn't be processed"}`
    case "cancelled":
      return "Cancelled · nothing was paid"
    case "expired":
      return "Expired · it wasn't confirmed in time, so nothing was paid"
    case "attention":
      return "Needs attention · support will resolve it"
  }
}

// What the completion time is called, by how the payout ended.
const completedAs: Readonly<Record<Status, string>> = {
  created: "Completed",
  requested: "Completed",
  held: "Completed",
  sent: "Completed",
  paid: "Paid",
  failed: "Failed",
  rejected: "Rejected",
  cancelled: "Cancelled",
  expired: "Expired",
  attention: "Completed",
}

/** A draft's expiry, to the second: it lives for ninety. */
export const expiryTime = (iso: string) => `${iso.slice(11, 19)} UTC`

/** What a payout pays and where to, as its confirmation and detail show them. */
export const amountLine = (payout: Payout) => formatMoney(BigInt(payout.amount), payout.scale, payout.currency)

export const destinationLine = (payout: Payout) =>
  `To ${destinationLabel(payout.destination)} · ${oneLine(payout.destination.account_name)}`

export const detailLines = (payout: Payout): ReadonlyArray<string> => [
  amountLine(payout),
  destinationLine(payout),
  `Created: ${formatTime(payout.created_at)}`,
  ...(payout.sent_at === null ? [] : [`Sent: ${formatTime(payout.sent_at)}`]),
  ...(payout.completed_at === null ? [] : [`${completedAs[payout.status]}: ${formatTime(payout.completed_at)}`]),
  ...(payout.under_review ? ["Under review · no action needed"] : []),
]

export type Field = "mode" | "bank" | "accountNumber"

export interface Form {
  readonly mode: Settings["mode"]
  /** An index into the banks; null until one is chosen. */
  readonly bank: number | null
  readonly accountNumber: string
}

const nonNegative = (index: number) => (index < 0 ? null : index)

/** The saved settings as a form. */
export const formOf = (settings: Settings, banks: ReadonlyArray<Bank>): Form => {
  const saved = settings.destination

  return {
    mode: settings.mode,
    // Never a bank the merchant didn't pick: none until they do, and a saved
    // one that's no longer listed is chosen again.
    bank: saved === null ? null : nonNegative(banks.findIndex((bank) => bank.code === saved.bank_code)),
    accountNumber: saved?.account_number ?? "",
  }
}

/** The request a form makes, or why it can't: every save names the account payouts go to. */
export const toSettingsRequest = (form: Form, banks: ReadonlyArray<Bank>): Result.Result<PayoutSettingsRequestEncoded, string> => {
  const number = form.accountNumber.trim()
  const bank = form.bank === null ? undefined : banks[form.bank]

  if (bank === undefined) {
    return Result.fail("Choose a bank.")
  }

  if (!/^\d{10}$/.test(number)) {
    return Result.fail("Enter the 10-digit account number.")
  }

  return Result.succeed({ mode: form.mode, destination: { bank_code: bank.code, account_number: number } })
}

/** The amount typed, in minor units, or why it isn't one plane would take. */
export const toAmount = (text: string, scale: number, currency: string, minimum: number): Result.Result<number, string> => {
  const parsed = parseAmount(text, scale)

  return Parsed.$match(parsed, {
    Blank: () => Result.fail("Enter the amount to pay out."),
    Invalid: ({ reason }) => Result.fail(reason),
    Amount: ({ minor }) =>
      minor < minimum
        ? Result.fail(`A payout must be at least ${formatMoney(minimum, scale, currency)}.`)
        : Result.succeed(minor),
  })
}
