import type { StandardSchemaV1 } from "@standard-schema/spec";
import { isStandardSchema } from "../utils/standard.ts";
import type { EventDefinition } from "./types.ts";

export function defineEvent<TType extends string, TSchema extends StandardSchemaV1>(
  type: TType,
  schema: TSchema,
): EventDefinition<TType, TSchema> {
  if (type.trim().length === 0) {
    throw new Error("Event type must be a non-empty string");
  }
  if (!isStandardSchema(schema)) {
    throw new Error(`Event "${type}" must have a Standard Schema`);
  }
  return { type, schema };
}
