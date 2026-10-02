import assert from "node:assert";
import { describe, test } from "node:test";
import { z } from "zod";
import {
  decodeMessage,
  defineEvent,
  encodeMessage,
  EventValidationError,
  MessageDecodeError,
  NonJsonValueError,
  normalizeJson,
  parseMessage,
  UnsupportedEventSchemaError,
  validateEventData,
} from "./index.ts";
import type { Message } from "./index.ts";

describe("event definition", () => {
  test("associates an event type with its payload schema", () => {
    const schema = z.object({ orderId: z.string() });

    const definition = defineEvent("order.placed", schema);

    assert.deepStrictEqual(definition, { type: "order.placed", schema });
    assert.ok(!("topic" in definition));
  });

  test("rejects invalid definitions immediately", () => {
    assert.throws(() => defineEvent("", z.string()), /Event type must be a non-empty string/);
    assert.throws(() => defineEvent("order.placed", {} as never), /Standard Schema/);
  });
});

describe("event validation", () => {
  test("returns the schema output", () => {
    const event = defineEvent(
      "order.placed",
      z.object({ orderId: z.string(), currency: z.string().default("USD") }),
    );

    assert.deepStrictEqual(validateEventData(event, { orderId: "order-1" }), {
      orderId: "order-1",
      currency: "USD",
    });
  });

  test("reports invalid payloads with their event type", () => {
    const event = defineEvent("order.placed", z.object({ orderId: z.string() }));

    assert.throws(
      () => validateEventData(event, { orderId: 42 }),
      (error: unknown) =>
        error instanceof EventValidationError && error.eventType === "order.placed",
    );
  });

  test("reports asynchronous schemas as unsupported configuration", () => {
    const event = defineEvent(
      "order.checked",
      z.object({ orderId: z.string() }).refine(async () => true),
    );

    assert.throws(
      () => validateEventData(event, { orderId: "order-1" }),
      UnsupportedEventSchemaError,
    );
  });
});

describe("message codec", () => {
  const message: Message = {
    messageVersion: 1,
    id: "message-1",
    source: "orders-service",
    createdAt: "2026-09-29T10:00:00.000Z",
    event: { type: "order.placed", data: { orderId: "order-1" } },
    metadata: { correlationId: "request-1" },
  };

  test("round-trips the versioned envelope and returns a frozen copy", () => {
    const decoded = decodeMessage(encodeMessage(message));

    assert.deepStrictEqual(decoded, message);
    assert.ok(Object.isFrozen(decoded));
    assert.ok(Object.isFrozen(decoded.event));
    assert.ok(Object.isFrozen(decoded.event.data));
    assert.ok(Object.isFrozen(decoded.metadata));
  });

  test("validates the envelope while leaving event data semantically unknown", () => {
    const decoded = parseMessage({
      ...message,
      event: { type: "order.placed", data: { deliberately: 42 } },
    });

    assert.deepStrictEqual(decoded.event.data, { deliberately: 42 });
  });

  test("reports malformed JSON and invalid envelopes as decode failures", () => {
    assert.throws(() => decodeMessage("{"), MessageDecodeError);
    assert.throws(
      () => parseMessage({ ...message, messageVersion: 2 }),
      (error: unknown) =>
        error instanceof MessageDecodeError && error.message.includes("messageVersion"),
    );
    assert.throws(
      () => parseMessage({ ...message, createdAt: "yesterday" }),
      MessageDecodeError,
    );
    assert.throws(
      () => parseMessage({ ...message, event: { type: "order.placed" } }),
      MessageDecodeError,
    );
  });

  test("accepts RFC 3339 timestamps from non-JavaScript producers", () => {
    assert.strictEqual(
      parseMessage({ ...message, createdAt: "2026-10-01T00:00:00Z" }).createdAt,
      "2026-10-01T00:00:00.000Z",
    );
    assert.strictEqual(
      parseMessage({ ...message, createdAt: "2026-10-01T01:30:00+01:30" }).createdAt,
      "2026-10-01T00:00:00.000Z",
    );
    assert.throws(
      () => parseMessage({ ...message, createdAt: "2026-02-30T00:00:00Z" }),
      MessageDecodeError,
    );
  });

  test("normalizes JSON without silently changing unsupported values", () => {
    assert.deepStrictEqual(normalizeJson({ optional: undefined, negativeZero: -0 }), {
      negativeZero: 0,
    });
    assert.throws(() => normalizeJson(undefined), NonJsonValueError);
    assert.throws(() => normalizeJson(["ok", undefined]), NonJsonValueError);
    assert.throws(() => normalizeJson(new Map([["key", "value"]])), NonJsonValueError);
  });

  test("preserves metadata keys that are special on object prototypes", () => {
    const decoded = decodeMessage(
      JSON.stringify({
        ...message,
        metadata: JSON.parse('{"__proto__":"context"}'),
      }),
    );

    assert.ok(Object.hasOwn(decoded.metadata, "__proto__"));
    assert.strictEqual(decoded.metadata["__proto__"], "context");
  });
});
