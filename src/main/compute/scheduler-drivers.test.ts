import { describe, expect, it, vi } from 'vitest'

import type {
  ComputeJobSpec,
  DirectSshRemoteHandle,
  SlurmRemoteHandle
} from '../../shared/compute-scheduler'
import { DirectSshDriver, buildDirectSshSubmitCommand } from './direct-ssh-driver'
import type { RemoteArgvResult, RemoteArgvRunner } from './scheduler-driver'
import {
  SlurmDriver,
  buildSlurmCancelCommand,
  buildSlurmAccountingCommand,
  buildSlurmQueueCommand,
  buildSlurmSubmitCommand,
  formatSlurmWallTime,
  normalizeSlurmState,
  parseSacctStatus,
  parseSlurmSubmission
} from './slurm-driver'

const sampleSpec = (overrides: Partial<ComputeJobSpec> = {}): ComputeJobSpec => ({
  jobId: 'job-123',
  providerId: 'ssh:cluster',
  host: 'cluster',
  intent: 'Run analysis',
  script: 'echo "$(this is workload content)"\npython analyze.py',
  workingDirectory: '/scratch/project with spaces/job-123',
  resources: {
    partition: 'gpus',
    account: 'genbiolab',
    nodes: 1,
    tasksPerNode: 1,
    cpusPerTask: 8,
    memoryMib: 32_768,
    gpus: { count: 2, type: 'h100' },
    wallTimeSeconds: 90_061
  },
  inputs: ['input.fa'],
  expectedOutputs: ['results/*.tsv'],
  ...overrides
})

const result = (overrides: Partial<RemoteArgvResult> = {}): RemoteArgvResult => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  ...overrides
})

const mockRunner = (
  ...results: RemoteArgvResult[]
): RemoteArgvRunner & { run: ReturnType<typeof vi.fn> } => {
  const run = vi.fn()
  for (const value of results) run.mockResolvedValueOnce(value)
  return { run }
}

describe('Slurm command construction', () => {
  it('uses sbatch --parsable and keeps every dynamic value in a separate argv element', () => {
    const spec = sampleSpec()
    const command = buildSlurmSubmitCommand(spec)

    expect(command.executable).toBe('sbatch')
    expect(command.args[0]).toBe('--parsable')
    expect(command.args).toEqual(
      expect.arrayContaining([
        '--partition',
        'gpus',
        '--account',
        'genbiolab',
        '--nodes',
        '1',
        '--cpus-per-task',
        '8',
        '--mem',
        '32768M',
        '--gres',
        'gpu:h100:2',
        '--time',
        '1-01:01:01',
        '--chdir',
        '/scratch/project with spaces/job-123'
      ])
    )
    expect(command.stdin).toBe(spec.script)
    expect(command.args.join(' ')).not.toContain('this is workload content')
  })

  it('rejects tilde workdirs because Slurm argv does not perform shell expansion', () => {
    expect(() =>
      buildSlurmSubmitCommand(sampleSpec({ workingDirectory: '~/jobs/job-123' }))
    ).toThrow(/absolute remote path/)
  })

  it('formats wall time and parses parsable ids without accepting option-like ids', () => {
    expect(formatSlurmWallTime(3_661)).toBe('01:01:01')
    expect(parseSlurmSubmission('12345;cluster-a\n')).toEqual({
      schedulerJobId: '12345',
      cluster: 'cluster-a'
    })
    expect(() => parseSlurmSubmission('--signal=KILL')).toThrow()
  })

  it('builds scancel with an option terminator and validates the tagged handle', () => {
    const handle: SlurmRemoteHandle = {
      version: 1,
      driver: 'slurm',
      schedulerJobId: '12345',
      workdir: '/scratch/job',
      stdoutPath: '/scratch/job/stdout',
      stderrPath: '/scratch/job/stderr',
      scriptHash: 'a'.repeat(64)
    }
    expect(buildSlurmCancelCommand(handle)).toMatchObject({
      executable: 'scancel',
      args: ['--', '12345']
    })
    expect(() =>
      buildSlurmCancelCommand({ ...handle, schedulerJobId: '--all' } as SlurmRemoteHandle)
    ).toThrow()
  })

  it('keeps the sbatch-returned cluster on poll, accounting, and cancellation', () => {
    const handle: SlurmRemoteHandle = {
      version: 1,
      driver: 'slurm',
      schedulerJobId: '12345',
      cluster: 'cluster-a',
      workdir: '/scratch/job',
      stdoutPath: '/scratch/job/stdout',
      stderrPath: '/scratch/job/stderr',
      scriptHash: 'a'.repeat(64)
    }
    expect(buildSlurmQueueCommand(handle).args.slice(0, 2)).toEqual(['--clusters', 'cluster-a'])
    expect(buildSlurmAccountingCommand(handle).args.slice(0, 2)).toEqual([
      '--clusters',
      'cluster-a'
    ])
    expect(buildSlurmCancelCommand(handle).args).toEqual(['--clusters', 'cluster-a', '--', '12345'])
  })
})

