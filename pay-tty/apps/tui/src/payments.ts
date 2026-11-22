import type { PaymentDetailEncoded, PaymentPageEncoded, PaymentSummaryEncoded } from "@pay-tty/plane-client"
import { DateTime } from "effect"
import stringWidth from "string-width"

import { formatMoney } from "./money.ts"
import { cell, formatTime, narrowRow, oneLine } from "./payment-link.ts"

export type Payment = PaymentSummaryEncoded

export type Page = PaymentPageEncoded

export type Detail = PaymentDetailEncoded

export type Event = Detail["timeline"][number]

/** Its status until it succeeds, then how its ledger posting stands. */
export type State = Payment["state"]

export interface Filter {
  readonly linkId: string | null
  readonly state: State | null
}

export const filters: ReadonlyArray<State | null> = [
  null, "settled", "settling", "pending", "failed", "cancelled", "expired", "attention",
]

export const filterLabel = (state: State | null) =>
  state === null ? "All" : state[0]?.toUpperCase() + state.slice(1)

/** Every filter with the chosen one bracketed, or the chosen one alone when they don't fit. */
export const filterLine = (state: State | null, width: number) => {
  const all = "← " + filters.map((each) => each === state ? "[" + filterLabel(each) + "]" : filterLabel(each)).join(" · ") + " →"

  return stringWidth(all) <= width ? all : "← " + filterLabel(state) + " →"
}

const shortState: Readonly<Record<State, string>> = {
  settled: "setl", settling: "stlg", attention: "attn", pending: "pend", failed: "fail", cancelled: "cncl", expired: "exp",
}

const initialState: Readonly<Record<State, string>> = {
  settled: "S", settling: "~", attention: "!", pending: "P", failed: "F", cancelled: "C", expired: "X",
}

/** The time relevant to the payment's effective status, including unswept expiry. */
export const paymentTiming = (payment: Payment) => {
  if (payment.status === "pending") {
    return "Expires at: " + formatTime(payment.expires_at)
  }

  if (payment.status === "expired") {
    return "Expired at: " + formatTime(payment.expires_at)
  }

  return payment.completed_at === null ? "Completed" : "Completed: " + formatTime(payment.completed_at)
}

/** Format a page together so its times, states and right-aligned amounts share columns. */
export const paymentRows = (
  payments: ReadonlyArray<Payment>,
  width: number,
  linked: boolean,
  today = DateTime.formatIsoDate(DateTime.nowUnsafe()),
): ReadonlyArray<string> => {
  const narrow = width < narrowRow
  const dated = payments.some((payment) => payment.created_at.slice(0, 10) !== today)
  let timeWidth = dated ? (narrow ? 11 : 16) : 5
  let statusWidth = narrow ? (dated ? 1 : 4) : 9
  const gap = narrow ? " " : "  "

  const amounts = payments.map((payment) =>
    formatMoney(BigInt(payment.amount), payment.scale, payment.currency_code),
  )

  const amountWidth = amounts.reduce((widest, amount) => Math.max(widest, stringWidth(amount)), 0)
  let initial = narrow && dated

  // Money keeps every digit. Compact the timestamp, then omit it before shortening status.
  if (dated && timeWidth + statusWidth + amountWidth + gap.length * 2 > width) {
    timeWidth = 5
  }

  if (timeWidth + statusWidth + amountWidth + gap.length * 2 > width) {
    timeWidth = 0
  }

  if (statusWidth + amountWidth + gap.length > width) {
    statusWidth = 1
    initial = true
  }

  const baseWidth = amountWidth +
    (timeWidth === 0 ? 0 : timeWidth + gap.length) +
    statusWidth + gap.length

  // A pending payment's expiry, or when a settling one becomes available.
  const expiryColumns = gap.length + "expires 00:00".length

  const expiryWidth = !narrow &&
    baseWidth + expiryColumns <= width &&
    payments.some((payment) => payment.status === "pending" || payment.settles_at !== null)
    ? expiryColumns
    : 0

  const titleWidth = narrow || linked ? 0 : Math.max(0, width - baseWidth - expiryWidth - gap.length)

  return payments.map((payment, index) => {
    const clock = payment.created_at.slice(11, 16)
    const date = narrow ? payment.created_at.slice(5, 10) : payment.created_at.slice(0, 10)
    // Five columns retain each row's scale: today's clock or an older date.
    const compact = payment.created_at.slice(0, 10) === today ? clock : payment.created_at.slice(5, 10)
    const at = timeWidth === 5 ? compact : date + " " + clock

    const status = initial
      ? initialState[payment.state]
      : narrow ? shortState[payment.state] : payment.state

    const columns: Array<string> = []

    if (timeWidth > 0) {
      columns.push(cell(at, timeWidth))
    }

    columns.push(cell(status, statusWidth))
    columns.push(cell(amounts[index] ?? "", amountWidth, "end"))

    if (titleWidth > 0) {
      columns.push(cell(oneLine(payment.source.title), titleWidth))
    }

    const row = columns.join(gap)

    const due = expiryWidth === 0
      ? null
      : payment.status === "pending"
        ? "expires " + payment.expires_at.slice(11, 16)
        : payment.settles_at === null ? null : "avail. " + availableAt(payment.settles_at, today)

    return cell(due === null ? row : row + gap + due, width)
  })
}

const clock = (iso: string) => iso.slice(11, 16)

// `~14:07` on `today`, else the date, `10-23`: settlement lands just after its time.
const availableAt = (iso: string, today: string) =>
  iso.slice(0, 10) === today ? "~" + clock(iso) : iso.slice(5, 10)

/** A demo's settlement delay, e.g. `5 s` or `5 min`. */
export const delayLabel = (seconds: number) =>
  seconds < 120 ? `${seconds} s` : seconds < 7200 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds / 3600)} h`

/**
 * One line per event, e.g. `Paid ₦25,000.00 · 14:02` then `Settled · 14:02 · jrn_…`.
 * A refusal is ours to resolve, so the merchant sees it as under review, not its code.
 */
export const timelineLines = (detail: Detail): ReadonlyArray<string> => [
  ...detail.timeline.flatMap((event) => {
    switch (event.kind) {
      case "paid":
        return [`Paid ${formatMoney(BigInt(detail.payment.amount), detail.payment.scale, detail.payment.currency_code)} · ${clock(event.at)}`]
      case "settled":
        return [`Settled · ${clock(event.at)} · ${event.journal_ref}`]
      case "refused":
        return []
    }
  }),
  ...(detail.payment.settles_at === null ? [] : [`Available from ~${formatTime(detail.payment.settles_at)}`]),
  // A person is looking at it, which the merchant can't speed up.
  ...(detail.payment.state === "attention" ? ["Under review · no action needed"] : []),
]
