import assert from "node:assert";
import { describe, test } from "node:test";
import { z } from "zod";
import {
  defineEvent,
  EventValidationError,
  UnsupportedEventSchemaError,
} from "../message/index.ts";
import type { Message } from "../message/index.ts";
import {
  createSubscriber,
  decideSubscriptionOutcome,
  handle,
} from "./index.ts";
import type { SubscriptionPolicy } from "./index.ts";

const orderPlaced = defineEvent(
  "order.placed",
  z.object({ orderId: z.string(), currency: z.string().default("USD") }),
);
const orderCancelled = defineEvent(
  "order.cancelled",
  z.object({ orderId: z.string(), reason: z.string() }),
);

function message(type = "order.placed", data: unknown = { orderId: "order-1" }): Message {
  return {
    id: "message-1",
    source: "orders-service",
    publishedAt: "2026-09-29T10:00:00.000Z",
    event: { type, data },
    metadata: { correlationId: "request-1" },
  };
}

describe("subscriber mechanism", () => {
  test("validates and dispatches a shared Message without making a delivery decision", async () => {
    let received: unknown;
    const subscriber = createSubscriber([
      handle(orderPlaced, (data, receivedMessage) => {
        received = { data, messageData: receivedMessage.event.data };
      }),
    ]);

    const outcome = await subscriber.handle(
      message("order.placed", { orderId: "order-1", total: 50.99 }),
    );

    assert.ok(outcome.status === "handled");
    assert.deepStrictEqual(received, {
      data: { orderId: "order-1", currency: "USD" },
      messageData: { orderId: "order-1", currency: "USD" },
    });
    assert.deepStrictEqual(outcome.message.event.data, {
      orderId: "order-1",
      currency: "USD",
    });
  });

  test("composes registrations from independent feature modules", async () => {
    const seen: string[] = [];
    const orderSubscriptions = [
      handle(orderPlaced, (data) => seen.push(`placed:${data.orderId}`)),
    ];
    const cancellationSubscriptions = [
      handle(orderCancelled, (data) => seen.push(`cancelled:${data.reason}`)),
    ];
    const subscriber = createSubscriber([
      ...orderSubscriptions,
      ...cancellationSubscriptions,
    ]);

    await subscriber.handle(message());
    await subscriber.handle(
      message("order.cancelled", { orderId: "order-1", reason: "out of stock" }),
    );

    assert.deepStrictEqual(seen, ["placed:order-1", "cancelled:out of stock"]);
  });

  test("reports an event without a registration as unhandled", async () => {
    const subscriber = createSubscriber([handle(orderPlaced, () => {})]);
    const unknown = message("invoice.issued", { deliberately: "not validated" });

    const outcome = await subscriber.handle(unknown);

    assert.ok(outcome.status === "unhandled");
    assert.strictEqual(outcome.message, unknown);
  });

  test("reports schema failure as an invalid event payload", async () => {
    const subscriber = createSubscriber([
      handle(orderPlaced, () => assert.fail("handler must not run")),
    ]);

    const outcome = await subscriber.handle(message("order.placed", { orderId: 42 }));

    assert.ok(outcome.status === "invalid");
    assert.ok(outcome.error instanceof EventValidationError);
    assert.strictEqual(outcome.error.eventType, "order.placed");
    assert.strictEqual(outcome.message.id, "message-1");
  });

  test("reports the exact handler failure without classifying it", async () => {
    const failure = new Error("database unavailable");
    const subscriber = createSubscriber([
      handle(orderPlaced, () => {
        throw failure;
      }),
    ]);

    const outcome = await subscriber.handle(message());

    assert.ok(outcome.status === "failed");
    assert.strictEqual(outcome.error, failure);
  });

  test("treats unsupported schemas as configuration faults, not message outcomes", async () => {
    const asyncEvent = defineEvent(
      "order.checked",
      z.object({ orderId: z.string() }).refine(async () => true),
    );
    const subscriber = createSubscriber([handle(asyncEvent, () => {})]);

    await assert.rejects(
      () => subscriber.handle(message("order.checked")),
      UnsupportedEventSchemaError,
    );
  });

  test("detects invalid and duplicate registrations at startup", () => {
    assert.throws(() => createSubscriber([]), /at least one event handler/);
    assert.throws(
      () => createSubscriber([handle(orderPlaced, () => {}), handle(orderPlaced, () => {})]),
      /already has a handler/,
    );
    assert.throws(
      () => createSubscriber([{ event: orderPlaced, handler: undefined } as never]),
      /must be a function/,
    );
  });

  test("types each handler from its event definition", () => {
    void (() => {
      handle(orderPlaced, (data, receivedMessage) => {
        data.orderId.toUpperCase();
        receivedMessage.event.data.currency.toLowerCase();
        // @ts-expect-error The order.placed schema does not declare this field.
        void data.reason;
      });
    });
  });
});

describe("subscription policy", () => {
  test("acknowledges handled outcomes without invoking failure policy", async () => {
    const outcome = await createSubscriber([handle(orderPlaced, () => {})]).handle(message());
    const policy: SubscriptionPolicy = () => {
      assert.fail("policy must not run for a handled message");
    };

    assert.strictEqual(await decideSubscriptionOutcome(outcome, policy), "acknowledge");
  });

  test("lets the caller independently decide each non-handled outcome", async () => {
    const subscriber = createSubscriber([
      handle(orderPlaced, () => {
        throw new Error("database unavailable");
      }),
    ]);
    const outcomes = await Promise.all([
      subscriber.handle(message("invoice.issued")),
      subscriber.handle(message("order.placed", { orderId: 42 })),
      subscriber.handle(message()),
    ]);
    const policy: SubscriptionPolicy = async (outcome) => {
      if (outcome.status === "unhandled") return "acknowledge";
      if (outcome.status === "invalid") return "reject";
      return "retry";
    };

    assert.deepStrictEqual(
      await Promise.all(outcomes.map((outcome) => decideSubscriptionOutcome(outcome, policy))),
      ["acknowledge", "reject", "retry"],
    );
  });

  test("rejects an invalid decision returned by JavaScript callers", async () => {
    const outcome = await createSubscriber([handle(orderPlaced, () => {})]).handle(
      message("invoice.issued"),
    );
    const badPolicy = (() => "discard") as unknown as SubscriptionPolicy;

    await assert.rejects(
      () => decideSubscriptionOutcome(outcome, badPolicy),
      /invalid delivery decision: discard/,
    );
  });
});
