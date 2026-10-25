import assert from "node:assert/strict"
import { test } from "node:test"

import stringWidth from "string-width"

import { narrowRow } from "../src/payment-link.ts"
import { paymentRows, paymentTiming } from "../src/payments.ts"
import { merchantPayment } from "./support.ts"

const paymentRow = (
  payment: Parameters<typeof paymentRows>[0][number],
  width: number,
  linked: boolean,
  today: string,
) => paymentRows([payment], width, linked, today)[0] ?? ""

void test("payment rows show time, status, amount and source, with expiry for pending payments", () => {
  const payment = merchantPayment({ status: "pending", completed_at: null })
  const row = paymentRow(payment, 90, false, "2026-10-22")

  assert.match(row, /14:02  pending +₦25,000.00 +Logo design +expires 14:32/)
  assert.equal(stringWidth(row), 90)
  assert.ok(!paymentRow(payment, 90, true, "2026-10-22").includes("Logo design"))
  assert.match(paymentRow(payment, 90, false, "2026-10-23"), /2026-10-22 14:02/)
  assert.match(paymentRow(payment, 24, false, "2026-10-23"), /10-22 14:02 P ₦25,000.00/)
})

void test("payment rows fit wide titles and fall back below narrowRow without splitting graphemes", () => {
  const payment = merchantPayment({ source: { kind: "link", id: "plink_one", title: "図書館 👩🏽‍💻 ".repeat(20) } })

  for (const width of [24, 31, narrowRow - 1, narrowRow, narrowRow + 1, 80]) {
    const row = paymentRow(payment, width, false, "2026-10-22")

    assert.equal(stringWidth(row), width)
    assert.ok(!row.includes("\n"))

    if (width < narrowRow) {
      assert.match(row, /paid/)
      assert.ok(!row.includes("図"))
    }
  }

  const row = paymentRow(payment, 80, false, "2026-10-22")

  assert.ok(row.includes("図書館"))
  assert.ok(row.includes("…"))
})


void test("mixed-date pages align time, status and amount cells at narrow and wide widths", () => {
  const payments = [
    merchantPayment({ amount: "100", created_at: "2026-10-22T14:02:00.000Z" }),
    merchantPayment({ status: "expired", amount: "2500000", created_at: "2026-10-21T13:58:00.000Z" }),
    merchantPayment({ status: "pending", amount: "10000", completed_at: null }),
  ]

  const amounts = ["₦1.00", "₦25,000.00", "₦100.00"]

  for (const width of [24, narrowRow - 1, narrowRow, 80, 90]) {
    const rows = paymentRows(payments, width, false, "2026-10-22")

    const ends = rows.map((row, index) => {
      const amount = amounts[index] ?? ""

      assert.ok(row.includes(amount), row)
      assert.equal(stringWidth(row), width)

      return stringWidth(row.slice(0, row.indexOf(amount))) + stringWidth(amount)
    })

    assert.equal(new Set(ends).size, 1, "amounts align on their last digit")
    assert.ok(rows.every((row) => row.startsWith(width < narrowRow ? "10-" : "2026-10-")))
    assert.equal(new Set(rows.map((row) => row.indexOf(":"))).size, 1, "time columns align")
  }

  const today = paymentRows(payments.map((payment) => ({
    ...payment, created_at: "2026-10-22T14:02:00.000Z",
  })), 30, false, "2026-10-22")

  assert.ok(today.every((row) => row.startsWith("14:02 ")))
  assert.ok(today[0]?.includes("paid "))
  assert.ok(today[1]?.includes("exp  "))
})

void test("detail timing uses effective status for both unswept and persisted expiry", () => {
  assert.equal(paymentTiming(merchantPayment({ status: "expired", completed_at: null })),
    "Expired at: 2026-10-22 14:32 UTC")
  assert.equal(paymentTiming(merchantPayment({ status: "expired", completed_at: "2026-10-22T14:32:00.000Z" })),
    "Expired at: 2026-10-22 14:32 UTC")
  assert.equal(paymentTiming(merchantPayment({ status: "pending", completed_at: null })),
    "Expires at: 2026-10-22 14:32 UTC")
  assert.equal(paymentTiming(merchantPayment()), "Completed: 2026-10-22 14:03 UTC")
})

