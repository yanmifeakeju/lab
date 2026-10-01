import assert from "node:assert";
import { describe, test } from "node:test";
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { defineEvent } from "../message/index.ts";
import type { Message } from "../message/index.ts";
import { createPublisher } from "../publisher/index.ts";
import { createSqsBroker, SqsTopicNotConfiguredError } from "./sqs.ts";
import { defineTopic } from "./topic.ts";

const queueUrl = "https://sqs.eu-west-1.amazonaws.com/123456789012/orders";
const orders = defineTopic("orders");
const orderPlaced = defineEvent("order.placed", {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({ value: value as { orderId: string } }),
  },
});

function stubClient(reply: () => unknown = () => ({ MessageId: "sqs-message-1" })): {
  client: SQSClient;
  commands: SendMessageCommand[];
} {
  const commands: SendMessageCommand[] = [];
  const client = {
    async send(command: SendMessageCommand): Promise<unknown> {
      commands.push(command);
      return reply();
    },
  } as unknown as SQSClient;
  return { client, commands };
}

describe("SQS broker", () => {
  test("publishes the publisher's message to the queue configured for its topic", async () => {
    const { client, commands } = stubClient();
    const publisher = createPublisher({
      source: "orders-service",
      broker: createSqsBroker({ client, queues: { orders: queueUrl } }),
      generateId: () => "message-1",
      now: () => new Date("2026-09-28T12:00:00.000Z"),
    });

    const result = await publisher.publish({
      topic: orders,
      event: orderPlaced,
      data: { orderId: "order-1" },
      metadata: { correlationId: "request-1" },
    });

    assert.strictEqual(commands.length, 1);
    const command = commands[0];
    assert.ok(command instanceof SendMessageCommand);
    assert.strictEqual(command.input.QueueUrl, queueUrl);
    assert.deepStrictEqual(JSON.parse(command.input.MessageBody ?? ""), result.message);
    assert.deepStrictEqual(result.receipt, { messageId: "sqs-message-1" });
  });

  test("returns an empty receipt when SQS omits its message id", async () => {
    const { client } = stubClient(() => ({}));
    const broker = createSqsBroker({ client, queues: { orders: queueUrl } });

    const receipt = await broker.publish(orders, message());

    assert.deepStrictEqual(receipt, {});
  });

  test("rejects a topic without a configured queue before calling SQS", async () => {
    const { client, commands } = stubClient();
    const broker = createSqsBroker({ client, queues: { orders: queueUrl } });

    await assert.rejects(
      () => broker.publish(defineTopic("audit"), message()),
      SqsTopicNotConfiguredError,
    );
    assert.strictEqual(commands.length, 0);
  });

  test("propagates SQS failures unchanged", async () => {
    const failure = new Error("SQS unavailable");
    const { client } = stubClient(() => {
      throw failure;
    });
    const broker = createSqsBroker({ client, queues: { orders: queueUrl } });

    await assert.rejects(() => broker.publish(orders, message()), (error) => error === failure);
  });

  test("reports serialization failures before calling SQS", async () => {
    const { client, commands } = stubClient();
    const broker = createSqsBroker({ client, queues: { orders: queueUrl } });
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    await assert.rejects(
      () => broker.publish(orders, { ...message(), event: { type: "broken", data: circular } }),
      /not JSON-serializable/,
    );
    assert.strictEqual(commands.length, 0);
  });

  test("validates routing configuration at construction", () => {
    const { client } = stubClient();

    assert.throws(() => createSqsBroker({ client, queues: {} }), /at least one topic/);
    assert.throws(
      () => createSqsBroker({ client, queues: { orders: "" } }),
      /must be a non-empty string/,
    );
    assert.throws(
      () => createSqsBroker({ client, queues: { orders: `${queueUrl}.fifo` } }),
      /must be a standard queue/,
    );
  });
});

function message(): Message {
  return {
    id: "message-1",
    source: "orders-service",
    publishedAt: "2026-09-28T12:00:00.000Z",
    event: { type: "order.placed", data: { orderId: "order-1" } },
    metadata: { correlationId: "request-1" },
  };
}
