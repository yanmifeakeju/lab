# Subscriber experiment

This folder separates message-handling mechanism from delivery policy.

`createSubscriber` composes typed handler registrations. It accepts the shared
`Message`, dispatches by `message.event.type`, validates `message.event.data`
against the registered event definition, and reports a factual
`SubscriptionOutcome`. It does not decode a broker representation,
acknowledge, retry, reject, dead-letter, or infer whether an error is permanent.
Receiving adapters decode with the shared message codec before calling it;
malformed envelopes raise `MessageDecodeError` at that boundary.

Decoded message data is deeply frozen. Most validating schemas, including Zod
objects, arrays, and records, construct fresh handler values. Pass-through
schemas such as `z.unknown()` and `z.custom()` may return the frozen value
unchanged, so handlers must treat their inputs as immutable. Attempted mutation
throws and is reported as a handler failure.

```ts
const orderSubscriptions = [
  handle(orderPlaced, async (data, message) => {
    await createPaymentIntent(data.orderId, message.id);
  }),
];

const subscriber = createSubscriber([
  ...orderSubscriptions,
  ...paymentSubscriptions,
]);
```

The event definition and handler are registered together, so there is no
separate topic/schema registry or handler-coverage assertion. Duplicate event
types fail at construction.

Dispatch uses `message.event.type` alone; the topic does not cross the wire
and `source` is not consulted. Event types must therefore be unique across
every producer that can reach one subscriber, so namespace them (for example
`orders.order.placed`).

`decideSubscriptionOutcome` applies a caller-supplied `SubscriptionPolicy` to
outcomes that were not handled. Its portable decisions are `acknowledge`,
`retry`, and `reject`; a future host adapter is responsible only for expressing
that decision in its host protocol.

Configuration faults still throw because they describe a broken subscriber,
not the disposition of one message.
