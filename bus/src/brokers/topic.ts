import type { Topic } from "./types.ts";

export function defineTopic<TName extends string>(name: TName): Topic<TName> {
  if (name.trim().length === 0) {
    throw new Error("Topic name must be a non-empty string");
  }
  return { name };
}
