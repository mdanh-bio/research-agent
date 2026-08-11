# Implementation Plan: Live Verification + Finish M1 (Transparent Routing)

Last updated: 2026-08-11. Owner: Anh. Base commit: `bed7ce1` on `main`.

Execution status: Phase A was verified and recorded in commit `e6ba961`. Phase B was implemented and
locally accepted on 2026-08-11; see `notes/2026-08-11.md` and `knowledge/current-state.md`. Statements
under “Current facts” below describe the pre-Phase-B baseline retained for auditability.

This plan has two phases. Phase A re-establishes a live, trustworthy verification
baseline (typecheck + Vitest + supporting checks) so the numbers in
`knowledge/current-state.md` are confirmed, not inherited. Phase B connects the
already-built M1 routing engine to a real runtime path so the "Foundation / not
active" state becomes an opt-in, ledger-recorded live route.

Follow `AGENTS.md`: diagnose before mutating, keep changes narrow and reversible,
never present a typecheck pass as proof that live routing works, and record
provider/model/policy/attempt provenance for every routed result.

---

## Phase A — Live verification baseline

Goal: reproduce the claimed green state on this Mac and capture the exact commands
and results in a dated note under `notes/`.

### A0. Preconditions

- Confirm clean tree and branch: `git status --porcelain=v1` (expect empty),
  `git rev-parse HEAD` (expect `bed7ce1`).
- Confirm Node version matches `.nvmrc`.
- Do not run packaging, SSH, or remote steps in this phase.

### A1. Install and generate

1. `npm ci` (uses `package-lock.json`; runs `postinstall`: `patch-package`,
   `check-claude-acp-patch`, `prisma generate`, `electron-builder install-app-deps`,
   `fix-electron-path`). If network access is sandbox-blocked, rerun with escalation.
2. Record whether `postinstall` succeeded end to end, since Prisma client
   generation is a prerequisite for the routing persistence tests.

### A2. Static checks (fast, run first)

- `npm run typecheck` (node + web).
- `npm run lint` (expect 0 errors; inherited warnings are acceptable, note the count).
- `npm run check:web-api-map`.
- `npm run check:claude-acp-patch`.

### A3. Test suites

- Full unit suite: `npm run test` (Vitest `vitest run`). Capture pass/skip counts.
- If the full run is too heavy for one pass, run focused routing suites first:
  - `npx vitest run src/main/model-routing`
  - `npx vitest run src/main/settings/backend-resolver.test.ts src/main/settings/service.test.ts`
  - `npx vitest run src/shared/routing-profile-foundation.test.ts`
- CLI + private-package guards: `npm run test:cli`, `npm run test:private-package`.

### A4. Build (no packaging)

- `npm run build` (typecheck + `electron-vite build` + `build:web`). This proves
  compilation and bundling without producing a DMG/ZIP.
- Explicitly skip `build:mac`/`build:unpack` here; packaging needs Xcode `actool`
  and is out of scope for M1.

### A5. Record results

- Write `notes/2026-08-10.md` (append-only) with: exact commands, tool versions
  (`node -v`, `npm -v`), pass/skip/fail counts, lint warning count, and any
  deviation from `knowledge/current-state.md`.
- Only after live confirmation, update the "Verification status" section of
  `knowledge/current-state.md` with the new date and observed numbers. If any
  number differs, correct it rather than restating the old figure.

Exit A: typecheck, lint, targeted routing suites, full Vitest, and `npm run build`
all pass locally, with results captured in `notes/`. Any red result is triaged
before Phase B.

---

## Phase B — Finish M1: connect transparent routing

Current facts (verified from source this session):

- Pure engine exists and is tested: `src/main/model-routing/` (`policy-planner.ts`
  `resolveRouteDecision`, `default-profiles.ts`, `fallback-policy.ts`, `ledger.ts`).
- Persistence schema round-trips (`persistence.integration.test.ts`): tables
  `routingPolicySnapshot`, `agentRun`, `modelAttempt`, runtime-thread link, with no
  message-content column.
- A bridge already exists but is deliberately inert:
  `SettingsService.resolveRoutedAgentBackend(decision, context)` in
  `src/main/settings/service.ts` delegates to
  `AgentBackendResolver.resolveRoutedTarget(decision.target, ...)`.
- UI is read-only: `src/renderer/src/pages/settings/RoutingPanel.tsx` shows
  "Foundation / not active" and renders `ROUTING_PROFILE_FOUNDATION_DEFINITIONS`.

M1 exit criteria (from `docs/roadmap.md`): model catalog + route policies/snapshots

- route-decision UI + immutable attempt ledger; visible Max/Balanced/Economy
  profiles; capability and `local_only`/`approved_cloud`/`any_configured` enforcement;
  availability fallback and vetted refusal fallback with side-effect replay guards;
  telemetry/export off by default; deterministic precedence/fallback acceptance tests;
  no secret values in policy/attempt data.

The engine and ledger already satisfy most of the logic. The remaining work is
wiring persistence, a live decision path, provenance recording, and UI activation,
all behind an explicit opt-in so the default conversation path is unchanged until
the user turns routing on.

