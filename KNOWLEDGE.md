# Research Agent Knowledge Index

This file is an index, not a context dump. At startup read `AGENTS.md`, this index, and
`knowledge/current-state.md`; then open only the files relevant to the task.

- [Current state](knowledge/current-state.md) — verified baseline, implemented work, and known gaps.
- [System](knowledge/system.md) — target architecture, trust boundaries, and storage ownership.
- [Repository map](knowledge/repository-map.md) — upstream structure and extension boundaries.
- [Model routing](knowledge/model-routing.md) — planned routing contracts, precedence, and fallback.
- [Compute](knowledge/compute.md) — planned SSH/Slurm control plane and approval contract.
- [Scientific quality](knowledge/scientific-quality.md) — evidence, citation, data, and review rules.
- [Research safety](knowledge/research-safety.md) — benign-research fallback and privacy boundaries.
- [Roadmap](docs/roadmap.md) — implementation sequence and milestone exit criteria.
- [Threat model](docs/threat-model.md) — assets, threats, mitigations, and residual risks.
- [Upstream sync](docs/upstream-sync.md) — controlled AIPOCH update procedure.
- [ADR 0001](docs/adr/0001-aipoch-base.md) — why AIPOCH is the application base.
- [ADR 0002](docs/adr/0002-transparent-routing-ledger.md) — routing and provenance boundary.
- [ADR 0003](docs/adr/0003-codex-app-server-boundary.md) — safe stable Codex integration.
- [ADR 0004](docs/adr/0004-scheduler-dispatch-fail-closed.md) — scheduler approval/execution identity.
- [Source lock](third_party/sources.lock.yaml) and [notices](THIRD_PARTY_NOTICES.md) — exact origins,
  licenses, and current import status.

Daily notes belong under `notes/YYYY-MM-DD.md` and are append-only. Promote only verified current
facts into `knowledge/`. Changes to durable rules in `AGENTS.md` require explicit user approval.
