import type { StandardSchemaV1 } from "@standard-schema/spec";
import { formatStandardSchemaIssues } from "../utils/standard.ts";
import { EventValidationError, UnsupportedEventSchemaError } from "./errors.ts";
import type { EventDefinition } from "./types.ts";

export function validateEventData<TType extends string, TSchema extends StandardSchemaV1>(
  event: EventDefinition<TType, TSchema>,
  data: unknown,
): StandardSchemaV1.InferOutput<TSchema> {
  const result = event.schema["~standard"].validate(data);
  if (result instanceof Promise) {
    throw new UnsupportedEventSchemaError(event.type, "validation must be synchronous");
  }

  if (result.issues) {
    throw new EventValidationError(event.type, formatStandardSchemaIssues(result.issues));
  }

  return result.value;
}
