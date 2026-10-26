import { Payments } from "@pay-tty/core/payments"
import { Schema } from "effect"

// A decimal string: a sum can pass the safe integers.
const Sum = Schema.String.check(Schema.isPattern(/^\d+$/).annotate({ expected: "a non-negative integer" }))
  .annotate({ description: "In minor units of the links' currency." })

export class PaymentStats extends Schema.Class<PaymentStats>("PaymentStats")({
  succeeded: Schema.Int,
  failed: Schema.Int,
  cancelled: Schema.Int,
  // Includes pending payments past their window, marked or not.
  expired: Schema.Int,
  pending: Schema.Int,
  // Succeeded payments by how their ledger posting stands.
  settling: Schema.Int,
  settled: Schema.Int,
  attention: Schema.Int,
  // What settled payments brought in.
  collected: Sum,
  settling_amount: Sum,
  // When the latest succeeded payment completed.
  last_paid_at: Schema.NullOr(Schema.String),
}) {}

export const stats = (stats: Payments.Stats) =>
  new PaymentStats({
    succeeded: stats.succeeded,
    failed: stats.failed,
    cancelled: stats.cancelled,
    expired: stats.expired,
    pending: stats.pending,
    settling: stats.settling,
    settled: stats.settled,
    attention: stats.attention,
    collected: stats.collected.toString(),
    settling_amount: stats.settlingAmount.toString(),
    last_paid_at: stats.lastPaidAt?.toISOString() ?? null,
  })

