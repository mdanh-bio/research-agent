# ADR 0005: Keep delivery behavior honest at the backend boundary

- Status: Accepted through M2 Stage 5 deterministic integration; live/package verification pending
- Date: 2026-08-11

## Context

Research Agent has a shared delivery decision contract, but the existing ACP lifecycle owns only
ordinary prompts and cancellation. Codex app-server can steer and fork through the pinned stable
JSONL boundary; OpenCode ACP exposes prompt and cancellation, but no app-owned native steer or fork
operation. Treating those backends as equivalent would make a UI action claim behavior the runtime
cannot perform.

## Decision

Use four explicit delivery behaviors: continue, steer, side-question, and stop-and-replace. Persist
the request and decision before any provider side effect, bind active-turn operations to the exact
thread and turn identity, and reject stale explicit active-turn operations instead of silently
reinterpretating them as ordinary prompts.

Codex uses native `turn/steer`, `turn/interrupt`, and read-only `thread/fork` only through the
existing allowlisted adapter. OpenCode labels steering as **Queue steering**: the instruction is
persisted FIFO and dispatched once as an app-owned continuation after the current ACP interaction
releases. Side questions always use a separate read-only child and never wait on, cancel, or mutate
the parent. Uncertain Auto input chooses a read-only side question.

The M2 development gate is internal and default-off. No delivery control is advertised to users
until the final M2 acceptance stage demonstrates the backend-specific behavior.

Approval-only execution is authorization, not sandboxing. This ADR does not widen the Codex adapter
to experimental methods, arbitrary RPC, full-access mode, or approval bypasses.

## Consequences

The renderer can display the requested and resolved behavior only as a main-process projection. It
cannot forge a thread, turn, parent run, or approval identity. OpenCode and Codex intentionally have
different delivery implementations, while the persisted contract and recovery semantics remain
backend-neutral.
