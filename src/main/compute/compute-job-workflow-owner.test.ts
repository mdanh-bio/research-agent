import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'

import type { ComputeHost } from '../../shared/compute'
import { ComputeJobWorkflowOwner, resolveInputs } from './compute-job-workflow-owner'
import type { ComputeApprovalBroker } from './compute-approval-broker'
import type { ComputeHostRepository } from './repository'
import type { ResolvedSshTarget, SshRunner } from './ssh-runner'
import { resolveSshTarget } from './ssh-runner'
import type { ScpRunner } from './scp-runner'
import type { ConcurrencyManager } from './concurrency-manager'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sampleHost = (overrides: Partial<ComputeHost> = {}): ComputeHost => ({
  id: 'host-1',
  providerId: 'ssh:biowulf',
  displayName: 'biowulf',
  shape: 'direct_ssh',
  sshAlias: 'biowulf',
  sshOverrides: undefined,
  scratchRoot: undefined,
  scratchPinned: false,
  concurrencyLimit: undefined,
  probeResult: {
    ok: true,
    probedAt: '2026-08-10T00:00:00.000Z',
    exitCode: 0,
    errorTail: null,
    detectedScheduler: 'none'
  },
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

// A fake target returned by the real resolveSshTarget helper — tests bypass that step by mocking the
// entire runner (which already has the target baked in).
const fakeTarget: ResolvedSshTarget = {
  sshBinary: '/usr/bin/ssh',
  host: 'biowulf.nih.gov',
  extraArgs: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'],
  connectionIdentity: {
    configResolved: true,
    alias: 'biowulf',
    hostname: 'biowulf.nih.gov',
    port: 22,
    effectiveConfigHash: 'a'.repeat(64)
  }
}

// Minimal fake runner — always resolves with a success result by default.
const makeFakeRunner = (result: Awaited<ReturnType<SshRunner['run']>>): SshRunner => ({
  run: vi.fn(() => Promise.resolve(result))
})

// Minimal repository double.
const makeRepo = (
  host: ComputeHost | null = sampleHost()
): {
  repo: ComputeHostRepository
  updateProbeResult: ReturnType<typeof vi.fn>
  updateScratchRoot: ReturnType<typeof vi.fn>
  updateDetails: ReturnType<typeof vi.fn>
  updateScratchPinned: ReturnType<typeof vi.fn>
  updateConcurrencyLimit: ReturnType<typeof vi.fn>
} => {
  const updateProbeResult = vi.fn(() => Promise.resolve())
  const updateScratchRoot = vi.fn(() => Promise.resolve())
  const updateDetails = vi.fn(() => Promise.resolve())
  const updateScratchPinned = vi.fn(() => Promise.resolve())
  const updateConcurrencyLimit = vi.fn(() => Promise.resolve())
  const repo: ComputeHostRepository = {
    get: vi.fn(() => Promise.resolve(host)),
    list: vi.fn(() => Promise.resolve([])),
    create: vi.fn(),
    delete: vi.fn(),
    updateProbeResult,
    updateScratchRoot,
    updateDetails,
    updateScratchPinned,
    updateConcurrencyLimit
  } as unknown as ComputeHostRepository
  return {
    repo,
    updateProbeResult,
    updateScratchRoot,
    updateDetails,
    updateScratchPinned,
    updateConcurrencyLimit
  }
}

// We use vi.mock for resolveSshTarget so the tests don't spawn ssh.
vi.mock('./ssh-runner', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./ssh-runner')>()
  return {
    ...orig,
    resolveSshTarget: vi.fn(() => Promise.resolve(fakeTarget))
  }
})

const makeScpRunner = (): ScpRunner => ({ copy: vi.fn() })

const makeOwner = (
  runner: SshRunner,
  repository: ComputeHostRepository,
  approvalBroker?: ComputeApprovalBroker,
  jobRepository?: import('./job-repository').ComputeJobRepository,
  publishJobUpdated?: (job: import('../../shared/compute').ComputeJob) => void,
  artifactResolver?: { resolveArtifactPath(uri: string): Promise<string> },
  storageRoot?: string,
  concurrencyManager?: ConcurrencyManager
): ComputeJobWorkflowOwner =>
  new ComputeJobWorkflowOwner(
    runner,
    repository,
    approvalBroker,
    makeScpRunner(),
    jobRepository,
    publishJobUpdated,
    artifactResolver,
    storageRoot,
    concurrencyManager
  )

const makeJobRepo = (
  jobs: Map<string, import('../../shared/compute').ComputeJob> = new Map()
): {
  repo: import('./job-repository').ComputeJobRepository
  createCalls: ReturnType<typeof vi.fn>
  updateCalls: ReturnType<typeof vi.fn>
} => {
  const createCalls = vi.fn(async (request: import('./job-repository').CreateJobRequest) => {
    const job: import('../../shared/compute').ComputeJob = {
      job_id: request.id,
      provider_id: request.providerId,
      shape: request.shape,
      session_id: request.sessionId,
      project_id: request.projectId,
      status: 'submitted',
      intent: request.intent,
      command: request.command,
      command_hash: request.commandHash,
      environment: request.environment,
      resource_request: request.resourceRequest,
      input_manifest: request.inputManifest,
      output_manifest: request.outputManifest,
      harvest_config: request.harvestConfig,
      timeout_seconds: request.timeoutSeconds,
      remote_workdir: request.remoteWorkdir,
      remote_handle: undefined,
      exit_code: undefined,
      stdout_tail: undefined,
      stderr_tail: undefined,
      error_code: undefined,
      created_at: Date.now(),
      submitted_at: Date.now(),
      started_at: undefined,
      finished_at: undefined,
      harvested_at: undefined
    }
    jobs.set(request.id, job)
    return job
  })
  const updateCalls = vi.fn(async (jobId: string, updates: unknown) => {
    const job = jobs.get(jobId) ?? { job_id: jobId }
    const updated = { ...job, ...(updates as object) }
    jobs.set(jobId, updated as import('../../shared/compute').ComputeJob)
    return updated as import('../../shared/compute').ComputeJob
  })
  const getCalls = vi.fn(async (jobId: string) => jobs.get(jobId) ?? null)
  const findNonTerminalCalls = vi.fn(async () => Array.from(jobs.values()))

  return {
    repo: {
      create: createCalls,
      get: getCalls,
      update: updateCalls,
      findNonTerminal: findNonTerminalCalls,
      findNonTerminalByProvider: vi.fn(async () => []),
      hasActiveJobsForProvider: vi.fn(async () => false)
    } as unknown as import('./job-repository').ComputeJobRepository,
    createCalls,
    updateCalls
  }
}

describe('ComputeJobWorkflowOwner.submitJob', () => {
  it('fails closed before approval or SSH for scheduler hosts until Slurm owns dispatch', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo, createCalls } = makeJobRepo()
    const { repo } = makeRepo(sampleHost({ shape: 'scheduler_cluster' }))
    const requestWithContext = vi.fn(() => Promise.resolve('once' as const))
    const broker = {
      request: requestWithContext,
      requestWithContext,
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker
    const service = makeOwner(runner, repo, broker, jobRepo)

    await expect(
      service.submitJob(
        'ssh:biowulf',
        'scheduled analysis',
        'python analysis.py',
        { resourceRequest: JSON.stringify({ partition: 'gpu', gpus: 1 }) },
        { sessionId: 'sess-1', projectId: 'proj-1' }
      )
    ).rejects.toMatchObject({
      computeCallError: {
        error_code: 'scheduler_not_ready',
        retry_after_user_action: true
      }
    })
    expect(requestWithContext).not.toHaveBeenCalled()
    expect(createCalls).not.toHaveBeenCalled()
    expect(runner.run).not.toHaveBeenCalled()
  })

  it.each([
    ['unprobed', undefined],
    [
      'failed probe',
      {
        ok: false,
        probedAt: '2026-08-10T00:00:00.000Z',
        exitCode: 255,
        errorTail: 'Connection refused'
      }
    ]
  ] as const)(
    'does not treat a direct-shaped %s host as executable',
    async (_label, probeResult) => {
      const runner = makeFakeRunner({
        exitCode: 0,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false
      })
      const { repo: jobRepo, createCalls } = makeJobRepo()
      const { repo } = makeRepo(sampleHost({ shape: 'direct_ssh', probeResult }))
      const requestWithContext = vi.fn(() => Promise.resolve('once' as const))
      const service = makeOwner(
        runner,
        repo,
        { requestWithContext } as unknown as ComputeApprovalBroker,
        jobRepo
      )

      await expect(
        service.submitJob(
          'ssh:biowulf',
          'analysis',
          'python analysis.py',
          {},
          { sessionId: 'sess-1', projectId: 'proj-1' }
        )
      ).rejects.toMatchObject({ computeCallError: { error_code: 'host_unclassified' } })
      expect(requestWithContext).not.toHaveBeenCalled()
      expect(createCalls).not.toHaveBeenCalled()
      expect(runner.run).not.toHaveBeenCalled()
    }
  )

  it('invalidates approval when the host becomes scheduler-classified while the card is open', async () => {
    const directHost = sampleHost()
    const schedulerHost = sampleHost({
      shape: 'scheduler_cluster',
      probeResult: {
        ok: true,
        probedAt: '2026-08-10T00:01:00.000Z',
        exitCode: 0,
        errorTail: null,
        detectedScheduler: 'slurm'
      }
    })
    const { repo } = makeRepo(directHost)
    vi.mocked(repo.get).mockResolvedValueOnce(directHost).mockResolvedValue(schedulerHost)
    const { repo: jobRepo, createCalls } = makeJobRepo()
    const requestWithContext = vi.fn(() => Promise.resolve('once' as const))
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })

    await expect(
      makeOwner(
        runner,
        repo,
        { requestWithContext } as unknown as ComputeApprovalBroker,
        jobRepo
      ).submitJob(
        'ssh:biowulf',
        'analysis',
        'python analysis.py',
        {},
        { sessionId: 'sess-1', projectId: 'proj-1' }
      )
    ).rejects.toMatchObject({ computeCallError: { error_code: 'approval_stale' } })
    expect(requestWithContext).toHaveBeenCalledOnce()
    expect(createCalls).not.toHaveBeenCalled()
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('invalidates approval when resolved SSH options change while the card is open', async () => {
    const changedTarget: ResolvedSshTarget = {
      ...fakeTarget,
      extraArgs: [...fakeTarget.extraArgs, '-p', '2222'],
      connectionIdentity: {
        ...fakeTarget.connectionIdentity!,
        port: 2222,
        effectiveConfigHash: 'b'.repeat(64)
      }
    }
    vi.mocked(resolveSshTarget)
      .mockResolvedValueOnce(fakeTarget)
      .mockResolvedValueOnce(changedTarget)
    const { repo } = makeRepo()
    const { repo: jobRepo, createCalls } = makeJobRepo()
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })

    await expect(
      makeOwner(
        runner,
        repo,
        {
          requestWithContext: vi.fn(() => Promise.resolve('once' as const))
        } as unknown as ComputeApprovalBroker,
        jobRepo
      ).submitJob(
        'ssh:biowulf',
        'analysis',
        'python analysis.py',
        {},
        { sessionId: 'sess-1', projectId: 'proj-1' }
      )
    ).rejects.toMatchObject({ computeCallError: { error_code: 'approval_stale' } })
    expect(createCalls).not.toHaveBeenCalled()
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('does not open an approval card when ssh -G cannot resolve the endpoint/options', async () => {
    vi.mocked(resolveSshTarget).mockResolvedValueOnce({
      ...fakeTarget,
      connectionIdentity: { ...fakeTarget.connectionIdentity!, configResolved: false }
    })
    const { repo } = makeRepo()
    const { repo: jobRepo, createCalls } = makeJobRepo()
    const requestWithContext = vi.fn(() => Promise.resolve('once' as const))
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })

    await expect(
      makeOwner(
        runner,
        repo,
        { requestWithContext } as unknown as ComputeApprovalBroker,
        jobRepo
      ).submitJob(
        'ssh:biowulf',
        'analysis',
        'python analysis.py',
        {},
        { sessionId: 'sess-1', projectId: 'proj-1' }
      )
    ).rejects.toMatchObject({ computeCallError: { error_code: 'host_unclassified' } })
    expect(requestWithContext).not.toHaveBeenCalled()
    expect(createCalls).not.toHaveBeenCalled()
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('invalidates approval when a local input changes while the card is open', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'compute-approval-race-'))
    const inputPath = join(workspace, 'counts.tsv')
    await writeFile(inputPath, 'gene\tcount\nA\t1\n')
    const { repo } = makeRepo()
    const { repo: jobRepo, createCalls } = makeJobRepo()
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const requestWithContext = vi.fn(async () => {
      await writeFile(inputPath, 'gene\tcount\nA\t999\n')
      return 'once' as const
    })

    try {
      await expect(
        makeOwner(
          runner,
          repo,
          { requestWithContext } as unknown as ComputeApprovalBroker,
          jobRepo
        ).submitJob(
          'ssh:biowulf',
          'analysis',
          'python analysis.py',
          { inputs: [{ src: 'counts.tsv', dst_filename: 'counts.tsv' }], workspaceCwd: workspace },
          { sessionId: 'sess-1', projectId: 'proj-1' }
        )
      ).rejects.toMatchObject({ computeCallError: { error_code: 'approval_stale' } })
      expect(createCalls).not.toHaveBeenCalled()
      expect(runner.run).not.toHaveBeenCalled()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('returns job_id + remote_workdir immediately (before dispatch)', async () => {
    // Runner should never be called for submit_job itself (dispatch is background).
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo, createCalls } = makeJobRepo()
    const { repo } = makeRepo()

    const approveDecision = vi.fn(() => Promise.resolve('once' as const))
    const broker = {
      request: approveDecision,
      requestWithContext: approveDecision,
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    const service = makeOwner(runner, repo, broker, jobRepo)

    const result = await service.submitJob(
      'ssh:biowulf',
      'smoke test',
      'echo hello',
      {},
      { sessionId: 'sess-1', projectId: 'proj-1' }
    )

    expect(result.status).toBe('submitted')
    expect(result.provider_id).toBe('ssh:biowulf')
    expect(result.job_id).toBeDefined()
    expect(result.remote_workdir).toContain('.research-agent/jobs/')
    expect(createCalls).toHaveBeenCalledOnce()
  })

  it('throws approval_denied and does NOT create a DB row when approval is denied', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo, createCalls } = makeJobRepo()
    const { repo } = makeRepo()

    const denyDecision = vi.fn(() => Promise.resolve('deny' as const))
    const broker = {
      request: denyDecision,
      requestWithContext: denyDecision,
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    const service = makeOwner(runner, repo, broker, jobRepo)

    const err = await service
      .submitJob('ssh:biowulf', 'test', 'echo hi', {}, { sessionId: 's1', projectId: 'p1' })
      .catch((e) => e)

    expect(err.computeCallError?.error_code).toBe('approval_denied')
    // No DB row should have been created.
    expect(createCalls).not.toHaveBeenCalled()
  })

  it('marks submit_job as single-use before handing it to the approval broker', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo } = makeJobRepo()
    const { repo } = makeRepo()

    const requestWithContext = vi.fn(() => Promise.resolve('conversation' as const))
    const broker = {
      request: vi.fn(),
      requestWithContext,
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    const service = makeOwner(runner, repo, broker, jobRepo)

    await service.submitJob(
      'ssh:biowulf',
      'test',
      'echo hi',
      {},
      { sessionId: 's1', projectId: 'p1' }
    )

    expect(requestWithContext).toHaveBeenCalledWith(
      expect.objectContaining({ execution_mode: 'direct_ssh', single_use: true }),
      expect.objectContaining({ operation: 'submit_job' })
    )
  })

  it('rejects timeout_seconds > 7 days', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo } = makeJobRepo()
    const { repo } = makeRepo()
    const broker = {
      request: vi.fn(),
      requestWithContext: vi.fn(() => Promise.resolve('once' as const)),
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    const service = makeOwner(runner, repo, broker, jobRepo)

    const err = await service
      .submitJob(
        'ssh:biowulf',
        'test',
        'echo hi',
        { timeoutSeconds: 8 * 24 * 3600 },
        { sessionId: 's1', projectId: 'p1' }
      )
      .catch((e) => e)

    expect(err.computeCallError?.error_code).toBe('timeout')
  })

  it('approval fires before any DB row is created (security contract)', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo, createCalls } = makeJobRepo()
    const { repo } = makeRepo()

    let approvalCalledAt: number | undefined
    let createCalledAt: number | undefined

    const requestWithContext = vi.fn(async () => {
      approvalCalledAt = Date.now()
      await new Promise((r) => setTimeout(r, 1))
      return 'once' as const
    })
    const broker = {
      request: vi.fn(),
      requestWithContext,
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    createCalls.mockImplementation(async (request: import('./job-repository').CreateJobRequest) => {
      createCalledAt = Date.now()
      return {
        job_id: request.id,
        provider_id: request.providerId,
        shape: request.shape,
        session_id: request.sessionId,
        project_id: request.projectId,
        status: 'submitted' as const,
        intent: request.intent,
        command: request.command,
        command_hash: request.commandHash,
        environment: undefined,
        resource_request: undefined,
        input_manifest: undefined,
        output_manifest: undefined,
        harvest_config: undefined,
        timeout_seconds: request.timeoutSeconds,
        remote_workdir: request.remoteWorkdir,
        remote_handle: undefined,
        exit_code: undefined,
        stdout_tail: undefined,
        stderr_tail: undefined,
        error_code: undefined,
        created_at: Date.now(),
        submitted_at: Date.now(),
        started_at: undefined,
        finished_at: undefined,
        harvested_at: undefined
      }
    })

    const service = makeOwner(runner, repo, broker, jobRepo)
    await service.submitJob(
      'ssh:biowulf',
      'test',
      'echo hi',
      {},
      { sessionId: 's1', projectId: 'p1' }
    )

    expect(approvalCalledAt).toBeDefined()
    expect(createCalledAt).toBeDefined()
    expect(approvalCalledAt!).toBeLessThanOrEqual(createCalledAt!)
  })
})

