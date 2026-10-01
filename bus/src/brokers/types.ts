import type { Message } from "../message/index.ts";

/** A logical broker address. It contains no subscriber or transport topology. */
export interface Topic<TName extends string = string> {
  readonly name: TName;
}

export interface BrokerReceipt {
  /** Broker-assigned identifier, when the broker supplies one. */
  readonly messageId?: string;
}

/**
 * A broker implementation owns encoding and delivery. Routing beyond the
 * logical topic is invisible to publishers.
 */
export interface MessageBroker {
  publish(topic: Topic, message: Message): Promise<BrokerReceipt>;
}
