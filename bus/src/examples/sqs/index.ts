/**
 * Verify this example against the local SQS emulator.
 *
 * 1. Create a standard queue:
 *
 *    AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
 *      AWS_DEFAULT_REGION=us-east-1 \
 *      aws --endpoint-url http://localhost:4566 sqs create-queue \
 *      --queue-name bus-publisher-example
 *
 * 2. From the project root, publish and consume one message:
 *
 *    node src/examples/sqs/index.ts
 *
 *    The publisher and subscriber are deliberately implemented in separate
 *    files. This entry point only runs them together for local verification.
 *
 * The service currently exposed on port 4566 is ElasticMQ. These commands use
 * its SQS-compatible API and work the same way for a LocalStack SQS endpoint.
 */
import assert from "node:assert/strict";
import { createSqsClient } from "./config.ts";
import { publishOrderPlaced } from "./publisher.ts";
import { receiveOrderPlaced } from "./subscriber.ts";

const client = createSqsClient();
const publication = await publishOrderPlaced(client);
let delivery: Awaited<ReturnType<typeof receiveOrderPlaced>> | undefined;

// A standard queue can contain messages from an earlier run. Handle those too,
// but keep receiving until this round trip's publication arrives.
for (let attempt = 0; attempt < 10; attempt += 1) {
  const candidate = await receiveOrderPlaced(client);
  if (candidate.message.id === publication.message.id) {
    delivery = candidate;
    break;
  }
}

assert.ok(delivery, "Did not receive the message published by this run");
console.log({
  messageId: delivery.message.id,
  decision: delivery.decision,
  deletedFromQueue: true,
});
