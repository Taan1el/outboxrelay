# ADR-001: Transactional outbox for the order and event write

## Status
Accepted

## Context
Saving an order and then publishing a message to a broker are two writes to two systems. If the database commit succeeds and the publish fails, consumers never hear about the order. If the publish happens first and the commit fails, consumers hear about an order that does not exist.

## Decision
Write the business row and an event row to the same database in one transaction:
- `createOrderWithOutboxEvent` opens `BEGIN IMMEDIATE`, inserts the order into `orders` and the event into `outbox_events` with status `PENDING`, then commits.
- If either insert throws, the transaction is rolled back and neither row exists.
- A separate relay reads `PENDING` rows and talks to the broker (see ADR-002).

## Consequences
### Positive
- No two-phase commit and no distributed lock: one local transaction covers both rows.
- An event is never lost because the broker was down at write time; it stays in the table until it is relayed.
- Works with any store that has transactions; this project uses SQLite in WAL mode.

### Trade-offs
- Consumers see events after the relay runs, not at commit time, so the system is eventually consistent.
- The relay can deliver an event more than once (ADR-002), so consumers must tolerate repeats (ADR-003).
- Orders and events share one SQLite file, so this layout suits a single node; it is not a distributed outbox.
