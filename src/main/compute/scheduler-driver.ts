import type {
  ComputeJobSpec,
  ComputeRemoteHandle,
  SchedulerJobState
} from '../../shared/compute-scheduler'

// An argv-only remote execution request. Implementations may transport it over SSH, but MUST invoke
// executable with argv semantics and MUST NOT join `args` into `sh -c` or another shell string.
export type RemoteArgvCommand = {
  executable: string
  args: string[]
  cwd?: string
  stdin?: string
  timeoutMs: number
  detached?: {
    stdoutPath: string
    stderrPath: string
    exitCodePath: string
  }
}

export type RemoteArgvResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  processId?: number
}

export interface RemoteArgvRunner {
  run(command: RemoteArgvCommand): Promise<RemoteArgvResult>
}

export type SchedulerSubmission<H extends ComputeRemoteHandle = ComputeRemoteHandle> = {
  handle: H
  state: SchedulerJobState
  rawState?: string
}

export type SchedulerStatus = {
  state: SchedulerJobState
  rawState?: string
  exitCode?: number
}

export type SchedulerLogs = {
  stdout: string
  stderr: string
  truncated: boolean
}

export type CollectedComputeOutput = {
  remotePath: string
  localPath: string
  sha256: string
  sizeBytes: number
}

export interface SchedulerOutputCollector {
  collect(request: {
    handle: ComputeRemoteHandle
    spec: ComputeJobSpec
  }): Promise<CollectedComputeOutput[]>
}

export interface SchedulerDriver<H extends ComputeRemoteHandle = ComputeRemoteHandle> {
  readonly kind: H['driver']
  submit(spec: ComputeJobSpec): Promise<SchedulerSubmission<H>>
  poll(handle: H): Promise<SchedulerStatus>
  cancel(handle: H): Promise<void>
  logs(handle: H, maxBytes?: number): Promise<SchedulerLogs>
  collect(handle: H, spec: ComputeJobSpec): Promise<CollectedComputeOutput[]>
}

export class SchedulerCommandError extends Error {
  constructor(
    readonly command: RemoteArgvCommand,
    readonly result: RemoteArgvResult,
    message = `${command.executable} failed with exit code ${result.exitCode ?? 'null'}`
  ) {
    super(message)
    this.name = 'SchedulerCommandError'
  }
}

export const assertCommandSucceeded = (
  command: RemoteArgvCommand,
  result: RemoteArgvResult
): void => {
  if (!result.timedOut && result.exitCode === 0) return
  const detail = result.stderr.trim() || result.stdout.trim()
  throw new SchedulerCommandError(
    command,
    result,
    `${command.executable} failed${result.timedOut ? ' (timed out)' : ''}: ${detail || `exit ${result.exitCode ?? 'null'}`}`
  )
}

const DEFAULT_LOG_BYTES = 64 * 1024
const MAX_LOG_BYTES = 1024 * 1024

export const normalizedLogLimit = (maxBytes = DEFAULT_LOG_BYTES): number => {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_LOG_BYTES) {
    throw new Error(`maxBytes must be an integer in the range 1..${MAX_LOG_BYTES}`)
  }
  return maxBytes
}

export const tailCommand = (path: string, maxBytes: number): RemoteArgvCommand => ({
  executable: 'tail',
  args: ['-c', String(normalizedLogLimit(maxBytes)), '--', path],
  timeoutMs: 30_000
})

export const remotePathChild = (directory: string, name: string): string => {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(`Remote child name must be a bare filename (got ${JSON.stringify(name)}).`)
  }
  const base = directory.replace(/\/+$/, '') || '/'
  return base === '/' ? `/${name}` : `${base}/${name}`
}

export const collectWith = async (
  collector: SchedulerOutputCollector | undefined,
  handle: ComputeRemoteHandle,
  spec: ComputeJobSpec
): Promise<CollectedComputeOutput[]> => {
  if (!collector) {
    throw new Error('No scheduler output collector is configured.')
  }
  return collector.collect({ handle, spec })
}
