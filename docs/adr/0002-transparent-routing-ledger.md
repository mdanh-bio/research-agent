# ADR 0002: Separate route policy from runtime execution

- Status: Accepted foundation; production integration pending
- Date: 2026-08-10

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
request identity, a finalized eligible failure, and no recorded side effect. Reservation and
activation are separate so a late effect report can invalidate an undispatched fallback. A
benign-refusal fallback additionally requires verified, scope-bound, single-use approval evidence.
At most two alternates are allowed. Prompt and attachment content remains authoritative in existing
Session storage.

## Consequences

The pure planner and ledger can be tested independently of Codex/OpenCode. Production routing remains
inactive until the orchestrator, settings/UI, provider catalog, and runtime events are connected. A
passing planner test therefore does not prove a live provider request was routed or retried.
