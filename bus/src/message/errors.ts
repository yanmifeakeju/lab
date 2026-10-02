export class EventValidationError extends Error {
  public readonly eventType: string;
  public readonly issues: readonly string[];

  constructor(eventType: string, issues: string[]) {
    super(`Validation failed for event "${eventType}": ${issues.join("; ")}`);
    this.eventType = eventType;
    this.issues = issues;
    this.name = "EventValidationError";
  }
}

/** An event-contract configuration fault, not a delivery decision. */
export class UnsupportedEventSchemaError extends Error {
  public readonly eventType: string;

  constructor(eventType: string, reason: string) {
    super(`Unsupported schema for event "${eventType}": ${reason}`);
    this.eventType = eventType;
    this.name = "UnsupportedEventSchemaError";
  }
}

export class MessageDecodeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MessageDecodeError";
  }
}

export class NonJsonValueError extends Error {
  public readonly path: string;

  constructor(path: string, reason: string) {
    super(`Value at ${path} is not JSON-compatible: ${reason}`);
    this.name = "NonJsonValueError";
    this.path = path;
  }
}
