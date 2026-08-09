# Research Agent Roadmap

The milestones are sequential trust gates, not calendar promises. A milestone is complete only after
its exit checks pass on the supported Apple-Silicon development environment.

## M0 — Private fork and trustworthy baseline

- Preserve AIPOCH v0.12.1 history and configure private `origin` plus AIPOCH `upstream`.
- Rebrand application/package identity and isolate config, data, cache, and development roots.
- Disable AIPOCH public updates; document manual private updates.
- Record exact upstream/reference pins, licenses, project rules, knowledge, and threat model.
- Pin Codex `rust-v0.147.0` and OpenCode `v1.18.12`.
- Exit: focused branding/storage/update tests, upstream unit tests, typecheck, Electron smoke, and an
  Apple-Silicon unpacked/package build pass. Live packaging checks must be reported separately.

## M1 — Transparent routing and trust boundary

- Add model catalog, route policies/snapshots, route decision UI, and immutable attempt ledger.
- Ship visible Research Max, balanced, and economy profiles.
- Enforce capability and `local_only` / `approved_cloud` / `any_configured` data boundaries.
- Implement availability fallback and vetted refusal fallback with side-effect replay guards.
- Default telemetry/export off and label runtime isolation accurately.
- Exit: deterministic precedence and fallback acceptance tests; no secret values in policy/attempt data.

## M2 — Steering and bounded multi-agent work

- Add a direct pinned Codex app-server adapter.
- Implement Auto, Steer active task, Ask side question, and Stop and replace semantics.
- Add durable OpenCode steering queues and read-only ephemeral child sessions.
- Add parent/child agent graph, four-agent default concurrency, budgets, isolated artifacts, and
  cancellation propagation.
- Exit: steering preserves active progress, side questions do not interrupt, and budget/concurrency
  tests pass across restart/error paths.

## M3 — Interactive SSH and Slurm

- Add PTY authentication and app-scoped SSH ControlMaster reuse.
- Implement Direct SSH and Slurm drivers, validation, staging, polling, cancellation, reattachment,
  checksum collection, and immutable compute manifests.
- Add exact single-use approval cards and login-node protections.
- Exit: an authorized test job survives app restart, cancels by scheduler ID, and returns verified
  outputs without logging credentials.

## M4 — Literature-to-HPC vertical slice

- Curate the minimum literature, provenance, statistical review, and remote-compute skills.
- Resolve PubMed/OpenAlex/Crossref identifiers and export citations.
- Run deterministic local validation, one approved Slurm analysis or sweep, and independent review.
- Exit: a versioned figure and cited report link to inputs, code, environment, scheduler record, model
  attempts, checksums, and reviewer findings.

## M5 — Personal Mac release

- Verify backup, schema rollback, provider/SSH/scheduler interruption recovery, and updater isolation.
- Package an Apple-Silicon DMG while preserving cross-platform source structure.
- Exercise the documented upstream-sync process and complete the acceptance suite.
- Exit: a clean Mac installation runs beside Claude Science and AIPOCH Open Science without sharing or
  overwriting state.
