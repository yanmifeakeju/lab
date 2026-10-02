import z from "zod";
import { defineEvent } from "../message/index.ts";
import type { Message } from "../message/index.ts";
import {
  createSubscriber,
  decideSubscriptionOutcome,
  handle,
} from "../subscriber/index.ts";

// A subscriber defines the smallest compatible contract it needs for each event.
const orderPlaced = defineEvent(
  "order.placed",
  z.object({ orderId: z.string(), amount: z.string().regex(/^\d+$/) }),
);
const orderCancelled = defineEvent(
  "order.cancelled",
  z.object({ orderId: z.string(), reason: z.string() }),
);

// Each event definition is paired with its handler at construction time.
const subscriber = createSubscriber([
  handle(orderPlaced, async (data, message) => {
    console.log(`${message.id}: order ${data.orderId} for ${data.amount}`);
  }),
  handle(orderCancelled, (data) => {
    console.log(`cancelled ${data.orderId}: ${data.reason}`);
  }),
]);

// A broker adapter is responsible for decoding its wire format into Message.
const message = {
  messageVersion: 1,
  id: "msg-1",
  source: "orders",
  createdAt: new Date().toISOString(),
  event: {
    type: "order.placed",
    data: { orderId: "o-1", amount: "1000000" },
  },
  metadata: { correlationId: "checkout-1" },
} satisfies Message;

// The subscriber reports what happened; it does not acknowledge or retry delivery.
const outcome = await subscriber.handle(message);

// Delivery policy remains outside the subscriber mechanism. A host adapter can
// translate this portable decision into SQS, Lambda, HTTP, or another protocol.
const decision = await decideSubscriptionOutcome(outcome, (failure) => {
  switch (failure.status) {
    case "failed":
      return "retry";
    case "invalid":
    case "unhandled":
      return "reject";
  }
});

console.log(`delivery decision: ${decision}`);
