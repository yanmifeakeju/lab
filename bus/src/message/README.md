# Message contract

This folder owns the protocol shared across publishing, brokers, and eventually
subscription:

- `EventDefinition` associates an event type with its payload schema.
- `Event` is a validated domain fact.
- `Message` is the transport-neutral envelope around an event.
- `MessageMetadata` carries scalar context such as a correlation ID.
- `validateEventData` applies an event definition consistently on either side
  of a broker.

It contains no delivery destination, broker implementation, or delivery policy.
