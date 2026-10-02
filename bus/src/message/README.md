# Message contract

This folder owns the protocol shared across publishing, brokers, and
subscription:

- `EventDefinition` associates an event type with its payload schema.
- `Event` is a validated domain fact.
- `Message` is the transport-neutral envelope around an event.
- `messageVersion` identifies the envelope format; the current version is `1`.
- `createdAt` records when the immutable message was built. Decoding accepts a
  valid RFC 3339 timestamp, including offsets and timestamps without fractional
  seconds, and normalizes it to fixed-width UTC ISO format for lexical ordering.
  Precision beyond milliseconds is truncated.
- `MessageMetadata` carries scalar context such as a correlation ID.
- `validateEventData` applies an event definition consistently on either side
  of a broker.
- `encodeMessage`, `decodeMessage`, and `parseMessage` own the shared wire
  format. Decoding validates the envelope and leaves event data semantically
  unknown for the subscriber's event schema.
- `normalizeJson` creates a frozen plain-JSON copy, dropping undefined object
  properties while rejecting values that JSON would otherwise change silently.

It contains no delivery destination, broker implementation, or delivery policy.
