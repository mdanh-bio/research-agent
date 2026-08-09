# Security Policy

Research Agent is a private desktop workbench that can read research files, call model providers,
execute local code, and request remote computation. Treat the application, imported skills, model
output, connectors, previews, and remote hosts as separate trust boundaries.

The authoritative engineering rules are in [AGENTS.md](AGENTS.md), and the current threat analysis is
in [docs/threat-model.md](docs/threat-model.md).

## Supported state

Research Agent has no public release and no public update channel. Only the current reviewed `main`
checkout is maintained. An unpacked local app is a development artifact, not a signed/notarized
release.

| Build or source                              | Status                    |
| -------------------------------------------- | ------------------------- |
| Current reviewed private `main` checkout     | Maintained                |
| Locally built artifact tied to that checkout | Development use only      |
| Older private checkouts or artifacts         | Not maintained            |
| AIPOCH Open Science downloads                | Separate upstream product |

The in-app updater is disabled on every platform. Updates are reviewed, built, tested, and installed
manually. Do not point Research Agent at AIPOCH's public update feed.

## Reporting a vulnerability

Do not disclose credentials, unpublished data, private paths, or vulnerability details in a public
issue, discussion, pull request, screenshot, or log excerpt.

Use GitHub's **Report a vulnerability** control under this private repository's **Security** tab when
available, or contact the repository owner directly through an already trusted private channel.
Include:

- the exact Research Agent commit and macOS version;
- the affected boundary, such as renderer, main process, provider, skill, connector, preview, storage,
  Codex/OpenCode runtime, SSH/compute, packaging, or update behavior;
- minimal reproduction steps and observed impact;
- sanitized evidence with secrets and research identifiers removed.

## Obtaining and verifying the application

There is currently no official Research Agent DMG, ZIP, npm package, or public download page. Build
only from an authorized checkout of
[mdanh-bio/research-agent](https://github.com/mdanh-bio/research-agent). An AIPOCH Open Science
installer is not a Research Agent installer.

Before building, confirm the repository and revision:

```bash
git remote get-url origin
git status --short --branch
git rev-parse HEAD
```

The expected private origin is `https://github.com/mdanh-bio/research-agent.git`. Review the diff,
dependency lock, [source lock](third_party/sources.lock.yaml), and
[third-party notices](THIRD_PARTY_NOTICES.md) before running dependency or build scripts.

For an unpacked local Apple-Silicon build, verify its identity and on-disk signature after packaging:

```bash
plutil -p "dist/mac-arm64/Research Agent.app/Contents/Info.plist"
file "dist/mac-arm64/Research Agent.app/Contents/MacOS/Research Agent"
codesign --verify --deep --strict --verbose=2 "dist/mac-arm64/Research Agent.app"
```

The bundle identifier must be `bio.mdanh.research-agent`, the executable must be Apple-Silicon arm64,
and a local build is expected to have only an ad-hoc signature unless a separate private signing and
notarization process has been provisioned and verified. Ad-hoc signing provides integrity structure,
not publisher authenticity.

## Credentials and local data

Research Agent uses distinct mutable roots so it can run beside AIPOCH Open Science and Claude Science:

| Runtime     | Config, settings, sessions, and app-managed credentials | Data, environments, and artifacts |
| ----------- | ------------------------------------------------------- | --------------------------------- |
| Packaged    | `~/.research-agent`                                     | `~/ResearchAgent`                 |
| Development | `~/.research-agent-project`                             | `~/ResearchAgent-DEV`             |

Electron profile and updater-cache names are also Research Agent-specific. Legacy `OPEN_SCIENCE_*`
environment overrides are ignored unless the explicit compatibility switch is enabled. Prefer
`RESEARCH_AGENT_*` overrides and use absolute paths.

Provider secrets entered through the application are stored through Electron `safeStorage` when the
operating-system credential vault is available. The application must fail closed rather than persist a
new secret when secure storage is unavailable. Authentication material may still be sent to the exact
provider or runtime it authenticates; local storage does not make provider traffic local.

Never put any of the following in Git, prompts, logs, crash reports, provenance, approval records, or
shared screenshots:

- API keys, OAuth tokens, passwords, OTPs, SSH private keys, cookies, or authenticated URLs;
- PHI, controlled identifiers, or sensitive sample metadata;
- contents of the app config root, credential databases, or another tool's authentication profile.

Logs remain local and may contain paths or scientific context even after secret redaction. Review and
minimize them before sharing.

## Execution and approval boundaries

- Model and tool output is untrusted input. Inspect consequential commands, file writes, provider
  transfers, and remote actions before approval.
- Approval is authorization, not sandboxing. Inherited OpenCode execution is approval-gated until an
  operating-system isolation layer is verified.
- The constrained direct Codex app-server adapter has a sandbox-backed design boundary, but it is not
  yet connected to composer sessions. Do not infer production isolation from its unit tests.
- Transparent routing and automatic fallback are foundations only. No production conversation is
  automatically replayed through an alternate provider.
- A fallback must never rewrite a request to evade provider policy, and automatic replay must stop once
  a side effect may have begun.
- Imported skills and connectors can execute code or transfer data. Review origin, revision, license,
  dependencies, data-use terms, and behavior before enabling one.

## SSH and remote compute

The current build does not provide a real interactive SSH PTY and has not live-verified a Slurm job.
Background SSH remains batch-mode behavior inherited from AIPOCH. Scheduler-classified and
unclassified hosts fail closed before the inherited direct launcher can run a workload on a login
node.

Every allowed remote submission requires exact, single-use approval bound to the resolved host,
resources, working directory, script hash, and identified inputs. Password and OTP responses must
never enter process arguments, logs, SQLite, or crash reports. No approval authorizes unrelated remote
actions or prompt replay after side effects.

## Research files and OneDrive

Keep mutable databases, environments, caches, and source checkouts on the local SSD. Before reading a
OneDrive-backed input, inspect metadata for the macOS `dataless` placeholder flag. Materialize only the
explicitly selected files required for the task; never recursively hydrate or automatically evict a
directory tree.

Preserve raw data. Write derived work into versioned run or artifact locations, identify inputs with
checksums when possible, and mark unavailable provenance rather than inventing it.

## Dependencies and residual risk

Research Agent is an Electron and npm application with native binaries and separately managed agent
runtimes. Pinned revisions, checksums, a lockfile, and passing tests reduce supply-chain risk but do not
eliminate it. The current production-dependency residuals and mitigations are documented in
[docs/threat-model.md](docs/threat-model.md); do not hide them with an unrelated forced upgrade.

Model output can be scientifically wrong, a user can approve a harmful action, a dependency or remote
host can be compromised, and an ad-hoc-signed build does not prove publisher identity. These are
residual risks, not solved properties.
