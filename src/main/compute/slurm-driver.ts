import type {
  ComputeJobSpec,
  SchedulerJobState,
  SlurmRemoteHandle
} from '../../shared/compute-scheduler'
import { computeScriptHash, validateComputeJobSpec } from './compute-job-spec'
import {
  assertCommandSucceeded,
  collectWith,
  normalizedLogLimit,
  remotePathChild,
  tailCommand,
  type RemoteArgvCommand,
  type RemoteArgvRunner,
  type CollectedComputeOutput,
  type SchedulerDriver,
  type SchedulerLogs,
  type SchedulerOutputCollector,
  type SchedulerStatus,
  type SchedulerSubmission
} from './scheduler-driver'

const SLURM_COMMAND_TIMEOUT_MS = 30_000
const SLURM_JOB_ID = /^\d+$/
const SLURM_CLUSTER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const assertHandle = (handle: SlurmRemoteHandle): void => {
  if (
    handle.version !== 1 ||
    handle.driver !== 'slurm' ||
    !SLURM_JOB_ID.test(handle.schedulerJobId) ||
    (handle.cluster !== undefined && !SLURM_CLUSTER_NAME.test(handle.cluster))
  ) {
    throw new Error('Invalid Slurm remote handle.')
  }
}

export const formatSlurmWallTime = (seconds: number): string => {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error('Slurm wall time must be a positive integer number of seconds.')
  }
  const days = Math.floor(seconds / 86_400)
  const remainder = seconds % 86_400
  const hours = Math.floor(remainder / 3_600)
  const minutes = Math.floor((remainder % 3_600) / 60)
  const secs = remainder % 60
  const clock = [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':')
  return days > 0 ? `${days}-${clock}` : clock
}

export const buildSlurmSubmitCommand = (spec: ComputeJobSpec): RemoteArgvCommand => {
  const validated = validateComputeJobSpec(spec)
  if (validated.workingDirectory === '~' || validated.workingDirectory.startsWith('~/')) {
    throw new Error(
      'Slurm workingDirectory must be an absolute remote path; argv execution does not expand ~.'
    )
  }
  const { resources } = validated
  const args = [
    '--parsable',
    '--job-name',
    `research-agent-${validated.jobId}`.slice(0, 128),
    '--chdir',
    validated.workingDirectory,
    '--nodes',
    String(resources.nodes),
    '--ntasks-per-node',
    String(resources.tasksPerNode),
    '--cpus-per-task',
    String(resources.cpusPerTask),
    '--time',
    formatSlurmWallTime(resources.wallTimeSeconds),
    '--output',
    remotePathChild(validated.workingDirectory, 'stdout'),
    '--error',
    remotePathChild(validated.workingDirectory, 'stderr'),
    '--open-mode',
    'truncate'
  ]

  if (resources.partition) args.push('--partition', resources.partition)
  if (resources.account) args.push('--account', resources.account)
  if (resources.memoryMib) args.push('--mem', `${resources.memoryMib}M`)
  if (resources.gpus) {
    const gpu = resources.gpus.type
      ? `gpu:${resources.gpus.type}:${resources.gpus.count}`
      : `gpu:${resources.gpus.count}`
    args.push('--gres', gpu)
  }

  return {
    executable: 'sbatch',
    args,
    stdin: validated.script,
    timeoutMs: SLURM_COMMAND_TIMEOUT_MS
  }
}

export const parseSlurmSubmission = (
  stdout: string
): { schedulerJobId: string; cluster?: string } => {
  const line = stdout
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find(Boolean)
  if (!line) throw new Error('sbatch --parsable returned no job id.')
  const [schedulerJobId, cluster, ...extra] = line.split(';')
  if (!schedulerJobId || !SLURM_JOB_ID.test(schedulerJobId) || extra.length > 0) {
    throw new Error(`Invalid sbatch --parsable response: ${JSON.stringify(line)}`)
  }
  if (cluster !== undefined && (!cluster || !SLURM_CLUSTER_NAME.test(cluster))) {
    throw new Error(`Invalid Slurm cluster name in sbatch response: ${JSON.stringify(line)}`)
  }
  return { schedulerJobId, ...(cluster ? { cluster } : {}) }
}

const canonicalSlurmState = (raw: string): string =>
  raw.trim().toUpperCase().split(/\s+/)[0]?.replace(/\++$/, '') ?? ''

export const normalizeSlurmState = (raw: string): SchedulerJobState => {
  const state = canonicalSlurmState(raw)
  if (
    [
      'PENDING',
      'PD',
      'CONFIGURING',
      'CF',
      'REQUEUED',
      'REQUEUE_FED',
      'REQUEUE_HOLD',
      'RH'
    ].includes(state)
  ) {
    return 'queued'
  }
  if (
    [
      'RUNNING',
      'R',
      'COMPLETING',
      'CG',
      'SUSPENDED',
      'S',
      'STOPPED',
      'ST',
      'RESIZING',
      'RS'
    ].includes(state)
  ) {
    return 'running'
  }
  if (state === 'COMPLETED' || state === 'CD') return 'succeeded'
  if (state === 'TIMEOUT' || state === 'TO') return 'timed_out'
  if (state === 'CANCELLED' || state === 'CA') return 'cancelled'
  if (
    [
      'FAILED',
      'F',
      'BOOT_FAIL',
      'BF',
      'DEADLINE',
      'DL',
      'NODE_FAIL',
      'NF',
      'OUT_OF_MEMORY',
      'OOM',
      'PREEMPTED',
      'PR',
      'SPECIAL_EXIT',
      'SE'
    ].includes(state)
  ) {
    return 'failed'
  }
  return 'unknown'
}

