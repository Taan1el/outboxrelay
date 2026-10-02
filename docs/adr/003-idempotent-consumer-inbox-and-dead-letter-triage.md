# ADR-003: Consumer inbox and dead-letter queue

## Status
Accepted

## Context
Because a relay can deliver an event more than once (ADR-002), a consumer that applies every delivery would double its side effects. Separately, an event that keeps failing must stop being retried so that it does not occupy the relay forever.

## Decision
1. Consumer inbox: `consumer_inbox` has a unique key on `(event_id, consumer_id)`. When a consumer receives an event it already recorded, the repeat is counted in `duplicate_detected` and nothing else happens. The three consumers in this project (notifications, inventory, analytics) are simulated inside the relay process; the inbox shows how a real consumer would deduplicate.
2. Dead-letter queue: an event that has failed 3 times gets status `DEAD_LETTER` and keeps the last error message. `POST /api/outbox/events/:id/retry` resets its attempt count and puts it back to `PENDING`; the console offers the same as "Replay".

## Consequences
### Positive
- A repeated delivery does not repeat a consumer's side effect, so the visible effect of at-least-once delivery is the same as processing each event once.
- A failing event stops consuming retries and stays inspectable, with its last error.

### Trade-offs
- Each consumer needs storage for processed event ids; this project never prunes them.
- The inbox write and the consumer's own work are only safe if the real consumer commits them in one transaction.
- Dead-lettered events need a person or a script to replay them.
