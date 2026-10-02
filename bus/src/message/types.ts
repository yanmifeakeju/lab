import type { StandardSchemaV1 } from "@standard-schema/spec";

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type DeepReadonly<T> = unknown extends T
  ? T
  : JsonValue extends T
    ? JsonValue
    : T extends JsonPrimitive
      ? T
      : T extends readonly unknown[]
        ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T extends object
          ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
          : T;

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
  readonly messageVersion: 1;
  readonly id: string;
  readonly source: string;
  /**
   * When this immutable message was constructed, not when a broker accepted it.
   * Decoding normalizes it to UTC with millisecond precision, so decoded values
   * order lexically.
   */
  readonly createdAt: string;
  readonly event: TEvent;
  readonly metadata: MessageMetadata;
}
