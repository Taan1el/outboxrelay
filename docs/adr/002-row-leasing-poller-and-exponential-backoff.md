# ADR-002: Row leasing poller with exponential backoff

## Status
Accepted

## Context
Something has to move `PENDING` rows to the broker. It must not hand the same row to two pollers at once, must recover rows whose poller died mid-delivery, and must not hammer a broker that is already failing.

## Decision
- Leasing: `leasePendingEvents` runs in a `BEGIN IMMEDIATE` transaction, selects rows that are due, sets them to `LEASED` and stores `leased_until = now + lease`. The default lease is 5 seconds and it can be set from 1 to 300 seconds.
- Due rows are `PENDING` rows whose `available_at` is empty or in the past, and `LEASED` rows whose `leased_until` has passed. Times come from the wall clock (`Date.now()`).
- Success: the row becomes `PUBLISHED` and the event is written to each consumer inbox.
- Failure: `retry_count` goes up. After the first and second failure the row returns to `PENDING` with `available_at` set 2 seconds and then 4 seconds ahead (the delay doubles, capped at 60 seconds). The third failure moves it to `DEAD_LETTER`.
- A background timer runs one cycle every 2.5 seconds by default, and the API can run a cycle on demand.

## Consequences
### Positive
- A crashed or stuck poller costs one lease period; the row is then leased again.
- Backoff spaces out retries instead of retrying on the next cycle.
- Leasing is atomic, so two cycles in the same process, or two processes on the same database file, do not lease the same row.

### Trade-offs
- Delivery is at-least-once. If a delivery takes longer than the lease, or the process stops after the broker accepted a message but before the row is marked `PUBLISHED`, the event is delivered again.
- The wall clock is used for leases and backoff, so a large clock change on the host shifts them.
- SQLite is a single-file database; running several relay nodes against one shared file over a network filesystem is not supported.
