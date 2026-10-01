import assert from "node:assert";
import { describe, test } from "node:test";
import { z } from "zod";
import { defineTopic } from "../brokers/index.ts";
import type { MessageBroker, Topic } from "../brokers/index.ts";
import {
  defineEvent,
  EventValidationError,
  UnsupportedEventSchemaError,
} from "../message/index.ts";
import type { Message } from "../message/index.ts";
import { createPublisher } from "./index.ts";

const orderPlaced = defineEvent(
  "order.placed",
  z.object({ orderId: z.string(), currency: z.string().default("USD") }),
);
const orders = defineTopic("orders");

function recordingBroker(received: Array<{ topic: Topic; message: Message }>): MessageBroker {
  return {
    async publish(topic, message) {
      received.push({ topic, message });
      return { messageId: "broker-1" };
    },
  };
}

describe("publisher mechanism", () => {
  test("creates an event, wraps it in a message, and publishes it to the topic", async () => {
    const received: Array<{ topic: Topic; message: Message }> = [];
    const publisher = createPublisher({
      source: "orders-service",
      broker: recordingBroker(received),
      generateId: () => "message-1",
      now: () => new Date("2026-09-28T12:00:00.000Z"),
    });

    const result = await publisher.publish({
      topic: orders,
      event: orderPlaced,
      data: { orderId: "order-1" },
      metadata: { correlationId: "request-1" },
    });

    assert.deepStrictEqual(received, [
      {
        topic: { name: "orders" },
        message: {
          id: "message-1",
          source: "orders-service",
          publishedAt: "2026-09-28T12:00:00.000Z",
          event: {
            type: "order.placed",
            data: { orderId: "order-1", currency: "USD" },
          },
          metadata: { correlationId: "request-1" },
        },
      },
    ]);
    assert.strictEqual(result.message, received[0]?.message);
    assert.deepStrictEqual(result.receipt, { messageId: "broker-1" });
  });

  test("passes a message object to the broker without serializing it", async () => {
    let received: Message | undefined;
    const broker: MessageBroker = {
      async publish(_topic, message) {
        received = message;
        return {};
      },
    };
    const publisher = createPublisher({ source: "orders", broker });

    await publisher.publish({ topic: orders, event: orderPlaced, data: { orderId: "order-1" } });

    assert.ok(received !== undefined);
    assert.strictEqual(typeof received, "object");
    assert.deepStrictEqual(received.metadata, {});
  });

  test("rejects invalid event data before calling the broker", async () => {
    let calls = 0;
    const broker: MessageBroker = {
      async publish() {
        calls += 1;
        return {};
      },
    };
    const publisher = createPublisher({ source: "orders", broker });

    await assert.rejects(
      () =>
        publisher.publish({
          topic: orders,
          event: orderPlaced,
          data: { orderId: 42 } as never,
        }),
      EventValidationError,
    );
    assert.strictEqual(calls, 0);
  });

  test("propagates broker failures without classifying or converting them", async () => {
    const failure = new Error("broker unavailable");
    const broker: MessageBroker = {
      async publish() {
        throw failure;
      },
    };
    const publisher = createPublisher({ source: "orders", broker });

    await assert.rejects(
      () => publisher.publish({ topic: orders, event: orderPlaced, data: { orderId: "order-1" } }),
      (error) => error === failure,
    );
  });

  test("treats asynchronous validation as a configuration fault", async () => {
    const asyncEvent = defineEvent(
      "order.checked",
      z.object({ orderId: z.string() }).refine(async () => true),
    );
    const publisher = createPublisher({ source: "orders", broker: recordingBroker([]) });

    await assert.rejects(
      () =>
        publisher.publish({
          topic: orders,
          event: asyncEvent,
          data: { orderId: "order-1" },
        }),
      UnsupportedEventSchemaError,
    );
  });

  test("validates message construction dependencies", async () => {
    const broker = recordingBroker([]);
    assert.throws(() => createPublisher({ source: "", broker }), /source must be a non-empty string/);
    assert.throws(
      () => createPublisher({ source: "orders", broker: {} as never }),
      /broker must provide a publish function/,
    );

    const badId = createPublisher({ source: "orders", broker, generateId: () => "" });
    await assert.rejects(
      () => badId.publish({ topic: orders, event: orderPlaced, data: { orderId: "order-1" } }),
      /message id must be a non-empty string/,
    );

    const badClock = createPublisher({
      source: "orders",
      broker,
      now: () => new Date(Number.NaN),
    });
    await assert.rejects(
      () => badClock.publish({ topic: orders, event: orderPlaced, data: { orderId: "order-1" } }),
      /now must return a valid Date/,
    );
  });

  test("types event data from its definition, independently of the topic", () => {
    const publisher = createPublisher({ source: "orders", broker: recordingBroker([]) });
    const audit = defineTopic("audit");

    void (() => {
      void publisher.publish({
        topic: audit,
        event: orderPlaced,
        // @ts-expect-error orderId is defined as a string by the event, not the topic.
        data: { orderId: 42 },
      });
    });
  });
});
