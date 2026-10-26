import type {
  CreatePaymentLinkRequestEncoded,
  PaymentLinkEncoded,
  PaymentLinkListEncoded,
  PaymentLinkSummaryEncoded,
  PaymentStatsEncoded,
} from "@pay-tty/plane-client"
import { Result } from "effect"
import stringWidth from "string-width"

import { belowWholeUnit, formatMoney, Parsed, parseAmount } from "./money.ts"

export type Link = PaymentLinkEncoded

export type Request = CreatePaymentLinkRequestEncoded

export type Overview = PaymentLinkListEncoded

export type Summary = PaymentLinkSummaryEncoded

export type Stats = PaymentStatsEncoded

export type Mode = "fixed" | "customer_chooses"

/** What the form holds, as typed. */
export interface Form {
  readonly title: string
  readonly description: string
  readonly mode: Mode
  readonly amount: string
  readonly suggested: string
  readonly minimum: string
  readonly maximum: string
}

export const emptyForm: Form = {
  title: "",
  description: "",
  mode: "fixed",
  amount: "",
  suggested: "",
  minimum: "",
  maximum: "",
}

/** Switching mode clears the settings the other mode had. */
export const withMode = (form: Form, mode: Mode): Form =>
  mode === form.mode ? form : { ...emptyForm, title: form.title, description: form.description, mode }

const optional = (parsed: Parsed) => (Parsed.$is("Amount")(parsed) ? parsed.minor : null)

/**
 * The request the form describes in the business's ledger, or why it can't be
 * sent. Only the chosen mode's settings are read.
 */
export const toRequest = (form: Form, scale: number, currency: string): Result.Result<Request, string> => {
  const title = form.title.trim()
  const description = form.description.trim()

  if (title === "") {
    return Result.fail("Enter a title.")
  }

  if (title.length > 255) {
    return Result.fail("Use a title of at most 255 characters.")
  }

  if (description.length > 500) {
    return Result.fail("Use a description of at most 500 characters.")
  }

  const base = { title, description: description === "" ? null : description }

  if (form.mode === "fixed") {
    return Parsed.$match(parseAmount(form.amount, scale), {
      Blank: () => Result.fail("Enter the amount."),
      Invalid: ({ reason }) => Result.fail(`Amount: ${reason}`),
      Amount: ({ minor }): Result.Result<Request, string> => {
        const below = belowWholeUnit(minor, scale, currency)

        return below === undefined
          ? Result.succeed({ ...base, pricing: { mode: "fixed", amount: minor } })
          : Result.fail(`Amount ${below}.`)
      },
    })
  }

  const settings = [
    ["Suggested amount", parseAmount(form.suggested, scale)],
    ["Minimum amount", parseAmount(form.minimum, scale)],
    ["Maximum amount", parseAmount(form.maximum, scale)],
  ] as const

  for (const [label, parsed] of settings) {
    if (Parsed.$is("Invalid")(parsed)) {
      return Result.fail(`${label}: ${parsed.reason}`)
    }

    const below = Parsed.$is("Amount")(parsed) ? belowWholeUnit(parsed.minor, scale, currency) : undefined

    if (below !== undefined) {
      return Result.fail(`${label} ${below}.`)
    }
  }

  const [suggested, minimum, maximum] = settings.map(([, parsed]) => optional(parsed))

  if (minimum != null && maximum != null && minimum > maximum) {
    return Result.fail("The maximum must be at least the minimum.")
  }

  if (suggested != null && ((minimum != null && suggested < minimum) || (maximum != null && suggested > maximum))) {
    return Result.fail("The suggested amount must be within the minimum and maximum.")
  }

  return Result.succeed({
    ...base,
    pricing: {
      mode: "customer_chooses",
      suggested_amount: suggested ?? null,
      minimum_amount: minimum ?? null,
      maximum_amount: maximum ?? null,
    },
  })
}