const parseExitCode = (raw: string | undefined): number | undefined => {
  if (!raw) return undefined
  const match = /^(\d+):(\d+)$/.exec(raw.trim())
  if (!match) return undefined
  const parsed = Number(match[1])
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 255 ? parsed : undefined
}

const clusterArgs = (handle: SlurmRemoteHandle): string[] =>
  handle.cluster ? ['--clusters', handle.cluster] : []

export const parseSacctStatus = (stdout: string): SchedulerStatus => {
  const line = stdout
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find(Boolean)
  if (!line) return { state: 'unknown', rawState: 'not_found' }
  const [rawState = '', rawExitCode] = line.split('|')
  const exitCode = parseExitCode(rawExitCode)
  return {
    state: normalizeSlurmState(rawState),
    rawState: rawState.trim(),
    ...(exitCode === undefined ? {} : { exitCode })
  }
}

export const buildSlurmQueueCommand = (handle: SlurmRemoteHandle): RemoteArgvCommand => {
  assertHandle(handle)
  return {
    executable: 'squeue',
    args: [...clusterArgs(handle), '--noheader', '--jobs', handle.schedulerJobId, '--format', '%T'],
    timeoutMs: SLURM_COMMAND_TIMEOUT_MS
  }
}

export const buildSlurmAccountingCommand = (handle: SlurmRemoteHandle): RemoteArgvCommand => {
  assertHandle(handle)
  return {
    executable: 'sacct',
    args: [
      ...clusterArgs(handle),
      '--noheader',
      '--parsable2',
      '--allocations',
      '--jobs',
      handle.schedulerJobId,
      '--format',
      'State,ExitCode'
    ],
    timeoutMs: SLURM_COMMAND_TIMEOUT_MS
  }
}

export const buildSlurmCancelCommand = (handle: SlurmRemoteHandle): RemoteArgvCommand => {
  assertHandle(handle)
  return {
    executable: 'scancel',
    // `--` terminates option parsing even though schedulerJobId is already digits-only.
    args: [...clusterArgs(handle), '--', handle.schedulerJobId],
    timeoutMs: SLURM_COMMAND_TIMEOUT_MS
  }
}

export class SlurmDriver implements SchedulerDriver<SlurmRemoteHandle> {
  readonly kind = 'slurm' as const

  constructor(
    private readonly runner: RemoteArgvRunner,
    private readonly collector?: SchedulerOutputCollector
  ) {}

  async submit(spec: ComputeJobSpec): Promise<SchedulerSubmission<SlurmRemoteHandle>> {
    const validated = validateComputeJobSpec(spec)
    const command = buildSlurmSubmitCommand(validated)
    const result = await this.runner.run(command)
    assertCommandSucceeded(command, result)
    const parsed = parseSlurmSubmission(result.stdout)
    const handle: SlurmRemoteHandle = {
      version: 1,
      driver: 'slurm',
      schedulerJobId: parsed.schedulerJobId,
      ...(parsed.cluster ? { cluster: parsed.cluster } : {}),
      workdir: validated.workingDirectory,
      stdoutPath: remotePathChild(validated.workingDirectory, 'stdout'),
      stderrPath: remotePathChild(validated.workingDirectory, 'stderr'),
      scriptHash: computeScriptHash(validated.script)
    }
    return { handle, state: 'queued', rawState: 'SUBMITTED' }
  }

  async poll(handle: SlurmRemoteHandle): Promise<SchedulerStatus> {
    assertHandle(handle)
    const queueCommand = buildSlurmQueueCommand(handle)
    const queueResult = await this.runner.run(queueCommand)
    assertCommandSucceeded(queueCommand, queueResult)
    const queueState = queueResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    if (queueState) {
      return { state: normalizeSlurmState(queueState), rawState: queueState }
    }

    const accountingCommand = buildSlurmAccountingCommand(handle)
    const accountingResult = await this.runner.run(accountingCommand)
    assertCommandSucceeded(accountingCommand, accountingResult)
    return parseSacctStatus(accountingResult.stdout)
  }

  async cancel(handle: SlurmRemoteHandle): Promise<void> {
    const command = buildSlurmCancelCommand(handle)
    const result = await this.runner.run(command)
    assertCommandSucceeded(command, result)
  }

  async logs(handle: SlurmRemoteHandle, maxBytes?: number): Promise<SchedulerLogs> {
    assertHandle(handle)
    const limit = normalizedLogLimit(maxBytes)
    const [stdoutResult, stderrResult] = await Promise.all([
      this.runner.run(tailCommand(handle.stdoutPath, limit)),
      this.runner.run(tailCommand(handle.stderrPath, limit))
    ])
    const stdout = stdoutResult.exitCode === 0 ? stdoutResult.stdout : ''
    const stderr = stderrResult.exitCode === 0 ? stderrResult.stdout : ''
    return {
      stdout,
      stderr,
      truncated: Buffer.byteLength(stdout) >= limit || Buffer.byteLength(stderr) >= limit
    }
  }

  collect(handle: SlurmRemoteHandle, spec: ComputeJobSpec): Promise<CollectedComputeOutput[]> {
    assertHandle(handle)
    return collectWith(this.collector, handle, validateComputeJobSpec(spec))
  }
}
