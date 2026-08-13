import { describe, expect, it, vi } from 'vitest'

import type { AgentRuntimePort } from '../agent-runtime'
import type { PersistedChatMessage, PersistedChatSession } from '../../shared/session-persistence'
import type { UploadedAttachment } from '../../shared/uploads'
import type {
  MessageDeliveryProjection,
  MessageDeliveryRequest,
  MessageDeliveryLifecycle,
  MessageDeliveryRendererRequest
} from '../../shared/message-delivery'
import type { MessageDeliveryJournal } from './delivery-journal'
import {
  MessageDeliveryOwner,
  type ActiveTurnSnapshot,
  type DeliveryOwnerOptions,
  type RuntimeAdapter
} from './message-delivery-owner'

const session = {
  id: 'session-1',
  projectId: 'project-1',
  title: 'Delivery test',
  cwd: '/workspace',
  status: 'running',
  messages: [],
  createdAt: 1,
  updatedAt: 1
} as unknown as PersistedChatSession

const snapshot = (overrides: Partial<ActiveTurnSnapshot> = {}): ActiveTurnSnapshot => ({
  sessionId: 'session-1',
  projectId: 'project-1',
  rootRunId: 'root-run-1',
  backendGeneration: 'generation-1',
  backend: 'codex',
  runtimeThreadId: 'thread-1',
  turnId: 'turn-1',
  promptMessageId: 'prompt-1',
  cancellationGeneration: 0,
  runtimeSessionId: 'runtime-session-1',
  ...overrides
})

const attachment = (overrides: Partial<UploadedAttachment> = {}): UploadedAttachment => ({
  id: 'upload-1',
  sessionId: 'session-1',
  name: 'figure.png',
  originalName: 'figure.png',
  path: '/managed/figure.png',
  mimeType: 'image/png',
  size: 10,
  versionId: 'version-1',
  versionNumber: 1,
  checksum: 'a'.repeat(64),
  ...overrides
})

const message = (id: string): PersistedChatMessage => ({
  id,
  role: 'user',
  content: 'change the threshold',
  status: 'complete',
  eventIds: [],
  createdAt: 2,
  updatedAt: 2
})

const createJournal = (): {
  prepareOnce: MessageDeliveryJournal['prepareOnce']
  reconcile: MessageDeliveryJournal['reconcile']
  transition: MessageDeliveryJournal['transition']
  rows: Map<string, MessageDeliveryProjection>
  transitions: Array<{ id: string; lifecycle: MessageDeliveryLifecycle }>
} => {
  const rows = new Map<string, MessageDeliveryProjection>()
  const transitions: Array<{ id: string; lifecycle: MessageDeliveryLifecycle }> = []
  const prepareOnce: MessageDeliveryJournal['prepareOnce'] = vi.fn(
    async (request: MessageDeliveryRequest) => {
      const row: MessageDeliveryProjection = {
        id: request.id,
        projectId: request.projectId,
        sessionId: request.sessionId,
        messageId: request.messageId,
        targetRootRunId: request.targetRootRunId,
        targetPromptMessageId: request.targetPromptMessageId,
        backend: request.backend,
        runtimeThreadId: request.runtimeThreadId,
        runtimeTurnId: request.runtimeTurnId,
        requested: request.requested,
        resolved: request.requested === 'auto' ? 'side-question' : request.requested,
        source: request.requested === 'auto' ? 'safe-default' : 'explicit',
        routerMetadata: request.routerMetadata,
        sequence: rows.size,
        lifecycle: 'preparing',
        createdAt: 1,
        updatedAt: 1,
        revision: 1
      }
      rows.set(row.id, row)
      return { delivery: row, created: true }
    }
  )
  const reconcile: MessageDeliveryJournal['reconcile'] = vi.fn(async (id: string) => {
    const current = rows.get(id)!
    const next = { ...current, lifecycle: 'queued' as const, revision: current.revision + 1 }
    rows.set(id, next)
    return next
  })
  const transition: MessageDeliveryJournal['transition'] = vi.fn(
    async (
      id: string,
      lifecycle: MessageDeliveryLifecycle,
      options: Partial<
        Pick<MessageDeliveryProjection, 'safeErrorCode' | 'resolved' | 'source'>
      > = {}
    ) => {
      const current = rows.get(id)!
      const next = {
        ...current,
        lifecycle,
        ...(options.safeErrorCode ? { safeErrorCode: options.safeErrorCode } : {}),
        ...(options.resolved ? { resolved: options.resolved } : {}),
        ...(options.source ? { source: options.source } : {}),
        revision: current.revision + 1
      }
      rows.set(id, next)
      transitions.push({ id, lifecycle })
      return next
    }
  )
  return { prepareOnce, reconcile, transition, rows, transitions }
}