/** The pricing as the result screen lists it, one line each. */
export const pricingLines = (link: Link): ReadonlyArray<string> => {
  const money = (minor: number) => formatMoney(minor, link.scale, link.currency_code)
  const { pricing } = link

  if (pricing.mode === "fixed") {
    return [`Amount: ${money(pricing.amount)} · ${link.currency_code}`]
  }

  const settings = [
    ["Suggested", pricing.suggested_amount],
    ["Minimum", pricing.minimum_amount],
    ["Maximum", pricing.maximum_amount],
  ] as const

  return [
    `Amount: Customer chooses · ${link.currency_code}`,
    ...settings.flatMap(([label, minor]) => (minor === null ? [] : [`${label}: ${money(minor)}`])),
  ]
}

/** What settled payments came to, at the scale and in the currency given. */
export const collected = (stats: Stats, scale: number, currency: string) =>
  formatMoney(BigInt(stats.collected), scale, currency)

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** The overview's heading, e.g. `Payment links · 3 links · 2 active`. */
export const listHeading = (overview: Overview) => {
  const heading = `Payment links · ${plural(overview.link_count, "link")}`

  return overview.active_link_count === overview.link_count ? heading : `${heading} · ${overview.active_link_count} active`
}

/**
 * The totals over every link, e.g. `Collected ₦75,000.00 · ₦2,500.00 settling
 * · 3 paid · 1 pending`; collected counts settled money only. Narrow, all but
 * what was collected and paid goes, so the line still fits on one row.
 */
export const totalsLine = (stats: Stats, scale: number, currency: string, narrow = false) => {
  const total = `Collected ${collected(stats, scale, currency)}`
  const paid = `${stats.succeeded} paid`

  if (narrow) {
    return `${total} · ${paid}`
  }

  const settling = stats.settling_amount === "0"
    ? ""
    : ` · ${formatMoney(BigInt(stats.settling_amount), scale, currency)} settling`

  return `${total}${settling} · ${paid} · ${stats.pending} pending`
}

/** Every status a link's payments ended in, paid first. */
export const statusLine = (stats: Stats) =>
  [
    `${stats.succeeded} paid`,
    `${stats.failed} failed`,
    `${stats.cancelled} cancelled`,
    `${stats.expired} expired`,
    `${stats.pending} pending`,
  ].join(" · ")

/** An ISO time as `2026-10-19 14:02 UTC`. */
export const formatTime = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`

const price = (link: Link) =>
  link.pricing.mode === "fixed"
    ? formatMoney(link.pricing.amount, link.scale, link.currency_code)
    : "Customer chooses"

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

// A line break or control character in a title would split its row.
export const oneLine = (text: string) => text.replace(/[\s\p{Cc}]+/gu, " ").trim()

// Fits the text to the width in terminal columns, where a CJK character or an
// emoji takes two, cutting it short with an ellipsis between graphemes. Any
// columns the cut frees, such as half of a wide character, become padding.
// Amounts align right, so their digits line up.
export const cell = (text: string, width: number, align: "start" | "end" = "start") => {
  if (width <= 0) {
    return ""
  }

  const shown = stringWidth(text)

  if (shown > width) {
    let kept = ""
    let used = 0

    for (const { segment } of graphemes.segment(text)) {
      const next = stringWidth(segment)

      if (used + next > width - 1) {
        break
      }

      kept += segment
      used += next
    }

    const cut = kept.trimEnd()

    return `${cut}…${" ".repeat(width - 1 - stringWidth(cut))}`
  }

  const padding = " ".repeat(width - shown)

  return align === "start" ? text + padding : padding + text
}

// Below this many columns a row keeps only the title and what was collected.
export const narrowRow = 46

/** A link as one row of the list, exactly `width` terminal columns wide. */
export const listRow = (summary: Summary, width: number) => {
  const title = summary.active ? oneLine(summary.title) : `${oneLine(summary.title)} (inactive)`
  const total = collected(summary.stats, summary.scale, summary.currency_code)

  if (width < narrowRow) {
    const totalWidth = Math.min(stringWidth(total), Math.max(width - 6, 0))

    return `${cell(title, width - totalWidth - 1)} ${cell(total, totalWidth, "end")}`
  }

  const columns = [
    cell(price(summary), 16, "end"),
    cell(`${summary.stats.succeeded} paid`, 8, "end"),
    cell(total, 16, "end"),
  ]

  return [cell(title, width - 16 - 8 - 16 - 3), ...columns].join(" ")
}