describe('ComputeJobWorkflowOwner.getJobStatus', () => {
  it('returns status shape from DB without SSH', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const jobs = new Map<string, import('../../shared/compute').ComputeJob>()
    const job: import('../../shared/compute').ComputeJob = {
      job_id: 'job-42',
      provider_id: 'ssh:biowulf',
      shape: 'direct_ssh',
      session_id: 'sess-1',
      project_id: 'proj-1',
      status: 'success',
      intent: 'test',
      command: 'echo hi',
      command_hash: 'abc',
      environment: undefined,
      resource_request: undefined,
      input_manifest: undefined,
      output_manifest: undefined,
      harvest_config: undefined,
      timeout_seconds: 3600,
      remote_workdir: '~/.openscience/jobs/job-42',
      remote_handle: undefined,
      exit_code: 0,
      stdout_tail: 'hi\n',
      stderr_tail: '',
      error_code: undefined,
      created_at: 1,
      submitted_at: 1,
      started_at: 1,
      finished_at: 2,
      harvested_at: undefined
    }
    jobs.set('job-42', job)
    const { repo: jobRepo } = makeJobRepo(jobs)
    const { repo } = makeRepo()

    const service = makeOwner(runner, repo, undefined, jobRepo)

    const status = await service.getJobStatus('job-42')
    expect(status.job_id).toBe('job-42')
    expect(status.status).toBe('success')
    expect(status.exit_code).toBe(0)
    expect(status.stdout_tail).toBe('hi\n')
    expect(status.remote_workdir).toBe('~/.openscience/jobs/job-42')

    // SSH runner should NOT have been called.
    expect((runner.run as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  it('throws when job not found', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo } = makeJobRepo()
    const { repo } = makeRepo()

    const service = makeOwner(runner, repo, undefined, jobRepo)

    await expect(service.getJobStatus('nonexistent')).rejects.toThrow(/No compute job/)
  })
})

// ---------------------------------------------------------------------------
// resolveInputs — unit tests for input staging validation/resolution
// ---------------------------------------------------------------------------

describe('resolveInputs — workspace source', () => {
  it('resolves a workspace path to an absolute local path', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'compute-resolve-workspace-'))
    const sourcePath = join(workspace, 'data', 'sample.fa')
    await mkdir(join(workspace, 'data'))
    await writeFile(sourcePath, 'ACGT\n')
    try {
      const { entries, inputsSummary } = await resolveInputs(
        [{ src: 'data/sample.fa', dst_filename: 'sample.fa' }],
        workspace,
        undefined
      )
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        kind: 'upload',
        sourcePath,
        localPath: await realpath(sourcePath),
        authorizedRoot: await realpath(workspace),
        dstFilename: 'sample.fa'
      })
      expect(inputsSummary).toBe('1 input: sample.fa')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('rejects a workspace path that escapes the workspace root via ../', async () => {
    await expect(
      resolveInputs(
        [{ src: '../../etc/passwd', dst_filename: 'passwd' }],
        '/workspace/root',
        undefined
      )
    ).rejects.toThrow(/escape/)
  })

  it('rejects a workspace symlink whose canonical target is outside the workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'compute-symlink-workspace-'))
    const outside = await mkdtemp(join(tmpdir(), 'compute-symlink-outside-'))
    const outsideFile = join(outside, 'secret.txt')
    await writeFile(outsideFile, 'not authorized\n')
    await symlink(outsideFile, join(workspace, 'input.txt'))
    try {
      await expect(
        resolveInputs([{ src: 'input.txt', dst_filename: 'input.txt' }], workspace, undefined)
      ).rejects.toThrow(/outside its authorized root/)
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('throws when workspaceCwd is missing for a workspace src', async () => {
    await expect(
      resolveInputs([{ src: 'data.csv', dst_filename: 'data.csv' }], undefined, undefined)
    ).rejects.toThrow(/workspace_cwd/)
  })
})

describe('resolveInputs — artifact source', () => {
  it('resolves an absolute artifact-store path via ArtifactResolver to a local path', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'compute-artifact-root-'))
    const artifactPath = join(storageRoot, 'artifacts', 'sess', 'run', 'model.pkl')
    await mkdir(join(storageRoot, 'artifacts', 'sess', 'run'), { recursive: true })
    await writeFile(artifactPath, 'model\n')
    const resolver = {
      resolveArtifactPath: vi.fn(async () => artifactPath)
    }
    try {
      const { entries, inputsSummary } = await resolveInputs(
        [{ src: '/storage/artifacts/sess/run/model.pkl', dst_filename: 'model.pkl' }],
        undefined,
        resolver,
        storageRoot
      )
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        kind: 'upload',
        sourcePath: artifactPath,
        localPath: await realpath(artifactPath),
        authorizedRoot: await realpath(storageRoot),
        dstFilename: 'model.pkl'
      })
      expect(inputsSummary).toBe('1 input: model.pkl')
      expect(resolver.resolveArtifactPath).toHaveBeenCalledWith(
        '/storage/artifacts/sess/run/model.pkl'
      )
    } finally {
      await rm(storageRoot, { recursive: true, force: true })
    }
  })

  it('throws when artifactResolver is missing for an absolute (artifact) src', async () => {
    await expect(
      resolveInputs(
        [{ src: '/storage/artifacts/sess/run/model.pkl', dst_filename: 'model.pkl' }],
        undefined,
        undefined
      )
    ).rejects.toThrow(/ArtifactResolver/)
  })
})

