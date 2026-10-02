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
import { createPublisher, defineEvent, defineTopic } from "@workspace/bus";
import { createSqsBroker } from "@workspace/bus/sqs";
import { z } from "zod";

const orders = defineTopic("orders");
const orderPlaced = defineEvent(
  "order.placed",
  z.object({ orderId: z.string(), amount: z.string().regex(/^\d+$/) }),
);

const broker = createSqsBroker({
  client,
  queues: { [orders.name]: queueUrl },
});
const publisher = createPublisher({ source: "orders-service", broker });

await publisher.publish({
  topic: orders,
  event: orderPlaced,
  data: { orderId: "order-1", amount: "1000000" },
  metadata: { correlationId: "request-42" },
});

// For a stable retry identity, construct once and resend the same publication.
const publication = publisher.create({
  topic: orders,
  event: orderPlaced,
  data: { orderId: "order-2", amount: "500000" },
});
await publisher.send(publication);
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
  z.object({ orderId: z.string(), amount: z.string().regex(/^\d+$/) }),
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

The receiving adapter uses `decodeMessage` to decode the broker representation,
then translates `acknowledge`, `retry`, or `reject` into broker operations.
Malformed envelopes raise `MessageDecodeError` before subscriber dispatch.

Messages use wire format version `1`. Producer schemas may normalize and
default values, but their output must be JSON-compatible. Creation copies and
deeply freezes that output so a stored or retried publication cannot change.
`createdAt` is the construction time and therefore also remains stable across
delivery attempts. Decoders accept valid RFC 3339 representations and normalize
them to fixed-width UTC ISO strings, so textual ordering is chronological.

## Development

```sh
pnpm test
pnpm check
pnpm build
```

The runnable SQS round trip is in `src/examples/sqs`.
