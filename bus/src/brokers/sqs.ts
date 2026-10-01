import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { Message } from "../message/index.ts";
import { isPlainObject } from "../utils/object.ts";
import type { MessageBroker, Topic } from "./types.ts";

export interface SqsBrokerConfig {
  readonly client: SQSClient;
  /** Logical topic name to physical SQS queue URL. */
  readonly queues: Readonly<Record<string, string>>;
}

export class SqsTopicNotConfiguredError extends Error {
  public readonly topic: string;

  constructor(topic: string) {
    super(`No SQS queue configured for topic "${topic}"`);
    this.topic = topic;
    this.name = "SqsTopicNotConfiguredError";
  }
}

export function createSqsBroker(config: SqsBrokerConfig): MessageBroker {
  const { client, queues } = config;
  if (typeof client?.send !== "function") {
    throw new Error("SQS broker client must provide a send function");
  }
  if (!isPlainObject(queues) || Object.keys(queues).length === 0) {
    throw new Error("SQS broker queues must map at least one topic to a queue URL");
  }

  const queueByTopic = new Map<string, string>();
  for (const [topic, queueUrl] of Object.entries(queues)) {
    if (topic.trim().length === 0) {
      throw new Error("SQS broker topic names must be non-empty strings");
    }
    if (typeof queueUrl !== "string" || queueUrl.trim().length === 0) {
      throw new Error(`SQS queue URL for topic "${topic}" must be a non-empty string`);
    }
    if (queueUrl.endsWith(".fifo")) {
      throw new Error(`SQS queue for topic "${topic}" must be a standard queue`);
    }
    queueByTopic.set(topic, queueUrl);
  }

  return {
    async publish(topic: Topic, message: Message) {
      const queueUrl = queueByTopic.get(topic.name);
      if (queueUrl === undefined) {
        throw new SqsTopicNotConfiguredError(topic.name);
      }

      const body = serializeMessage(topic.name, message);
      const result = await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: body,
        }),
      );

      return result.MessageId === undefined ? {} : { messageId: result.MessageId };
    },
  };
}

function serializeMessage(topic: string, message: Message): string {
  try {
    return JSON.stringify(message);
  } catch (error) {
    throw new Error(
      `Message for topic "${topic}" is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
