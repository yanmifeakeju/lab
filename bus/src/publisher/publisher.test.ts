import assert from "node:assert";
import { describe, test } from "node:test";
import { z } from "zod";
import { defineTopic } from "../brokers/index.ts";
import type { MessageBroker, Topic } from "../brokers/index.ts";
import {
  defineEvent,
  EventValidationError,
  NonJsonValueError,
  UnsupportedEventSchemaError,
} from "../message/index.ts";
import type { Message } from "../message/index.ts";
import {
  createPublisher,
  decodePublication,
  encodePublication,
} from "./index.ts";

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
          messageVersion: 1,
          id: "message-1",
          source: "orders-service",
          createdAt: "2026-09-28T12:00:00.000Z",
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

  test("creates synchronously and resends the exact publication", async () => {
    const received: Array<{ topic: Topic; message: Message }> = [];
    let ids = 0;
    let clockReads = 0;
    const publisher = createPublisher({
      source: "orders",
      broker: recordingBroker(received),
      generateId: () => `message-${++ids}`,
      now: () => {
        clockReads += 1;
        return new Date("2026-09-28T12:00:00.000Z");
      },
    });

    const publication = publisher.create({
      topic: orders,
      event: orderPlaced,
      data: { orderId: "order-1" },
    });

    assert.strictEqual(received.length, 0);
    await publisher.send(publication);
    await publisher.send(publication);

    assert.strictEqual(ids, 1);
    assert.strictEqual(clockReads, 1);
    assert.strictEqual(received[0]?.message, publication.message);
    assert.strictEqual(received[1]?.message, publication.message);
    assert.strictEqual(received[0]?.topic, publication.topic);
    assert.strictEqual(received[1]?.topic, publication.topic);
  });

  test("publish remains safe when destructured", async () => {
    const publisher = createPublisher({ source: "orders", broker: recordingBroker([]) });
    const { publish } = publisher;

    await assert.doesNotReject(() =>
      publish({ topic: orders, event: orderPlaced, data: { orderId: "order-1" } }),
    );
  });

  test("normalizes, copies, and deeply freezes schema output", () => {
    const passthrough = defineEvent(
      "order.snapshot",
      z.custom<{ nested: { value: string }; note?: string | undefined }>(),
    );
    const publisher = createPublisher({ source: "orders", broker: recordingBroker([]) });
    const input = { nested: { value: "before" }, note: undefined };

    const publication = publisher.create({ topic: orders, event: passthrough, data: input });
    input.nested.value = "after";

    assert.deepStrictEqual(publication.message.event.data, { nested: { value: "before" } });
    assert.ok(Object.isFrozen(publication));
    assert.ok(Object.isFrozen(publication.topic));
    assert.ok(Object.isFrozen(publication.message));
    assert.ok(Object.isFrozen(publication.message.event.data.nested));
    assert.throws(() => {
      (publication.message.event.data.nested as { value: string }).value = "runtime mutation";
    }, TypeError);

    void (() => {
      // @ts-expect-error Created publication payloads are deeply readonly.
      publication.message.event.data.nested.value = "compile-time mutation";
    });
  });

  test("allows JSON schemas containing unknown and recursive JSON output", () => {
    const recordEvent = defineEvent(
      "record.created",
      z.object({ extra: z.record(z.string(), z.unknown()) }),
    );
    const jsonEvent = defineEvent("json.created", z.json());
    const publisher = createPublisher({ source: "records", broker: recordingBroker([]) });

    const record = publisher.create({
      topic: orders,
      event: recordEvent,
      data: { extra: { nested: [1, true, null] } },
    });
    const json = publisher.create({
      topic: orders,
      event: jsonEvent,
      data: { nested: [1, true, null] },
    });

    assert.deepStrictEqual(record.message.event.data, {
      extra: { nested: [1, true, null] },
    });
    assert.ok(json);
  });

  test("rejects schema output that cannot cross the JSON boundary", () => {
    const dateEvent = defineEvent("order.dated", z.coerce.date());
    const publisher = createPublisher({ source: "orders", broker: recordingBroker([]) });

    assert.throws(
      () =>
        publisher.create({
          topic: orders,
          event: dateEvent,
          data: "2026-09-29T10:00:00.000Z",
        } as never),
      NonJsonValueError,
    );

    void (() => {
      publisher.create({
        topic: orders,
        // @ts-expect-error Producer schema output must be JSON-compatible.
        event: dateEvent,
        data: "2026-09-29T10:00:00.000Z",
      });
    });
  });

  test("decodes stored publications and reconstructs their topic", async () => {
    const received: Array<{ topic: Topic; message: Message }> = [];
    const publisher = createPublisher({
      source: "orders",
      broker: recordingBroker(received),
      generateId: () => "message-1",
      now: () => new Date("2026-09-28T12:00:00.000Z"),
    });
    const original = publisher.create({
      topic: orders,
      event: orderPlaced,
      data: { orderId: "order-1" },
    });

    const restored = decodePublication(encodePublication(original));
    await publisher.send(restored);

    assert.deepStrictEqual(restored, original);
    assert.notStrictEqual(restored.topic, original.topic);
    assert.deepStrictEqual(received[0], restored);
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
