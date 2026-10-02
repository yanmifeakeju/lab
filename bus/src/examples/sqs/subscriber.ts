import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { z } from "zod";
import { decodeMessage, defineEvent } from "../../message/index.ts";
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
    amount: z.string().regex(/^\d+$/),
    currency: z.string().length(3),
  }),
);

const subscriber = createSubscriber([
  handle(orderPlaced, async (data, message) => {
    console.log({
      handled: message.event.type,
      orderId: data.orderId,
      amount: data.amount,
      correlationId: message.metadata["correlationId"],
    });
  }),
]);

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
  const message = decodeSqsMessage(sqsMessage.Body);
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

function decodeSqsMessage(body: string | undefined) {
  if (body === undefined) {
    throw new Error("SQS returned a message without a body");
  }
  return decodeMessage(body);
}
