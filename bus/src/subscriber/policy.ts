import type { ActionableSubscriptionOutcome, SubscriptionOutcome } from "./types.ts";

export type DeliveryDecision = "acknowledge" | "retry" | "reject";

export type SubscriptionPolicy = (
  outcome: ActionableSubscriptionOutcome,
) => DeliveryDecision | Promise<DeliveryDecision>;

const DELIVERY_DECISIONS: readonly DeliveryDecision[] = ["acknowledge", "retry", "reject"];

export async function decideSubscriptionOutcome(
  outcome: SubscriptionOutcome,
  policy: SubscriptionPolicy,
): Promise<DeliveryDecision> {
  if (outcome.status === "handled") {
    return "acknowledge";
  }

  const decision = await policy(outcome);
  if (!(DELIVERY_DECISIONS as readonly unknown[]).includes(decision)) {
    throw new Error(`Subscription policy returned an invalid delivery decision: ${String(decision)}`);
  }

  return decision;
}
