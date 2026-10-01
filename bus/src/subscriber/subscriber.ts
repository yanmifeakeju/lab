import type { StandardSchemaV1 } from "@standard-schema/spec";
import { EventValidationError, validateEventData } from "../message/index.ts";
import type { EventDefinition } from "../message/index.ts";
import { isStandardSchema } from "../utils/standard.ts";
import { isNonEmptyString } from "../utils/string.ts";
import type {
  EventHandler,
  HandlerRegistration,
  Subscriber,
  SubscriptionOutcome,
} from "./types.ts";

interface RegisteredHandler {
  readonly event: EventDefinition<string, StandardSchemaV1>;
  readonly handler: HandlerRegistration["handler"];
}

export function handle<TType extends string, TSchema extends StandardSchemaV1>(
  event: EventDefinition<TType, TSchema>,
  handler: EventHandler<TType, TSchema>,
): HandlerRegistration {
  return { event, handler: handler as HandlerRegistration["handler"] };
}

export function createSubscriber(
  registrations: readonly HandlerRegistration[],
): Subscriber {
  if (!Array.isArray(registrations) || registrations.length === 0) {
    throw new Error("Subscriber must register at least one event handler");
  }

  const handlers = new Map<string, RegisteredHandler>();
  for (const registration of registrations) {
    assertValidRegistration(registration);
    const eventType = registration.event.type;
    if (handlers.has(eventType)) {
      throw new Error(`Event "${eventType}" already has a handler`);
    }
    handlers.set(eventType, {
      event: registration.event,
      handler: registration.handler,
    });
  }

  return {
    async handle(message): Promise<SubscriptionOutcome> {
      const registration = handlers.get(message.event.type);
      if (registration === undefined) {
        return { status: "unhandled", message };
      }

      let data;
      try {
        data = validateEventData(registration.event, message.event.data);
      } catch (error) {
        if (error instanceof EventValidationError) {
          return { status: "invalid", error, message };
        }
        throw error;
      }

      const validatedMessage = {
        ...message,
        event: { ...message.event, data },
      };

      try {
        await registration.handler(data as never, validatedMessage as never);
      } catch (error) {
        return { status: "failed", error, message: validatedMessage };
      }

      return { status: "handled", message: validatedMessage };
    },
  };
}

function assertValidRegistration(value: unknown): asserts value is HandlerRegistration {
  if (typeof value !== "object" || value === null) {
    throw new Error("Subscriber registrations must be created with handle(event, handler)");
  }

  const registration = value as Partial<HandlerRegistration>;
  const event = registration.event;
  if (
    typeof event !== "object" ||
    event === null ||
    !isNonEmptyString(event.type) ||
    !isStandardSchema(event.schema)
  ) {
    throw new Error("Subscriber registration must contain a valid event definition");
  }
  if (typeof registration.handler !== "function") {
    throw new Error(`Handler for event "${event.type}" must be a function`);
  }
}