const createRuntime = (actions: string[]): RuntimeAdapter => {
  const nativeSteer = vi.fn(async (request) => {
    actions.push(`steer:${request.expectedTurnId}`)
    return {
      appSessionId: request.appSessionId,
      runtimeThreadId: 'thread-1',
      runtimeTurnId: request.expectedTurnId,
      acceptedAt: 3
    }
  })
  const interruptAndAwaitTerminal = vi.fn(async (_sessionId: string, turnId: string) => {
    actions.push(`interrupt:${turnId}`)
  })
  const runtime = {
    capabilities: { nativeSteer },
    interruptAndAwaitTerminal,
    backend: 'codex'
  } as unknown as AgentRuntimePort
  return { backend: 'codex', runtime }
}

const createOwner = (
  overrides: Partial<DeliveryOwnerOptions> = {}
): {
  owner: MessageDeliveryOwner
  journal: ReturnType<typeof createJournal>
  resolveActiveTurn: ReturnType<typeof vi.fn>
  append: ReturnType<typeof vi.fn>
  active: ActiveTurnSnapshot
} => {
  const journal = createJournal()
  const active = snapshot()
  const resolveActiveTurn = vi.fn(async () => active)
  const append = vi.fn(async ({ messageId }: { messageId: string }) => message(messageId))
  const options: DeliveryOwnerOptions = {
    sessions: {
      projectIdForSession: async () => 'project-1',
      loadSession: async () => session,
      assertSessionAvailable: async () => undefined,
      appendUserMessageToInteraction: append
    },
    deliveries: journal,
    resolveActiveTurn,
    runtimeForSnapshot: async () => createRuntime([]),
    idFactory: (() => {
      let index = 0
      return () => `generated-${++index}`
    })(),
    ...overrides
  }
  return { owner: new MessageDeliveryOwner(options), journal, resolveActiveTurn, append, active }
}

const request = (
  requested: 'auto' | 'steer' | 'side-question' | 'stop-and-replace' = 'steer'
): MessageDeliveryRendererRequest => ({
  sessionId: 'session-1',
  content: 'change the threshold',
  requested
})

