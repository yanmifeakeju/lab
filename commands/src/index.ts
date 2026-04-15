/**
 * Commands provides a type-safe registry and runner for command patterns.
 */
export { createCommands } from "./lib/commands.ts";

/**
 * Public types for command definitions and execution.
 */
export type { Commands, CommandRunner, CommandDefinition } from "./types.ts";

/**
 * Errors thrown by the commands library.
 */
export {
  CommandNotFoundError,
  CommandAlreadyExistsError,
  CommandValidationError,
  CommandRegistrationError,
} from "./lib/errors.ts";
