# Research Agent Engineering Rules

These rules apply to the entire repository. More specific `AGENTS.md` files may add constraints but
must not weaken these safety, provenance, or authorization requirements.

1. Diagnose and inspect the current implementation before changing code, configuration, or data.
2. Keep changes narrow, reversible, and covered by tests proportional to their risk.
3. Distinguish proposals, structural checks, simulated results, and successful live verification.
4. Preserve raw research data. Write derived work into versioned run or artifact locations.
5. Record the actual provider, model, policy version, code revision, environment, and input identities
   for every scientific result when those facts are available; mark unavailable evidence explicitly.
6. Never store credentials, API tokens, passwords, OTPs, PHI, or sensitive sample metadata in Git,
   prompts, logs, crash reports, or provenance records.
7. Treat approval as authorization and sandboxing as isolation. Never describe approval-only
   execution, including OpenCode execution, as sandboxed.
8. Require exact, single-use user approval before every remote compute submission or consequential
   external action. Display the resolved target and resources before asking.
9. Before accessing OneDrive-backed inputs, inspect metadata for `dataless` placeholders. Hydrate only
   explicitly selected files; never recursively materialize or automatically evict a tree.
10. Ground scientific claims in traceable evidence. Resolve citations, report uncertainty and
    statistical limitations, and never invent missing provenance.
11. Agents may propose new rules, skills, or routing policies but must not promote or activate them
    automatically. The user approves durable behavior changes.
12. Preserve upstream licenses, notices, and source pins. Claude Science is a clean-room behavioral
    reference only: copy no proprietary code, prompts, assets, credentials, or application data.

## Working conventions

- Read `KNOWLEDGE.md` and `knowledge/current-state.md` before substantial work, then open only the
  task-relevant knowledge files.
- Keep mutable databases, environments, caches, and source checkouts on the Mac's local SSD by
  default. A research workspace may point to explicitly selected external data.
- Do not modify routing, compute, or safety behavior based solely on a roadmap document. Confirm the
  implementation and tests first.
- Use `origin` for the private fork and `upstream` for AIPOCH. Follow `docs/upstream-sync.md` for
  updates and never merge an upstream release directly into the working branch.
- Do not commit generated secrets, local `.research-agent/` workspace state, or runtime databases.
- Normal verification is `npm run typecheck` plus focused Vitest suites. Packaging or live remote
  tests require the relevant environment and explicit authorization.
