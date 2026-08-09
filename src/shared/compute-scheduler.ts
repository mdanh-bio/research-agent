// Backend-neutral contracts for validated compute submissions and scheduler drivers.
//
// These values may be persisted in SQLite or shown in an approval card, so they deliberately contain
// no credentials, authentication prompts, or provider secrets. Remote commands remain script content;
// control-plane implementations must pass every executable argument through argv, never interpolate
// these fields into a shell command.

export type ComputeGpuRequest = {
  count: number
  type?: string
}

export type ComputeResourceSpec = {
  partition?: string
  account?: string
  nodes: number
  tasksPerNode: number
  cpusPerTask: number
  memoryMib?: number
  gpus?: ComputeGpuRequest
  wallTimeSeconds: number
}

export type ComputeJobSpec = {
  jobId: string
  providerId: string
  // Concrete ~/.ssh/config alias used for the approval summary. It is not a hostname/password pair.
  host: string
  intent: string
  script: string
  workingDirectory: string
  resources: ComputeResourceSpec
  // Human-readable, non-secret input labels/paths. Checksums stay in the durable input manifest.
  inputs: string[]
  // Output paths or globs the caller expects the job to produce.
  expectedOutputs: string[]
}

// Exact, structured fields required by the single-use job approval card. Values are kept numeric
// where possible so the renderer can format them without parsing prose.
export type ComputeJobApprovalSummary = {
  host: string
  partition: string | null
  account: string | null
  cpu: {
    nodes: number
    tasks_per_node: number
    cpus_per_task: number
    total_cpus: number
  }
  gpu: {
    count: number
    type: string | null
  } | null
  memory_mib: number | null
  wall_time_seconds: number
  script_hash: string
  inputs: string[]
  expected_outputs: string[]
  working_directory: string
}

export type ComputeInputContentIdentitySummary = {
  destination: string
  label: string
  size_bytes: number
  sha256: string
}

// Secret-free projection of the effective SSH destination authorized for one dispatch. The hash
// binds the complete `ssh -G` result without putting arbitrary config values (for example a
// ProxyCommand containing environment-specific data) into the approval transcript.
export type ComputeSshTargetApprovalSummary = {
  alias: string
  hostname: string
  user: string | null
  port: number
  identity_file: string | null
  proxy_jump: string | null
  host_key_alias: string | null
  proxy_command_hash: string | null
  effective_config_hash: string
  invocation_options: string[]
  invocation_hash: string
}

export type ComputeDispatchApprovalSummary = {
  binding_hash: string
  inputs: ComputeInputContentIdentitySummary[]
  ssh_target: ComputeSshTargetApprovalSummary
}

export type SchedulerJobState =
  'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'unknown'

export type DirectSshRemoteHandle = {
  version: 1
  driver: 'direct_ssh'
  processId: number
  workdir: string
  stdoutPath: string
  stderrPath: string
  exitCodePath: string
  scriptHash: string
}

export type SlurmRemoteHandle = {
  version: 1
  driver: 'slurm'
  schedulerJobId: string
  cluster?: string
  workdir: string
  stdoutPath: string
  stderrPath: string
  scriptHash: string
}

// Tagged handles make persisted jobs unambiguous after restart and allow the poller to select the
// correct driver without guessing from fields such as pid/job id.
export type ComputeRemoteHandle = DirectSshRemoteHandle | SlurmRemoteHandle
