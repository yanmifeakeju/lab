import assert from "node:assert";
import { describe, test } from "node:test";
import { z } from "zod";
import {
  defineEvent,
  EventValidationError,
  UnsupportedEventSchemaError,
  validateEventData,
} from "./index.ts";

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
