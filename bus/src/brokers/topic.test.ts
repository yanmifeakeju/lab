import assert from "node:assert";
import { describe, test } from "node:test";
import { defineTopic } from "./index.ts";

describe("topic definition", () => {
  test("defines only a logical broker address", () => {
    const topic = defineTopic("orders");

    assert.deepStrictEqual(topic, { name: "orders" });
    assert.ok(!("events" in topic));
    assert.ok(!("subscribers" in topic));
  });

  test("rejects an empty address", () => {
    assert.throws(() => defineTopic(""), /Topic name must be a non-empty string/);
  });
});
