# Compute

This is the v1 SSH/Slurm contract. It is not a claim that the production driver is complete.

## Control plane

The Mac owns orchestration. An `InteractiveSshBroker` will run `/usr/bin/ssh` in a real PTY, relay
host-key/password/OTP prompts to the UI, and never persist or log the answers. After authentication it
will establish an app-scoped ControlMaster socket with an eight-hour maximum lifetime. Background
SSH, SCP, rsync, and scheduler operations reuse that socket.

`DirectSshDriver` is limited to probes, staging, scheduler control, and lightweight remote commands.
Login nodes must not perform heavy analysis. `SlurmDriver` uses `sbatch --parsable`, `squeue`, `sacct`,
and `scancel`, persists scheduler IDs, and reattaches after application restart.

## Single-use approval

Before submission show the fully resolved:

- SSH host and remote working directory;
- partition, account, CPUs, GPUs, memory, and wall time;
- script path and SHA-256;
- staged inputs with sizes/checksums;
- declared outputs and collection destination.

Approval authorizes exactly that specification once. Any material resource, script, input, target, or
working-directory change invalidates it. Approval is not sandboxing and does not authorize unrelated
remote actions.

## Run record

Persist local run ID, scheduler ID, host alias, submitted specification, approval time, state history,
stdout/stderr locations, input/output checksums, environment metadata, collection result, and cancel
outcome. Secret prompt contents and SSH control-socket material are excluded.

Slurm is the only automated scheduler in v1. PBS, LSF, Kubernetes, and cloud compute are deferred.
