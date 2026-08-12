# Current State

Last reviewed: 2026-08-11.

## Verified baseline

- Repository base: AIPOCH Open Science v0.12.1, commit
  `218d77e17a91c13f4797e943a723cf0f8e681387`, with full upstream history.
- Private origin: `https://github.com/mdanh-bio/research-agent.git`.
- Upstream remote: `https://github.com/aipoch/open-science.git`.
- Product identity: Research Agent; bundle/application ID `bio.mdanh.research-agent`.
- Root package and executable name: `research-agent`.
- Default packaged config root: `~/.research-agent`; development config root:
  `~/.research-agent-project`.
- Default packaged data root: `~/ResearchAgent`; development data root: `~/ResearchAgent-DEV`.
- Public AIPOCH auto-update is disabled. Private builds are updated manually until an authenticated
  release channel is implemented and verified.
- App/config/storage/E2E overrides use `RESEARCH_AGENT_APP_PATH`,
  `RESEARCH_AGENT_CONFIG_ROOT`, `RESEARCH_AGENT_STORAGE_ROOT`,
  `RESEARCH_AGENT_E2E_STORAGE_ROOT`, and `RESEARCH_AGENT_E2E_EXECUTABLE`. Their legacy
  `OPEN_SCIENCE_*` equivalents are ignored unless
  `RESEARCH_AGENT_ALLOW_LEGACY_OPEN_SCIENCE_ENV=1` is explicitly set; Research Agent values always
  take precedence.

The internal SQLite filename, protocol schemes, database fields, and selected `OPEN_SCIENCE_*`
environment variables remain unchanged compatibility identifiers. Do not rename them casually: they
cross process and package boundaries and require a migration plan.

## Runtime pins

- Codex design snapshot: `646f7c0a91b8e327d263335da68ae8ef212895ce`.
- Target Codex runtime release: `rust-v0.147.0`.
- OpenCode runtime release: `v1.18.12`.

Exact origins and license status are in `third_party/sources.lock.yaml`.

## Implemented foundations

- Milestone 0 fork identity, local state isolation, disabled public updater, source attribution,
  engineering rules, knowledge layout, and pinned Codex/OpenCode installers.
- Backend-neutral work classes, model targets, route precedence, capability/data-boundary filtering,
  Research Max/Balanced/Economy profile factories, and a two-alternate fallback evaluator.
- Routing-policy, agent-run, model-attempt, and runtime-thread-link tables plus a ledger owner. The
  ledger computes domain-separated request digests from request bytes rather than accepting caller
  hashes, binds complete provider/model/backend/capability/data-boundary targets and policy budgets to
  the persisted decision, and uses reserve/activate attempt states. Automatic alternate selection is
  limited to a reserved, pre-dispatch target; exact-attempt side effects and all activated failures
  fail closed. Benign-refusal fallback fails closed without scope-bound, single-use approval evidence
  and a configured approval verifier.
- An opt-in transparent-routing path now connects configured model targets, persisted
  Research Max/Balanced/Economy selection, policy precedence, the ACP prompt lifecycle, provider
  model switching, attempt reservation/activation/finalization, bounded pre-dispatch target fallback,
  and the local routing ledger. Routing is absent/off by default. Settings shows concrete effective
  provider/model/reasoning/boundary/source choices, labels the preview as the user default, and keeps
  external telemetry/export off and unavailable. Routed `@` references require immutable verified
  Version identities; user cancellation and tool-side-effect guards stop automatic fallback fail
  closed.
- A direct Codex app-server JSONL client and process adapter for stable thread/turn operations,
  read-only side-question forks, steering, interruption, and replacement. Experimental APIs,
  arbitrary RPC, shell-command access, full-access sandboxing, approval bypasses, unsafe CLI flags,
  and workspace-write outside explicitly approved roots are excluded.
- Delivery-mode resolution for Auto, Steer, Side question, and Stop and replace as a pure contract.
  Invalid router confidence or threshold values resolve to the non-destructive side-question default.
- Validated scheduler-neutral job specs, exact approval summaries, tagged remote handles,
  Direct SSH/Slurm driver logic, Slurm state parsing, and an interactive-SSH broker interface.
  Production `submit_job` approvals are single-use and show every structured field. New, corrupt,
  unprobed, incompletely probed, and failed-probe hosts are `unclassified`; direct execution requires
  a successful probe that explicitly reports no scheduler. Scheduler, bridge, and unclassified hosts
  fail closed before approval or SSH so the inherited direct launcher cannot bypass Slurm or run a
  workload on a login node.
