# System

## Target architecture

```text
Electron/React UI
  -> Research Orchestrator
       -> Transparent Model Router -> Codex/OpenCode -> configured providers
       -> Task and Agent Graph     -> isolated specialist runs
       -> Provenance Ledger        -> policy, attempts, artifacts, cost
       -> Compute Broker           -> SSH -> Slurm
```

AIPOCH's Electron main process remains the local authority for credentials, persistence, approvals,
runtime processes, artifacts, and compute connections. Renderer code requests typed operations over
the existing preload/IPC boundary and must not gain direct secret or shell access.

## Trust and data boundaries

- **Local trusted control plane:** Electron main process, SQLite/config files, artifact store,
  credential vault integration, local runtimes, and user-approved source checkouts.
- **Renderer:** untrusted relative to secrets and process execution; receives only required views and
  typed commands.
- **Model providers:** external data recipients constrained by each route's data boundary.
- **Agent runtimes:** subprocesses with different isolation guarantees. Codex sandboxing and OpenCode
  approval are distinct controls and must be labeled accurately.
- **Remote compute:** externally consequential. SSH authentication and every scheduler submission
  require narrow handling and explicit authorization.

## Storage ownership

- `~/.research-agent`: packaged configuration, SQLite databases, sessions, settings, and app-owned
  runtime configuration.
- `~/ResearchAgent`: default relocatable data, artifacts, uploads, notebooks, environments, and
  caches. The user may choose another local parent through the inherited migration flow.
- `.research-agent/` inside a research workspace: future project goal, scope, data catalog, routing
  policy, compute aliases, and run manifests. It must contain no credentials.
- Electron secure storage: provider secrets and isolated authentication material.
- `~/.ssh/config`: host aliases and SSH routing; no SSH password or OTP persistence in the app.

The similarly named AIPOCH roots (`~/.open-science` and `~/OpenScience`) are never automatic import
sources for this private fork.
