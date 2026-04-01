import { describe, it, expect } from "bun:test";
import { example } from "./example";

describe("example", () => {
  it("returns greeting for valid name", () => {
    const result = example({ name: "World" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("Hello, World");
    }
  });

  it("returns error for empty name", () => {
    const result = example({ name: "" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("empty_name");
    }
  });
});
