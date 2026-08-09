# Third-Party Notices

Research Agent is a private derivative of **AIPOCH Open Science** v0.12.1 at commit
`218d77e17a91c13f4797e943a723cf0f8e681387`.

Copyright 2026 AIPOCH.

AIPOCH Open Science is licensed under the Apache License, Version 2.0. The original license is
preserved in the repository root as `LICENSE`. Research Agent changes include product and package
identity, isolated mutable storage roots, a private update boundary, project rules and knowledge, and
subsequent routing/orchestration/compute extensions recorded in version control.

## Referenced projects

The following projects are pinned as behavior, interface, runtime, or future asset references. At
Milestone 0, no source from these reference repositories has been copied into Research Agent unless it
already arrived through AIPOCH's own dependency history.

- **AI4S Open Science**, commit `a68f2032df5f4b73328e766181ad5cdeca592deb`, MIT License.
  Copyright 2026 AI4S Workbench contributors.
- **Synthetic Sciences OpenScience**, commit
  `edd585468549a0921be5b3b19cb6284d65d6b5d9`, Apache License 2.0.
- **OpenAI Codex**, design snapshot `646f7c0a91b8e327d263335da68ae8ef212895ce` and target
  runtime `rust-v0.147.0`, Apache License 2.0. Copyright 2025 OpenAI. Its upstream NOTICE also
  identifies Ratatui-derived MIT-licensed code.
- **OpenCode**, target runtime `v1.18.12`, MIT License. It remains an external runtime dependency.

Claude Science 0.1.27 is a proprietary clean-room interaction reference only. Research Agent includes
no Claude Science code, prompts, assets, credentials, authentication behavior, or application data.

Exact source and tag identities are recorded in `third_party/sources.lock.yaml`. Before importing any
skill, connector, source file, prompt, or asset from a referenced project, update both files with its
exact path, revision, license, dependencies, data-use terms, and import status.
