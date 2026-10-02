import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { BrokerReceipt, MessageBroker, Topic } from "../brokers/types.ts";
import type {
  DeepReadonly,
  Event,
  EventDefinition,
  JsonPrimitive,
  JsonValue,
  Message,
  MessageMetadata,
} from "../message/types.ts";

type NonJsonPart<T> = unknown extends T
  ? never
  : T extends JsonValue
    ? never
    : T extends JsonPrimitive
      ? never
      : T extends (...args: never[]) => unknown
        ? T
        : T extends Date | Map<unknown, unknown> | Set<unknown>
          ? T
          : T extends readonly (infer TItem)[]
            ? NonJsonPart<TItem>
            : T extends object
              ? { [TKey in keyof T]-?: NonJsonPart<Exclude<T[TKey], undefined>> }[keyof T]
              : T;

type JsonOutputConstraint<TSchema extends StandardSchemaV1> =
  [NonJsonPart<StandardSchemaV1.InferOutput<TSchema>>] extends [never]
    ? unknown
    : {
        readonly __eventSchemaOutputMustBeJsonCompatible: never;
      };

export interface PublishRequest<
  TType extends string,
  TSchema extends StandardSchemaV1,
  TTopicName extends string,
> {
  readonly topic: Topic<TTopicName>;
  readonly event: EventDefinition<TType, TSchema> & JsonOutputConstraint<TSchema>;
  readonly data: StandardSchemaV1.InferInput<TSchema>;
  readonly metadata?: MessageMetadata;
}

export interface Publication<
  TEvent extends Event = Event,
  TTopicName extends string = string,
> {
  readonly topic: Topic<TTopicName>;
  readonly message: Message<TEvent>;
}

export type CreatedPublication<
  TType extends string,
  TSchema extends StandardSchemaV1,
  TTopicName extends string,
> = Publication<
  Event<TType, DeepReadonly<StandardSchemaV1.InferOutput<TSchema>>>,
  TTopicName
>;

export interface SendResult<
  TEvent extends Event = Event,
  TTopicName extends string = string,
> extends Publication<TEvent, TTopicName> {
  readonly receipt: BrokerReceipt;
}

export type PublishResult<
  TType extends string,
  TSchema extends StandardSchemaV1,
  TTopicName extends string,
> = SendResult<
  Event<TType, DeepReadonly<StandardSchemaV1.InferOutput<TSchema>>>,
  TTopicName
>;

export interface Publisher {
  create<
    TType extends string,
    TSchema extends StandardSchemaV1,
    TTopicName extends string,
  >(
    request: PublishRequest<TType, TSchema, TTopicName>,
  ): CreatedPublication<TType, TSchema, TTopicName>;

  send<TEvent extends Event, TTopicName extends string>(
    publication: Publication<TEvent, TTopicName>,
  ): Promise<SendResult<TEvent, TTopicName>>;

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
