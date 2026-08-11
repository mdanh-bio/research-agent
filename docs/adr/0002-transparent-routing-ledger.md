# ADR 0002: Separate route policy from runtime execution

- Status: Accepted; opt-in ACP integration implemented, live-provider verification pending
- Date: 2026-08-10
- Updated: 2026-08-11

## Context

The inherited application resolves one active framework/provider/model from settings. Research Agent
needs deterministic work-class routing, visible fallbacks, and scientific provenance without copying
message content into a second store.

## Decision

Keep model catalog and policy resolution backend-neutral. Resolve a `RouteDecision` before runtime
selection, persist a canonical secret-free policy/decision snapshot, then append agent runs, exact
model attempts, ledger-computed request identities, policy-owned budgets, costs, and runtime-thread
links to the project SQLite database. Target ids are not treated as identities; full target structure
and ordered eligible alternates must match the snapshot.

Fallback attempts must be reserved from the persisted eligible-alternate order. They require the same
request identity, an eligible _pre-dispatch_ failure, and no recorded side effect. Reservation and
activation are separate: activation occurs immediately before `session.prompt()`, and every failure
after that conservative boundary fails closed because a persistent ACP session cannot prove a clean
replay input. A late effect report is correlated to the exact model attempt. A benign-refusal fallback
additionally requires verified, scope-bound, single-use approval evidence; production has no issuer or
verifier yet, so it stops for review. At most two pre-dispatch alternates are allowed. Prompt and
attachment content remains authoritative in existing Session storage.

## Consequences

The pure planner and ledger remain independently testable. The configured catalog, settings/UI,
application-command surface, ACP prompt boundary, provider model switch, lifecycle ledger events, and
bounded pre-dispatch target fallback are connected behind a default-off profile. The Settings table is
a user-default preview; project overrides resolve at dispatch. Benign-refusal replay still requires a
future production approval issuer/verifier and otherwise stops for review. Local deterministic tests
and a production build do not prove that a real provider request was routed; no provider-to-provider
post-dispatch replay is claimed.