### B1. Concrete model targets for shipped profiles

- Today `routing-profile-foundation` defines only tiers (strong/medium/cheap), not
  real `ModelTarget`s. Add a mapping from tier -> concrete `ModelTarget` derived
  from the user's configured providers/models, so a profile can resolve to a route
  the `AgentBackendResolver` can actually run.
- Keep this mapping capability- and data-boundary-aware: a tier resolves only to
  targets whose declared capabilities and data boundary satisfy the work class.
- Credentials referenced by secure-storage identity only; never embed secret values
  in a profile or snapshot (enforced by an assertion + test).

### B2. Policy persistence and active-profile selection

- Add settings state for: selected routing profile (or `off`), plus optional
  per-project and per-user policy overrides, matching the precedence in
  `knowledge/model-routing.md` (session/agent pin > project > user > shipped default).
- Persist profile/override selection through the existing settings store. Persist
  resolved decisions as `routingPolicySnapshot` rows via the ledger owner when a
  routed run begins.
- Default remains `off` (unchanged behavior). Turning routing on is an explicit user
  action.

### B3. Live routed decision path (opt-in)

- Introduce an orchestrator seam that, for a run whose routing is enabled, calls
  `resolveRouteDecision(request, layers)` -> `SettingsService.resolveRoutedAgentBackend(decision)`
  and records the attempt through `RoutingLedger` (begin run, begin attempt as
  `reserved`, activate immediately before dispatch, finish with result/usage).
- Wire availability fallback: on eligible triggers (timeout, rate limit, provider
  unavailable, malformed response) re-resolve with the failed target id in
  `excludedTargetIds`, capped at `MAX_AUTOMATIC_ALTERNATES` (2). Replay only before
  any side-effecting tool call; after effects begin, hand off instead of auto-replay.
- Benign-refusal fallback stays fail-closed: it fires only with the scope-bound,
  single-use approval evidence and configured verifier already required by
  `fallback-policy.ts`/`ledger.ts`. No new bypass.
- Do not change the default (non-routed) path. When routing is `off`, the existing
  `resolveAgentBackend(selection)` flow is untouched.

### B4. Provenance recording

- For every routed result, persist provider, model, backend, reasoning effort,
  capabilities, data boundary, policy id/version, selection reason, rejected
  alternates, request-identity digest (computed from request bytes, never caller-
  supplied), latency, usage, cost, result class, and side-effect state.
- Assert no secrets are written into policy/attempt/snapshot JSON (test).

### B5. Route-decision UI activation

- Extend `RoutingPanel.tsx` from read-only to: profile selector (Off / Research Max /
  Balanced / Economy), optional per-work-class override view, and a live "effective
  route" display that shows the resolved provider/model/reasoning for each work class
  (not just the tier). Show the current status badge as Active/Off accurately.
- Keep telemetry/export off by default; surface it as an explicit control only.
- Preserve the existing `data-routing-status` contract used by render tests; update
  those tests for the new active state.

### B6. Tests (proportional to risk)

- Unit: tier->target mapping honors capability + data-boundary filtering and refuses
  secret embedding.
- Deterministic precedence: pin > project > user > shipped default resolves the
  expected target across representative work classes.
- Fallback acceptance: each eligible trigger produces the expected ordered alternate,
  stops after two, and refuses replay after a recorded side effect.
- Ledger integration: begin/reserve/activate/finish lifecycle persists all provenance
  fields and invalidates a stale reservation when a late side effect is marked.
- UI render tests: Off vs Active states, effective-route rendering, no secret leakage
  into rendered DOM.
- Guard test: with routing `off`, the resolved backend equals the pre-change
  `resolveAgentBackend` result (behavioral no-op proof).

### B7. Documentation

- Update `knowledge/current-state.md`: move the connected pieces out of "Not yet
  connected or live-verified" into "Implemented foundations", keep anything not
  live-verified clearly marked.
- Note in `knowledge/model-routing.md` that a live opt-in path now exists and how it
  maps to precedence and fallback.

Exit B: routing can be switched on for a run, the effective route is visible in
Settings, decisions and attempts are persisted with full provenance and no secrets,
availability + vetted-refusal fallbacks behave per contract, default-off behavior is
unchanged, and B6 tests plus Phase A checks pass.

---

## Sequencing and risk notes

- Do Phase A fully before Phase B; a red baseline invalidates any B result.
- Land B1-B2 (targets + persistence) before B3 (live path); the live path depends on
  resolvable targets and a place to persist snapshots.
- Keep every step reversible: routing defaults to `off`, and each PR should be
  independently revertible without affecting the default conversation path.
- This plan does not touch M2 (composer/ACP steering), M3 (SSH/Slurm live), or
  packaging. Those remain separate milestones.

## Assumptions

- The configured providers expose at least one model per tier the shipped profiles
  reference; if not, B1 surfaces the gap rather than inventing a target.
- No schema migration beyond existing routing tables is required; if a new column is
  needed, it gets an explicit migration plan (per `AGENTS.md`).
- "Live provider routing" in this plan means the local decision + resolver + ledger
  path. It does not include remote compute, which stays in M3.
