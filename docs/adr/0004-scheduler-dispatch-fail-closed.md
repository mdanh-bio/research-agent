# ADR 0004: Fail closed until scheduler approval and execution are identical

- Status: Accepted
- Date: 2026-08-10

## Context

The inherited `submit_job` dispatcher launches a detached shell script over SSH. Showing Slurm
partition, account, GPU, memory, and wall-time fields while still using that launcher would approve
one operation and execute another, and could run heavy work on a login node.

## Decision

Direct-SSH jobs may continue through the inherited dispatcher with an explicit UI statement that
scheduler resources are not enforced, but `direct_ssh` is an evidence-backed classification rather
than a default. New, corrupt, unprobed, incompletely probed, and failed-probe hosts are
`unclassified`. Only a successful probe that explicitly reports `sbatch=no`, `qsub=no`, and
`bsub=no` can enable direct execution. Scheduler-cluster, bridge-runner, and unclassified
submissions fail before approval, persistence, staging, or SSH until `SlurmDriver` owns submission,
polling, cancellation, restart recovery, and collection end to end.

Every `submit_job` approval is single-use. Remembered Session/Project/Global grants are ignored and a
broad renderer response is normalized to once. The approval card renders the complete validated job
summary and script hash. For direct jobs it also renders and binds each local input's byte size and
SHA-256 plus the sanitized effective SSH hostname, user, port, identity/proxy options, full config
hash, and invocation hash. The persisted binding includes the successful host proof and is
revalidated after the decision, before staging, and again immediately before the launcher call. A
changed file, host classification, alias/override, or resolved SSH configuration invalidates the
approval. Remote-path symlink inputs fail closed until their content can be identified and
revalidated through an authorized remote-read path.

## Consequences

The current build cannot submit Slurm work or approve content-unidentified remote symlink inputs, but
it also cannot silently bypass Slurm or reuse an approval after input/endpoint drift. Enabling the
Slurm path requires a concrete SSH argv transport, durable tagged handle persistence, poller
integration, reattachment tests, and an authorized live acceptance job.
