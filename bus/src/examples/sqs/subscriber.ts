import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { z } from "zod";
import { defineEvent } from "../../message/index.ts";
import type { Message } from "../../message/index.ts";
import {
  createSubscriber,
  decideSubscriptionOutcome,
  handle,
} from "../../subscriber/index.ts";
import { queueUrl } from "./config.ts";

// The subscriber owns the event contract it needs; it does not import the
// producer's event definition.
const orderPlaced = defineEvent(
  "order.placed",
  z.object({
    orderId: z.string(),
    total: z.number().nonnegative(),
    currency: z.string().length(3),
  }),
);

const subscriber = createSubscriber([
  handle(orderPlaced, async (data, message) => {
    console.log({
      handled: message.event.type,
      orderId: data.orderId,
      total: data.total,
      correlationId: message.metadata["correlationId"],
    });
  }),
]);

const messageSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  publishedAt: z.string().datetime(),
  event: z.object({
    type: z.string().min(1),
    data: z.unknown(),
  }),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

export async function receiveOrderPlaced(client: SQSClient) {
  const received = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 5,
    }),
  );
  const sqsMessage = received.Messages?.[0];
  if (sqsMessage === undefined) {
    throw new Error("SQS did not return the published message");
  }

  // Decoding is transport mechanism, so it happens at the SQS boundary rather
  // than inside the subscriber. The subscriber validates event-specific data.
  const message = decodeMessage(sqsMessage.Body);
  const outcome = await subscriber.handle(message);
  const decision = await decideSubscriptionOutcome(outcome, (failure) =>
    failure.status === "failed" ? "retry" : "reject",
  );

  if (decision !== "acknowledge") {
    throw new Error(`Message was not acknowledged: ${decision}`);
  }
  if (sqsMessage.ReceiptHandle === undefined) {
    throw new Error("SQS returned a message without a receipt handle");
  }

  await client.send(
    new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: sqsMessage.ReceiptHandle,
    }),
  );

  return { message, decision };
}

function decodeMessage(body: string | undefined): Message {
  if (body === undefined) {
    throw new Error("SQS returned a message without a body");
  }

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new Error("SQS message body is not valid JSON", { cause: error });
  }

  return messageSchema.parse(value);
}
