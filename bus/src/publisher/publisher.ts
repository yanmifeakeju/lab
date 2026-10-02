import { randomUUID } from "node:crypto";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { defineTopic } from "../brokers/topic.ts";
import { normalizeJson, validateEventData } from "../message/index.ts";
import type {
  DeepReadonly,
  Event,
  Message,
  MessageMetadata,
} from "../message/index.ts";
import { isPlainObject } from "../utils/object.ts";
import { assertNonEmptyString } from "../utils/string.ts";
import type {
  CreatedPublication,
  Publication,
  PublishRequest,
  Publisher,
  PublisherConfig,
  SendResult,
} from "./types.ts";

export function createPublisher(config: PublisherConfig): Publisher {
  const { source, broker, generateId = randomUUID, now = () => new Date() } = config;
  assertNonEmptyString(source, "Publisher source");
  if (typeof broker?.publish !== "function") {
    throw new Error("Publisher broker must provide a publish function");
  }
  if (typeof generateId !== "function") {
    throw new Error("Publisher generateId must be a function");
  }
  if (typeof now !== "function") {
    throw new Error("Publisher now must be a function");
  }

  const create = <
    TType extends string,
    TSchema extends StandardSchemaV1,
    TTopicName extends string,
  >(
    request: PublishRequest<TType, TSchema, TTopicName>,
  ): CreatedPublication<TType, TSchema, TTopicName> => {
    const validatedData = validateEventData(request.event, request.data);
    const data = normalizeJson(validatedData) as DeepReadonly<
      StandardSchemaV1.InferOutput<TSchema>
    >;
    const metadata = normalizeMetadata(request.metadata ?? {});

    const id = generateId();
    assertNonEmptyString(id, "Generated message id");

    const createdAt = now();
    if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
      throw new Error("Publisher now must return a valid Date");
    }

    const event: Event<TType, typeof data> = Object.freeze({
      type: request.event.type,
      data,
    });
    const message: Message<typeof event> = Object.freeze({
      messageVersion: 1,
      id,
      source,
      createdAt: createdAt.toISOString(),
      event,
      metadata,
    });

    return Object.freeze({
      topic: defineTopic(request.topic.name),
      message,
    });
  };

  const send = async <TEvent extends Event, TTopicName extends string>(
    publication: Publication<TEvent, TTopicName>,
  ): Promise<SendResult<TEvent, TTopicName>> => {
    const receipt = await broker.publish(publication.topic, publication.message);
    return { ...publication, receipt };
  };

  const publish: Publisher["publish"] = async (request) => send(create(request));

  return { create, send, publish };
}

function normalizeMetadata(metadata: MessageMetadata): MessageMetadata {
  if (!isPlainObject(metadata)) {
    throw new Error("Message metadata must be a plain object");
  }

  for (const [key, value] of Object.entries(metadata)) {
    if (
      (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") ||
      (typeof value === "number" && !Number.isFinite(value))
    ) {
      throw new Error(`Message metadata value for "${key}" must be a scalar`);
    }
  }

  return normalizeJson(metadata) as unknown as MessageMetadata;
}
