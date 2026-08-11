# Implementation Plan: M2 — Steering and Bounded Multi-Agent Work

Last updated: 2026-08-11. Owner: Anh. Base commit: `6cdf94b` on `main`.

Execution status: **Stages 0 and 1 executed locally; Stages 2+ remain planning only**. The Stage 0/1
deterministic exit gates pass on 2026-08-11, but managed-binary/provider live evidence is unavailable
in this environment, so M2 is not live-certified. M2 is complete only after every required stage exit
gate and the final acceptance gate pass on the supported Apple-Silicon environment.

This plan follows `AGENTS.md`: diagnose before mutation, keep changes narrow and reversible, keep
renderer code outside credential/process authority, require exact approval for consequential child
dispatches, preserve raw research data, and distinguish deterministic tests from live provider or
packaged-app verification.

---

## 1. M2 outcome

M2 should let a user interact with an active task without losing its work and let the main agent use
a small, auditable set of child agents without creating an unbounded autonomous system.

M2 must deliver all of the following:

- `Auto`, `Steer active task`, `Ask side question`, and `Stop and replace` have explicit,
  backend-honest behavior.
- A Codex conversation managed by Research Agent uses the pinned direct app-server path when native
  steering, interruption, or forking is required.
- OpenCode steering is a durable, ordered queue. The UI must call it **queued steering**, because the
  current ACP path cannot mutate an already-running provider turn.
- Side questions run in read-only ephemeral child sessions and cannot interrupt or mutate the parent
  task.
- Every root and child run belongs to a persisted parent/child graph with bounded concurrency,
  depth, child count, time, model usage, and artifact output.
- The default maximum is four concurrently running agent nodes per graph, including the root agent.
- Child artifacts are written into run-isolated storage, finalized as immutable Versions, and linked
  to their exact run before the parent can consume them.
- Parent cancellation propagates to unfinished work descendants, and restart/error recovery never
  replays an ambiguous provider dispatch.
- Renderer projections show actual state and budgets but cannot forge session, turn, parent-run,
  route, approval, or artifact authority.

### Milestone exit statement

M2 can be declared complete only when tests and authorized live checks demonstrate that:

1. native or queued steering preserves the original task's completed and in-flight progress;
2. a side question finishes without interrupting, redirecting, or writing through the parent;
3. stop-and-replace never overlaps the replacement with an unconfirmed old turn;
4. no graph exceeds its concurrency, depth, child-count, or enforceable resource budget;
5. cancellation and restart tests leave no active orphan, duplicate prompt, reusable approval,
   unsealed artifact, or leaked concurrency slot; and
6. the actual runtime/provider/package verification boundary is recorded without overstating it.

---

## 2. Verified starting point

The following is the implementation baseline at the base commit, not a target-state claim.

| Area                     | What exists now                                                                                                                                                 | M2 gap                                                                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delivery decision        | `src/shared/message-delivery.ts` resolves `Auto`, `Steer`, `Side question`, and `Stop and replace`; uncertain Auto input safely chooses side question.          | No classifier, durable decision owner, IPC command, composer control, or runtime dispatch uses it.                                                                                              |
| Codex control            | `src/main/codex-app-server/` has a pinned-runtime verifier, narrow JSONL client, process adapter, path authority, approval broker, and research-thread service. | It is not the owner of composer sessions, runtime events, permissions, persistence, or active-turn state. Existing Codex conversations still use the ACP lifecycle.                             |
| ACP lifecycle            | `AcpRuntime` and `AcpRuntimeCoordinator` own create/resume/prompt/cancel, per-session interaction locks, artifacts, permissions, reconnects, and routing.       | ACP exposes no native steer or fork operation. The renderer rejects a second send while a turn is active.                                                                                       |
| Composer                 | Running sessions replace Send with a Cancel button in `ConversationPanel.tsx`; `workspace-conversation-controller.ts` blocks active-session submission.         | No active-turn delivery menu, queued status, side-question surface, or replacement progress.                                                                                                    |
| Run persistence          | Prisma has `AgentRun.parentAgentRunId`, `budgetJson`, `outputArtifactIdsJson`, and `RuntimeThreadLink`. M1 records routed runs.                                 | No graph owner, root graph, admission lease, budget enforcement, child scheduler, cancellation tree, or restart reconciliation uses these fields. Routing-off prompts do not create graph runs. |
| Conversation graph       | Session JSON v2 supports parent Agent Frames and `delegate` / `reviewer` frame kinds.                                                                           | There is no production API that creates, completes, or projects a general delegate frame.                                                                                                       |
| Artifacts                | Artifact runs have run IDs, graph provenance, RPC capability binding, pending storage, immutable Version finalization, and checksum evidence.                   | `ArtifactTurnOwner` assumes one active turn per app Session. Parallel children need distinct storage and capabilities so their handoff files and writes cannot collide.                         |
| Existing child-like work | Reviewer sessions and Task Runner flows demonstrate fresh sessions, bounded drive loops, cancellation, and artifact finalization.                               | They are specialized owners, not a reusable bounded multi-agent graph, and must not be silently repurposed without their existing tests.                                                        |

Official Codex app-server documentation describes `thread/start`, `thread/resume`, `thread/fork`,
`turn/start`, `turn/steer`, `turn/interrupt`, and terminal `turn/completed` events. The runtime pin and
its exact protocol tests remain authoritative for this repository; current online documentation is
orientation, not proof that pinned `0.147.0` implements an untested shape.

---

## 3. Scope boundaries

### In scope

- New and explicitly migrated Codex sessions managed through the pinned direct app-server.
- OpenCode through its pinned ACP runtime, with honest queued-steering behavior.
- Backend-neutral delivery decisions and typed renderer/main contracts.
- Read-only side-question sessions for Codex and OpenCode.
- A root-plus-direct-children graph, provider-neutral routing, exact child approvals, bounded
  scheduling, result handoff, artifact isolation, cancellation, and restart recovery.
- Apple-Silicon development, unpacked-app, and authorized live-provider verification.

### Out of scope

- Codex experimental APIs, generic RPC, `thread/shellCommand`, `process/*`, full-access mode,
  approval bypasses, or Codex's internal/native multi-agent implementation.
- Shared-workspace editing by parallel children. M2 children are read-only with artifact-only output.
- Grandchildren or an arbitrary-depth agent tree.
- Automatic provider replay after a prompt might have been accepted.
- Full Claude Code behavior parity. Claude remains a compatibility backend; it is not an M2 exit
  target.
