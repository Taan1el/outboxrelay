# ADR-003: Idempotent Consumer Inbox and Dead-Letter Queue (DLQ) Triage

## Status
Accepted

## Context
Because message transport guarantees across networks are inherently **at-least-once**, network retries and lease expirations can deliver the same outbox event multiple times to downstream consumers. Without deduplication, financial ledgers, inventory counts, and emails would suffer duplicate side-effects. Furthermore, poison-pill events that fail repeatedly must not block the entire event pipeline.

## Decision
We implemented a two-part reliability guarantee:
1. **Downstream Consumer Inbox**: Consumers maintain a deduplication index tracking `(event_id, consumer_id)`. If an event has already been processed by that specific consumer, duplicate deliveries are acknowledged and safely discarded.
2. **Dead-Letter Queue (DLQ)**: If an event fails more than `MAX_RETRIES` (3 attempts), it is transitioned to `DEAD_LETTER` with the exact error message stack trace, freeing the queue to process subsequent events. Dead-lettered events can be inspected and manually retried via the management API.

## Consequences
### Positive
- Delivers **end-to-end exactly-once business semantics** over at-least-once transport.
- Prevents poison-pill messages from halting production outbox processing pipelines.
- Clear auditability and recovery mechanisms for failed messages.

### Trade-offs
- Downstream services must allocate storage for the consumer inbox deduplication table.