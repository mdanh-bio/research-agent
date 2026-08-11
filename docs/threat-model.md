# Threat Model

## Assets

- research inputs, unpublished results, controlled metadata, and derived artifacts;
- provider credentials, OAuth tokens, SSH keys, passwords, and OTPs;
- local source/workspaces, SQLite state, environments, provenance, and approvals;
- remote compute allocations, scheduler jobs, and collected outputs;
- integrity of model routing, agent instructions, citations, and scientific conclusions.

## Boundaries and adversaries

The renderer, model providers, MCP/connectors, imported skills, research files, remote hosts, scheduler
output, and update artifacts are outside or across the main-process trust boundary. Threats include a
malicious imported skill, prompt injection in a paper/web response, compromised provider/connector,
path traversal, secret leakage, forged provenance, duplicated side effects after fallback, excessive
compute submission, hostile SSH host, supply-chain substitution, and accidental collision with an
upstream installation.

## Required controls

| Threat                    | Control                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State collision           | Distinct bundle ID, package/executable identity, config roots, data roots, dev roots, and updater cache.                                                               |
| Secret disclosure         | OS secure storage, native auth prompts, logger redaction, no secret fields in ledgers/manifests.                                                                       |
| Renderer compromise       | Typed preload/IPC contract; execution, storage, credentials, and approvals remain in main.                                                                             |
| Prompt/tool injection     | Treat external content as data, preserve system/project policy precedence, require approval at consequential boundaries.                                               |
| Unsafe fallback replay    | Immutable Version-bound request identity, exact ordered targets, two-alternate pre-dispatch limit, attempt-correlated effects, and fail-closed post-dispatch outcomes. |
| Compute abuse             | Validated job schema, resolved resource card, exact single-use approval, login-node restriction, scheduler ID persistence.                                             |
| Artifact tampering        | Immutable versions, SHA-256 input/output identities, execution/environment references, missing-evidence markers.                                                       |
| Supply-chain replacement  | Pinned source manifest, license review, dependency lock, build/test gates, and no public upstream updater or inherited publication workflow.                           |
| OneDrive mass hydration   | Metadata-first placeholder detection and explicit bounded materialization.                                                                                             |
| Upstream merge regression | Dedicated integration branch, source/notice review, migrations, full acceptance suite before merge.                                                                    |

## Residual risks

Model output can remain scientifically wrong; approvals can authorize a harmful command; a trusted
dependency or remote host can be compromised; and ad-hoc-signed packages do not provide release
authenticity. M1 deliberately does not retry a prompt after provider dispatch, because persistent ACP
session state cannot guarantee provider consistency; fresh-context replay remains a future residual
design task. These risks must be visible rather than described as eliminated.

Codex read-only mode still permits broad filesystem reads under the current pinned runtime. Research
Agent constrains writable roots and direct network access for workspace-write threads, but it cannot
yet describe read-only side-question forks as narrowly scoped filesystem isolation. On POSIX, the
adapter owns and tears down the app-server process group; a descendant that deliberately creates a
separate session before an abrupt parent crash can escape that group and remains a residual process
lifecycle risk.

Managed notebook environments still default to AIPOCH's public runtime-bundle CDN. Pack bytes are
size- and SHA-256-verified against the downloaded manifest, but that manifest is not independently
pinned or signed by Research Agent. A personal release must either ship/use a locally controlled,
verified bundle or explicitly accept and document this external trust. The inherited Windows
installer and cache-cleanup scripts also retain Open Science paths; Windows packaging is unsupported
and must remain outside release workflows until those paths are migrated and tested.

The 2026-08-10 production-dependency audit also reports no-fix advisories in `js-yaml` through the
disabled `electron-updater` path and in Mermaid rendering dependencies. The public updater is
disabled and receives no feed, while Mermaid still processes agent-generated diagrams in the
renderer. Treat diagram content as untrusted, retain Streamdown's strict Mermaid security mode, and
re-audit or isolate/disable affected diagram types before a personal release; do not hide the audit by
applying an unrelated forced dependency upgrade.

## Verification priorities

Tests must demonstrate that passwords/OTPs never enter arguments, logs, SQLite, or crash reports; no
update request reaches the AIPOCH feed; fallback cannot duplicate an executed side effect; job approval
is invalidated by specification changes; and Research Agent never selects AIPOCH's default mutable
roots on a fresh install.