- Interactive SSH, Slurm dispatch, remote compute, or any M3 work.
- DMG/ZIP release certification or M5 release work.

---

## 4. Product and safety decisions to confirm in Stage 0

These decisions are explicit because changing one later alters schema, UI copy, recovery, or tests.
The recommended value is the assumed value in the remaining stages.

| Decision              | Recommended M2 contract                                                                                                                                                   | Confirmation required                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Four-agent meaning    | Four **running nodes total**, including the root; therefore at most three children run beside an active root.                                                             | Confirm this is not intended to mean four children plus the root.           |
| Graph depth           | Depth 1: one root and direct children only.                                                                                                                               | Confirm grandchildren are deferred.                                         |
| Child-count limit     | At most eight admitted children per root graph, including completed and failed children.                                                                                  | Confirm the default; keep it configurable below a hard cap.                 |
| Parallel-write policy | Children cannot write the shared workspace. They may write only through a run-bound artifact capability into isolated storage.                                            | Confirm no child worktree/edit workflow is required for M2.                 |
| OpenCode steer        | Persist immediately, keep the current turn running, then deliver FIFO as an app-owned continuation after the current interaction releases.                                | Confirm the UI label is “Queue steering,” not “Steer now.”                  |
| Side-question context | Use only the last stable parent context plus the user's side question; do not consume unfinalized streamed output.                                                        | Confirm partial active output is excluded.                                  |
| Auto behavior         | Use the `interaction_router` only when a valid routed classifier is available; otherwise use the existing safe side-question default.                                     | Confirm Auto may incur one bounded classifier call when routing is enabled. |
| Child authorization   | Resolve task, provider/model, boundary, sandbox, and budget first; require one exact, single-use approval for each child or exact batch before provider dispatch.         | Confirm there is no ambient “always delegate” approval in M2.               |
| Legacy Codex sessions | Keep them on ACP until idle, then offer an explicit fresh app-server adoption with bounded history replay; never claim an ACP session was natively resumed by app-server. | Confirm no forced silent migration.                                         |
| Live exit gate        | Require one authorized Codex and one authorized OpenCode provider exercise in addition to fake/local tests.                                                               | If not approved, M2 remains locally accepted but not live-certified.        |

---

## 5. Delivery semantics to preserve

| Runtime state                              | Requested mode                     | Required behavior                                                                                                                                               |
| ------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No active turn                             | Auto/normal Send                   | Use the existing ordinary prompt path.                                                                                                                          |
| No active turn                             | Explicit Steer or Stop and replace | Reject as stale and retain the draft; do not silently reinterpret it as a normal prompt.                                                                        |
| Idle parent thread                         | Ask side question                  | Start a read-only child from the last completed context when a parent thread exists.                                                                            |
| Active Codex turn                          | Steer                              | Persist the instruction, call `turn/steer` for the exact thread/turn, and record the accepted turn ID.                                                          |
| Active OpenCode turn                       | Steer                              | Persist as queued, leave the current prompt untouched, and dispatch exactly once after release.                                                                 |
| Active Codex/OpenCode turn                 | Ask side question                  | Start a separate read-only child; do not cancel, steer, or wait on the parent.                                                                                  |
| Active Codex turn                          | Stop and replace                   | Persist replacement intent, interrupt the exact turn, wait for terminal `turn/completed` and local release, seal partial artifacts, then start the replacement. |
| Active OpenCode turn                       | Stop and replace                   | Persist replacement intent, request ACP cancellation, wait for terminal release, seal partial artifacts, then start the replacement.                            |
| Active turn, uncertain Auto classification | Auto                               | Choose side question. Never default uncertainty to cancellation or redirection.                                                                                 |
| Target turn changed before dispatch        | Any active-turn mode               | Mark the delivery stale/blocked and retain an explicit retry choice. Never retarget a newer turn automatically.                                                 |

Every active-turn message is persisted before its external side effect. Prompt text and attachments
remain in authoritative Session storage; delivery rows store only IDs and secret-free control
metadata.

---

## Stage 0 — Lock contracts and reproduce the baseline

### Goal

Freeze the exact M2 semantics and prove the repository is green before implementation starts.

### Things that must be achieved

- [x] Every decision in section 4 has an accepted value, using the recommended contract recorded in
      `notes/2026-08-11.md`.
- [x] The exact Codex `0.147.0` and OpenCode `1.18.12` protocol/capability boundary is recorded from
      the pinned source/tests; live managed-runtime probing remains unavailable.
- [x] Baseline failures, if any, are separated from M2 changes.
- [x] Two ADRs are accepted: delivery/runtime semantics and bounded graph/artifact ownership.

### What should be done

1. Record `git status --porcelain=v1`, `git rev-parse HEAD`, `node -v`, and `npm -v` in a dated note.
2. Run the current baseline:
   - `npm run typecheck`
   - focused `message-delivery`, Codex app-server, ACP interaction, routing-ledger, conversation-graph,
     session-persistence, artifact-turn, reviewer, and Task Runner suites
   - `npm run check:web-api-map`
3. Probe the app-managed Codex binary identity and version using the existing verifier. Inspect the
   pinned app-server schema or exact-tag source for every method/event added to production tests.
4. Confirm the OpenCode ACP runtime supports prompt and cancellation but no app-owned native steer or
   fork method. Record the exact observed capability response.
5. Write ADR 0005 for backend-honest delivery semantics and ADR 0006 for the graph, approval, budget,
   cancellation, and artifact model.
6. Update the threat-model proposal with duplicate dispatch, stale-turn retargeting, child authority
   forgery, concurrency leakage, artifact collision, and crash-window threats. Do not mark controls as
   implemented yet.
7. Define the internal M2 development gate. It must default off and must not appear as an available
   user feature until the final acceptance stage.

### What should be checked or confirmed

- [x] The working tree was not clean before implementation; the user-provided plan was the only
      pre-existing change and is identified in the dated note.
- [x] Current focused tests and typechecks pass, with exact counts recorded.
- [x] Online Codex docs are not used as a substitute for the pinned runtime schema.
- [x] No experimental or unsafe Codex method enters the allowlist.
- [x] The ADRs state that approval-only execution is not sandboxing.
- [x] M2 does not modify M1 fallback, M3 compute, or release behavior.

### Stage exit gate

Do not start schema or runtime changes until the decisions, protocol evidence, ADRs, and baseline note
are reviewed and accepted.