- Direct-job approval binds the script hash, SHA-256 and size of every local upload, successful host
  classification proof, and the sanitized `ssh -G` endpoint/options identity. The binding is
  persisted with the job and revalidated after approval, before staging, and immediately before the
  launcher call. Host/SSH/input drift stops without launching. Remote-path symlink inputs currently
  fail closed because their content identity cannot yet be verified without a separate authorized
  remote-read workflow.
- App-scoped eight-hour ControlMaster paths are hashed from the alias and resolved endpoint/options.
- Inherited release, nightly, website-mirror, runtime-bundle, and notarization publishers are disabled.
  Their remaining manual workflows are read-only verification paths with short-lived private Actions
  artifacts; they cannot create GitHub Releases, write AIPOCH S3/CDN objects, submit to Apple, or
  inherit repository secrets. Runtime-bundle verification is Apple-Silicon-only.
- Generated Specialist/Connector archive names and outbound connector/GitHub User-Agent strings use
  the Research Agent identity. Compatibility-only protocol, database, migration, and fixture names
  remain unchanged.
- Fresh or already-encrypted settings no longer query macOS Keychain during legacy-credential
  migration. Secure storage is consulted only when a legacy `plain:` provider or NCBI reference is
  actually present, preventing keyless ad-hoc builds from blocking during startup.
- M2 Stage 0/1 foundations are locally implemented behind a default-off, non-user-visible gate:
  backend-honest delivery contracts and CAS journal transitions, additive `AgentGraph`/
  `MessageDelivery` persistence, graph-owned routing-on/off root runs, bounded direct-child/frame
  validation, caller-supplied main-generated Session Message IDs/parts/uploads, and explicit
  abandoned/recoverable/dispatch-ambiguous crash outcomes. Existing M1 rows without a graph remain
  readable legacy roots; no successful Codex/OpenCode provider exercise has been recorded for M2.
- M2 Stage 2 direct Codex runtime foundations are locally implemented behind the same default-off
  gate: a backend-neutral runtime port, a bounded main-process Codex generation owner, validated
  `RuntimeThreadLink` persistence, allowlisted `AcpRuntimeEvent` projections, exact active-turn and
  terminal handling, typed approval settlement, fail-closed protocol limits, and explicit idle-only
  ACP migration metadata. The direct start seam accepts only an app-owned subscription home or an
  explicit main-process API-key/gateway handoff; ambient credentials, proxy variables, global Codex
  configuration, and user Skills are excluded. Native custom-provider configuration uses fixed,
  credential-free, allowlisted `-c` overrides, an explicit API-key environment binding, and zero HTTP
  or stream retries so one approval cannot fan out into additional model calls. Composer IPC,
  settings-to-direct-runtime composition, and artifact handoff remain unconnected.

## Verification status

- On 2026-08-11, the Phase B acceptance run used the pinned Node `v22.23.2` and npm `10.9.8`.
  The full Vitest suite passed: 904 files passed and 14 skipped; 12,986 tests passed and 190 skipped,
  with zero failures. Node and renderer typechecks, generated web API-map validation, CLI tests
  (37/37), private-package guards (10/10), Claude ACP patch-integrity validation, and the production
  Electron/renderer/Web build also passed.
- ESLint has no errors and 13 inherited warnings. Every changed or new supported file passes
  Prettier and `git diff --check`.
- The signed Electron journey passed four macOS-app tests; two Windows-only cases were skipped.
- An unpacked arm64 application built with the existing ICNS fallback and passed a live isolated
  packaged smoke test. Its bundle ID/name, arm64 executable and micromamba 2.8.1 payload, Prisma
  resources/notices, strict deep ad-hoc signature, bootstrap identity, isolated storage root, and
  clean shutdown were verified. The smoke also exposed and verified the fresh-profile Keychain fix.
- M2 Stage 0/1 local acceptance on Node `v26.3.1` and npm `11.16.0` passed typechecks, web API-map
  validation, lint with zero errors and 13 inherited warnings, and the full Vitest suite: 907 files
  passed and 14 skipped; 13,005 tests passed and 190 skipped. Fresh/existing/rollback-compatible
  SQLite schema cases, graph/delivery recovery, routing-on/off root creation, and corruption checks
  passed. No managed Codex/OpenCode binary or real provider request was available for live M2 checks.
- M2 Stage 2 local acceptance on Node `v26.3.1` and npm `11.16.0` passed the focused direct
  runtime/client rerun (2 files, 35 tests), final node and renderer typechecks, and the full Vitest
  suite (911 files passed, 14 skipped; 13,027 tests passed, 190 skipped). ESLint reported zero
  errors and the 13 inherited warnings; `git diff --check` passed. No managed Codex binary handshake
  or real provider request was available, so this is deterministic local acceptance rather than live
  provider certification.