describe('resolveInputs — remote_path source', () => {
  it('creates a symlink entry for an absolute remote path', async () => {
    const { entries, inputsSummary } = await resolveInputs(
      [{ remote_path: '/scratch/ref.fa', dst_filename: 'ref.fa' }],
      undefined,
      undefined
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: 'symlink',
      remotePath: '/scratch/ref.fa',
      dstFilename: 'ref.fa'
    })
    expect(inputsSummary).toBe('1 input: ref.fa (symlink)')
  })

  it('infers dst_filename from basename when omitted', async () => {
    const { entries } = await resolveInputs(
      [{ remote_path: '/scratch/genome.fa' }],
      undefined,
      undefined
    )
    expect(entries[0]).toMatchObject({ kind: 'symlink', dstFilename: 'genome.fa' })
  })

  it('rejects a relative remote_path', async () => {
    await expect(
      resolveInputs([{ remote_path: 'relative/path' }], undefined, undefined)
    ).rejects.toThrow(/absolute/)
  })

  it('rejects a remote_path with glob characters', async () => {
    await expect(
      resolveInputs([{ remote_path: '/scratch/*.fa' }], undefined, undefined)
    ).rejects.toThrow(/glob/)
  })

  it('rejects a remote_path with shell-unsafe characters', async () => {
    await expect(
      resolveInputs([{ remote_path: '/scratch/$(id)' }], undefined, undefined)
    ).rejects.toThrow(/shell-unsafe/)
  })
})

