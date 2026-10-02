# Publisher experiment

This folder owns the publishing side of the message protocol.

- The neutral `message` package defines events and messages.
- The `brokers` package defines topics and the broker port.
- The caller chooses which event is published to which topic.
- `create` synchronously validates and normalizes the payload into an immutable
  `Publication` with a stable ID and `createdAt` timestamp.
- `send` passes an existing publication to the configured broker, allowing the
  exact same publication to be retried.
- `publish` remains the convenient create-and-send operation.
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

// Build once, then retry the same identity when delivery is uncertain.
const publication = publisher.create({
  topic: orders,
  event: orderPlaced,
  data: { orderId: "order-2" },
});
await publisher.send(publication);
```

Producer schema output must be JSON-compatible. The publisher sends the
schema's normalized output, so defaults and transformations are preserved, but
rich values such as `Date` and `Map` are rejected. Persisted publications can
be restored with `decodePublication`; decoding reconstructs their logical
`Topic`, while the broker remains responsible for rejecting an unconfigured
topic when it is sent.