Stage 0 local status: **passed for deterministic preparation**. No managed Codex/OpenCode binary was
available under `/Users/mdanh/ResearchAgent-DEV`, so the live capability/version checks are recorded
as unavailable evidence rather than successful probes.

---

## Stage 1 — Add durable delivery and graph foundations

### Goal

Create restart-safe, secret-free authority for delivery decisions and agent graphs before connecting
any provider side effect.

### Things that must be achieved

- [x] Delivery intent can be prepared, persisted, accepted, completed, failed, cancelled, blocked, or
      recovered without copying prompt text into SQLite.
- [x] Every new M2 prompt has one root graph and one root `AgentRun`, even when transparent routing is
      off.
- [x] Parent, child, runtime-thread, budget, cancellation, and artifact-storage identities survive
      restart.
- [x] Cross-store Session/SQLite crash windows reconcile idempotently for the defined abandoned,
      recoverable, and dispatch-ambiguous outcomes.

### What should be done

1. Extend shared contracts with closed, validated types for:
   - delivery request, resolved behavior, decision source, and lifecycle status;
   - graph kind (`root`, `delegate`, `side-question`, `interaction-router`);
   - graph limits, per-run budget, observed usage, cancellation intent, and result summary;
   - renderer-safe graph and delivery projections.
2. Add an additive `AgentGraph` table with root task identity, lifecycle, concurrency/depth/child
   limits, total budget, observed usage, cancellation generation, timestamps, and revision.
3. Extend `AgentRun` additively with graph ID, frame ID, run kind, depth, artifact-storage session ID,
   observed-budget JSON, cancellation timestamps, safe failure code, and `updatedAt`. Treat legacy M1
   rows without a graph ID as read-only legacy roots.
4. Add a `MessageDelivery` metadata/journal table. Store project/session/message IDs, target root run,
   target prompt, backend/thread/turn IDs, requested/resolved mode, decision source, safe router
   metadata, sequence, lifecycle, timestamps, and safe error code. Store no message content, file
   bytes, credentials, raw provider payloads, or approval secrets.
5. Keep the existing required policy-snapshot relation honest for routing-off runs by adding a
   secret-free `configured_direct` one-target snapshot. It must say transparent routing was off and
   record the exact configured backend/provider/model/reasoning/boundary; it must not imply a routed
   fallback occurred.
6. Refactor run creation out of `RoutedRunOrchestrator` into an `AgentGraphOwner`/`AgentRunOwner` seam.
   M1 routing attaches its snapshot and attempts to the already-owned run rather than becoming the
   only way a run exists.
7. Add compare-and-set repository operations for graph/run transitions. Terminal transitions are
   one-way; duplicate completion, slot release, or approval consumption must be idempotent.
8. Add Session persistence support for a caller-supplied, main-generated message ID and validated
   message parts/uploads. Use a journaled sequence:
   - create `MessageDelivery(status=preparing)`;
   - append the exact user Message to authoritative Session JSON;
   - promote the delivery to its executable state;
   - acknowledge the renderer only after both are durable.
9. Reconcile crashes as follows:
   - journal row without a Session message: abandon it because the user never received an ack;
   - Session message plus `preparing` row: finish promotion idempotently;
   - dispatch-ambiguous row: mark `blocked`, never replay automatically.
10. Add conversation-graph helpers to create, validate, complete, cancel, and fail child Agent Frames
    without switching the parent's active branch.
11. Add runtime DDL, Prisma schema, index, fresh-database, existing-database, downgrade/rollback, and
    corruption tests. No destructive migration should be needed for existing rows.

### What should be checked or confirmed

- [x] Routing-off and routing-on prompts both create exactly one root run.
- [x] `configured_direct` snapshots are labeled accurately and contain no secrets.
- [x] A child cannot name a nonexistent parent, another graph, a depth beyond the limit, or a parent
      already terminal/cancelling.
- [x] Duplicate delivery IDs and duplicate runtime thread links fail safely.
- [x] Crash injection at the Session append/promotion boundary and dispatch-ambiguous recovery
      produce either one recoverable instruction or an explicit abandoned/blocked record; no provider
      call is made by the Stage 1 owner.
- [x] Legacy Session JSON and pre-M2 routing rows still load without backfill mutation.
- [x] Renderer saves have no access to the main-owned delivery/graph tables or authority fields; the
      M2 feature gate remains off and no renderer surface is connected.

### Stage exit gate

Schema compatibility, journal recovery, graph invariants, routing-on/off root creation, secret scans,
and focused persistence tests all pass with the M2 feature gate still off.

Stage 1 local status: **passed**. This stage adds authority and deterministic recovery foundations
only; provider-side steering, child dispatch, approvals, artifact isolation, composer controls, and
live packaged/runtime checks remain later-stage work.

---

## Stage 2 — Make direct Codex app-server a production session runtime

### Goal

Turn the existing narrow Codex client into a complete Research Agent runtime owner for M2-managed
Codex sessions without widening its trust boundary.

### Things that must be achieved

- [ ] A new Codex root Session can start, stream, approve, cancel, finish, persist, and resume through
      direct app-server.
- [ ] The main process always knows the exact owned thread and active turn IDs.
- [ ] Existing composer/session/event/artifact projections work without exposing raw app-server RPC
      to renderer code.
- [ ] Existing ACP Codex sessions have an honest compatibility/migration path.

### What should be done

1. Define a backend-neutral runtime port for start/resume/read state/start turn/cancel/close plus
   optional native steer and native fork capabilities. Do not force OpenCode to pretend it implements
   native operations.
2. Wrap `CodexAppServerClient` in a Codex runtime generation owner that:
   - starts only the verified app-managed binary;
   - owns one bounded process and multiple Research Agent threads;
   - loads owned thread IDs only from validated `RuntimeThreadLink` rows;
   - registers exact approval and notification handlers before dispatch.
3. Complete app-owned Codex authentication/provider configuration for subscription, official API,
   and configured gateway paths already supported by Research Agent. Resolve credentials only after
   target selection. Do not inherit ambient keys, proxy variables, SSH agents, global Codex config,
   or user Skills.
4. If an ephemeral local provider bridge/token is required, bind it to one runtime generation, keep
   the real provider secret in the main process, revoke it on teardown, and never persist the token.
5. Add an allowlisted notification projector for turn lifecycle, message deltas, thought/activity,
   tools, approvals, usage, errors, and terminal completion. Convert these into the existing
   `AcpRuntimeEvent`/Session projection rather than adding a second renderer event system.
