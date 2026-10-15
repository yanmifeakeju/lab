import type { CreatePaymentLinkRequestEncoded, PaymentLinkEncoded } from "@pay-tty/plane-client"
import { Result } from "effect"

import { formatMoney, Parsed, parseAmount } from "./money.ts"

export type Link = PaymentLinkEncoded

export type Request = CreatePaymentLinkRequestEncoded

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
 * The request the form describes at the business's scale, or why it can't be
 * sent. Only the chosen mode's settings are read.
 */
export const toRequest = (form: Form, scale: number): Result.Result<Request, string> => {
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
      Amount: ({ minor }): Result.Result<Request, string> =>
        Result.succeed({ ...base, pricing: { mode: "fixed", amount_minor: minor } }),
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
      suggested_amount_minor: suggested ?? null,
      minimum_amount_minor: minimum ?? null,
      maximum_amount_minor: maximum ?? null,
    },
  })
}

/** The pricing as the result screen lists it, one line each. */
export const pricingLines = (link: Link): ReadonlyArray<string> => {
  const money = (minor: number) => formatMoney(minor, link.scale, link.currency_code)
  const { pricing } = link

  if (pricing.mode === "fixed") {
    return [`Amount: ${money(pricing.amount_minor)} · ${link.currency_code}`]
  }

  const settings = [
    ["Suggested", pricing.suggested_amount_minor],
    ["Minimum", pricing.minimum_amount_minor],
    ["Maximum", pricing.maximum_amount_minor],
  ] as const

  return [
    `Amount: Customer chooses · ${link.currency_code}`,
    ...settings.flatMap(([label, minor]) => (minor === null ? [] : [`${label}: ${money(minor)}`])),
  ]
}
