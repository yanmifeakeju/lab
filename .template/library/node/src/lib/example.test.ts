import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { example } from "./example.js";

describe("example", () => {
  it("returns greeting for valid name", () => {
    const result = example({ name: "World" });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value, "Hello, World");
    }
  });

  it("returns error for empty name", () => {
    const result = example({ name: "" });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "empty_name");
    }
  });
});