6. Track active turn state from accepted `turn/start` responses and terminal notifications. Treat the
   request response as admission, not completion.
7. Connect the existing Codex approval broker to Research Agent's user approval surface. Unknown
   server requests, unowned threads, session-wide root grants, unsupported permission expansion, and
   missing handlers decline by default.
8. Preserve the adapter exclusion list: no arbitrary method, `thread/shellCommand`, `command/exec`,
   `process/*`, experimental capabilities, full access, approval bypass, arbitrary config, or
   turn-level sandbox override.
9. Bound protocol risk with maximum JSONL line size, maximum pending requests, request timeouts,
   notification payload caps, error redaction, and deterministic whole-process-tree teardown.
10. Persist/close `RuntimeThreadLink` rows at the same lifecycle boundaries as the owned thread. On
    resume, verify effective cwd, sandbox, model/provider, approval policy, and fork provenance.
11. For a legacy Codex ACP Session, keep the old path until idle. On explicit migration, start a new
    app-server thread, create a new Runtime Segment, replay only bounded completed history, mark
    `contextReset`, and retain the old provider identity for audit.

### What should be checked or confirmed

- [ ] Direct app-server handles a complete fake turn, approval, usage, and terminal event sequence.
- [ ] Out-of-order, duplicate, oversized, malformed, unknown-thread, and unknown-request messages fail
      closed without hanging pending promises.
- [ ] `turn/interrupt` is not treated as terminal until the matching completion notification arrives.
- [ ] A resumed thread is rejected if effective cwd, sandbox, provider/model, or ownership differs.
- [ ] Read-only and workspace-write policies remain exactly those permitted by the existing path
      authority; full access is unrepresentable.
- [ ] Process exit rejects pending operations, cancels approvals, closes links, and reaps descendants.
- [ ] An actual pinned-binary isolated handshake passes. A real provider turn is recorded separately
      and requires explicit approval.

### Stage exit gate

The direct Codex runtime passes protocol, security, session, event, approval, artifact, and restart
integration tests behind the M2 gate. Legacy ACP Codex behavior remains unchanged until migration.

---

## Stage 3 — Connect delivery decisions to IPC and the composer

### Goal

Make the main process the single authority that resolves and executes active-turn delivery while the
composer remains usable and honest about the selected behavior.

### Things that must be achieved

- [ ] The renderer can submit an active-turn message with an explicit mode but cannot select its
      actual thread, turn, parent run, route, or approval identity.
- [ ] Every decision is bound to the exact active turn observed at admission.
- [ ] Codex native steer and stop-and-replace work through the production runtime.
- [ ] Auto cannot turn uncertain input into cancellation or redirection.

### What should be done

1. Add a main-process `MessageDeliveryOwner` that captures one immutable active-turn snapshot:
   session ID, root run ID, backend generation, runtime thread ID, turn ID, prompt message ID, and
   cancellation generation.
2. Validate renderer input as content plus requested mode only. Resolve all authority fields in main,
   reject archived/deleted/unreadable sessions, and revalidate the active snapshot immediately before
   every external side effect.
3. Persist the Session message and delivery journal before calling a backend. Return a renderer-safe
   durable projection so the UI can apply the exact main-owned Message without resaving it as new.
4. Connect Auto:
   - use a bounded, tool-free `interaction_router` run only when a valid policy/target exists;
   - require a closed enum, confidence in `[0,1]`, and the configured threshold;
   - persist router run/model/policy provenance and safe decision metadata;
   - use side question on timeout, error, invalid output, no slot, no route, or low confidence.
5. Implement Codex Steer by calling `turn/steer` with the exact expected turn ID. Mark the instruction
   accepted only when the returned ID matches; a stale turn becomes a visible blocked delivery.
6. Implement Codex Stop and replace as a state machine: persist intent, request interrupt, wait for the
   matching terminal event, release the local interaction, seal partial output/artifacts, then start
   the replacement run. Do not use the existing immediate interrupt-then-start helper as production
   proof.
7. Register typed application command, Electron IPC, preload, Web map, and renderer API contracts.
   Expose no raw app-server or ACP method name.
8. Change the active-session composer behavior:
   - keep draft editing and attachment preparation available when safe;
   - keep Cancel as a separate action;
   - add Auto, Steer/Queue steering, Ask side question, and Stop and replace controls;
   - use destructive styling and clear copy for Stop and replace;
   - retain the draft on stale/failed admission and clear it only after the durable ack.
9. Keep the ordinary idle Send path unchanged in this stage. If the active turn settles before main
   admission, return a stale result and let the user resend normally rather than silently changing
   semantics.

### What should be checked or confirmed

- [ ] Renderer payloads that forge a run/thread/turn/route/backend/approval field are stripped or
      rejected.
- [ ] A turn-change race between click and dispatch never targets the newer turn.
- [ ] Codex steer does not create a new turn and does not interrupt the active one.
- [ ] Stop-and-replace starts exactly one replacement only after old-turn terminal confirmation.
- [ ] Auto classifier failure always chooses side question and never modifies message bytes.
- [ ] Session deletion, archive, graph-sync failure, upload failure, or persistence failure blocks the
      external action and preserves the draft.
- [ ] Existing idle Send, plan-first, branch, edit, permission, fix-loop, and cancel tests remain green.

### Stage exit gate

With fake transports, every delivery decision has one durable message, one journal row, one exact
target turn, and at most one backend action. Codex behavior passes; OpenCode Steer remains visibly
unavailable until Stage 4.

---

## Stage 4 — Implement durable OpenCode steering and replacement

### Goal

Provide useful active-task control on OpenCode without pretending ACP can steer an already-running
provider turn.

### Things that must be achieved

- [ ] A queued steering message survives renderer reload and app restart.
- [ ] The current OpenCode prompt continues untouched.
- [ ] Queue delivery is FIFO and exactly once at the Research Agent dispatch boundary.
- [ ] Ambiguous post-dispatch restart state blocks instead of replaying.

### What should be done

1. Give OpenCode delivery rows a strict lifecycle:
   `preparing -> queued -> dispatching -> accepted -> completed`, with terminal
   `failed`, `cancelled`, or `blocked` branches.
2. Bind each item to its original parent prompt/run and a monotonic per-session sequence. Cap the
   queue and reject overflow before accepting more user messages.
3. Enqueue only after the user Message is durable. Do not cancel the active prompt, mutate its request,
   change its model, or mark the queue as delivered.
