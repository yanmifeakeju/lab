import { Data } from "effect"

// Amounts move between the merchant's decimal text and plane's integer minor
// units by string and bigint arithmetic alone, at the ledger's scale.

export type Parsed = Data.TaggedEnum<{
  Blank: {}
  Amount: { readonly minor: number }
  Invalid: { readonly reason: string }
}>

export const Parsed = Data.taggedEnum<Parsed>()

const largest = BigInt(Number.MAX_SAFE_INTEGER)

const written = /^(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/

const symbols = new Map([["NGN", "₦"], ["USD", "$"]])

/** Text like `2,500.00` or `2500` as minor units at the scale. */
export const parseAmount = (text: string, scale: number): Parsed => {
  const trimmed = text.trim()

  if (trimmed === "") {
    return Parsed.Blank()
  }

  const match = written.exec(trimmed)

  if (match === null) {
    return Parsed.Invalid({ reason: `Enter an amount like ${formatDecimal(250_000, scale)}.` })
  }

  const whole = (match[1] ?? "").replaceAll(",", "")
  const fraction = match[2] ?? ""

  if (fraction.length > scale) {
    return Parsed.Invalid({ reason: scale === 0 ? "Enter a whole amount." : `Use at most ${scale} decimal places.` })
  }

  const minor = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0") || "0")

  if (minor === 0n) {
    return Parsed.Invalid({ reason: "Enter an amount greater than zero." })
  }

  if (minor > largest) {
    return Parsed.Invalid({ reason: "That amount is too large." })
  }

  return Parsed.Amount({ minor: Number(minor) })
}

/** Minor units as grouped decimal text, e.g. 250000 at scale 2 is `2,500.00`. */
export const formatDecimal = (minor: number, scale: number) => {
  const digits = BigInt(minor).toString().padStart(scale + 1, "0")
  const whole = digits.slice(0, digits.length - scale).replace(/\B(?=(\d{3})+$)/g, ",")

  return scale === 0 ? whole : `${whole}.${digits.slice(digits.length - scale)}`
}

/** With the currency's symbol, or its code where it has none here. */
export const formatMoney = (minor: number, scale: number, currency: string) => {
  const symbol = symbols.get(currency)

  return symbol === undefined ? `${currency} ${formatDecimal(minor, scale)}` : `${symbol}${formatDecimal(minor, scale)}`
}