describe('MessageDeliveryOwner', () => {
  it('rejects renderer authority forgery before loading a Session', async () => {
    const projectIdForSession = vi.fn()
    const { owner } = createOwner({
      sessions: {
        projectIdForSession,
        loadSession: async () => session,
        assertSessionAvailable: async () => undefined,
        appendUserMessageToInteraction: async () => message('unused')
      }
    })

    await expect(
      owner.deliver({ ...request(), projectId: 'forged-project', turnId: 'forged-turn' })
    ).rejects.toThrow(/unsupported authority fields/i)
    expect(projectIdForSession).not.toHaveBeenCalled()
  })

  it('binds Codex steer to the existing root and exact active turn without interrupting it', async () => {
    const actions: string[] = []
    const runtime = createRuntime(actions)
    const fixture = createOwner({ runtimeForSnapshot: async () => runtime })

    const result = await fixture.owner.deliver(request('steer'))

    expect(result.status).toBe('accepted')
    expect(fixture.journal.prepareOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        targetRootRunId: 'root-run-1',
        targetPromptMessageId: 'prompt-1',
        runtimeThreadId: 'thread-1',
        runtimeTurnId: 'turn-1'
      })
    )
    expect(actions).toEqual(['steer:turn-1'])
    expect(runtime.runtime.interruptAndAwaitTerminal).not.toHaveBeenCalled()
  })

  it('reloads Session authority before dispatch and uses the same exact snapshot', async () => {
    const loadSession = vi.fn(async () => session)
    const assertSessionAvailable = vi.fn(async () => undefined)
    const actions: string[] = []
    const runtime = createRuntime(actions)
    const append = vi.fn(async ({ messageId }: { messageId: string }) => message(messageId))
    const fixture = createOwner({
      sessions: {
        projectIdForSession: async () => 'project-1',
        loadSession,
        assertSessionAvailable,
        appendUserMessageToInteraction: append
      },
      runtimeForSnapshot: async () => runtime
    })

    const result = await fixture.owner.deliver(request('steer'))

    expect(result.status).toBe('accepted')
    expect(loadSession).toHaveBeenCalledTimes(3)
    expect(assertSessionAvailable).toHaveBeenCalledTimes(3)
    expect(actions).toEqual(['steer:turn-1'])
    expect(append).toHaveBeenCalledOnce()
  })

  it.each(['session_archived', 'session_deleted'] as const)(
    'blocks after durable persistence when availability changes to %s',
    async (errorCode) => {
      let availabilityChecks = 0
      const runtime = createRuntime([])
      const append = vi.fn(async ({ messageId }: { messageId: string }) => message(messageId))
      const fixture = createOwner({
        sessions: {
          projectIdForSession: async () => 'project-1',
          loadSession: async () => session,
          assertSessionAvailable: vi.fn(async () => {
            availabilityChecks += 1
            if (availabilityChecks === 2) throw new Error(errorCode)
          }),
          appendUserMessageToInteraction: append
        },
        runtimeForSnapshot: async () => runtime
      })

      const result = await fixture.owner.deliver(request('steer'))

      expect(result).toMatchObject({ status: 'blocked', safeErrorCode: errorCode })
      expect(append).toHaveBeenCalledOnce()
      expect(runtime.runtime.capabilities.nativeSteer).not.toHaveBeenCalled()
      expect(fixture.journal.transitions.at(-1)?.lifecycle).toBe('blocked')
    }
  )

  it('blocks a runtime-resolution failure after the Message and journal are durable', async () => {
    const fixture = createOwner({
      runtimeForSnapshot: async () => {
        throw new Error('provider_startup_failed')
      }
    })

    const result = await fixture.owner.deliver(request('steer'))

    expect(result).toMatchObject({ status: 'blocked', safeErrorCode: 'runtime_resolution_failed' })
    expect(fixture.journal.prepareOnce).toHaveBeenCalledOnce()
    expect(fixture.append).toHaveBeenCalledOnce()
    expect(fixture.journal.transitions.at(-1)?.lifecycle).toBe('blocked')
  })

  it('persists and dispatches an attachment-only instruction without inventing text', async () => {
    const actions: string[] = []
    const runtime = createRuntime(actions)
    const finalized = attachment()
    const append = vi.fn(
      async (input: { messageId: string; content: string; uploads?: unknown[] }) => ({
        ...message(input.messageId),
        content: input.content,
        ...(input.uploads ? { uploads: input.uploads as PersistedChatMessage['uploads'] } : {})
      })
    )
    const nativeSteer = runtime.runtime.capabilities.nativeSteer!
    const fixture = createOwner({
      sessions: {
        projectIdForSession: async () => 'project-1',
        loadSession: async () => session,
        assertSessionAvailable: async () => undefined,
        appendUserMessageToInteraction: append
      },
      uploads: {
        finalizeSessionUploads: async () => [finalized]
      },
      runtimeForSnapshot: async () => runtime
    })

    const result = await fixture.owner.deliver({
      ...request('steer'),
      content: '',
      attachments: [finalized]
    })

    expect(result.status).toBe('accepted')
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '',
        uploads: expect.arrayContaining([expect.objectContaining({ id: 'upload-1' })])
      })
    )
    expect(nativeSteer).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedTurnId: 'turn-1',
        input: [{ kind: 'image', source: 'path', value: '/managed/figure.png', detail: 'auto' }]
      })
    )
  })

  it('marks a turn-change race stale and never retargets the newer turn', async () => {
    const newer = snapshot({ turnId: 'turn-2', promptMessageId: 'prompt-2' })
    const runtime = createRuntime([])
    const fixture = createOwner({
      resolveActiveTurn: vi
        .fn()
        .mockResolvedValueOnce(fixtureSnapshot())
        .mockResolvedValueOnce(fixtureSnapshot())
        .mockResolvedValueOnce(newer),
      runtimeForSnapshot: async () => runtime
    })

    const result = await fixture.owner.deliver(request('steer'))

    expect(result.status).toBe('stale')
    expect(runtime.runtime.capabilities.nativeSteer).not.toHaveBeenCalled()
    expect(fixture.journal.transitions.at(-1)?.lifecycle).toBe('blocked')
  })

  it('waits for terminal interruption before starting exactly one replacement', async () => {
    const actions: string[] = []
    let release!: () => void
    const terminal = new Promise<void>((resolve) => {
      release = resolve
    })
    const runtime = createRuntime(actions)
    runtime.runtime.interruptAndAwaitTerminal = vi.fn(async () => {
      actions.push('interrupt')
      await terminal
      actions.push('terminal')
    })
    const startReplacement = vi.fn(async () => {
      actions.push('replacement')
    })
    const fixture = createOwner({
      runtimeForSnapshot: async () => ({ ...runtime, startReplacement }) as RuntimeAdapter,
      resolveActiveTurn: vi.fn(async () => fixtureSnapshot())
    })
    const pending = fixture.owner.deliver(request('stop-and-replace'))
    await Promise.resolve()
    await Promise.resolve()
    expect(startReplacement).not.toHaveBeenCalled()
    release()

    await expect(pending).resolves.toMatchObject({ status: 'accepted' })
    expect(actions).toEqual(['interrupt', 'terminal', 'replacement'])
    expect(startReplacement).toHaveBeenCalledOnce()
  })

  it('uses safe side-question semantics when Auto classification fails', async () => {
    const runtime = createRuntime([])
    const fixture = createOwner({
      runtimeForSnapshot: async () => runtime,
      resolveRouter: async () => {
        throw new Error('classifier unavailable')
      }
    })

    const result = await fixture.owner.deliver(request('auto'))

    expect(result.status).toBe('blocked')
    expect(result.safeErrorCode).toBe('side_question_unavailable')
    expect(runtime.runtime.capabilities.nativeSteer).not.toHaveBeenCalled()
    expect(fixture.append).toHaveBeenCalledOnce()
  })

  it('blocks before persistence or provider side effects when upload finalization fails', async () => {
    const runtime = createRuntime([])
    const fixture = createOwner({
      runtimeForSnapshot: async () => runtime,
      uploads: {
        finalizeSessionUploads: async () => {
          throw new Error('upload_finalization_failed')
        }
      }
    })

    const result = await fixture.owner.deliver({ ...request(), attachments: [attachment()] })

    expect(result).toMatchObject({ status: 'blocked', safeErrorCode: 'upload_finalization_failed' })
    expect(fixture.journal.prepareOnce).not.toHaveBeenCalled()
    expect(fixture.append).not.toHaveBeenCalled()
    expect(runtime.runtime.capabilities.nativeSteer).not.toHaveBeenCalled()
  })

  it('returns stale for idle active-turn controls so ordinary Send remains the only idle path', async () => {
    const fixture = createOwner({ resolveActiveTurn: async () => undefined })

    const result = await fixture.owner.deliver(request('steer'))

    expect(result).toEqual({
      status: 'stale',
      sessionId: 'session-1',
      safeErrorCode: 'stale_active_turn'
    })
    expect(fixture.journal.prepareOnce).not.toHaveBeenCalled()
    expect(fixture.append).not.toHaveBeenCalled()
  })
})

// Kept separate from the fixture object so tests that change resolver sequences do not mutate the
// owner's private options. The production owner treats each resolver result as immutable authority.
const fixtureSnapshot = (): ActiveTurnSnapshot => snapshot()
