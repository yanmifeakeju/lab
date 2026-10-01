export {
  defineEvent,
  EventValidationError,
  UnsupportedEventSchemaError,
  validateEventData,
} from "./message/index.ts";
export type {
  Event,
  EventDefinition,
  Message,
  MessageMetadata,
} from "./message/index.ts";

export { createPublisher } from "./publisher/index.ts";
export type {
  Publisher,
  PublisherConfig,
  PublishRequest,
  PublishResult,
} from "./publisher/index.ts";

export {
  createSubscriber,
  decideSubscriptionOutcome,
  handle,
} from "./subscriber/index.ts";
export type {
  ActionableSubscriptionOutcome,
  DeliveryDecision,
  EventHandler,
  FailedOutcome,
  HandledOutcome,
  HandlerRegistration,
  InvalidOutcome,
  PayloadOf,
  Subscriber,
  SubscriptionOutcome,
  SubscriptionPolicy,
  UnhandledOutcome,
} from "./subscriber/index.ts";

// SQS lives at "./sqs" so the optional AWS SDK peer loads only when used.
export { defineTopic } from "./brokers/index.ts";
export type { BrokerReceipt, MessageBroker, Topic } from "./brokers/index.ts";