void test("seven-figure amounts stay complete at width 24, using time today and date for older payments", () => {
  const payments = [
    merchantPayment({ amount: "125000000", created_at: "2026-10-22T14:02:00.000Z" }),
    merchantPayment({ amount: "100", created_at: "2026-10-21T13:58:00.000Z" }),
  ]

  const rows = paymentRows(payments, 24, false, "2026-10-22")

  assert.match(rows[0] ?? "", /^14:02 S +₦1,250,000\.00/)
  assert.match(rows[1] ?? "", /^10-21 S +₦1\.00/)
  assert.ok(rows.every((row) => stringWidth(row) === 24 && !row.includes("…")))

  const amounts = ["₦1,250,000.00", "₦1.00"]

  const ends = rows.map((row, index) => {
    const amount = amounts[index] ?? ""

    return stringWidth(row.slice(0, row.indexOf(amount))) + stringWidth(amount)
  })

  assert.equal(new Set(ends).size, 1)
})

void test("large amounts omit time and shorten status without losing digits", () => {
  const payments = [
    merchantPayment({ amount: "1250000000000" }),
    merchantPayment({ amount: "100" }),
  ]

  const rows = paymentRows(payments, 24, false, "2026-10-22")

  assert.ok(rows[0]?.includes("₦12,500,000,000.00"))
  assert.ok(rows.every((row) => stringWidth(row) === 24 && !row.includes("14:02") && !row.includes("…")))

  const largest = paymentRow(merchantPayment({ amount: "9007199254740991" }), 24, false, "2026-10-22")

  assert.ok(largest.includes("₦90,071,992,547,409.91"))
  assert.equal(stringWidth(largest), 24)
  assert.ok(!largest.includes("…"))
})

void test("small amounts use only their own width, leaving room for the title", () => {
  const payment = merchantPayment({ amount: "10000" })
  const row = paymentRow(payment, 60, false, "2026-10-22")

  assert.ok(row.startsWith("14:02  succeeded  ₦100.00  Logo design"))
})


void test("five-column timestamps distinguish today from older payments beside large amounts", () => {
  const rows = paymentRows([
    merchantPayment({ amount: "999999999999999", created_at: "2026-10-22T14:02:00.000Z" }),
    merchantPayment({ amount: "125000000", created_at: "2026-10-21T14:02:00.000Z" }),
  ], 32, false, "2026-10-22")

  assert.match(rows[0] ?? "", /^14:02 S +₦9,999,999,999,999\.99/)
  assert.match(rows[1] ?? "", /^10-21 S +₦1,250,000\.00/)
  assert.ok(rows.every((row) => stringWidth(row) === 32 && !row.includes("…")))
})

void test("expiry is either complete or absent around wide-row fit boundaries", () => {
  const payments = [
    merchantPayment({ amount: "9007199254740991" }),
    merchantPayment({ amount: "100", status: "pending", completed_at: null }),
  ]

  for (const linked of [false, true]) {
    for (let width = narrowRow; width <= 80; width++) {
      const rows = paymentRows(payments, width, linked, "2026-10-22")
      const pending = rows[1] ?? ""

      assert.equal(stringWidth(pending), width)
      assert.ok(!pending.includes("exp") || pending.includes("expires 14:32"), pending)
      assert.ok(rows[0]?.includes("₦90,071,992,547,409.91"))
    }

    assert.ok(!paymentRows(payments, 46, linked, "2026-10-22")[1]?.includes("exp"))
    assert.ok(paymentRows(payments, 55, linked, "2026-10-22")[1]?.includes("expires 14:32"))
  }
})
