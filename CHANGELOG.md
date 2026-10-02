# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-10-02

### Added
- Transactional outbox: an order row and its outbox event are written in one SQLite transaction (`node:sqlite`, WAL mode), so neither exists without the other.
- Row-leasing relay: pending events are leased for a configurable time, and a lease that expires without an outcome is picked up again. Delivery is at-least-once.
- Retries with exponential backoff (2 s, then 4 s) and a dead-letter queue after the third failed attempt, with a replay endpoint.
- Consumer inbox keyed by event id and consumer, which counts repeated deliveries and ignores them.
- Fault simulator for the broker (healthy, partial failures, full outage) with adjustable delivery latency.
- Express REST API, plus a React 19 operations console with an outbox table, consumer list, dead-letter queue and fault simulator.
- Per-consumer counts in `GET /api/stats` (`consumers`), and an `availableAt` field on outbox rows that shows when a retry is due.
- Input validation for orders, broker settings, the status filter and the poll options (`batchSize` 1 to 100, `leaseSeconds` 1 to 300); invalid input gets `400` and changes nothing.
- In-browser demo for GitHub Pages: the same relay, backoff and validation code runs against an in-memory store with fixed sample data, with a demo bar and a "Reset sample data" control.
- GitHub Pages workflow, a CI workflow that runs lint, tests, both builds and a Docker build on Node 22 and 24, MIT license, environment variable examples for server and client, and a Dockerfile and Compose file.
- Server and client test suites covering routes, validation, leasing, backoff, dead-lettering, the demo store and the main console flows, all on fake timers.

### Changed
- Redesigned the console: a light paper theme with one amber-brown accent, status shown as a dot plus text, a single stats strip, an outbox table, dense lists for consumers and the dead-letter queue, and the fault simulator as a form column beside its results. Fonts are self-hosted and icons come from Lucide.
- Rewrote the README and the ADRs to describe at-least-once delivery honestly and removed claims the code does not back (exactly-once delivery, performance and guarantee wording).
- The SQLite file now defaults to `data/outbox.db` at the repository root, or `OUTBOXRELAY_DB_PATH`.

### Fixed
- The server looked for the client build relative to the working directory, so inside the Docker image (working directory `/app`) it resolved to `/client/dist` and served no UI.
- `npm start` and the Docker `CMD` pointed at `dist/index.js`, which the build does not produce (the entry point is `dist/server/src/index.js`).
- The consumer inbox endpoint returned raw database column names, so the console never matched a row to a consumer and showed zeros. Counts are now computed from the whole inbox table, not from the last 50 rows.
- Failed events were retried on the very next poll; the documented backoff did not exist.
- The poll endpoint turned any value into a batch size with `parseInt`; it now rejects values that are not whole numbers in range.
- Orders accepted negative quantities and prices, and broker settings and the status filter accepted any value.
- Server errors returned the raw exception message to the client; they are now logged and answered with a generic message.
- The `.gitignore` pattern for the database file did not match `server/data/`, where the server created it when started from the workspace.
- The console used browser alert dialogs for errors and showed an "Active" badge for consumers regardless of their state; errors now appear inline.
