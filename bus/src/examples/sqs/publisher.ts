import type { SQSClient } from "@aws-sdk/client-sqs";
import { z } from "zod";
import { defineTopic } from "../../brokers/index.ts";
import { createSqsBroker } from "../../sqs.ts";
import { defineEvent } from "../../message/index.ts";
import type { MessageMetadata } from "../../message/index.ts";
import { createPublisher } from "../../publisher/index.ts";
import type { Publisher } from "../../publisher/index.ts";
import { queueUrl } from "./config.ts";

const orders = defineTopic("orders");
const orderPlaced = defineEvent(
  "order.placed",
  z.object({
    orderId: z.string(),
    // Minor units (kobo) as a string; money never travels as a float.
    amount: z.string().regex(/^\d+$/),
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
      amount: "5099",
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

type MetadataProvider = () => MessageMetadata;

// Application composition, deliberately not part of the bus library.
function withMetadata(publisher: Publisher, provider: MetadataProvider): Publisher {
  const create: Publisher["create"] = (request) =>
    publisher.create({
      ...request,
      metadata: {
        ...provider(),
        ...request.metadata,
      },
    });
  const send: Publisher["send"] = (publication) => publisher.send(publication);
  const publish: Publisher["publish"] = async (request) => send(create(request));
  return { create, send, publish };
}