4. Drain only after all of these are true:
   - the exact parent interaction reached a durable terminal state;
   - artifact publication/finalization for that turn settled;
   - the session interaction lock and routed-target lease released;
   - no cancellation/replacement/migration barrier owns the session.
5. Claim one queued item atomically, then send it through `sendAppContinuation` with its original
   Message identity and `suppressUserMessage`. Never create a second visible user message.
6. Keep items FIFO. A failed/blocked item stops later items until the user retries, cancels, or removes
   the blocker; do not silently reorder intent.
7. Define restart behavior:
   - `queued` and never dispatched: safe to resume after the parent is durably terminal;
   - `dispatching` without provider-acceptance proof: `blocked`, no replay;
   - `accepted`: observe/resume if provable, otherwise mark the run interrupted; never resend;
   - parent interrupted before terminal: preserve the queue but require parent recovery first.
8. Implement OpenCode Stop and replace using the same persisted replacement state: request ACP cancel,
   wait for interaction release, seal the old run, then send the replacement exactly once.
9. Label OpenCode controls and timeline entries “Queued steering,” “Waiting for current turn,” and
   “Delivered after current turn.” Do not use “Steered active turn.”

### What should be checked or confirmed

- [ ] Enqueueing never invokes ACP cancel or prompt for the current turn.
- [ ] Multiple messages drain in sequence and do not duplicate visible transcript messages.
- [ ] A queue item added as the parent finishes is either part of the next drain or safely queued,
      never lost between states.
- [ ] Crash injection before claim, after claim, before provider acceptance, after acceptance, and
      after completion produces the defined state without duplicate dispatch.
- [ ] Queue overflow, stale parent binding, archived session, failed artifact finalization, and
      cancellation all fail closed.
- [ ] Stop-and-replace cannot overlap two OpenCode prompts for the same session.

### Stage exit gate

The pinned fake OpenCode agent proves FIFO persistence, current-turn preservation, exact-once local
dispatch, replacement ordering, and restart/error behavior. UI copy accurately distinguishes queued
from native steering.

---

## Stage 5 — Add read-only ephemeral side-question children

### Goal

Answer a question from stable parent context in a separate child without interrupting or modifying
the parent task.

### Things that must be achieved

- [ ] Side questions have explicit child graph/run/frame/thread lineage.
- [ ] Parent turn IDs, interaction locks, models, messages, and cancellation state do not change.
- [ ] Side-question runtime access is read-only and consequential tools fail without prompting the
      parent user flow.
- [ ] The child result persists while its runtime session is ephemeral and cleaned up.

### What should be done

1. Create a `side-question` child run and Agent Frame under the active root. It consumes one graph
   slot and its own bounded budget but does not become the parent's active frame.
2. Capture an immutable context boundary before child creation:
   - completed active-branch messages through the last stable turn;
   - the parent task prompt when needed for interpretation;
   - immutable referenced Artifact/Upload Version identities;
   - no unfinalized streamed model output or mutable path-only reference.
3. For Codex, call `thread/fork` from the owned parent with the last completed turn ID,
   `ephemeral: true`, and `sandbox: read-only`. Verify the returned thread is distinct and reports
   correct fork provenance before starting its turn.
4. For OpenCode, create a separate ACP session and send a bounded history preamble plus the question.
   Record that it is an app-level context snapshot, not a native provider fork.
5. Apply a child-only permission policy: safe reads may run; workspace writes, shell side effects,
   network expansion, compute, Specialist mutation, and approval escalation decline. Side questions
   receive no artifact-write capability in M2.
6. Project output into a side-question card/child frame linked to the initiating user Message. Do not
   append it as though it were the primary agent's next answer.
7. On terminal completion, failure, timeout, cancellation, parent deletion, or app shutdown, close the
   runtime link and dispose/delete the ephemeral child session. Keep the durable result and provenance.

### What should be checked or confirmed

- [ ] Parent streaming continues while the child starts and finishes.
- [ ] Parent active thread/turn, model, interaction owner, artifacts, and message branch are unchanged.
- [ ] Codex fork is ephemeral, distinct, read-only, and bound to the intended stable turn.
- [ ] OpenCode child context excludes partial active output and stays under replay limits.
- [ ] Attempted child writes/tools are declined without granting or leaking parent permissions.
- [ ] Child timeout/failure is isolated and frees its graph slot exactly once.
- [ ] Session deletion and quit leave no child process, runtime session, link, or approval pending.

### Stage exit gate

Codex and OpenCode side-question integration tests show the parent completing normally, the child
answering independently, all write attempts denied, and all ephemeral resources cleaned up.

---

## Stage 6 — Implement the bounded parent/child agent graph

### Goal

Let the main agent delegate a small number of independent read-only tasks through an app-owned,
auditable scheduler.

### Things that must be achieved

- [ ] Delegation is impossible without a trusted parent run and remaining graph budget.
- [ ] The four-agent concurrency, depth-one, and child-count limits are enforced atomically.
- [ ] Each child has an exact provider/model/data-boundary/budget approval before dispatch.
- [ ] Parent agents can spawn, inspect, wait for, and cancel their own direct children only.

### What should be done

1. Add an app-owned delegation tool/port with closed operations such as `spawn`, `status`, `wait`, and
   `cancel`. Do not overload Specialist profile mutation/switch operations without an explicit contract
   separation.
2. Bind the tool to a short-lived, run-scoped capability that injects project, Session, graph, parent
   run, parent frame, route constraints, and cancellation generation in main. Model arguments may
   provide task text, role/work class, requested result shape, and a budget no larger than the parent
   remainder; they cannot provide authority IDs.
3. Validate delegation before approval:
   - parent is running and not cancelling;
   - depth is zero and child cap is not exhausted;
   - task is non-empty and within size limits;
   - requested capabilities/data boundary do not exceed the parent;
   - a route exists and the exact target can run under the read-only child policy;
   - graph budget can reserve the child.
4. Present an exact, secret-free, single-use approval containing child task summary, role/work class,
   provider/model, data boundary, read-only policy, time/token/artifact limits, and whether it is part
   of a batch. Bind the approval to the task digest, parent/child IDs, target, policy version, and
   budget. Any change invalidates it.
5. Atomically consume approval and transition the child from queued to running immediately before
   runtime/thread creation. A declined child becomes terminal without a provider call.
6. Implement FIFO admission per graph with a global fairness check. The root owns one of four slots;
   the fifth simultaneous node waits queued. Failed startup refunds the running slot but not the
   admitted child-count slot.
