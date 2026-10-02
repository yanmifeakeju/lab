import { assertNonEmptyString } from "../utils/string.ts";
import type { Topic } from "./types.ts";

export function defineTopic<TName extends string>(name: TName): Topic<TName> {
  assertNonEmptyString(name, "Topic name");
  return Object.freeze({ name });
}
