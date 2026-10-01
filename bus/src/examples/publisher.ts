import { z } from "zod";
import { defineTopic } from "../brokers/index.ts";
import type { MessageBroker } from "../brokers/index.ts";
import { defineEvent } from "../message/index.ts";
import { createPublisher } from "../publisher/index.ts";

const orders = defineTopic("orders");
const orderPlaced = defineEvent(
  "order.placed",
  z.object({
    orderId: z.string(),
    total: z.number().nonnegative(),
  }),
);

const broker: MessageBroker = {
  async publish(topic, message) {
    console.log({ topic: topic.name, message });
    return { messageId: "broker-message-1" };
  },
};

const publisher = createPublisher({
  source: "orders-service",
  broker,
});

const result = await publisher.publish({
  topic: orders,
  event: orderPlaced,
  data: { orderId: "order-1", total: 100 },
  metadata: { correlationId: "request-42" },
});

console.log(result);
