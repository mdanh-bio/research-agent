# Model Routing

This document defines the target contract; consult `knowledge/current-state.md` before assuming it is
implemented.

## Work classes

`interaction_router`, `title`, `summary`, `compaction`, `explore`, `plan`, `build`, `review`,
`literature`, `analysis`, and `compute`.

Each route policy resolves a backend, provider, model, reasoning effort, required capabilities,
budget, data boundary, primary target, and at most two ordered fallbacks. Every resolution emits a
policy version, selection reason, rejected alternatives, and the exact policy-owned budget. Target
ids are labels only: persistence and attempt reservation compare the complete backend, provider,
model, reasoning, capabilities, context, and data-boundary structure in configured order.

## Precedence

1. Explicit per-session or per-agent pin.
2. Project policy.
3. User policy.
4. Shipped profile default.
5. Capability and data-boundary filtering.

The visible `Research Max` profile assigns strong models to planning, synthesis, and independent
review; medium models to building, general analysis, and compaction; and cheap models to titles,
summaries, exploration, and interaction classification. The UI must show the effective route, not
only the preset name.

## Fallback contract

- Eligible triggers: timeout, rate limit, provider unavailable, malformed response, or a user-approved
  category of benign-research refusal.
- A benign-refusal category alone is not approval. Automatic handling requires explicit single-use
  user approval bound to the project research-scope id/version, session, run, failed attempt, request
  identity, policy version, data boundary, source target, alternate target, and approved provider.
  The ledger also requires an approval-owner verifier and persists the secret-free evidence.
- Retry the byte-equivalent request and attachments. Never rewrite a request to evade a safety policy.
- The alternate provider must satisfy capability, research-scope, and data-boundary requirements.
- Stop after two alternate attempts.
- Replay automatically only before any side-effecting tool call. After effects begin, create a
  recovery handoff or ask the user to avoid duplicate files and jobs.
- The ledger computes a domain-separated SHA-256 identity from the request bytes and validated,
  ordered attachment digests. A fallback is first reserved, then activated immediately before
  dispatch; a late side-effect event monotonically marks the prior attempt and invalidates an active
  reservation. Production runtime cancellation propagation is still unconnected.
- Record every attempt, trigger, latency, usage, cost, result class, request hash, and side-effect
  state. Ambiguous safety cases stop for review.

Custom model catalog entries must declare protocol, context window, modalities, tool support, and
accepted reasoning levels. Credentials are referenced by secure-storage identity, never copied into a
policy snapshot.

These contracts remain foundations. No current composer/orchestrator path selects a live provider or
automatically replays a request through them.
