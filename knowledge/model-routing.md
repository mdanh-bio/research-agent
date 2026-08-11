# Model Routing

This document defines the routing contract and its opt-in ACP integration. Consult
`knowledge/current-state.md` for the latest verification and live-test boundary.

## Opt-in runtime path

- `settings.json` stores `off` (the default), `research_max`, `balanced`, or `economy`. Selecting a
  profile rotates the runtime generation; turning it off preserves the configured Model/Agent path.
- The main process builds a renderer-safe catalog from the selected framework and its configured
  providers/models without a current validation failure. Model order supplies strong/medium/cheap tier
  intent. Targets remain in one compatible transport family so the existing provider/model switch path
  can apply them.
- Official and subscription identities are `approved_cloud`; custom endpoints are conservatively
  `any_configured`. A loopback URL does not establish `local_only` execution. Capability and boundary
  filtering fails closed when no target qualifies.
- Settings displays the concrete user-default route for every work class. Project overrides are
  resolved at dispatch and recorded in the immutable snapshot; the current Settings surface does not
  edit overrides or render an active-project preview.
- Ordinary composer prompts use `analysis`; app-owned callers may provide another work class. Each
  enabled prompt persists its policy/decision snapshot, agent run, exact model attempts, request
  identity, latency, available usage, result, and side-effect state. ACP provides no trusted monetary
  cost, so cost remains absent rather than estimated.
- External routing telemetry/export has no implementation and is forced off. Policy and attempt JSON
  pass a secret-bearing-field and common credential-pattern rejection before persistence.

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
  reservation. Attachments without an immutable digest stop before a durable run is created. User
  cancellation is terminal; an unqualified `AbortError` is not treated as timeout evidence.
- Record every attempt, trigger, latency, usage, cost, result class, request hash, and side-effect
  state. Ambiguous safety cases stop for review.

The current configured-provider catalog derives protocol family, context window, image input, and
accepted reasoning levels from Settings/static provider profiles. It admits providers already usable
by an agent framework as `text`/`tool_use` targets. A future catalog that admits chat-only or other
non-agent models must add an explicit per-model tool-support declaration before those models can be
eligible. Credentials are resolved from secure storage only after target selection and never copied
into a policy snapshot.

The production ACP composer/orchestrator path now uses these contracts only after explicit opt-in.
Availability replay is active under deterministic tests; benign-refusal replay remains fail closed
until a production approval issuer/verifier supplies the already-required single-use evidence. No real
provider request or fallback was live-executed during Phase B acceptance.
