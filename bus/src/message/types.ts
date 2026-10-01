import type { StandardSchemaV1 } from "@standard-schema/spec";

export interface EventDefinition<
  TType extends string,
  TSchema extends StandardSchemaV1,
> {
  readonly type: TType;
  readonly schema: TSchema;
}

export interface Event<TType extends string = string, TData = unknown> {
  readonly type: TType;
  readonly data: TData;
}

export type MessageMetadata = Readonly<Record<string, string | number | boolean>>;

export interface Message<TEvent extends Event = Event> {
  readonly id: string;
  readonly source: string;
  readonly publishedAt: string;
  readonly event: TEvent;
  readonly metadata: MessageMetadata;
}