describe('resolveInputs — dst_filename validation', () => {
  it('rejects a dst_filename containing /', async () => {
    await expect(
      resolveInputs([{ src: 'data.csv', dst_filename: 'sub/data.csv' }], '/workspace', undefined)
    ).rejects.toThrow(/bare filename/)
  })

  it('rejects an empty dst_filename', async () => {
    await expect(
      resolveInputs([{ src: 'data.csv', dst_filename: '' }], '/workspace', undefined)
    ).rejects.toThrow(/bare filename/)
  })

  it.each(['$(touch owned)', '`touch owned`', 'result;touch-owned', '*.csv'])(
    'rejects traditional-SCP metacharacters in dst_filename %s',
    async (dstFilename) => {
      await expect(
        resolveInputs([{ src: 'data.csv', dst_filename: dstFilename }], '/workspace', undefined)
      ).rejects.toThrow(/shell-unsafe|glob/)
    }
  )
})

describe('resolveInputs — mixed inputs summary', () => {
  it('builds summary for multiple inputs of different kinds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compute-mixed-inputs-'))
    const workspace = join(root, 'workspace')
    const storageRoot = join(root, 'storage')
    const artifactPath = join(storageRoot, 'model.pkl')
    await mkdir(workspace)
    await mkdir(storageRoot)
    await writeFile(join(workspace, 'data.csv'), 'value\n')
    await writeFile(artifactPath, 'model\n')
    const resolver = {
      resolveArtifactPath: vi.fn(async () => artifactPath)
    }
    try {
      const { entries, inputsSummary } = await resolveInputs(
        [
          { src: 'data.csv', dst_filename: 'data.csv' },
          { src: '/storage/artifacts/s/r/model.pkl', dst_filename: 'model.pkl' },
          { remote_path: '/scratch/ref.fa', dst_filename: 'ref.fa' }
        ],
        workspace,
        resolver,
        storageRoot
      )
      expect(entries).toHaveLength(3)
      expect(inputsSummary).toBe('3 inputs: data.csv, model.pkl, ref.fa (symlink)')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns empty summary when no inputs', async () => {
    const { entries, inputsSummary } = await resolveInputs([], '/workspace', undefined)
    expect(entries).toHaveLength(0)
    expect(inputsSummary).toBe('')
  })
})