7. Create children using the backend-neutral runtime port:
   - Codex: ephemeral read-only fork from stable parent context;
   - OpenCode: separate read-only ACP session with bounded context snapshot.
8. Route each child by work class through M1 policy and attach exact attempts to its existing
   `AgentRun`. Children cannot choose arbitrary providers or weaken the parent data boundary.
9. Return small structured text plus immutable artifact references. `wait` may block only within its
   own wall-clock budget and must remain cancellation-aware. A failed child returns structured failure
   to the parent instead of crashing the root interaction.
10. Keep automatic review and existing Task Runner flows outside the new graph until separate adapters
    explicitly opt in; preserve all their existing lifecycle tests.

### What should be checked or confirmed

- [ ] Root plus three children run; a fourth child waits until a slot releases.
- [ ] Concurrent admission transactions cannot exceed four running nodes or eight total children.
- [ ] Grandchild, cross-graph parent, terminal parent, forged authority, replayed approval, route drift,
      and budget escalation are rejected before provider dispatch.
- [ ] Decline, startup failure, provider failure, timeout, and child cancellation release the running
      slot once and preserve terminal provenance.
- [ ] Different graphs receive fair progress and cannot steal each other's reserved budgets.
- [ ] A child cannot mutate Specialist bindings, routing settings, permission profiles, compute hosts,
      or shared workspace files.

### Stage exit gate

Deterministic concurrency and approval tests prove hard admission bounds under simultaneous requests,
failures, cancellation, and restart reconstruction. No child provider call occurs without a consumed
exact approval.

---

## Stage 7 — Isolate artifacts and hand results back safely

### Goal

Give every child a collision-free output channel and make only finalized, checksum-verified results
visible to the parent.

### Things that must be achieved

- [ ] Parallel children never share `current-run.json`, pending directories, artifact capability
      tokens, notebook provenance context, or mutable output paths.
- [ ] `AgentRun.outputArtifactIdsJson` names only immutable finalized Versions owned by that run.
- [ ] Parent consumption retains child run, frame, model attempt, input, environment, and checksum
      lineage.

### What should be done

1. Allocate a safe, unique `artifactStorageSessionId` for every child run while retaining the parent
   app Session ID in provenance. Never derive a filesystem path directly from model text or role name.
2. Refactor `ArtifactTurnOwner` so active turns and handoff locks are keyed by run/child storage
   identity rather than assuming one active artifact turn per app Session.
3. Issue one artifact RPC capability per delegate run, bound to project, parent Session, graph/run,
   Agent Frame, branch, runtime segment, prompt, allowed methods, expiry, artifact count, and byte
   budget. Side-question children receive no write capability.
4. Deny direct shared-workspace writes. Child-created files enter only the isolated pending/Version
   pipeline.
5. On child terminal output:
   - revoke and drain its write capability;
   - seal all pending writes;
   - compute/verify checksums and provenance;
   - finalize immutable Versions;
   - atomically attach Version IDs to the child run;
   - only then mark the run completed and publish its result to the parent.
6. If finalization fails, mark the child failed/blocked and keep recoverable pending evidence. Do not
   return mutable paths or claim success.
7. Add a bounded result envelope with summary text, omission/truncation markers, Version identities,
   and unavailable-evidence reasons. Parent prompts receive locators, not unrestricted filesystem
   paths.
8. Make cancellation close writes and retain already finalized Versions. Late output after terminal
   status is quarantined/reconciled and never silently attached to another run.

### What should be checked or confirmed

- [ ] Three simultaneous children can create the same filename without collision or overwrite.
- [ ] Each resulting Version has the correct graph/run/frame/thread/model/input/checksum lineage.
- [ ] Capability reuse, cross-child token use, expired token use, path traversal, symlink escape,
      artifact-count overflow, and byte-budget overflow fail closed.
- [ ] Parent result publication never precedes Version finalization.
- [ ] Cancellation during write, failure during checksum, crash during finalization, and duplicate
      finalize recover idempotently.
- [ ] Raw research inputs remain unchanged; only derived run/artifact locations are written.

### Stage exit gate

Parallel artifact stress and recovery tests pass with immutable lineage, no shared mutable child
output, and no false-complete run after finalization failure.

---

## Stage 8 — Enforce budgets, cancellation, and restart/error recovery

### Goal

Make bounds and terminal behavior hold under the races and failures that are most likely to create
duplicate work or orphaned resources.

### Things that must be achieved

- [ ] Admission and runtime enforcement use one graph budget authority.
- [ ] Parent cancellation stops new admission and propagates to every unfinished descendant.
- [ ] Startup reconciliation either reattaches with proof or makes ambiguity explicit without replay.
- [ ] Every slot, timer, approval, process, link, capability, and artifact owner settles exactly once.

### What should be done

1. Define hard default graph limits after Stage 0 confirmation:
   - four running nodes including root;
   - depth one;
   - eight admitted children;
   - per-child and total wall-clock deadlines;
   - bounded input/context, output, result-envelope, artifact-count, and artifact-byte limits.
2. Reserve budget atomically before approval/dispatch and reconcile observed usage after terminal
   output. Enforce output/time/child/concurrency/artifact bounds even when a provider reports no usage.
3. Enforce token or cost limits only when the transport supplies trusted values or a pre-dispatch hard
   control. Mark unavailable values explicitly; do not present estimates as hard enforcement or invent
   cost.
4. Add a graph cancellation generation. Parent cancel/stop/session delete/quit first increments the
   generation and blocks admission, then records cancellation intent for all nonterminal descendants,
   then dispatches backend cancellation with bounded waits.
5. Revalidate the generation immediately before thread/session creation, provider prompt, artifact
   capability issue, and result publication. Late work from an older generation cannot publish.
6. Define child-only cancel as local to that subtree. Root cancel propagates to all work and
   side-question children. Session deletion and app quit always cancel/close the whole graph.
7. Reconcile startup by state:
   - Codex thread/turn status provably active: resume/subscription and continue observation;
   - Codex terminal: reconstruct/finalize from owned thread history and persisted IDs;
   - OpenCode prompt accepted before process loss: mark interrupted/blocked; never replay;
   - OpenCode queued steering never dispatched: retain safely;
   - ephemeral child after process loss: terminalize and clean its link/capability;
   - dispatching/approval ambiguity: block for user review;
   - orphan running slot with no live owner: release only through reconciliation transaction.
