import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { CommandDefinition, Commands, CommandRunner } from "../types.ts";
import {
  CommandNotFoundError,
  CommandAlreadyExistsError,
  CommandRegistrationError,
} from "./errors.ts";
import { validateSchema } from "./validate.ts";

interface StoredCommand<Context> {
  schema: StandardSchemaV1;
  run: (data: unknown, context: Context) => Promise<unknown> | unknown;
}

/**
 * createCommands creates a new command registry.
 * The split between Commands (registry) and CommandRunner (executor) allows for 
 * a clear separation between setup/configuration and execution phases.
 */
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
