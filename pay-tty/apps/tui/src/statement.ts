import type { BusinessGetStatementParams, BusinessStatementEncoded, StatementMovementEncoded } from "@pay-tty/plane-client"
import stringWidth from "string-width"

import { formatMoney } from "./money.ts"
import { cell, narrowRow, oneLine } from "./payment-link.ts"

export type Statement = BusinessStatementEncoded

export type Movement = StatementMovementEncoded

export type Period = NonNullable<BusinessGetStatementParams["period"]>

export const periods: ReadonlyArray<Period> = ["today", "7d", "30d", "90d"]

export const defaultPeriod: Period = "30d"

const labels: Readonly<Record<Period, readonly [long: string, short: string]>> = {
  today: ["Today", "Today"],
  "7d": ["7 days", "7d"],
  "30d": ["30 days", "30d"],
  "90d": ["90 days", "90d"],
}

const fits = (width: number) => (line: string) => stringWidth(line) <= width

/** The period tabs with the chosen one bracketed, shortened to fit the width. */
export const periodLine = (period: Period, width: number) => {
  const tabs = (short: boolean) =>
    periods.map((each) => {
      const label = labels[each][short ? 1 : 0]

      return each === period ? `[${label}]` : label
    }).join(" · ")

  const lines = [`Statement   ${tabs(false)}`, `Statement   ${tabs(true)}`, tabs(true)]

  return lines.find(fits(width)) ?? cell(tabs(true), width)
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** An ISO time's UTC date, e.g. `9 Oct`. */
export const formatDay = (iso: string) => `${Number(iso.slice(8, 10))} ${months[Number(iso.slice(5, 7)) - 1] ?? ""}`

// A balance can in principle go below zero, which formatMoney doesn't take.
const balance = (minor: string, statement: Statement) => {
  const amount = BigInt(minor)
  const shown = formatMoney(amount < 0n ? -amount : amount, statement.scale, statement.currency)

  return amount < 0n ? `−${shown}` : shown
}

/** The period's dates and the balances either side, e.g. `28 Sep – 28 Oct   Opening ₦0.00  →  Closing ₦7,500.00`. */
export const balanceLine = (statement: Statement, width: number) => {
  const from = formatDay(statement.period.from)
  const to = formatDay(statement.period.to)
  const dates = from === to ? from : `${from} – ${to}`
  const opening = balance(statement.opening, statement)
  const closing = balance(statement.closing, statement)

  const lines = [
    `${dates}   Opening ${opening}  →  Closing ${closing}`,
    `Opening ${opening} → Closing ${closing}`,
    `Open ${opening} → Close ${closing}`,
    `${opening} → ${closing}`,
  ]

  return lines.find(fits(width)) ?? cell(`${opening} → ${closing}`, width)
}

/** What identifies a row: one entry can touch the account on two lines. */
export const movementId = (movement: Movement) => `statement-row-${movement.journal_ref}-${movement.line_number}`

// Narrower than this, the description would say too little to keep beside the balance.
const descriptionMinimum = 12

/**
 * A page as rows sharing columns: date, description, signed amount and balance
 * after, both amounts right-aligned. The description gives way first, then the
 * balance column goes.
 */
export const statementRows = (statement: Statement, width: number): ReadonlyArray<string> => {
  const gap = width < narrowRow ? " " : "  "
  const widest = (texts: ReadonlyArray<string>) => texts.reduce((most, text) => Math.max(most, stringWidth(text)), 0)

  const dates = statement.movements.map((movement) => formatDay(movement.recorded_at))

  const amounts = statement.movements.map((movement) =>
    (movement.direction === "credit" ? "+" : "−") +
    formatMoney(BigInt(movement.amount), statement.scale, statement.currency))

  const balances = statement.movements.map((movement) => balance(movement.balance_after, statement))

  const dateWidth = widest(dates)
  const amountWidth = widest(amounts)
  const balanceWidth = widest(balances)
  const fixed = dateWidth + gap.length * 2 + amountWidth
  const balanced = width - fixed - gap.length - balanceWidth >= descriptionMinimum
  const descriptionWidth = Math.max(0, width - fixed - (balanced ? gap.length + balanceWidth : 0))

  return statement.movements.map((movement, index) => {
    const columns = [cell(dates[index] ?? "", dateWidth)]

    if (descriptionWidth > 0) {
      columns.push(cell(oneLine(movement.description), descriptionWidth))
    }

    columns.push(cell(amounts[index] ?? "", amountWidth, "end"))

    if (balanced) {
      columns.push(cell(balances[index] ?? "", balanceWidth, "end"))
    }

    return cell(columns.join(gap), width)
  })
}

/** The keys the screen takes, leaving out a page key with nowhere to go. */
export const statementHints = (statement: Statement, narrow: boolean) => {
  const paging = statement.next !== null && statement.previous !== null
    ? "n/p"
    : statement.next !== null ? "n" : statement.previous !== null ? "p" : null

  const hints = narrow
    ? ["↑/↓", "←/→", paging, "r", "Esc"]
    : ["↑/↓", "←/→ period", paging === null ? null : `${paging} page`, "r refresh", "Esc back"]

  return hints.filter((hint) => hint !== null).join(" · ")
}
