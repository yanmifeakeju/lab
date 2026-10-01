# Publisher experiment

This folder establishes the publishing protocol before any adapter or
subscriber is designed around it.

- The neutral `message` package defines events and messages.
- The `brokers` package defines topics and the broker port.
- The caller chooses which event is published to which topic.
- The publisher validates the payload, creates the event, wraps it in a
  message, and passes the topic and message to one broker port.
- The broker owns encoding and routing to subscriptions.

The publisher has no subscriber destinations, transport targets, fan-out loop,
serialization, retries, persistence, or delivery-failure policy.

```ts
import { defineTopic } from "../brokers/index.ts";
import { defineEvent } from "../message/index.ts";
import { createPublisher } from "./index.ts";

const orderPlaced = defineEvent(
  "order.placed",
  z.object({ orderId: z.string() }),
);
const orders = defineTopic("orders");
const publisher = createPublisher({ source: "orders-service", broker });

await publisher.publish({
  topic: orders,
  event: orderPlaced,
  data: { orderId: "order-1" },
});
```
