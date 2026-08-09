# Upstream Sync

Research Agent preserves AIPOCH history and minimizes invasive renames so upstream releases remain
reviewable. `origin` is the private fork; `upstream` is `https://github.com/aipoch/open-science.git`.

## Procedure

1. Start from a clean `main` and fetch both remotes without changing the working tree.
2. Verify the upstream release tag and its peeled commit. Read release/security notes and compare
   license or notice changes before code integration.
3. Create `codex/upstream-vX.Y.Z` from the current private `main`.
4. Merge the verified upstream tag into that branch, preserving merge ancestry. Do not force-push or
   rewrite the AIPOCH history.
5. Resolve conflicts by retaining Research Agent identity, storage isolation, disabled update policy,
   and documented trust boundaries while adopting upstream fixes. Avoid broad textual rebranding.
6. Review Prisma migrations, packaging/updater changes, credential handling, runtime downloads,
   remote access, and permissions as high-risk areas.
7. Update `third_party/sources.lock.yaml`, `THIRD_PARTY_NOTICES.md`, and `knowledge/current-state.md`.
8. Run typecheck, focused conflict-area tests, the full unit suite, Electron E2E smoke, database
   migration/rollback checks, and an Apple-Silicon build. Run live provider or remote tests only with
   the necessary authorization.
9. Merge the integration branch into private `main` only after results and remaining gaps are recorded.

## Rollback

Keep the previous private build and a timestamped copy of its config database before first launch of a
new merged build. If a schema or startup regression appears, stop the application, preserve the failed
state for diagnosis, restore the previous copy, and reinstall the previous package. Never use an
upstream installer as an in-place update for Research Agent: bundle and mutable state are intentionally
separate.
