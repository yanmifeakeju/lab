import type { SQSClient } from "@aws-sdk/client-sqs";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";
import { createSqsBroker, defineTopic } from "../../brokers/index.ts";
import { defineEvent } from "../../message/index.ts";
import type { MessageMetadata } from "../../message/index.ts";
import { createPublisher } from "../../publisher/index.ts";
import type { Publisher, PublishRequest, PublishResult } from "../../publisher/index.ts";
import { queueUrl } from "./config.ts";

const orders = defineTopic("orders");
const orderPlaced = defineEvent(
  "order.placed",
  z.object({
    orderId: z.string(),
    total: z.number().nonnegative(),
    currency: z.string().length(3),
  }),
);

export async function publishOrderPlaced(client: SQSClient) {
  const broker = createSqsBroker({
    client,
    queues: {
      [orders.name]: queueUrl,
    },
  });
  const basePublisher = createPublisher({
    source: "orders-service",
    broker,
  });

  // The application owns correlation. A real request handler would propagate
  // its request context; this fixed value makes the local example easy to inspect.
  const correlationId = "local-sqs-publish-test";
  const publisher = withMetadata(basePublisher, () => ({
    correlationId,
    // An application using OpenTelemetry could inject `traceparent`,
    // `tracestate`, and baggage here from its active context.
  }));

  const result = await publisher.publish({
    topic: orders,
    event: orderPlaced,
    data: {
      orderId: "order-123",
      total: 50.99,
      currency: "NGN",
    },
    // Explicit values are merged after provided context and therefore win.
    metadata: { initiatedBy: "sqs-example" },
  });

  console.log({
    published: result.message.event.type,
    topic: result.topic.name,
    messageId: result.message.id,
    sqsMessageId: result.receipt.messageId,
    correlationId,
  });

  return result;
}

type MetadataProvider = () => MessageMetadata | Promise<MessageMetadata>;

// Application composition, deliberately not part of the bus library.
function withMetadata(publisher: Publisher, provider: MetadataProvider): Publisher {
  return {
    async publish<
      TType extends string,
      TSchema extends StandardSchemaV1,
      TTopicName extends string,
    >(
      request: PublishRequest<TType, TSchema, TTopicName>,
    ): Promise<PublishResult<TType, TSchema, TTopicName>> {
      return publisher.publish({
        ...request,
        metadata: {
          ...(await provider()),
          ...request.metadata,
        },
      });
    },
  };
}