describe('Slurm state normalization and driver', () => {
  it.each([
    ['PENDING', 'queued'],
    ['RUNNING', 'running'],
    ['COMPLETED', 'succeeded'],
    ['FAILED', 'failed'],
    ['OUT_OF_MEMORY', 'failed'],
    ['CANCELLED by 1000', 'cancelled'],
    ['TIMEOUT', 'timed_out'],
    ['NEW_FUTURE_STATE', 'unknown']
  ] as const)('normalizes %s to %s', (raw, expected) => {
    expect(normalizeSlurmState(raw)).toBe(expected)
  })

  it('parses sacct state and primary exit status', () => {
    expect(parseSacctStatus('COMPLETED|0:0\n')).toEqual({
      state: 'succeeded',
      rawState: 'COMPLETED',
      exitCode: 0
    })
  })

  it('does not accept partial or malformed sacct exit-code fields', () => {
    expect(parseSacctStatus('FAILED|12garbage:0\n')).toEqual({
      state: 'failed',
      rawState: 'FAILED'
    })
    expect(parseSacctStatus('FAILED|12:garbage\n')).toEqual({
      state: 'failed',
      rawState: 'FAILED'
    })
  })

  it('submits and persists a tagged Slurm handle', async () => {
    const runner = mockRunner(result({ stdout: '98231;cluster-a\n' }))
    const submission = await new SlurmDriver(runner).submit(sampleSpec())

    expect(submission.state).toBe('queued')
    expect(submission.handle).toMatchObject({
      version: 1,
      driver: 'slurm',
      schedulerJobId: '98231',
      cluster: 'cluster-a'
    })
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: 'sbatch',
        args: expect.arrayContaining(['--parsable'])
      })
    )
  })

  it('uses squeue while active and sacct after the job leaves the queue', async () => {
    const handle: SlurmRemoteHandle = {
      version: 1,
      driver: 'slurm',
      schedulerJobId: '98231',
      workdir: '/scratch/job',
      stdoutPath: '/scratch/job/stdout',
      stderrPath: '/scratch/job/stderr',
      scriptHash: 'a'.repeat(64)
    }
    const activeRunner = mockRunner(result({ stdout: 'RUNNING\n' }))
    await expect(new SlurmDriver(activeRunner).poll(handle)).resolves.toEqual({
      state: 'running',
      rawState: 'RUNNING'
    })
    expect(activeRunner.run).toHaveBeenCalledTimes(1)

    const finishedRunner = mockRunner(result({ stdout: '' }), result({ stdout: 'COMPLETED|0:0\n' }))
    await expect(new SlurmDriver(finishedRunner).poll(handle)).resolves.toEqual({
      state: 'succeeded',
      rawState: 'COMPLETED',
      exitCode: 0
    })
    expect(finishedRunner.run.mock.calls.map(([command]) => command.executable)).toEqual([
      'squeue',
      'sacct'
    ])
  })
})

describe('DirectSshDriver', () => {
  it('submits script content via stdin and returns a tagged process handle', async () => {
    const command = buildDirectSshSubmitCommand(sampleSpec())
    expect(command).toMatchObject({
      executable: 'bash',
      args: ['-s', '--'],
      cwd: '/scratch/project with spaces/job-123'
    })
    expect(command.stdin).toContain('python analyze.py')

    const runner = mockRunner(result({ processId: 4123 }))
    const submission = await new DirectSshDriver(runner).submit(sampleSpec())
    expect(submission.handle).toMatchObject({
      version: 1,
      driver: 'direct_ssh',
      processId: 4123
    })
  })

  it('polls the exit-code file before testing process liveness', async () => {
    const handle: DirectSshRemoteHandle = {
      version: 1,
      driver: 'direct_ssh',
      processId: 4123,
      workdir: '/scratch/job',
      stdoutPath: '/scratch/job/stdout',
      stderrPath: '/scratch/job/stderr',
      exitCodePath: '/scratch/job/exit_code',
      scriptHash: 'a'.repeat(64)
    }
    const runner = mockRunner(result({ stdout: '0\n' }))
    await expect(new DirectSshDriver(runner).poll(handle)).resolves.toEqual({
      state: 'succeeded',
      rawState: 'exited',
      exitCode: 0
    })
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({ executable: 'cat', args: ['--', '/scratch/job/exit_code'] })
    )
  })
})
