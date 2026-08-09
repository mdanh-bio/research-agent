import type {
  ComputeJobSpec,
  DirectSshRemoteHandle,
  SchedulerJobState
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

const DIRECT_SUBMIT_TIMEOUT_MS = 120_000

const assertHandle = (handle: DirectSshRemoteHandle): void => {
  if (
    handle.version !== 1 ||
    handle.driver !== 'direct_ssh' ||
    !Number.isSafeInteger(handle.processId) ||
    handle.processId <= 0
  ) {
    throw new Error('Invalid direct SSH remote handle.')
  }
}

// Builds a detached execution request without constructing a remote shell command. The eventual SSH
// transport owns staging/stdout/stderr/exit-code bookkeeping and must preserve these argv fields.
export const buildDirectSshSubmitCommand = (spec: ComputeJobSpec): RemoteArgvCommand => {
  const validated = validateComputeJobSpec(spec)
  return {
    executable: 'bash',
    args: ['-s', '--'],
    cwd: validated.workingDirectory,
    stdin: validated.script,
    timeoutMs: DIRECT_SUBMIT_TIMEOUT_MS,
    detached: {
      stdoutPath: remotePathChild(validated.workingDirectory, 'stdout'),
      stderrPath: remotePathChild(validated.workingDirectory, 'stderr'),
      exitCodePath: remotePathChild(validated.workingDirectory, 'exit_code')
    }
  }
}

const stateFromExitCode = (exitCode: number): SchedulerJobState => {
  if (exitCode === 0) return 'succeeded'
  // GNU timeout convention, matching the current launcher.sh behavior.
  if (exitCode === 124 || exitCode === 137) return 'timed_out'
  return 'failed'
}

export class DirectSshDriver implements SchedulerDriver<DirectSshRemoteHandle> {
  readonly kind = 'direct_ssh' as const

  constructor(
    private readonly runner: RemoteArgvRunner,
    private readonly collector?: SchedulerOutputCollector
  ) {}

  async submit(spec: ComputeJobSpec): Promise<SchedulerSubmission<DirectSshRemoteHandle>> {
    const validated = validateComputeJobSpec(spec)
    const command = buildDirectSshSubmitCommand(validated)
    const result = await this.runner.run(command)
    assertCommandSucceeded(command, result)
    if (!Number.isSafeInteger(result.processId) || (result.processId ?? 0) <= 0) {
      throw new Error('Detached direct SSH submission did not return a valid process id.')
    }

    return {
      state: 'running',
      handle: {
        version: 1,
        driver: 'direct_ssh',
        processId: result.processId!,
        workdir: validated.workingDirectory,
        stdoutPath: command.detached!.stdoutPath,
        stderrPath: command.detached!.stderrPath,
        exitCodePath: command.detached!.exitCodePath,
        scriptHash: computeScriptHash(validated.script)
      }
    }
  }

  async poll(handle: DirectSshRemoteHandle): Promise<SchedulerStatus> {
    assertHandle(handle)
    const exitCommand: RemoteArgvCommand = {
      executable: 'cat',
      args: ['--', handle.exitCodePath],
      timeoutMs: 30_000
    }
    const exitResult = await this.runner.run(exitCommand)
    if (!exitResult.timedOut && exitResult.exitCode === 0) {
      const exitCode = Number.parseInt(exitResult.stdout.trim(), 10)
      if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
        return { state: 'unknown', rawState: 'invalid_exit_code' }
      }
      return { state: stateFromExitCode(exitCode), rawState: 'exited', exitCode }
    }

    const aliveCommand: RemoteArgvCommand = {
      executable: 'kill',
      args: ['-0', '--', String(handle.processId)],
      timeoutMs: 10_000
    }
    const alive = await this.runner.run(aliveCommand)
    if (alive.timedOut) return { state: 'unknown', rawState: 'poll_timeout' }
    return alive.exitCode === 0
      ? { state: 'running', rawState: 'process_alive' }
      : { state: 'unknown', rawState: 'process_vanished' }
  }

  async cancel(handle: DirectSshRemoteHandle): Promise<void> {
    assertHandle(handle)
    const command: RemoteArgvCommand = {
      executable: 'kill',
      args: ['-TERM', '--', String(handle.processId)],
      timeoutMs: 10_000
    }
    const result = await this.runner.run(command)
    assertCommandSucceeded(command, result)
  }

  async logs(handle: DirectSshRemoteHandle, maxBytes?: number): Promise<SchedulerLogs> {
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

  collect(handle: DirectSshRemoteHandle, spec: ComputeJobSpec): Promise<CollectedComputeOutput[]> {
    assertHandle(handle)
    return collectWith(this.collector, handle, validateComputeJobSpec(spec))
  }
}
