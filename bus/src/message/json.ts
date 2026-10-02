import { isPlainObject } from "../utils/object.ts";
import { NonJsonValueError } from "./errors.ts";
import type { JsonValue } from "./types.ts";

export function normalizeJson(value: unknown): JsonValue {
  return normalize(value, "$", new WeakSet<object>());
}

function normalize(value: unknown, path: string, ancestors: WeakSet<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new NonJsonValueError(path, "numbers must be finite");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (value === undefined) {
    throw new NonJsonValueError(path, "undefined is only allowed on object properties");
  }
  if (typeof value !== "object") {
    throw new NonJsonValueError(path, `received ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new NonJsonValueError(path, "cyclic values are not supported");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new NonJsonValueError(`${path}[${index}]`, "sparse arrays are not supported");
        }
        result.push(normalize(value[index], `${path}[${index}]`, ancestors));
      }
      return Object.freeze(result);
    }

    if (!isPlainObject(value)) {
      const name = value.constructor?.name ?? "object";
      throw new NonJsonValueError(path, `received ${name}; expected a plain object`);
    }

    const entries: Array<readonly [string, JsonValue]> = [];
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) {
        entries.push([key, normalize(child, propertyPath(path, key), ancestors)]);
      }
    }
    return Object.freeze(Object.fromEntries(entries) as Record<string, JsonValue>);
  } finally {
    ancestors.delete(value);
  }
}

function propertyPath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}