describe('ComputeJobWorkflowOwner.submitJob — inputs_summary in approval', () => {
  it('passes inputs_summary to the approval request when inputs are provided', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'compute-approved-input-'))
    await writeFile(join(workspace, 'ref.fa'), 'ACGT\n')
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo } = makeJobRepo()
    const { repo } = makeRepo()

    const requestWithContext = vi.fn(() => Promise.resolve('once' as const))
    const broker = {
      request: requestWithContext,
      requestWithContext,
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    const service = makeOwner(runner, repo, broker, jobRepo)

    try {
      await service.submitJob(
        'ssh:biowulf',
        'test',
        'echo hi',
        {
          inputs: [{ src: 'ref.fa', dst_filename: 'ref.fa' }],
          workspaceCwd: workspace
        },
        { sessionId: 's1', projectId: 'p1' }
      )

      const callArg = (requestWithContext as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        inputs_summary?: string
        job_summary?: import('../../shared/compute-scheduler').ComputeJobApprovalSummary
        dispatch_binding?: import('../../shared/compute-scheduler').ComputeDispatchApprovalSummary
      }
      expect(callArg.inputs_summary).toMatch(/^ref\.fa \(5 bytes; sha256 [a-f0-9]{64}\)$/)
      expect(callArg.job_summary).toMatchObject({
        host: 'biowulf',
        partition: null,
        account: null,
        cpu: { nodes: 1, tasks_per_node: 1, cpus_per_task: 1, total_cpus: 1 },
        gpu: null,
        memory_mib: null,
        wall_time_seconds: 24 * 3600,
        inputs: ['ref.fa'],
        expected_outputs: []
      })
      expect(callArg.job_summary?.script_hash).toMatch(/^[a-f0-9]{64}$/)
      expect(callArg.job_summary?.working_directory).toContain('.research-agent/jobs/')
      expect(callArg.dispatch_binding).toMatchObject({
        inputs: [{ destination: 'ref.fa', size_bytes: 5 }],
        ssh_target: {
          alias: 'biowulf',
          hostname: 'biowulf.nih.gov',
          port: 22,
          effective_config_hash: 'a'.repeat(64)
        }
      })
      expect(callArg.dispatch_binding?.inputs[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(callArg.dispatch_binding?.binding_hash).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('stores resolved inputManifest in the DB row', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'compute-approved-manifest-'))
    const localInput = join(workspace, 'ref.fa')
    await writeFile(localInput, 'ACGT\n')
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo, createCalls } = makeJobRepo()
    const { repo } = makeRepo()

    const broker = {
      request: vi.fn(() => Promise.resolve('once' as const)),
      requestWithContext: vi.fn(() => Promise.resolve('once' as const)),
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    const service = makeOwner(runner, repo, broker, jobRepo)

    try {
      await service.submitJob(
        'ssh:biowulf',
        'test',
        'echo hi',
        {
          inputs: [{ src: 'ref.fa', dst_filename: 'ref.fa' }],
          workspaceCwd: workspace
        },
        { sessionId: 's1', projectId: 'p1' }
      )

      const createArg = (createCalls as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        inputManifest?: string
      }
      expect(createArg.inputManifest).toBeDefined()
      const manifest = JSON.parse(createArg.inputManifest!) as {
        version: number
        inputs: Array<{
          kind: string
          sourcePath: string
          localPath: string
          authorizedRoot: string
          dstFilename: string
          contentIdentity: { sizeBytes: number; sha256: string }
        }>
      }
      expect(manifest.version).toBe(2)
      expect(manifest.inputs).toHaveLength(1)
      expect(manifest.inputs[0]).toMatchObject({
        kind: 'upload',
        sourcePath: localInput,
        localPath: await realpath(localInput),
        authorizedRoot: await realpath(workspace),
        dstFilename: 'ref.fa',
        contentIdentity: { sizeBytes: 5 }
      })
      expect(manifest.inputs[0]?.contentIdentity.sha256).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('rejects an outside-target workspace symlink before approval or persistence', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'compute-submit-symlink-workspace-'))
    const outside = await mkdtemp(join(tmpdir(), 'compute-submit-symlink-outside-'))
    const outsideFile = join(outside, 'private-key')
    await writeFile(outsideFile, 'sensitive\n')
    await symlink(outsideFile, join(workspace, 'input.fa'))
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo, createCalls } = makeJobRepo()
    const { repo } = makeRepo()
    const requestWithContext = vi.fn(() => Promise.resolve('once' as const))
    const broker = {
      request: requestWithContext,
      requestWithContext,
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker
    const service = makeOwner(runner, repo, broker, jobRepo)

    try {
      await expect(
        service.submitJob(
          'ssh:biowulf',
          'test',
          'echo hi',
          {
            inputs: [{ src: 'input.fa', dst_filename: 'input.fa' }],
            workspaceCwd: workspace
          },
          { sessionId: 's1', projectId: 'p1' }
        )
      ).rejects.toMatchObject({
        computeCallError: {
          error_code: 'input_identity_unavailable',
          message: expect.stringMatching(/outside its authorized root/)
        }
      })
      expect(requestWithContext).not.toHaveBeenCalled()
      expect(createCalls).not.toHaveBeenCalled()
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects remote symlink inputs before approval because their bytes cannot be identified', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo, createCalls } = makeJobRepo()
    const { repo } = makeRepo()
    const requestWithContext = vi.fn(() => Promise.resolve('once' as const))
    const broker = {
      request: requestWithContext,
      requestWithContext,
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker
    const service = makeOwner(runner, repo, broker, jobRepo)

    await expect(
      service.submitJob(
        'ssh:biowulf',
        'test',
        'echo hi',
        { inputs: [{ remote_path: '/scratch/ref.fa', dst_filename: 'ref.fa' }] },
        { sessionId: 's1', projectId: 'p1' }
      )
    ).rejects.toMatchObject({
      computeCallError: { error_code: 'input_identity_unavailable' }
    })
    expect(requestWithContext).not.toHaveBeenCalled()
    expect(createCalls).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// ComputeJobWorkflowOwner.getJobResult — four-timing semantics (design §9, issue 04)
// ---------------------------------------------------------------------------

describe('ComputeJobWorkflowOwner.getJobResult', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'job-result-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  const makeServiceWithStorageRoot = (
    job: import('../../shared/compute').ComputeJob,
    storageRoot: string
  ): ComputeJobWorkflowOwner => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const jobs = new Map([[job.job_id, job]])
    const { repo: jobRepo } = makeJobRepo(jobs)
    const { repo } = makeRepo()
    return makeOwner(runner, repo, undefined, jobRepo, undefined, undefined, storageRoot)
  }

  const baseJob = (
    overrides: Partial<import('../../shared/compute').ComputeJob> = {}
  ): import('../../shared/compute').ComputeJob => ({
    job_id: 'job-result-1',
    provider_id: 'ssh:biowulf',
    shape: 'direct_ssh',
    session_id: 'sess-1',
    project_id: 'proj-1',
    status: 'success',
    intent: 'test',
    command: 'echo hi',
    command_hash: 'abc',
    environment: undefined,
    resource_request: undefined,
    input_manifest: undefined,
    output_manifest: undefined,
    harvest_config: undefined,
    timeout_seconds: 3600,
    remote_workdir: '~/.openscience/jobs/job-result-1',
    remote_handle: undefined,
    exit_code: 0,
    stdout_tail: 'hi\n',
    stderr_tail: '',
    error_code: undefined,
    created_at: 1,
    submitted_at: 1,
    started_at: 1,
    finished_at: 2,
    harvested_at: undefined,
    ...overrides
  })

  it('non-terminal status: returns empty file lists without error', async () => {
    const job = baseJob({ status: 'running', harvested_at: undefined })
    const service = makeServiceWithStorageRoot(job, tmpDir)
    const result = await service.getJobResult('job-result-1')
    expect(result.status).toBe('running')
    expect(result.featured_files).toEqual([])
    expect(result.hidden_files).toEqual([])
    expect(result.output_files).toEqual([])
    expect(result.left_on_remote).toEqual([])
  })

  it('terminal but harvest not done: returns empty file lists without error', async () => {
    const job = baseJob({ status: 'success', harvested_at: undefined })
    const service = makeServiceWithStorageRoot(job, tmpDir)
    const result = await service.getJobResult('job-result-1')
    expect(result.status).toBe('success')
    expect(result.featured_files).toEqual([])
    expect(result.output_files).toEqual([])
  })

  it('clean harvest: returns full file lists with workspace-relative paths', async () => {
    const harvestDir = join(tmpDir, 'notebooks', 'proj-1', 'sess-1', 'hpc', 'job-result-1')
    await mkdir(join(harvestDir, 'featured'), { recursive: true })
    await mkdir(join(harvestDir, 'hidden'), { recursive: true })
    await writeFile(join(harvestDir, 'featured', 'out.result'), 'result data')
    await writeFile(join(harvestDir, 'hidden', 'debug.log'), 'log data')

    const job = baseJob({ harvested_at: Date.now(), harvest_error: undefined })
    const service = makeServiceWithStorageRoot(job, tmpDir)
    const result = await service.getJobResult('job-result-1')

    expect(result.status).toBe('success')
    expect(result.exit_code).toBe(0)
    expect(result.featured_files).toContain('hpc/job-result-1/featured/out.result')
    expect(result.hidden_files).toContain('hpc/job-result-1/hidden/debug.log')
    expect(result.output_files).toContain('hpc/job-result-1/featured/out.result')
    expect(result.output_files).toContain('hpc/job-result-1/hidden/debug.log')
    // featured entries come before hidden in output_files
    const featIdx = result.output_files.indexOf('hpc/job-result-1/featured/out.result')
    const hidIdx = result.output_files.indexOf('hpc/job-result-1/hidden/debug.log')
    expect(featIdx).toBeLessThan(hidIdx)
  })

  it('reads attach_job results from the data-root workspace when config and data roots differ', async () => {
    const configRoot = await mkdtemp(join(tmpdir(), 'job-result-config-root-'))
    const dataRoot = await mkdtemp(join(tmpdir(), 'job-result-data-root-'))
    const dataHarvestDir = join(dataRoot, 'notebooks', 'proj-1', 'sess-1', 'hpc', 'job-result-1')
    const configHarvestDir = join(
      configRoot,
      'notebooks',
      'proj-1',
      'sess-1',
      'hpc',
      'job-result-1'
    )
    await mkdir(join(dataHarvestDir, 'featured'), { recursive: true })
    await mkdir(join(configHarvestDir, 'featured'), { recursive: true })
    await writeFile(join(dataHarvestDir, 'featured', 'data-root.result'), 'readable by notebook')
    await writeFile(
      join(configHarvestDir, 'featured', 'stale-config.result'),
      'must not be returned'
    )

    try {
      const service = makeServiceWithStorageRoot(baseJob({ harvested_at: Date.now() }), dataRoot)
      const result = await service.getJobResult('job-result-1')
      expect(result.featured_files).toEqual(['hpc/job-result-1/featured/data-root.result'])
      expect(result.output_files).toEqual(['hpc/job-result-1/featured/data-root.result'])
    } finally {
      await rm(configRoot, { recursive: true, force: true })
      await rm(dataRoot, { recursive: true, force: true })
    }
  })

  it('harvest_failed: partial files returned, remote_workdir preserved', async () => {
    const harvestDir = join(tmpDir, 'notebooks', 'proj-1', 'sess-1', 'hpc', 'job-result-1')
    await mkdir(join(harvestDir, 'featured'), { recursive: true })
    await writeFile(join(harvestDir, 'featured', 'partial.result'), 'partial')

    const leftOnRemote = JSON.stringify([
      { uri: 'ssh://biowulf/tmp/big.bin', size_mb: 150, reason: 'exceeds_max_file_mb' }
    ])
    const job = baseJob({
      harvested_at: Date.now(),
      harvest_error: 'scp failed: connection reset',
      left_on_remote: leftOnRemote,
      remote_workdir: '~/.openscience/jobs/job-result-1'
    })
    const service = makeServiceWithStorageRoot(job, tmpDir)
    const result = await service.getJobResult('job-result-1')

    expect(result.status).toBe('success')
    expect(result.featured_files).toContain('hpc/job-result-1/featured/partial.result')
    expect(result.remote_workdir).toBe('~/.openscience/jobs/job-result-1')
    expect(result.left_on_remote).toHaveLength(1)
    expect(result.left_on_remote[0].uri).toBe('ssh://biowulf/tmp/big.bin')
  })

  it('throws when job not found', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo } = makeJobRepo()
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo, undefined, jobRepo, undefined, undefined, tmpDir)
    await expect(service.getJobResult('no-such-job')).rejects.toThrow(/No compute job/)
  })
})

