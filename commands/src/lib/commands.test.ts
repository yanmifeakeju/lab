import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { createCommands } from "./commands.ts";
import {
  CommandNotFoundError,
  CommandAlreadyExistsError,
  CommandValidationError,
  CommandRegistrationError,
} from "./errors.ts";

type TestContext = {
  logger: { log: (msg: string) => void };
  counter: number;
};

describe("createCommands", () => {
  test("1. register and execute command successfully", async () => {
    const commands = createCommands<TestContext>();
    let handlerCalled = false;
    let receivedData: unknown;

    commands.add("greet", {
      schema: z.object({ name: z.string() }),
      run: (data) => {
        handlerCalled = true;
        receivedData = data;
        return { greeting: `Hello, ${data.name}!` };
      },
    });

    const runner = commands.init({ logger: { log: () => {} }, counter: 0 });
    await runner.execute("greet", { name: "World" });

    expect(handlerCalled).toBe(true);
    expect(receivedData).toEqual({ name: "World" });
  });

  test("2. context is passed to handler correctly", async () => {
    const logs: string[] = [];
    let receivedCounter: number | undefined;
    const commands = createCommands<TestContext>();

    commands.add("log-message", {
      schema: z.object({ message: z.string() }),
      run: (data, ctx) => {
        ctx.logger.log(data.message);
        receivedCounter = ctx.counter;
        return { logged: true, counter: ctx.counter };
      },
    });

    const runner = commands.init({
      logger: { log: (msg) => logs.push(msg) },
      counter: 42,
    });

    await runner.execute("log-message", { message: "test" });

    expect(logs).toEqual(["test"]);
    expect(receivedCounter).toBe(42);
  });

  test("3. throw CommandNotFoundError for missing command", async () => {
    const commands = createCommands<TestContext>();
    const runner = commands.init({ logger: { log: () => {} }, counter: 0 });

    expect(runner.execute("nonexistent", {})).rejects.toThrow(
      CommandNotFoundError,
    );

    try {
      await runner.execute("nonexistent", {});
    } catch (error) {
      expect(error).toBeInstanceOf(CommandNotFoundError);
      expect((error as CommandNotFoundError).commandName).toBe("nonexistent");
    }
  });

  test("4. throw CommandRegistrationError for invalid definition", () => {
    const commands = createCommands<TestContext>();

    expect(() => {
      commands.add("bad-cmd", null as never);
    }).toThrow(CommandRegistrationError);

    expect(() => {
      commands.add("missing-schema", { run: () => {} } as never);
    }).toThrow(CommandRegistrationError);

    expect(() => {
      commands.add("missing-run", { schema: z.object({}) } as never);
    }).toThrow(CommandRegistrationError);
  });

  test("4b. throw CommandRegistrationError for invalid schema (missing ~standard.validate)", () => {
    const commands = createCommands<TestContext>();

    // Plain object is truthy but not a Standard Schema
    expect(() => {
      commands.add("bad-schema", { schema: {}, run: () => {} } as never);
    }).toThrow(CommandRegistrationError);

    // Object with ~standard but no validate function
    expect(() => {
      commands.add("bad-schema-2", {
        schema: { "~standard": {} },
        run: () => {},
      } as never);
    }).toThrow(CommandRegistrationError);

    // Verify error message mentions Standard Schema
    try {
      commands.add("bad-schema-3", { schema: { foo: "bar" }, run: () => {} } as never);
    } catch (error) {
      expect(error).toBeInstanceOf(CommandRegistrationError);
      expect((error as CommandRegistrationError).message).toContain("~standard.validate");
    }
  });

  test("5. throw CommandAlreadyExistsError for duplicate registration", () => {
    const commands = createCommands<TestContext>();

    commands.add("unique", {
      schema: z.object({}),
      run: () => "first",
    });

    expect(() => {
      commands.add("unique", {
        schema: z.object({}),
        run: () => "second",
      });
    }).toThrow(CommandAlreadyExistsError);

    try {
      commands.add("unique", {
        schema: z.object({}),
        run: () => "second",
      });
    } catch (error) {
      expect((error as CommandAlreadyExistsError).commandName).toBe("unique");
    }
  });

  test("6. throw CommandValidationError for invalid input data", async () => {
    const commands = createCommands<TestContext>();

    commands.add("create-user", {
      schema: z.object({
        email: z.string().email(),
        age: z.number().min(0),
      }),
      run: (data) => data,
    });

    const runner = commands.init({ logger: { log: () => {} }, counter: 0 });

    await expect(
      runner.execute("create-user", { email: "not-email", age: -5 }),
    ).rejects.toThrow(CommandValidationError);

    try {
      await runner.execute("create-user", { email: "invalid", age: "string" });
    } catch (error) {
      expect(error).toBeInstanceOf(CommandValidationError);
      const validationError = error as CommandValidationError;
      expect(validationError.commandName).toBe("create-user");
      expect(validationError.issues.length).toBeGreaterThan(0);
    }
  });

  test("7. list() returns registered command names", () => {
    const commands = createCommands<TestContext>();

    expect(commands.list()).toEqual([]);

    commands
      .add("cmd-a", { schema: z.object({}), run: () => {} })
      .add("cmd-b", { schema: z.object({}), run: () => {} })
      .add("cmd-c", { schema: z.object({}), run: () => {} });

    expect(commands.list()).toEqual(["cmd-a", "cmd-b", "cmd-c"]);

    const runner = commands.init({ logger: { log: () => {} }, counter: 0 });
    expect(runner.list()).toEqual(["cmd-a", "cmd-b", "cmd-c"]);
  });

  test("8. has() correctly reports existence", () => {
    const commands = createCommands<TestContext>();

    expect(commands.has("missing")).toBe(false);

    commands.add("existing", { schema: z.object({}), run: () => {} });

    expect(commands.has("existing")).toBe(true);
    expect(commands.has("missing")).toBe(false);

    const runner = commands.init({ logger: { log: () => {} }, counter: 0 });
    expect(runner.has("existing")).toBe(true);
    expect(runner.has("missing")).toBe(false);
  });

  test("9. multiple init() calls produce independent runners", async () => {
    const receivedValues: number[] = [];
    const commands = createCommands<{ value: number }>();

    commands.add("get-value", {
      schema: z.object({}),
      run: (_, ctx) => {
        receivedValues.push(ctx.value);
        return ctx.value;
      },
    });

    const runner1 = commands.init({ value: 100 });
    const runner2 = commands.init({ value: 200 });

    await runner1.execute("get-value", {});
    await runner2.execute("get-value", {});

    expect(receivedValues).toEqual([100, 200]);
  });

  test("10. handler errors propagate to caller", async () => {
    const commands = createCommands<TestContext>();

    commands.add("failing-cmd", {
      schema: z.object({}),
      run: () => {
        throw new Error("Handler exploded");
      },
    });

    const runner = commands.init({ logger: { log: () => {} }, counter: 0 });

    await expect(runner.execute("failing-cmd", {})).rejects.toThrow(
      "Handler exploded",
    );
  });

  test("supports async handlers", async () => {
    let completed = false;
    const commands = createCommands<TestContext>();

    commands.add("async-cmd", {
      schema: z.object({ delay: z.number() }),
      run: async (data) => {
        await new Promise((resolve) => setTimeout(resolve, data.delay));
        completed = true;
        return { completed: true };
      },
    });

    const runner = commands.init({ logger: { log: () => {} }, counter: 0 });
    await runner.execute("async-cmd", { delay: 10 });

    expect(completed).toBe(true);
  });

  test("supports method chaining on add()", () => {
    const commands = createCommands<TestContext>();

    const result = commands
      .add("a", { schema: z.object({}), run: () => {} })
      .add("b", { schema: z.object({}), run: () => {} })
      .add("c", { schema: z.object({}), run: () => {} });

    expect(result).toBe(commands);
    expect(commands.list()).toEqual(["a", "b", "c"]);
  });
});
