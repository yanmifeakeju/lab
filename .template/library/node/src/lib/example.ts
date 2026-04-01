import type { Result } from "../types.js";

export type ExampleOptions = {
  readonly name: string;
};

/**
 * Example creates a greeting message from the provided options.
 * Returns an error if the name is empty.
 */
export function example(options: ExampleOptions): Result<string, "empty_name"> {
  if (options.name.length === 0) {
    return { ok: false, error: "empty_name" };
  }

  return { ok: true, value: `Hello, ${options.name}` };
}
