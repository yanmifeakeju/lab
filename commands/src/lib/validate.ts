import type { StandardSchemaV1 } from "@standard-schema/spec";
import { CommandValidationError } from "./errors.ts";

export async function validateSchema<T extends StandardSchemaV1>(
  schema: T,
  input: unknown,
  commandName: string
): Promise<StandardSchemaV1.InferOutput<T>> {
  let result = schema["~standard"].validate(input);
  if (result instanceof Promise) {
    result = await result;
  }

  if (result.issues) {
    const formatted = result.issues.map((issue) => {
      if (!issue.path?.length) return issue.message;
      const path = issue.path
        .map((segment) =>
          typeof segment === "object" && "key" in segment ? segment.key : segment
        )
        .join(".");
      return `${path}: ${issue.message}`;
    });
    throw new CommandValidationError(commandName, formatted);
  }

  return result.value;
}
