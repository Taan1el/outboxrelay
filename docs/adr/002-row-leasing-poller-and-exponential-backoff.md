# ADR-002: Row Leasing Poller with Monotonic Timeouts and Exponential Backoff

## Status
Accepted

## Context
Asynchronously picking up pending events from the outbox table across multiple parallel worker instances requires coordination to prevent race conditions, duplicate dispatches, and worker crashes from causing indefinitely stuck events.

## Decision
We implemented optimistic row leasing:
1. When polling for `PENDING` events, the worker sets status to `LEASED` and assigns a lease expiration timestamp (`leased_until = now + leaseDuration`).
2. If a worker crashes or encounters an unhandled timeout mid-flight, the lease expires naturally. Subsequent poller ticks identify expired leases (`status = 'LEASED' AND leased_until < now`) and re-acquire the events automatically.
3. Upon dispatch errors, events are returned to `PENDING` with an incremented `retry_count` and exponential delay backoff.

## Consequences
### Positive
- High resilience to background worker failures; zero events remain stuck indefinitely.
- Safe concurrent polling across multiple application nodes.
- Controlled rate of retries with exponential backoff avoiding thundering herd on downstream sinks.

### Trade-offs
- Network delays exceeding lease duration could cause duplicate dispatches (handled by consumer idempotency in ADR-003).