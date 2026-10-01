import assert from "node:assert";
import { test } from "node:test";
import { z } from "zod";
import { defineTopic } from "../brokers/index.ts";
import type { MessageBroker } from "../brokers/index.ts";
import { defineEvent } from "../message/index.ts";
import { createPublisher } from "../publisher/index.ts";
import { createSubscriber, handle } from "./index.ts";

test("a publisher Message is the subscriber's input contract", async () => {
  const orderPlaced = defineEvent(
    "order.placed",
    z.object({ orderId: z.string(), total: z.number() }),
  );
  const broker: MessageBroker = {
    async publish() {
      return { messageId: "broker-message-1" };
    },
  };
  const publisher = createPublisher({
    source: "orders-service",
    broker,
    generateId: () => "message-1",
    now: () => new Date("2026-09-29T10:00:00.000Z"),
  });
  let receivedOrderId: string | undefined;
  const subscriber = createSubscriber([
    handle(orderPlaced, (data) => {
      receivedOrderId = data.orderId;
    }),
  ]);

  const publication = await publisher.publish({
    topic: defineTopic("orders"),
    event: orderPlaced,
    data: { orderId: "order-1", total: 50.99 },
  });
  const outcome = await subscriber.handle(publication.message);

  assert.ok(outcome.status === "handled");
  assert.strictEqual(receivedOrderId, "order-1");
  assert.deepStrictEqual(outcome.message, publication.message);
});
