import { describe, expect, it, vi } from 'vitest'

import type { AgentRunProjection } from '../../shared/agent-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { PersistedSideQuestion, SideQuestionRuntimeAdapter } from '../../shared/side-question'
import { SideQuestionOwner } from './side-question-owner'
import type { SideQuestionRepository } from './side-question-repository'

const session: PersistedChatSession = {
  id: 'session-1',
  projectId: 'project-1',
  title: 'Side question test',
  cwd: '/workspace',
  status: 'running',
  createdAt: 1,
  updatedAt: 1,
  messages: [
    {
      id: 'parent-message',
      role: 'user',
      content: 'Analyze the cohort.',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
  ]
}

const parent = {
  projectId: 'project-1',
  sessionId: 'session-1',
  graphId: 'graph-1',
  agentRunId: 'root-run-1',
  frameId: 'root-frame-1',
  promptMessageId: 'parent-message',
  backend: 'codex' as const,
  runtimeSessionId: 'parent-runtime-session',
  runtimeThreadId: 'parent-thread',
  activeTurnId: 'parent-turn',
  lastStableTurnId: 'stable-turn',
  cwd: '/workspace',
  cancellationGeneration: 0
}

const childProjection: AgentRunProjection = {
  id: 'child-run-1',
  graphId: 'graph-1',
  parentAgentRunId: 'root-run-1',
  frameId: 'child-frame-1',
  runKind: 'side-question' as const,
  depth: 1,
  projectId: 'project-1',
  sessionId: 'session-1',
  role: 'side-question',
  workClass: 'analysis' as const,
  runtime: 'codex' as const,
  status: 'queued' as const,
  observedBudget: {},
  outputArtifactIds: [],
  createdAt: 1,
  updatedAt: 1,
  revision: 1
}

const graph = {
  createSideQuestionChild: vi.fn(async () => childProjection),
  startRun: vi.fn(async () => childProjection),
  finishRun: vi.fn(async () => childProjection),
  getGraphProjection: vi.fn(),
  getRunProjection: vi.fn(),
  listSessionSideQuestionRuns: vi.fn(async () => [])
}

const repository = (): {
  store: Map<string, PersistedSideQuestion>
  value: SideQuestionRepository
} => {
  const store = new Map<string, PersistedSideQuestion>()
  const value: SideQuestionRepository = {
    create: async (input) => {
      const row = {
        ...input,
        lifecycle: input.lifecycle ?? 'preparing',
        updatedAt: input.createdAt
      }
      store.set(row.id, row)
      return row
    },
    get: async (_projectId, _sessionId, id) => store.get(id),
    listForSession: async (_projectId, sessionId) =>
      [...store.values()].filter((row) => row.sessionId === sessionId),
    transition: async (_projectId, _sessionId, id, lifecycle, update = {}) => {
      const current = store.get(id)
      if (!current) throw new Error('side_question_missing')
      const next = {
        ...current,
        ...update,
        lifecycle,
        updatedAt: current.updatedAt + 1
      }
      store.set(id, next)
      return next
    }
  }
  return { store, value }
}

const deferred = <Value>(): {
  promise: Promise<Value>
  resolve(value: Value): void
  reject(error: unknown): void
} => {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const createOwner = (
  adapter: SideQuestionRuntimeAdapter,
  repo = repository(),
  overrides: Partial<ConstructorParameters<typeof SideQuestionOwner>[0]> = {}
): { owner: SideQuestionOwner; store: Map<string, PersistedSideQuestion> } => ({
  owner: new SideQuestionOwner({
    graph,
    sessions: {
      projectIdForSession: async () => 'project-1',
      loadSession: async () => session,
      assertSessionAvailable: async () => undefined
    },
    parentResolver: async () => parent,
    adapters: { codex: adapter, opencode: adapter },
    repository: repo.value,
    requestApproval: async () => true,
    idFactory: () => 'side-question-1',
    now: () => 10,
    ...overrides
  }),
  store: repo.store
})

describe('SideQuestionOwner', () => {
  it('cancels a live child through its signal and records terminal cleanup only after close', async () => {
    const run = deferred<string>()
    const cancel = vi.fn(async () => undefined)
    const close = vi.fn(async () => undefined)
    const adapter: SideQuestionRuntimeAdapter = {
      backend: 'codex',
      create: async () => ({
        runtimeSessionId: 'child-runtime',
        runtimeThreadId: 'child-thread',
        run: async () => run.promise,
        cancel,
        close
      })
    }
    const { owner, store } = createOwner(adapter)

    const admitted = await owner.ask({
      sessionId: 'session-1',
      question: 'What assumption is fragile?'
    })
    expect(admitted.status).toBe('accepted')
    await vi.waitFor(() => expect(store.get('side-question-1')?.lifecycle).toBe('running'))

    await expect(owner.cancel('session-1', 'side-question-1')).resolves.toMatchObject({
      lifecycle: 'running'
    })
    await vi.waitFor(() => expect(store.get('side-question-1')?.lifecycle).toBe('cancelled'))
    await vi.waitFor(() => expect(graph.finishRun).toHaveBeenCalled())

    expect(cancel).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(store.get('side-question-1')).toMatchObject({
      lifecycle: 'cancelled',
      runtimeLinkClosed: true,
      runtimeDisposed: true
    })
    expect(graph.finishRun).toHaveBeenCalledWith(
      'child-run-1',
      'cancelled',
      expect.objectContaining({ safeFailureCode: 'side_question_cancelled' })
    )
  })

  it('does not claim cleanup when the ephemeral runtime close fails', async () => {
    const adapter: SideQuestionRuntimeAdapter = {
      backend: 'codex',
      create: async () => ({
        runtimeSessionId: 'child-runtime',
        run: async () => 'A bounded answer.',
        cancel: async () => undefined,
        close: async () => {
          throw new Error('side_question_cleanup_failed')
        }
      })
    }
    const { owner, store } = createOwner(adapter)

    await expect(
      owner.ask({ sessionId: 'session-1', question: 'What assumption is fragile?' })
    ).resolves.toMatchObject({ status: 'accepted' })
    await vi.waitFor(() => expect(store.get('side-question-1')?.lifecycle).toBe('blocked'))

    expect(store.get('side-question-1')).toMatchObject({
      lifecycle: 'blocked',
      runtimeLinkClosed: false,
      runtimeDisposed: false,
      safeFailureCode: 'side_question_cleanup_failed'
    })
    expect(graph.finishRun).toHaveBeenCalledWith(
      'child-run-1',
      'blocked',
      expect.objectContaining({ safeFailureCode: 'side_question_cleanup_failed' })
    )
  })

  it('still closes the runtime when cancellation reports an error', async () => {
    const close = vi.fn(async () => undefined)
    const adapter: SideQuestionRuntimeAdapter = {
      backend: 'codex',
      create: async () => ({
        runtimeSessionId: 'child-runtime',
        run: async () => 'A bounded answer.',
        cancel: async () => {
          throw new Error('side_question_cleanup_failed')
        },
        close
      })
    }
    const { owner, store } = createOwner(adapter)

    await expect(
      owner.ask({ sessionId: 'session-1', question: 'What assumption is fragile?' })
    ).resolves.toMatchObject({ status: 'accepted' })
    await vi.waitFor(() => expect(store.get('side-question-1')?.lifecycle).toBe('blocked'))

    expect(close).toHaveBeenCalledOnce()
    expect(store.get('side-question-1')).toMatchObject({
      lifecycle: 'blocked',
      runtimeLinkClosed: false,
      runtimeDisposed: false
    })
  })

  it('declines single-use approval without creating a provider runtime', async () => {
    const create = vi.fn()
    const { owner, store } = createOwner({ backend: 'codex', create }, repository(), {
      requestApproval: async () => false
    })

    await expect(
      owner.ask({ sessionId: 'session-1', question: 'What assumption is fragile?' })
    ).resolves.toMatchObject({ status: 'accepted' })
    await vi.waitFor(() => expect(store.get('side-question-1')?.lifecycle).toBe('cancelled'))

    expect(create).not.toHaveBeenCalled()
    expect(graph.finishRun).toHaveBeenCalledWith(
      'child-run-1',
      'cancelled',
      expect.objectContaining({ safeFailureCode: 'side_question_approval_declined' })
    )
  })

  it('blocks parent drift after approval without creating a provider runtime', async () => {
    const create = vi.fn()
    let resolution = 0
    const { owner, store } = createOwner({ backend: 'codex', create }, repository(), {
      parentResolver: async () => ({
        ...parent,
        cancellationGeneration: resolution++ === 0 ? 0 : 1
      })
    })

    await owner.ask({ sessionId: 'session-1', question: 'What assumption is fragile?' })
    await vi.waitFor(() => expect(store.get('side-question-1')?.lifecycle).toBe('blocked'))

    expect(create).not.toHaveBeenCalled()
    expect(store.get('side-question-1')?.safeFailureCode).toBe('side_question_parent_drift')
  })

  it('cancels every non-terminal child for a deleted or cancelled parent Session', async () => {
    const run = deferred<string>()
    const cancel = vi.fn(async () => undefined)
    const close = vi.fn(async () => undefined)
    const { owner, store } = createOwner({
      backend: 'codex',
      create: async () => ({
        runtimeSessionId: 'child-runtime',
        run: async () => run.promise,
        cancel,
        close
      })
    })

    await owner.ask({ sessionId: 'session-1', question: 'What assumption is fragile?' })
    await vi.waitFor(() => expect(store.get('side-question-1')?.lifecycle).toBe('running'))
    await owner.cancelSession('session-1')
    await vi.waitFor(() => expect(store.get('side-question-1')?.lifecycle).toBe('cancelled'))

    expect(cancel).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('reconciles orphan runs and blocks durable pre-dispatch cards without replay', async () => {
    const repo = repository()
    const create = vi.fn()
    const recoveryGraph = {
      ...graph,
      listSessionSideQuestionRuns: vi.fn(async () => [{ ...childProjection, id: 'orphan-run' }]),
      getRunProjection: vi.fn(async () => {
        throw new Error('run_not_found')
      }),
      finishRun: vi.fn(async () => childProjection)
    }
    await repo.value.create({
      id: 'side-question-restart',
      projectId: 'project-1',
      sessionId: 'session-1',
      parentGraphId: 'graph-1',
      parentAgentRunId: 'root-run-1',
      childAgentRunId: 'child-run-restart',
      parentFrameId: 'root-frame-1',
      childFrameId: 'child-frame-restart',
      parentPromptMessageId: 'parent-message',
      runtimeSessionId: 'runtime-restart',
      backend: 'codex',
      ephemeral: true,
      sandbox: 'read-only',
      context: { messages: [], references: [], truncated: false },
      question: 'Was this dispatched?',
      createdAt: 1
    })
    await repo.value.transition(
      'project-1',
      'session-1',
      'side-question-restart',
      'awaiting-approval'
    )
    const { owner } = createOwner({ backend: 'codex', create }, repo, { graph: recoveryGraph })

    await owner.recover([{ ...session, sideQuestions: [...repo.store.values()] }])

    expect(create).not.toHaveBeenCalled()
    expect(repo.store.get('side-question-restart')).toMatchObject({
      lifecycle: 'blocked',
      safeFailureCode: 'side_question_interrupted_before_dispatch'
    })
    expect(recoveryGraph.finishRun).toHaveBeenCalledWith(
      'orphan-run',
      'blocked',
      expect.objectContaining({ safeFailureCode: 'side_question_card_missing' })
    )
  })
})
