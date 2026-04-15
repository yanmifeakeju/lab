import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * CommandDefinition represents a single command with its validation schema and execution logic.
 */
export interface CommandDefinition<
  Schema extends StandardSchemaV1,
  Context,
  Result,
> {
  /** The schema used to validate the input data before execution. */
  schema: Schema;
  /** The function that executes the command logic. */
  run: (
    data: StandardSchemaV1.InferOutput<Schema>,
    context: Context
  ) => Promise<Result> | Result;
}

/**
 * Commands is a registry for defining and initializing command runners.
 */
export interface Commands<Context> {
  /** Add registers a new command definition with a unique name. */
  add<Schema extends StandardSchemaV1, Result>(
    name: string,
    definition: CommandDefinition<Schema, Context, Result>
  ): Commands<Context>;

  /** Init creates an immutable CommandRunner with the provided execution context. */
  init(context: Context): CommandRunner;
  /** List returns all registered command names. */
  list(): string[];
  /** Has returns true if a command with the given name is registered. */
  has(name: string): boolean;
}

/**
 * CommandRunner executes registered commands using a pre-configured context.
 */
export interface CommandRunner {
  /** Execute validates input data against the command's schema and runs its handler. */
  execute(name: string, data: unknown): Promise<void>;
  /** List returns all available command names for this runner. */
  list(): string[];
  /** Has returns true if the runner can execute the given command name. */
  has(name: string): boolean;
}