8. Add bounded timeouts for startup, provider acceptance, child execution, wait, interrupt, artifact
   drain, and teardown. Timeout messages must distinguish “request sent” from “terminal confirmed.”
9. Use failure injection at every async boundary and verify idempotent cleanup on retry.

### What should be checked or confirmed

- [ ] Parent cancellation during queued admission, approval, runtime start, provider execution,
      artifact write, and result publication prevents all later unauthorized boundaries.
- [ ] A child completing while cancellation propagates has one deterministic terminal outcome and no
      duplicate result.
- [ ] Restart reconstructs the correct running count and never admits a fifth node.
- [ ] OpenCode accepted prompts and ambiguous Codex dispatches are never automatically replayed.
- [ ] Approval tokens cannot survive target, budget, generation, restart, or task-identity drift.
- [ ] Timeouts close processes/links/capabilities or leave an explicit blocked record for retry.
- [ ] No cancellation/error path erases partial output or finalized artifacts already recorded.

### Stage exit gate

The full fault-injection matrix passes across both target backends. There are no leaked slots,
processes, runtime sessions, links, timers, approvals, or artifact capabilities after terminal state.

---

## Stage 9 — Complete graph UI, observability, and security review

### Goal

Make M2 understandable and auditable without leaking raw provider/control data into the renderer.

### Things that must be achieved

- [ ] Users can see what mode occurred, whether steering was native or queued, and which turn it
      targeted.
- [ ] Users can inspect/cancel children and see concurrency/budget state.
- [ ] Errors identify safe next actions without suggesting that ambiguous work was retried.
- [ ] Security labels distinguish sandboxing, approval, read-only policy, and provider data transfer.

### What should be done

1. Add a renderer-safe delivery timeline with requested/resolved mode, source, backend behavior,
   target turn, queue position, and lifecycle. Show router confidence only when valid and useful.
2. Add a compact Agent Graph panel/tree with role, backend/model, status, parent, elapsed time,
   concurrency (`n/4`), enforceable budget remaining, artifacts, and child cancel controls.
3. Render side-question output separately from the primary transcript and make its parent context
   boundary visible.
4. Show exact user-facing states: native steering accepted, queued steering waiting, replacement
   cancelling, replacement starting, child awaiting approval, child queued for slot, blocked after
   restart, and partial output retained.
5. Keep secrets, raw headers, auth state, internal capability tokens, provider payloads, filesystem
   roots, and arbitrary RPC errors out of renderer state and diagnostics.
6. Add accessibility coverage for keyboard delivery selection, destructive-action labeling, status
   announcements, focus return, reduced motion, and screen-reader graph relationships.
7. Add bounded diagnostics with run/delivery IDs, backend, safe state, policy version, elapsed time,
   and unavailable-evidence markers. External telemetry/export remains off and unavailable by default.
8. Review the implementation against `docs/threat-model.md`, ADR 0003, ADRs 0005/0006, and all
   `AGENTS.md` authorization rules.

### What should be checked or confirmed

- [ ] UI never says “steered” for queued OpenCode behavior.
- [ ] “Interrupt requested” and “turn terminal” are visually and semantically distinct.
- [ ] A renderer cannot mutate graph or delivery state through snapshot fields.
- [ ] Graph output is bounded for many completed children and does not retain unbounded streams.
- [ ] Keyboard-only and screen-reader flows can choose modes, approve/decline, inspect status, and
      cancel safely.
- [ ] Error reports contain no prompt content by default and no credential/token/secret-like field.
- [ ] Telemetry/export remains disabled unless a separate approved milestone changes it.

### Stage exit gate

Renderer interaction, accessibility, redaction, structural contract, and threat-model tests pass.
Every displayed claim corresponds to a persisted main-process state.

---

## Stage 10 — Acceptance, live verification, and documentation

### Goal

Prove the complete M2 behavior in deterministic tests, the real pinned runtimes, and an unpacked app,
then update durable project knowledge with the exact verification boundary.

### Things that must be achieved

- [ ] All focused and repository-wide checks pass.
- [ ] Real pinned Codex and OpenCode paths pass authorized live scenarios.
- [ ] An unpacked Apple-Silicon app passes the M2 journey with isolated state.
- [ ] Current-state and roadmap documentation distinguish implemented, locally verified, live
      verified, packaged verified, and still-deferred behavior.

### What should be done

1. Run focused suites for all changed domains:
   - delivery resolver/owner and classifier;
   - Session journal and startup reconciliation;
   - Agent Graph repository/scheduler/budgets;
   - routing ledger integration;
   - Codex app-server client/runtime/event/approval/process;
   - ACP/OpenCode queue and child sessions;
   - conversation graph/frame projection;
   - artifact isolation/finalization/recovery;
   - renderer controllers/components/accessibility;
   - reviewer and Task Runner regression boundaries.
2. Run normal repository verification:
   - `npm run typecheck`
   - `npm run test`
   - `npm run lint`
   - `npm run check:web-api-map`
   - `npm run check:claude-acp-patch`
   - `npm run test:cli`
   - `npm run test:private-package`
   - `npm run build`
   - `git diff --check`
3. Add deterministic Electron journeys with fake/local providers:
   - Codex native steer preserves and completes the active task;
   - Codex/OpenCode side question finishes while parent work continues;
   - OpenCode queued steer survives restart and dispatches once;
   - stop-and-replace waits for old terminal state;
   - root plus three children run while the next child queues;
   - parent cancel propagates;
   - same-named child artifacts remain isolated and verified.
4. Before each live provider scenario, show the user the exact backend, provider, model, data boundary,
   test prompt, child count, budget, and expected external actions, then obtain single-use approval.
5. Run one real Codex native-steer/side-question scenario and one real OpenCode queued-steer/
   side-question scenario. Record provider/model, policy version, run/attempt IDs, usage availability,
   timings, results, and any unavailable evidence. Use benign, non-sensitive test data.
6. Build an unpacked arm64 app and run the M2 journey with isolated config/data/storage roots. Verify
   clean shutdown and no collision with Research Agent production, AIPOCH, or Claude Science state.
7. Append a dated note with exact commands, versions, counts, live approvals, outcomes, and skipped
   checks.
8. Update `knowledge/current-state.md`, `knowledge/system.md`, the accepted ADRs,
   `docs/threat-model.md`, `docs/roadmap.md`, and `README.md`. Remove stale “not connected” statements
   only for behavior actually verified.

### What should be checked or confirmed

- [ ] Full tests, typechecks, build, lint, formatting, API map, and package guards pass with exact
      counts recorded.
