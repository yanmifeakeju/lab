import { Payments } from "@pay-tty/core/payments"
import { Schema } from "effect"

export class PaymentStats extends Schema.Class<PaymentStats>("PaymentStats")({
  succeeded: Schema.Int,
  failed: Schema.Int,
  cancelled: Schema.Int,
  // Includes pending payments past their window, marked or not.
  expired: Schema.Int,
  pending: Schema.Int,
  // A decimal string: a sum can pass the safe integers.
  collected: Schema.String.check(Schema.isPattern(/^\d+$/).annotate({ expected: "a non-negative integer" }))
    .annotate({ description: "In minor units of the links' currency." }),
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
    collected: stats.collected.toString(),
    last_paid_at: stats.lastPaidAt?.toISOString() ?? null,
  })

