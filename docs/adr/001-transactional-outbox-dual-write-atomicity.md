# ADR-001: Transactional Outbox Pattern for Dual-Write Atomicity

## Status
Accepted

## Context
In microservice and distributed architectures, updating a business entity in a relational database and subsequently publishing a message to a broker (e.g. Kafka, RabbitMQ, AWS SQS) introduces the classic **dual-write problem**. If the database commit succeeds but the message broker network call fails, downstream services miss critical updates. If the broker publish happens first and the database transaction rolls back, downstream services process phantom events.

## Decision
We implemented the Transactional Outbox Pattern:
- Within a single ACID database transaction (`BEGIN IMMEDIATE`), write both the business entity mutation (`orders` table) and an outbox event record (`outbox_events` table).
- Event state is initially marked as `PENDING`.
- If either write fails, the entire transaction is rolled back by SQLite WAL, guaranteeing strict atomicity and zero discrepancy.

## Consequences
### Positive
- Strict atomicity without complex 2-Phase Commit (2PC) or distributed locking.
- Zero dual-write data loss; events are persisted with database durability guarantees.
- Works natively with any relational ACID store (SQLite WAL, PostgreSQL).

### Trade-offs
- Introduces eventual consistency between database persistence and external broker propagation.