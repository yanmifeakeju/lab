import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  CommandNotFoundError,
  CommandAlreadyExistsError,
  CommandRegistrationError,
} from "./errors.ts";
import { validateSchema } from "./validate.ts";

export interface CommandDefinition<
  Schema extends StandardSchemaV1,
  Context,
  Result,
> {
  schema: Schema;
  run: (
    data: StandardSchemaV1.InferOutput<Schema>,
    context: Context
  ) => Promise<Result> | Result;
}

export interface Commands<Context> {
  add<Schema extends StandardSchemaV1, Result>(
    name: string,
    definition: CommandDefinition<Schema, Context, Result>
  ): Commands<Context>;

  init(context: Context): CommandRunner;
  list(): string[];
  has(name: string): boolean;
}

export interface CommandRunner {
  execute(name: string, data: unknown): Promise<void>;
  list(): string[];
  has(name: string): boolean;
}

interface StoredCommand<Context> {
  schema: StandardSchemaV1;
  run: (data: unknown, context: Context) => Promise<unknown> | unknown;
}

export function createCommands<Context>(): Commands<Context> {
  const registry = new Map<string, StoredCommand<Context>>();

  const builder: Commands<Context> = {
    add<Schema extends StandardSchemaV1, Result>(
      name: string,
      definition: CommandDefinition<Schema, Context, Result>
    ): Commands<Context> {
      if (!definition || typeof definition !== "object") {
        throw new CommandRegistrationError(
          `Invalid definition for command "${name}": definition must be an object`
        );
      }
      if (!definition.schema) {
        throw new CommandRegistrationError(
          `Invalid definition for command "${name}": missing schema`
        );
      }
      if (
        !definition.schema["~standard"] ||
        typeof definition.schema["~standard"].validate !== "function"
      ) {
        throw new CommandRegistrationError(
          `Invalid definition for command "${name}": schema must be a Standard Schema (missing ~standard.validate)`
        );
      }
      if (typeof definition.run !== "function") {
        throw new CommandRegistrationError(
          `Invalid definition for command "${name}": run must be a function`
        );
      }
      if (registry.has(name)) {
        throw new CommandAlreadyExistsError(name);
      }

      registry.set(name, {
        schema: definition.schema,
        run: definition.run as (
          data: unknown,
          context: Context
        ) => Promise<unknown> | unknown,
      });

      return builder;
    },

    init(context: Context): CommandRunner {
      return {
        async execute(name: string, data: unknown): Promise<void> {
          const command = registry.get(name);
          if (!command) {
            throw new CommandNotFoundError(name);
          }

          const validatedData = await validateSchema(
            command.schema,
            data,
            name
          );
          await command.run(validatedData, context);
        },

        list(): string[] {
          return Array.from(registry.keys());
        },

        has(name: string): boolean {
          return registry.has(name);
        },
      };
    },

    list(): string[] {
      return Array.from(registry.keys());
    },

    has(name: string): boolean {
      return registry.has(name);
    },
  };

  return builder;
}
