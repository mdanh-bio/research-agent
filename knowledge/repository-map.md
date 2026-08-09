# Repository Map

Research Agent intentionally keeps AIPOCH's layout so upstream changes remain reviewable.

- `src/main/` — Electron authority: runtimes, persistence, settings, updates, compute, credentials,
  notebooks, artifacts, and typed IPC owners.
- `src/renderer/` — React desktop and localhost web interfaces. It must not own credentials or invoke
  arbitrary host commands.
- `src/preload/` and `src/shared/` — typed renderer contract and cross-process data structures.
- `prisma/` — SQLite schema and migrations. Additive schema changes require migration and rollback
  tests before they are relied on.
- `packages/open-science/` — inherited SDK/CLI implementation. The directory name and public type
  names are compatibility identifiers even though the bundled command is branded `research-agent`.
- `resources/` and `build/` — bundled skills/connectors, icons, entitlements, and packaging hooks.
- `e2e/`, `scripts/`, and colocated `*.test.*` files — application and release verification.

## Extension boundaries

- Place backend-neutral routing contracts above the existing session route planner; do not embed
  routing policy in React components or one runtime adapter.
- Implement Codex app-server as an adapter behind the orchestrator. Do not fork the Codex Rust
  workspace in this repository.
- Implement scheduler behavior behind `SchedulerDriver`; keep SSH transport separate from Slurm
  state parsing and resource validation.
- Extend AIPOCH persistence and artifact lineage instead of introducing a second message store.
- Import no Synthetic Sciences skill or connector until its exact source, license, dependencies,
  data terms, and behavioral test are recorded.

Brand compatibility identifiers such as `open-science.db`, `open-science-preview:`, and legacy
`OPEN_SCIENCE_*` environment variables are not user-facing product names. Change them only through a
separate compatibility migration.