// ---------------------------------------------------------------------------
// Session concurrency control (Phase 3c, issue 04)
// ---------------------------------------------------------------------------

describe('setSessionConcurrencyLimit', () => {
  it('delegates to concurrency manager', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const setSessionLimit = vi.fn()
    const concurrencyManager = {
      setSessionLimit,
      getStatus: vi.fn(),
      enqueue: vi.fn(),
      onJobCompleted: vi.fn()
    }
    const service = makeOwner(
      runner,
      repo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      concurrencyManager as unknown as ConcurrencyManager
    )

    await service.setSessionConcurrencyLimit('session-123', 10)
    expect(setSessionLimit).toHaveBeenCalledWith('session-123', 10)
  })

  it('throws when concurrency manager not initialized', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo)

    await expect(service.setSessionConcurrencyLimit('session-123', 10)).rejects.toThrow(
      /ConcurrencyManager is required/
    )
  })

  it('validates limit is positive integer', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const concurrencyManager = {
      setSessionLimit: vi.fn(),
      getStatus: vi.fn(),
      enqueue: vi.fn(),
      onJobCompleted: vi.fn()
    }
    const service = makeOwner(
      runner,
      repo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      concurrencyManager as unknown as ConcurrencyManager
    )

    await expect(service.setSessionConcurrencyLimit('session-123', 0)).rejects.toThrow(
      /integer in the range 1\.\.500/
    )
    await expect(service.setSessionConcurrencyLimit('session-123', -5)).rejects.toThrow(
      /integer in the range 1\.\.500/
    )
    await expect(service.setSessionConcurrencyLimit('session-123', 3.5)).rejects.toThrow(
      /integer in the range 1\.\.500/
    )
  })
})

