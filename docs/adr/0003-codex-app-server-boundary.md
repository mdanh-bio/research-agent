# ADR 0003: Integrate Codex through the stable app-server boundary

- Status: Accepted through M2 Stage 5 deterministic integration; live/package verification pending
- Date: 2026-08-10

## Context

Native Codex thread forks, steering, interruption, discovery, sandbox approvals, skills, and MCP are
needed without maintaining a fork of the Codex Rust workspace.

## Decision

Run the pinned Codex executable as `codex app-server` over JSONL and expose only the stable operations
needed by Research Agent: initialize, thread start/resume/read/list/fork, and turn
start/steer/interrupt. Experimental APIs, generic outbound RPC, `thread/shellCommand`, process APIs,
danger-full-access, approval bypasses, arbitrary config, unsafe CLI flags, and turn-level sandbox
overrides are outside the adapter.

Managed threads default to read-only with user-reviewed on-request approval. Workspace-write requires
an explicit cwd inside a main-process-approved root. Side questions fork ephemeral read-only threads.

## Consequences

The boundary is narrow and upstream-replaceable, but the existing ACP session lifecycle does not yet
use it. Composer delivery modes must not be advertised as operational until IPC, task state, approval
responses, and runtime-thread persistence are connected and tested.
