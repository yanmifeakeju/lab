import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { validateSchema } from "./validate.ts";
import { CommandValidationError } from "./errors.ts";

describe("validateSchema", () => {
  test("valid input passes through", async () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const input = { name: "Alice", age: 30 };

    const result = await validateSchema(schema, input, "test-cmd");

    expect(result).toEqual({ name: "Alice", age: 30 });
  });

  test("invalid input throws CommandValidationError", async () => {
    const schema = z.object({ name: z.string() });
    const input = { name: 123 };

    expect(validateSchema(schema, input, "test-cmd")).rejects.toThrow(
      CommandValidationError,
    );
  });

  test("error includes formatted issues with paths", async () => {
    const schema = z.object({
      user: z.object({
        email: z.email(),
      }),
    });
    const input = { user: { email: "not-an-email" } };

    try {
      await validateSchema(schema, input, "create-user");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CommandValidationError);
      const validationError = error as CommandValidationError;
      expect(validationError.commandName).toBe("create-user");
      expect(validationError.issues.length).toBeGreaterThan(0);
      expect(validationError.issues.some((i) => i.includes("email"))).toBe(
        true,
      );
    }
  });

  test("handles root-level validation errors", async () => {
    const schema = z.string();
    const input = 123;

    try {
      await validateSchema(schema, input, "string-cmd");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CommandValidationError);
      const validationError = error as CommandValidationError;
      expect(validationError.issues.length).toBeGreaterThan(0);
    }
  });

  test("handles async schema validation", async () => {
    const schema = z.object({
      code: z.string().refine(async (val) => val.length >= 3, {
        message: "Code must be at least 3 characters",
      }),
    });

    const validResult = await validateSchema(
      schema,
      { code: "ABC" },
      "async-cmd",
    );
    expect(validResult).toEqual({ code: "ABC" });

    expect(validateSchema(schema, { code: "AB" }, "async-cmd")).rejects.toThrow(
      CommandValidationError,
    );
  });
});