- M2 Stage 0-2 repair acceptance on pinned Node `v22.23.2` and npm `10.9.8` passed Prisma
  format/generate and migration coverage, 12 focused files with 190 tests, node/web typechecks,
  web API-map validation, lint with zero errors and 13 inherited warnings, the production build, and
  the full Vitest suite: 911 files passed and 14 skipped; 13,037 tests passed and 190 skipped.
  `git diff --check` and the scoped credential scan passed.
- The managed Codex `0.147.0` `darwin-arm64` manifest, executable path, code-owned SHA-256
  `19c4f144c5226a9f17c58e6f0fa854843b0f77a6eb420f40e2745a12f10f5d37`, and live version probe
  passed. The approved Techopenclaw `gpt-5.6-sol` zero-retry turn authenticated and reached the
  endpoint, but the stream closed before `response.completed`; Codex emitted the matching terminal
  `failed` event, so live certification failed. Usage was unavailable. No other Techopenclaw model,
  fallback, tool, attachment, approval, or shared-workspace write was used.
- On 2026-08-12, the final Stage 0-2 rerun after ephemeral-thread repair passed 12 focused files with
  191 tests and the full Vitest suite: 911 files passed and 14 skipped; 13,038 tests passed and 190
  skipped. Typechecks, Prisma format/generate, web API map, lint (zero errors, 13 inherited warnings),
  production build, `git diff --check`, and scoped secret scan passed.
- Techopenclaw `fugu-ultra` passed one serialized zero-retry live direct-runtime turn: three streamed
  assistant events/four characters, exact terminal `completed`, input 7,569 tokens, cache-read 7,424,
  output 43, zero tools/approvals/protocol errors, and clean thread/link/process teardown in 3,639 ms.
  The saved active model remained `gpt-5.6-sol`. Separate zero-retry probes recorded
  `gpt-5.6-sol` HTTP 529 overload and `gpt-5.6-terra` stream closure before `response.completed`;
  neither failure is reported as a successful model certification.
- Xcode 26.6 is installed, but first-launch/plugin initialization is incomplete, so the adaptive-icon
  `actool` packaging path is not certified. No DMG or ZIP release artifact has been built or verified.

## Not yet connected or live-verified

- Transparent routing is locally integrated and deterministically tested, but no real provider
  request or target-fallback path has been executed in this phase, and no packaged-app routing journey
  was run. M1 intentionally has no provider-to-provider post-dispatch replay. Loopback URL shape is
  not proof of local inference: custom endpoints remain
  `any_configured`, and `local_only` work fails closed until a genuinely declared local target exists.
  The current catalog treats framework-compatible configured providers as tool-capable; there is no
  separate per-model tool-support declaration yet.
- Sanitized user/project work-class overrides are persisted and resolved, but Settings has no
  override editor and its table is deliberately a user-default preview rather than an active-project
  view. Session/agent pins remain an internal policy seam. Benign-refusal results stop for review
  because no production approval issuer/verifier is connected; no refusal bypass is active.
- The direct Codex generation owner and delivery-mode contract are not connected to composer IPC or
  the existing ACP session lifecycle. Settings resolution does not yet instantiate the direct owner;
  callers must provide an explicit main-process provider handoff. Durable OpenCode steering queues,
  child dispatch/approval, provider-side graph scheduling, and artifact handoff remain planned; only
  the bounded graph/delivery foundations and direct Codex runtime seam are locally integrated.
- The direct Codex runtime has a successful Techopenclaw `fugu-ultra` Responses path, but the saved
  `gpt-5.6-sol` target remains upstream-overloaded and is not live-certified. Model-specific
  availability must remain distinct from runtime/provider-path certification.
- Interactive SSH is an interface, not a PTY implementation. Background SSH still uses batch mode.
  The scheduler drivers do not yet own production dispatch/polling, restart reattachment, staging, or
  checksum collection. No SSH login or Slurm command has been run.
- The literature-to-HPC workflow and a signed/notarized personal release remain unimplemented.
- Managed notebook environments still default to AIPOCH's public runtime-bundle CDN. Packs are
  checksum-verified against its fetched manifest, but Research Agent does not independently pin or
  sign that manifest. Replace it with a locally controlled bundle or explicitly accept that trust
  before a personal release.
- Inherited Windows installer/cache-cleanup paths still target Open Science state. Windows packaging
  is deferred and excluded from every release path until those paths are migrated and tested.
- Five no-fix production dependency advisories remain documented in `docs/threat-model.md`; release
  work must re-audit them rather than applying a forced unrelated upgrade.

AIPOCH's inherited projects, sessions, providers, artifacts, skills, connectors, task runner, compute
UI, and agent backends remain the functional application base.

Before updating this file, verify repository state and behavior. A passing typecheck is not evidence
that a packaged app, provider request, SSH login, or scheduler job works live.
