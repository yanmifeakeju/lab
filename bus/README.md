# @workspace/bus

A small, type-safe messaging library that keeps application policy separate
from broker mechanism.

- `message` defines events, messages, and shared validation.
- `publisher` validates event data, creates a message, and gives it to a broker.
- `subscriber` validates event data, dispatches a handler, and reports what happened.
- `brokers` translates messages to a concrete backend such as SQS.

The library does not own polling, retries, acknowledgements, dead-lettering,
fan-out policy, correlation context, or tracing context.

## Publishing

```ts
import {
  createPublisher,
  createSqsBroker,
  defineEvent,
  defineTopic,
} from "@workspace/bus";
import { z } from "zod";

const orders = defineTopic("orders");
const orderPlaced = defineEvent(
  "order.placed",
  z.object({ orderId: z.string(), total: z.number() }),
);

const broker = createSqsBroker({
  client,
  queues: { [orders.name]: queueUrl },
});
const publisher = createPublisher({ source: "orders-service", broker });

await publisher.publish({
  topic: orders,
  event: orderPlaced,
  data: { orderId: "order-1", total: 100 },
  metadata: { correlationId: "request-42" },
});
```

## Subscribing

```ts
import {
  createSubscriber,
  decideSubscriptionOutcome,
  defineEvent,
  handle,
} from "@workspace/bus";
import { z } from "zod";

const orderPlaced = defineEvent(
  "order.placed",
  z.object({ orderId: z.string(), total: z.number() }),
);

const subscriber = createSubscriber([
  handle(orderPlaced, async (data, message) => {
    await fulfil(data.orderId, message.id);
  }),
]);

const outcome = await subscriber.handle(message);
const decision = await decideSubscriptionOutcome(outcome, (failure) =>
  failure.status === "failed" ? "retry" : "reject",
);
```

The receiving adapter owns decoding the broker representation into `Message`
and translating `acknowledge`, `retry`, or `reject` into broker operations.

## Development

```sh
pnpm test
pnpm check
pnpm build
```

The runnable SQS round trip is in `src/examples/sqs`.
