# Research Agent

Research Agent is a private, Mac-first computational-biology workbench built on
[AIPOCH Open Science v0.12.1](https://github.com/aipoch/open-science/releases/tag/v0.12.1).
It keeps AIPOCH's Electron/React application foundation while adding explicit model-routing,
agent-thread, provenance, and SSH/Slurm trust boundaries.

> **Private source build:** Research Agent has no public download or public update channel. Install it
> only from an authorized checkout of this private repository. The in-app updater is disabled, and
> updates are applied manually after review and verification. AIPOCH Open Science releases are upstream
> reference builds, not Research Agent releases.

## Current status

The inherited AIPOCH projects, sessions, providers, artifacts, previews, skills, connectors, task
runner, notebook runtime, and Claude/OpenCode/Codex backend selection remain the functional
application base.

Research Agent currently adds tested foundations for transparent routing and attempt records, a
constrained Codex app-server boundary, delivery-mode contracts, exact remote-compute approvals, and
scheduler-neutral SSH/Slurm drivers. These foundations are intentionally not advertised as live
features:

- model-policy selection and automatic fallback are not connected to production conversations;
- Codex steering and side-question forks are not connected to the composer or existing ACP sessions;
- durable OpenCode steering queues and the bounded parallel-agent graph are not implemented;
- interactive SSH is still an interface rather than a real PTY implementation;
- Slurm submission, polling, restart recovery, staging, and checksum collection are not connected;
- the literature-to-HPC proof workflow has not run.

See [current state](knowledge/current-state.md) for the verified implementation boundary and
[Research Agent roadmap](docs/roadmap.md) for the gated delivery sequence.

## Supported target

- Personal, private, single-user application
- Apple-Silicon Mac as the first-class packaging target
- Codex and OpenCode as first-class runtimes
- Claude Code compatibility inherited from AIPOCH, but not a v1 acceptance target
- Slurm as the only planned automated scheduler for v1

Cross-platform source structure is retained to make upstream synchronization safer. A cross-platform
source path does not mean Windows or Linux packages are Research Agent v1 release targets.

## Development setup

Prerequisites:

- Node.js 22 and npm
- Git with access to the private repository
- Apple Silicon macOS for the supported local package checks

```bash
git clone https://github.com/mdanh-bio/research-agent.git
cd research-agent
npm install
npm run dev
```

`npm install` executes the repository `postinstall` scripts, including Prisma generation and Electron
native-dependency setup. Review the checkout and lockfile before running it.

Research Agent deliberately does not share mutable roots with AIPOCH Open Science:

| Runtime     | Config and session root     | Data and environment root |
| ----------- | --------------------------- | ------------------------- |
| Packaged    | `~/.research-agent`         | `~/ResearchAgent`         |
| Development | `~/.research-agent-project` | `~/ResearchAgent-DEV`     |

The Electron profile, updater cache, app identity, CLI name, and environment overrides are also
Research Agent-specific. Legacy `OPEN_SCIENCE_*` overrides are ignored unless the explicit compatibility
switch is enabled; prefer the documented `RESEARCH_AGENT_*` variables.

Useful checks:

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm run build:unpack
```

An unpacked Apple-Silicon app is a development artifact, not a signed/notarized release. Building the
configured DMG/ZIP path requires the documented full-Xcode packaging prerequisites and separate live
verification.

## Command-line client

The private CLI/SDK package is `@mdanh-bio/research-agent`, and the executable is `research-agent`.
It is not published to npm. Install the launcher from **Settings -> General -> Command line tool**, or
use the private source package during development:

```bash
npm install --global ./packages/open-science
research-agent start --no-open
research-agent status --json
research-agent stop
```

The `packages/open-science` directory name and selected `OpenScience*` API type names are retained
compatibility identifiers. They do not change the package name, executable, product identity, or data
roots. See the [CLI guide](packages/open-science/CLI.md) for the current command reference.

## Trust and data boundaries

- Provider credentials stay in OS-backed secure storage; do not put credentials or sensitive sample
  metadata in source, prompts, logs, or provenance.
- The Mac is the control plane. Consequential remote actions require exact, single-use approval.
- Approval authorizes an action; it is not a sandbox. Codex can use its sandbox-backed boundary,
  while inherited OpenCode execution remains approval-gated until OS isolation is verified.
- Research data and mutable runtime state belong on the local SSD. OneDrive inputs require
  metadata-first placeholder detection and explicit, bounded hydration.
- Scientific outputs must distinguish observed evidence, inference, uncertainty, and unavailable
  provenance.

Read [AGENTS.md](AGENTS.md) before changing code or configuration and [SECURITY.md](SECURITY.md) before
handling credentials, external data, packaging, or remote execution.

## Project documentation

- [Vision](VISION.md)
- [Knowledge index](KNOWLEDGE.md)
- [Current state](knowledge/current-state.md)
- [Research Agent roadmap](docs/roadmap.md)
- [Threat model](docs/threat-model.md)
- [Upstream synchronization](docs/upstream-sync.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Pinned source manifest](third_party/sources.lock.yaml)

The root [ROADMAP.md](ROADMAP.md) and [upstream PRD](docs/PRD.md) are retained as clearly labeled AIPOCH
baseline references. They are not the source of truth for Research Agent feature status.

## Upstream and license

Research Agent preserves AIPOCH's full Git history and Apache-2.0 license. The application baseline is
AIPOCH Open Science v0.12.1 at commit
[`218d77e`](https://github.com/aipoch/open-science/commit/218d77e17a91c13f4797e943a723cf0f8e681387).
`upstream` tracks [aipoch/open-science](https://github.com/aipoch/open-science); `origin` tracks the
private Research Agent fork. Additional reference origins, revisions, licenses, and import status are
recorded in [third-party notices](THIRD_PARTY_NOTICES.md) and the
[source lock](third_party/sources.lock.yaml).

Claude Science is a clean-room behavioral reference only. No proprietary Claude Science code,
prompts, assets, credentials, authentication behavior, or application data may be copied into this
repository.
