# ADR 0006: Persist a bounded root-plus-child graph in main-process authority

- Status: Implemented deterministic M2 Stage 6 control-plane foundation; live/runtime adapters and
  packaged-app acceptance remain pending
- Date: 2026-08-11

## Context

M1 persists routed runs and model attempts, but routing is not the authority for every prompt and it
does not enforce a parent/child graph. M2 needs restart-safe identity and bounded admission without
turning the application into an unbounded autonomous system.

## Decision

Every M2 prompt has one persisted root `AgentGraph` and one root `AgentRun`. The default graph limits
are four concurrently running nodes including the root, depth 1, and eight admitted children. These
limits are stored with the graph, validated in the main process, and may be configured only below a
hard application cap. Legacy M1 runs without a graph ID remain read-only legacy roots.

Children are direct descendants only. They are read-only with respect to the shared workspace and
may produce output only through a run-bound artifact-storage identity. Each child has an explicit
frame, parent run, budget, cancellation generation, and safe result/failure code. A child approval
is exact and single-use; M2 has no ambient always-delegate approval.

Graph and run lifecycle changes use compare-and-set semantics. Terminal transitions are one-way and
idempotent for duplicate completion/cancellation calls. A provider dispatch that may have been
accepted is never replayed automatically after restart. The delivery journal stores identifiers and
safe control metadata only; prompt text, attachments, bytes, credentials, raw provider payloads, and
approval secrets remain outside SQLite.

Cross-store prompt durability is ordered as: prepare a delivery row, append the exact user Message to
authoritative Session JSON, then promote the delivery. Recovery abandons a journal row that has no
Session Message, promotes a durable Session Message left in `preparing`, and blocks any dispatch-
ambiguous row. No renderer projection can overwrite graph or delivery authority.

Stage 6 adds an additive Session-owned delegation record and a secret-free SQLite control journal.
Approval is represented by a main-issued human receipt bound to the exact task digest, identities,
target, budget, and cancellation generation; the scheduler consumes it once by CAS immediately before
claiming a graph slot. Admission is separate from execution, with FIFO ordering per graph and one
child per graph per fairness pass. Restart reconciliation blocks awaiting-approval and
dispatch-ambiguous children and never replays a provider call. Task and result bodies remain in
Session JSON; the journal retains only digests and control metadata.

## Consequences

The graph owner is independent of M1 route selection. Routing-on attaches its immutable policy
snapshot and attempts to an already-owned root; routing-off uses a secret-free `configured_direct`
one-target snapshot that records the exact configured backend/provider/model without claiming that
transparent routing or fallback occurred. Child frame helpers do not switch the parent active branch.

Approval is still a user authorization boundary and is not a substitute for sandboxing. Shared-
workspace parallel editing, grandchildren, automatic provider replay, remote compute, and release
behavior remain outside M2.
