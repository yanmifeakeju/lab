# Broker implementations

Broker implementations adapt the shared `MessageBroker` port to concrete
infrastructure. They own physical destination resolution and wire encoding;
the publisher remains infrastructure-independent.

## SQS

The SQS broker maps logical topic names to standard queue URLs and sends the
JSON-encoded message with `SendMessageCommand`.

```ts
const broker = createSqsBroker({
  client: new SQSClient({ region: "eu-west-1" }),
  queues: {
    orders: process.env.ORDERS_QUEUE_URL,
  },
});
```

It does not retry, classify failures, fan out, or support FIFO ordering. SDK
errors propagate to the caller unchanged.
