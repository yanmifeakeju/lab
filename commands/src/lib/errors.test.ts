import { test, expect, describe } from "bun:test";
import {
  CommandNotFoundError,
  CommandAlreadyExistsError,
  CommandValidationError,
  CommandRegistrationError,
} from "./errors.ts";

describe("CommandNotFoundError", () => {
  test("includes command name in metadata", () => {
    const error = new CommandNotFoundError("process-order");
    expect(error.name).toBe("CommandNotFoundError");
    expect(error.commandName).toBe("process-order");
  });

  test("has descriptive message", () => {
    const error = new CommandNotFoundError("send-email");
    expect(error.message).toBe("Command not found: send-email");
  });
});

describe("CommandAlreadyExistsError", () => {
  test("includes command name in metadata", () => {
    const error = new CommandAlreadyExistsError("duplicate-cmd");
    expect(error.name).toBe("CommandAlreadyExistsError");
    expect(error.commandName).toBe("duplicate-cmd");
  });

  test("has descriptive message", () => {
    const error = new CommandAlreadyExistsError("my-command");
    expect(error.message).toBe("Command already exists: my-command");
  });
});

describe("CommandValidationError", () => {
  test("includes command name and issues in metadata", () => {
    const issues = ["name: Required", "age: Expected number"];
    const error = new CommandValidationError("create-user", issues);
    expect(error.name).toBe("CommandValidationError");
    expect(error.commandName).toBe("create-user");
    expect(error.issues).toEqual(issues);
  });

  test("has descriptive message with issues", () => {
    const issues = ["field1: invalid", "field2: missing"];
    const error = new CommandValidationError("test-cmd", issues);
    expect(error.message).toBe(
      'Validation failed for command "test-cmd": field1: invalid; field2: missing'
    );
  });
});

describe("CommandRegistrationError", () => {
  test("includes custom message", () => {
    const error = new CommandRegistrationError("Missing schema property");
    expect(error.name).toBe("CommandRegistrationError");
    expect(error.message).toBe("Missing schema property");
  });
});
