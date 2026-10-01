import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { BrokerReceipt, MessageBroker, Topic } from "../brokers/types.ts";
import type { Event, EventDefinition, Message, MessageMetadata } from "../message/types.ts";

export interface PublishRequest<
  TType extends string,
  TSchema extends StandardSchemaV1,
  TTopicName extends string,
> {
  readonly topic: Topic<TTopicName>;
  readonly event: EventDefinition<TType, TSchema>;
  readonly data: StandardSchemaV1.InferInput<TSchema>;
  readonly metadata?: MessageMetadata;
}

export interface PublishResult<
  TType extends string,
  TSchema extends StandardSchemaV1,
  TTopicName extends string,
> {
  readonly topic: Topic<TTopicName>;
  readonly message: Message<Event<TType, StandardSchemaV1.InferOutput<TSchema>>>;
  readonly receipt: BrokerReceipt;
}

export interface Publisher {
  publish<
    TType extends string,
    TSchema extends StandardSchemaV1,
    TTopicName extends string,
  >(
    request: PublishRequest<TType, TSchema, TTopicName>,
  ): Promise<PublishResult<TType, TSchema, TTopicName>>;
}

export interface PublisherConfig {
  readonly source: string;
  readonly broker: MessageBroker;
  /** Injectable mechanism dependencies make construction deterministic in tests. */
  readonly generateId?: () => string;
  readonly now?: () => Date;
}
