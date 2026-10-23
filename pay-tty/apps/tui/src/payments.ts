import type { PaymentPageEncoded, PaymentSummaryEncoded } from "@pay-tty/plane-client"
import { DateTime } from "effect"
import stringWidth from "string-width"

import { formatMoney } from "./money.ts"
import { cell, formatTime, narrowRow, oneLine } from "./payment-link.ts"

export type Payment = PaymentSummaryEncoded

export type Page = PaymentPageEncoded

export type Status = Payment["status"]

export interface Filter {
  readonly linkId: string | null
  readonly status: Status | null
}

export const filters: ReadonlyArray<Status | null> = [null, "succeeded", "pending", "failed", "cancelled", "expired"]

export const filterLabel = (status: Status | null) =>
  status === null ? "All" : status[0]?.toUpperCase() + status.slice(1)

const shortStatus: Readonly<Record<Status, string>> = {
  succeeded: "paid", pending: "pend", failed: "fail", cancelled: "cncl", expired: "exp",
}

const initialStatus: Readonly<Record<Status, string>> = {
  succeeded: "S", pending: "P", failed: "F", cancelled: "C", expired: "X",
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

/** Format a page together so its times, statuses and right-aligned amounts share columns. */
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
    formatMoney(BigInt(payment.amount_minor), payment.scale, payment.currency_code),
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
      ? initialStatus[payment.status]
      : narrow ? shortStatus[payment.status] : payment.status

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
