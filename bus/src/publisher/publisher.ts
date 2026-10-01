import { randomUUID } from "node:crypto";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { validateEventData } from "../message/index.ts";
import type { Event, Message, MessageMetadata } from "../message/index.ts";
import { isPlainObject } from "../utils/object.ts";
import type {
  PublishRequest,
  PublishResult,
  Publisher,
  PublisherConfig,
} from "./types.ts";

export function createPublisher(config: PublisherConfig): Publisher {
  const { source, broker, generateId = randomUUID, now = () => new Date() } = config;
  assertNonEmpty(source, "Publisher source");
  if (typeof broker?.publish !== "function") {
    throw new Error("Publisher broker must provide a publish function");
  }
  if (typeof generateId !== "function") {
    throw new Error("Publisher generateId must be a function");
  }
  if (typeof now !== "function") {
    throw new Error("Publisher now must be a function");
  }

  return {
    async publish<
      TType extends string,
      TSchema extends StandardSchemaV1,
      TTopicName extends string,
    >(
      request: PublishRequest<TType, TSchema, TTopicName>,
    ): Promise<PublishResult<TType, TSchema, TTopicName>> {
      const data = validateEventData(request.event, request.data);
      const metadata = request.metadata ?? {};
      assertValidMetadata(metadata);

      const id = generateId();
      assertNonEmpty(id, "Generated message id");

      const publishedAt = now();
      if (!(publishedAt instanceof Date) || Number.isNaN(publishedAt.getTime())) {
        throw new Error("Publisher now must return a valid Date");
      }

      const event: Event<TType, StandardSchemaV1.InferOutput<TSchema>> = {
        type: request.event.type,
        data,
      };
      const message: Message<typeof event> = {
        id,
        source,
        publishedAt: publishedAt.toISOString(),
        event,
        metadata,
      };

      // No serialization, fan-out, retry, or failure classification here.
      const receipt = await broker.publish(request.topic, message);
      return { topic: request.topic, message, receipt };
    },
  };
}

function assertValidMetadata(metadata: MessageMetadata): void {
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
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}
