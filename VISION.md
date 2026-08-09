# Research Agent Vision

Research Agent is a private, Mac-first research workbench for computational biology. It combines a
transparent local control plane, user-selected model providers, inspectable agent delegation, and
approved remote computation without hiding which system produced a result.

## Product promise

- The researcher can see and control the backend, provider, model, reasoning effort, cost, fallback
  history, tool effects, and compute resources used for each task.
- Strong models are reserved for planning, synthesis, and independent review; routine work can use
  cheaper models under explicit, inspectable policies.
- A clarification or side question can be answered without silently interrupting active work.
- Scientific outputs remain tied to their evidence: inputs, citations, code, environment, attempts,
  scheduler records, checksums, and reviewer findings.
- The Mac remains the trusted control plane. Remote systems are execution targets reached through
  the user's SSH configuration and exact per-job approval.

## First proof workflow

The first end-to-end acceptance workflow is:

1. Search and resolve scientific literature.
2. Run a deterministic local validation on authorized or synthetic data.
3. Show an exact Slurm job specification and obtain single-use approval.
4. Submit, monitor, recover, and collect that job through SSH.
5. Produce a versioned figure and cited report linked to execution and model provenance.

## Product boundaries

Research Agent is personal and single-user in v1. It is not a hosted service, team collaboration
platform, clinical decision system, safety-policy bypass, or guarantee of scientific correctness.
Apple Silicon is the first packaging target; cross-platform source structure is retained to reduce
upstream divergence. Claude Code compatibility remains inherited but is not a v1 acceptance target.
