# ADR 0001: Use AIPOCH Open Science as the application base

- Status: Accepted
- Date: 2026-08-10
- Baseline: AIPOCH Open Science v0.12.1 at
  `218d77e17a91c13f4797e943a723cf0f8e681387`

## Context

The project needs a local desktop workbench with projects, sessions, provider configuration, agent
backends, secure credentials, artifacts/provenance, reviewers, scientific previews, skills,
connectors, task execution, and compute UI. Rebuilding those mature surfaces would delay the routing,
steering, and HPC behavior that differentiates Research Agent.

AI4S Open Science offers useful per-role model and SSH/Slurm behaviors but uses a different
Rust/Tauri architecture. Synthetic Sciences OpenScience offers valuable biology-domain assets but a
large skill surface that requires individual validation. Codex provides the desired thread/steering
runtime through app-server rather than a desktop shell to fork. Claude Science is proprietary and may
only be observed as a clean-room interaction reference.

## Decision

Fork AIPOCH Open Science with full history and retain its Electron/React, persistence, and UI
foundation. Port selected behavior behind typed interfaces instead of merging other repositories
wholesale. Run pinned Codex app-server and OpenCode as external runtimes. Curate biology assets one at
a time with source, license, data-use, dependency, and behavioral evidence.

The fork uses a distinct name, bundle ID, config/data roots, executable, and update policy. Internal
compatibility identifiers are retained until a migration has a concrete benefit and tests.

## Consequences

- Upstream security and functionality can be integrated through controlled merge branches.
- New orchestration must respect AIPOCH's main/renderer and persistence boundaries.
- The project carries Apache-2.0 attribution obligations and must mark/reference its modifications.
- AI4S behavior requires a deliberate TypeScript/Electron port, not direct architectural reuse.
- Public AIPOCH packages cannot update this private derivative safely; updates remain manual until a
  private authenticated channel exists.
