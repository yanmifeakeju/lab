import { isPlainObject } from "../utils/object.ts";
import { isNonEmptyString } from "../utils/string.ts";
import { MessageDecodeError } from "./errors.ts";
import { normalizeJson } from "./json.ts";
import type { Event, JsonValue, Message, MessageMetadata } from "./types.ts";

export function encodeMessage(message: Message): string {
  return JSON.stringify(normalizeJson(message));
}

export function decodeMessage(body: string): Message {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new MessageDecodeError("Message body is not valid JSON", { cause: error });
  }
  return parseMessage(value);
}

export function parseMessage(value: unknown): Message {
  try {
    if (!isPlainObject(value)) {
      throw new Error("message must be an object");
    }
    if (value["messageVersion"] !== 1) {
      throw new Error('"messageVersion" must be 1');
    }

    const id = requiredString(value, "id");
    const source = requiredString(value, "source");
    const rawCreatedAt = requiredString(value, "createdAt");
    const createdAt = normalizeRfc3339Timestamp(rawCreatedAt);
    if (createdAt === undefined) {
      throw new Error('"createdAt" must be a valid RFC 3339 timestamp');
    }

    const rawEvent = value["event"];
    if (!isPlainObject(rawEvent)) {
      throw new Error('"event" must be an object');
    }
    const type = requiredString(rawEvent, "type", "event.type");
    if (!Object.hasOwn(rawEvent, "data")) {
      throw new Error('"event.data" is required');
    }
    const data = normalizeJson(rawEvent["data"]);
    const metadata = parseMetadata(value["metadata"]);

    const event: Event<string, JsonValue> = Object.freeze({ type, data });
    return Object.freeze({
      messageVersion: 1,
      id,
      source,
      createdAt,
      event,
      metadata,
    });
  } catch (error) {
    if (error instanceof MessageDecodeError) {
      throw error;
    }
    throw new MessageDecodeError(
      `Invalid message envelope: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function requiredString(
  object: Record<string, unknown>,
  key: string,
  label = key,
): string {
  const value = object[key];
  if (!isNonEmptyString(value)) {
    throw new Error(`"${label}" must be a non-empty string`);
  }
  return value;
}

function parseMetadata(value: unknown): MessageMetadata {
  if (!isPlainObject(value)) {
    throw new Error('"metadata" must be an object');
  }

  const entries: Array<readonly [string, string | number | boolean]> = [];
  for (const [key, item] of Object.entries(value)) {
    if (
      (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") ||
      (typeof item === "number" && !Number.isFinite(item))
    ) {
      throw new Error(`"metadata.${key}" must be a scalar`);
    }
    entries.push([key, item]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function normalizeRfc3339Timestamp(value: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
    value,
  );
  if (match === null) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[7] ?? 0);
  const offsetMinute = Number(match[8] ?? 0);

  const valid =
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value));

  return valid ? new Date(value).toISOString() : undefined;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
