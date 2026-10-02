import { defineTopic } from "../brokers/topic.ts";
import { isPlainObject } from "../utils/object.ts";
import { isNonEmptyString } from "../utils/string.ts";
import { parseMessage } from "../message/codec.ts";
import { normalizeJson } from "../message/json.ts";
import { PublicationDecodeError } from "./errors.ts";
import type { Publication } from "./types.ts";

export function encodePublication(publication: Publication): string {
  return JSON.stringify(
    normalizeJson({
      topic: publication.topic.name,
      message: publication.message,
    }),
  );
}

export function decodePublication(body: string): Publication {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new PublicationDecodeError("Publication body is not valid JSON", { cause: error });
  }
  return parsePublication(value);
}

export function parsePublication(value: unknown): Publication {
  try {
    if (!isPlainObject(value)) {
      throw new Error("publication must be an object");
    }
    const topicName = value["topic"];
    if (!isNonEmptyString(topicName)) {
      throw new Error('"topic" must be a non-empty string');
    }

    return Object.freeze({
      topic: defineTopic(topicName),
      message: parseMessage(value["message"]),
    });
  } catch (error) {
    if (error instanceof PublicationDecodeError) {
      throw error;
    }
    throw new PublicationDecodeError(
      `Invalid publication: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