- [ ] Live checks use the pinned Codex `0.147.0` and OpenCode `1.18.12`, or an approved pin update with
      its own source/license/protocol review.
- [ ] Fake-server success is not described as a real provider result.
- [ ] A real provider result is not described as packaged-app success unless the packaged journey ran.
- [ ] No remote compute, Slurm job, SSH login, DMG/ZIP release, or public upload occurred.
- [ ] Every child live dispatch has exact approval evidence and complete available provenance.
- [ ] Remaining limits—especially broad Codex read-only filesystem visibility, Claude parity, trusted
      cost availability, and parallel workspace editing—remain documented.

### Stage exit gate

All M2 milestone exit statements in section 1 are supported by recorded evidence. If either authorized
live-provider check or the unpacked-app journey is skipped, report M2 as partially/local verified, not
complete.

---

## 6. Required acceptance matrix

| Scenario                                 | Expected result                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Codex native steer during active work    | Same thread and turn; no interrupt/new turn; steering message accepted once; parent completes. |
| OpenCode queued steer during active work | Current prompt is untouched; message is durable; continuation dispatches once after release.   |
| Uncertain Auto                           | Read-only side question; no cancellation or steering.                                          |
| Codex side question                      | Ephemeral read-only fork from stable turn; parent continues.                                   |
| OpenCode side question                   | Separate read-only ACP session from bounded stable context; parent continues.                  |
| Stop and replace                         | Old turn terminal and artifacts sealed before one replacement starts.                          |
| Four-agent cap                           | Root + three running children; next child remains queued.                                      |
| Child approval decline                   | No provider/thread/session creation; child terminal; budget/slot state consistent.             |
| Parent cancellation                      | Admission closes; all unfinished descendants cancel; late results cannot publish.              |
| Restart before child dispatch            | Safe queued work may resume; no provider call is duplicated.                                   |
| Restart after ambiguous dispatch         | Run/delivery is blocked for review; no automatic replay.                                       |
| Parallel same-name artifacts             | Separate immutable Versions with correct child lineage and checksums.                          |
| Renderer forgery                         | Forged authority is rejected before persistence/provider/artifact boundaries.                  |
| Session deletion/quit                    | All child processes, sessions, links, approvals, capabilities, and timers settle.              |

---

## 7. Primary risks and required mitigations

| Risk                                        | Required mitigation                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Codex ACP and app-server state diverge      | One runtime owns a Session at a time; migration creates a new Runtime Segment and explicit context reset. |
| Interrupt response mistaken for completion  | Wait for matching terminal notification and local interaction release before replacement.                 |
| OpenCode queue replays after crash          | Persist pre-dispatch/accepted boundary; block ambiguous dispatch instead of replaying.                    |
| Renderer targets a newer/different turn     | Main resolves and revalidates exact thread/turn/generation; renderer cannot supply them.                  |
| Child graph expands without bound           | Depth one, child cap, four running nodes including root, atomic admission, and exact budgets.             |
| Child calls provider without user authority | Resolve exact target/budget first; consume a task-bound single-use approval immediately before dispatch.  |
| Parallel children overwrite files           | Read-only workspace plus per-run artifact storage and capability tokens.                                  |
| Partial artifact is reported complete       | Finalize/checksum/link before completed status and parent publication.                                    |
| Usage/cost is unavailable                   | Enforce count/time/output/artifact controls; mark token/cost unavailable rather than estimating.          |
| Process/event flood exhausts the app        | Bound JSONL lines, pending requests, notifications, result envelopes, graph projection, and logs.         |
| Restart leaks slots or replays work         | Persist lifecycle boundaries and reconstruct through an idempotent reconciliation owner.                  |
| Existing reviewer/task behavior regresses   | Keep specialized owners separate and run their focused plus full regression suites.                       |

---

## 8. Likely code ownership map

This is a navigation guide, not permission to modify every listed file.

- Shared contracts: `src/shared/message-delivery.ts`, a new bounded-agent contract, model-routing
  types, conversation graph, and renderer contract catalog.
- Persistence: `prisma/schema.prisma`, `src/main/projects/prisma-client.ts`, model-routing ledger,
  Session persistence coordinator/state owner, and new delivery/graph repositories.
- Codex runtime: `src/main/codex-app-server/` plus a narrow runtime/event adapter behind the
  orchestrator.
- OpenCode/ACP: `src/main/acp/runtime*.ts`, session interaction owner, prompt workflow, continuation
  owner, and provider/session lifecycle seams.
- Artifacts: `src/main/acp/artifact-turn-owner.ts`, artifact RPC capability owner, Version/finalization
  repositories, and recovery tests.
- Renderer: ACP workspace runtime hook/command owner, workspace conversation controller,
  `ConversationPanel.tsx`, Session store graph projection, and new delivery/agent graph views.
- Verification: colocated Vitest, persistence integration tests, Electron E2E journeys, dated notes,
  current state, ADRs, roadmap, README, and threat model.

---

## 9. Final M2 checklist

- [ ] Stage 0 contracts and ADRs accepted.
- [ ] Stage 1 durable foundations and recovery pass.
- [ ] Stage 2 direct Codex runtime pass.
- [ ] Stage 3 delivery IPC/composer and native Codex controls pass.
- [ ] Stage 4 OpenCode queued semantics pass.
- [ ] Stage 5 side-question isolation pass.
- [ ] Stage 6 bounded graph, approvals, and concurrency pass.
- [ ] Stage 7 artifact isolation and lineage pass.
- [ ] Stage 8 cancellation/budget/restart fault matrix pass.
- [ ] Stage 9 UI/accessibility/security review pass.
- [ ] Stage 10 full, live, and unpacked-app acceptance pass.
- [ ] `knowledge/current-state.md` reports only the evidence actually observed.
- [ ] M3, M4, and M5 remain unchanged and separately gated.

## References

- [Research Agent roadmap](../roadmap.md)
- [Current verified state](../../knowledge/current-state.md)
- [System and trust boundaries](../../knowledge/system.md)
- [Repository extension boundaries](../../knowledge/repository-map.md)
- [ADR 0003: Codex app-server boundary](../adr/0003-codex-app-server-boundary.md)
- [Threat model](../threat-model.md)
- [Official Codex app-server lifecycle](https://learn.chatgpt.com/docs/app-server#lifecycle-overview)
- [Official Codex app-server API overview](https://learn.chatgpt.com/docs/app-server#api-overview)