describe('getSessionConcurrencyStatus', () => {
  it('delegates to concurrency manager and enriches with all host ceilings', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const hostA = sampleHost({ providerId: 'ssh:host-a', concurrencyLimit: 20 })
    const hostB = sampleHost({ providerId: 'ssh:host-b', concurrencyLimit: undefined })
    const hostC = sampleHost({ providerId: 'ssh:host-c', concurrencyLimit: 50 })
    const list = vi.fn(() => Promise.resolve([hostA, hostB, hostC]))
    const { repo } = makeRepo()
    repo.list = list

    const managerStatus = {
      session_limit: 10,
      active_count: 3,
      queued_count: 2,
      provider_ceilings: { 'ssh:host-a': 20 } // Only one host has jobs in this session
    }
    const getStatus = vi.fn(() => Promise.resolve(managerStatus))
    const concurrencyManager = {
      setSessionLimit: vi.fn(),
      getStatus,
      enqueue: vi.fn(),
      onJobCompleted: vi.fn()
    }
    const service = makeOwner(
      runner,
      repo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      concurrencyManager as unknown as ConcurrencyManager
    )

    const result = await service.getSessionConcurrencyStatus('session-123')
    expect(getStatus).toHaveBeenCalledWith('session-123')
    expect(result.session_limit).toBe(10)
    expect(result.active_count).toBe(3)
    expect(result.queued_count).toBe(2)
    // All registered hosts appear in provider_ceilings
    expect(result.provider_ceilings['ssh:host-a']).toBe(20) // from jobs
    expect(result.provider_ceilings['ssh:host-b']).toBe(10) // added (null -> 10)
    expect(result.provider_ceilings['ssh:host-c']).toBe(50) // added
  })

  it('throws when concurrency manager not initialized', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo)

    await expect(service.getSessionConcurrencyStatus('session-123')).rejects.toThrow(
      /ConcurrencyManager is required/
    )
  })
})

