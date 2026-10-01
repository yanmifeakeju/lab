import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { EventValidationError } from "../message/index.ts";
import type { Event, EventDefinition, Message } from "../message/index.ts";

export type PayloadOf<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>;

export type EventHandler<TType extends string, TSchema extends StandardSchemaV1> = (
  data: PayloadOf<TSchema>,
  message: Message<Event<TType, PayloadOf<TSchema>>>,
) => unknown | Promise<unknown>;

/** Construct with `handle(event, handler)` so the pair is checked together. */
export interface HandlerRegistration {
  readonly event: EventDefinition<string, StandardSchemaV1>;
  readonly handler: (data: never, message: never) => unknown | Promise<unknown>;
}

export interface HandledOutcome {
  readonly status: "handled";
  readonly message: Message;
}

export interface UnhandledOutcome {
  readonly status: "unhandled";
  readonly message: Message;
}

export interface InvalidOutcome {
  readonly status: "invalid";
  readonly error: EventValidationError;
  readonly message: Message;
}

export interface FailedOutcome {
  readonly status: "failed";
  readonly error: unknown;
  readonly message: Message;
}

export type SubscriptionOutcome =
  | HandledOutcome
  | UnhandledOutcome
  | InvalidOutcome
  | FailedOutcome;

export type ActionableSubscriptionOutcome = Exclude<SubscriptionOutcome, HandledOutcome>;

export interface Subscriber {
  /** Reports what happened. Decoding and broker acknowledgment happen elsewhere. */
  handle(message: Message): Promise<SubscriptionOutcome>;
}

export type { Event, EventDefinition, Message } from "../message/index.ts";
