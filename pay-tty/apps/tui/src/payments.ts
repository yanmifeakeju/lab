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

  const expiryColumns = gap.length + "expires 00:00".length

  const expiryWidth = !narrow &&
    baseWidth + expiryColumns <= width &&
    payments.some((payment) => payment.status === "pending")
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

    return cell(
      payment.status === "pending" && expiryWidth > 0
        ? row + gap + "expires " + payment.expires_at.slice(11, 16)
        : row,
      width,
    )
  })
}

const clock = (iso: string) => iso.slice(11, 16)

/** One line per event, e.g. `Paid ₦25,000.00 · 14:02` then `Settled · 14:02 · jrn_…`. */
export const timelineLines = (detail: Detail): ReadonlyArray<string> =>
  detail.timeline.map((event) => {
    switch (event.kind) {
      case "paid":
        return `Paid ${formatMoney(BigInt(detail.payment.amount), detail.payment.scale, detail.payment.currency_code)} · ${clock(event.at)}`
      case "settled":
        return `Settled · ${clock(event.at)} · ${event.journal_ref}`
      case "refused":
        return `Ledger refused: ${event.error_code}`
    }
  })
