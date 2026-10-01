import { SQSClient } from "@aws-sdk/client-sqs";

export const endpoint = "http://localhost:4566";
export const region = "us-east-1";
export const queueUrl = `${endpoint}/000000000000/bus-publisher-example`;

export function createSqsClient(): SQSClient {
  return new SQSClient({
    endpoint,
    region,
    credentials: {
      accessKeyId: "test",
      secretAccessKey: "test",
    },
  });
}
