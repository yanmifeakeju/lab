import { Payments } from "@pay-tty/core/payments"
import { Schema } from "effect"

export class PaymentStats extends Schema.Class<PaymentStats>("PaymentStats")({
  succeeded: Schema.Int,
  failed: Schema.Int,
  cancelled: Schema.Int,
  // Includes pending payments past their window, marked or not.
  expired: Schema.Int,
  pending: Schema.Int,
  // Minor units as a decimal string: a sum can pass the safe integers.
  collected_minor: Schema.String.check(Schema.isPattern(/^\d+$/).annotate({ expected: "a non-negative integer" })),
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
    collected_minor: stats.collectedMinor.toString(),
    last_paid_at: stats.lastPaidAt?.toISOString() ?? null,
  })

