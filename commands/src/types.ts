import type { StandardSchemaV1 } from "@standard-schema/spec";

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