describe('ComputeJobWorkflowOwner.handleJobUpdated', () => {
  const job = { job_id: 'job-1', status: 'running' } as import('../../shared/compute').ComputeJob

  it('publishes only through the concurrency manager when configured', () => {
    const managerPublish = vi.fn()
    const fallbackPublish = vi.fn()
    const { repo } = makeRepo()
    const owner = makeOwner(
      makeFakeRunner({
        exitCode: 0,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false
      }),
      repo,
      undefined,
      undefined,
      fallbackPublish,
      undefined,
      undefined,
      { handleJobUpdated: managerPublish } as unknown as ConcurrencyManager
    )

    owner.handleJobUpdated(job)

    expect(managerPublish).toHaveBeenCalledOnce()
    expect(managerPublish).toHaveBeenCalledWith(job)
    expect(fallbackPublish).not.toHaveBeenCalled()
  })

  it('publishes only through the fallback when no concurrency manager is configured', () => {
    const fallbackPublish = vi.fn()
    const { repo } = makeRepo()
    const owner = makeOwner(
      makeFakeRunner({
        exitCode: 0,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false
      }),
      repo,
      undefined,
      undefined,
      fallbackPublish
    )

    owner.handleJobUpdated(job)

    expect(fallbackPublish).toHaveBeenCalledOnce()
    expect(fallbackPublish).toHaveBeenCalledWith(job)
  })
})
