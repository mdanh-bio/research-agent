import { describe, expect, it, vi } from 'vitest'

import type { AcpPromptRequest } from '../../shared/acp'
import type { PersistedChatMessage, PersistedChatSession } from '../../shared/session-persistence'
import type {
  MessageDeliveryLifecycle,
  MessageDeliveryProjection,
  MessageDeliveryRequest,
  MessageDeliveryRendererRequest
} from '../../shared/message-delivery'
import type { UploadedAttachment } from '../../shared/uploads'
import type { MessageDeliveryJournal } from './delivery-journal'
import {
  OpenCodeQueuedDeliveryOwner,
  type OpenCodeQueuedDeliveryOwnerOptions
} from './opencode-queued-delivery-owner'
import type { ActiveTurnSnapshot } from './message-delivery-owner'

const sessionId = 'session-1'
const projectId = 'project-1'
const promptMessageId = 'prompt-1'

const activeSnapshot: ActiveTurnSnapshot = Object.freeze({
  sessionId,
  projectId,
  rootRunId: 'root-run-1',
  backendGeneration: 'runtime-generation-1',
  backend: 'opencode',
  runtimeThreadId: 'opencode-thread-1',
  turnId: 'turn-1',
  promptMessageId,
  cancellationGeneration: 0,
  runtimeSessionId: sessionId
})

const message = (id: string, content: string): PersistedChatMessage => ({
  id,
  role: 'user',
  content,
  status: 'complete',
  eventIds: [],
  createdAt: 2,
  updatedAt: 2
})

const createSession = (): PersistedChatSession =>
  ({
    id: sessionId,
    projectId,
    title: 'OpenCode queue',
    cwd: '/workspace',
    status: 'running',
    messages: [],
    activeRun: { promptMessageId, startedAt: 1 },
    createdAt: 1,
    updatedAt: 1
  }) as unknown as PersistedChatSession

type Harness = {
  owner: OpenCodeQueuedDeliveryOwner
  deliveries: ReturnType<typeof createDeliveryStore>
  session: PersistedChatSession
  active: { value: boolean }
  runtime: {
    sent: AcpPromptRequest[]
    cancelled: ReturnType<typeof vi.fn>
    accepted: boolean
    acceptanceError?: Error
  }
}

const createDeliveryStore = (
  storeOptions: { throwAfter?: MessageDeliveryLifecycle } = {}
): {
  prepareOnce: MessageDeliveryJournal['prepareOnce']
  reconcile: MessageDeliveryJournal['reconcile']
  transition: MessageDeliveryJournal['transition']
  listForSession: MessageDeliveryJournal['listForSession']
  get: MessageDeliveryJournal['get']
  claimNextOpenCodeQueued: MessageDeliveryJournal['claimNextOpenCodeQueued']
  recoverOpenCodeDispatches: MessageDeliveryJournal['recoverOpenCodeDispatches']
  listPendingOpenCodeSessionIds: MessageDeliveryJournal['listPendingOpenCodeSessionIds']
  rows: Map<string, MessageDeliveryProjection>
  transitions: Array<{ id: string; lifecycle: MessageDeliveryLifecycle }>
} => {
  const rows = new Map<string, MessageDeliveryProjection>()
  const transitions: Array<{ id: string; lifecycle: MessageDeliveryLifecycle }> = []

  const clone = (row: MessageDeliveryProjection): MessageDeliveryProjection => ({ ...row })
  const pending = new Set<MessageDeliveryLifecycle>([
    'preparing',
    'ready',
    'queued',
    'dispatching',
    'accepted',
    'dispatched'
  ])
  const passable = new Set<MessageDeliveryLifecycle>(['completed', 'cancelled', 'abandoned'])

  const prepareOnce: MessageDeliveryJournal['prepareOnce'] = vi.fn(
    async (request: MessageDeliveryRequest) => {
      if (
        request.backend === 'opencode' &&
        (request.requested === 'steer' || request.requested === 'stop-and-replace') &&
        [...rows.values()].filter((row) => pending.has(row.lifecycle)).length >=
          (request.maxPendingQueueItems ?? 8)
      ) {
        throw new Error('queue_overflow')
      }
      const existing = [...rows.values()].find(
        (row) => row.id === request.id || row.messageId === request.messageId
      )
      if (existing) return { delivery: clone(existing), created: false }
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
        sequence: rows.size,
        lifecycle: 'preparing',
        createdAt: 1,
        updatedAt: 1,
        revision: 1
      }
      rows.set(row.id, row)
      return { delivery: clone(row), created: true }
    }
  )

  const reconcile: MessageDeliveryJournal['reconcile'] = vi.fn(
    async (id: string, state: { hasSessionMessage: boolean }) => {
      const current = rows.get(id)!
      const next: MessageDeliveryProjection = {
        ...current,
        lifecycle: state.hasSessionMessage ? 'queued' : 'abandoned',
        ...(state.hasSessionMessage ? {} : { safeErrorCode: 'session_message_missing' }),
        revision: current.revision + 1
      }
      rows.set(id, next)
      transitions.push({ id, lifecycle: next.lifecycle })
      return clone(next)
    }
  )

  const transition: MessageDeliveryJournal['transition'] = vi.fn(
    async (
      id: string,
      lifecycle: MessageDeliveryLifecycle,
      transitionOptions: Parameters<MessageDeliveryJournal['transition']>[2] = {}
    ) => {
      const current = rows.get(id)!
      if (
        transitionOptions.expectedRevision !== undefined &&
        transitionOptions.expectedRevision !== current.revision
      ) {
        throw new Error('revision changed')
      }
      const next: MessageDeliveryProjection = {
        ...current,
        lifecycle,
        ...(transitionOptions.safeErrorCode
          ? { safeErrorCode: transitionOptions.safeErrorCode }
          : {}),
        ...(transitionOptions.runtimeThreadId
          ? { runtimeThreadId: transitionOptions.runtimeThreadId }
          : {}),
        ...(transitionOptions.runtimeTurnId
          ? { runtimeTurnId: transitionOptions.runtimeTurnId }
          : {}),
        revision: current.revision + 1
      }
      rows.set(id, next)
      transitions.push({ id, lifecycle })
      if (storeOptions.throwAfter === lifecycle) throw new Error(`crash_after_${lifecycle}`)
      return clone(next)
    }
  )

  const listForSession: MessageDeliveryJournal['listForSession'] = vi.fn(async (id: string) =>
    [...rows.values()]
      .filter((row) => row.sessionId === id)
      .sort((left, right) => left.sequence - right.sequence)
      .map(clone)
  )

  const get: MessageDeliveryJournal['get'] = vi.fn(async (id: string) => clone(rows.get(id)!))

  const claimNextOpenCodeQueued: MessageDeliveryJournal['claimNextOpenCodeQueued'] = vi.fn(
    async (id: string) => {
      const ordered = [...rows.values()]
        .filter((row) => row.sessionId === id)
        .sort((left, right) => left.sequence - right.sequence)
      const first = ordered.find((row) => !passable.has(row.lifecycle))
      if (!first || first.lifecycle !== 'queued') return undefined
      const claimed = { ...first, lifecycle: 'dispatching' as const, revision: first.revision + 1 }
      rows.set(claimed.id, claimed)
      transitions.push({ id: claimed.id, lifecycle: 'dispatching' })
      return clone(claimed)
    }
  )

  const recoverOpenCodeDispatches: MessageDeliveryJournal['recoverOpenCodeDispatches'] = vi.fn(
    async (id?: string) => {
      const recovered: MessageDeliveryProjection[] = []
      for (const row of [...rows.values()]) {
        if (
          row.backend !== 'opencode' ||
          !['dispatching', 'accepted', 'dispatched'].includes(row.lifecycle) ||
          (id !== undefined && row.sessionId !== id)
        ) {
          continue
        }
        const blocked = {
          ...row,
          lifecycle: 'blocked' as const,
          safeErrorCode: 'dispatch_ambiguous',
          revision: row.revision + 1
        }
        rows.set(row.id, blocked)
        recovered.push(clone(blocked))
      }
      return recovered
    }
  )

  const listPendingOpenCodeSessionIds: MessageDeliveryJournal['listPendingOpenCodeSessionIds'] =
    vi.fn(async () => [
      ...new Set(
        [...rows.values()].filter((row) => pending.has(row.lifecycle)).map((row) => row.sessionId)
      )
    ])

  return {
    prepareOnce,
    reconcile,
    transition,
    listForSession,
    get,
    claimNextOpenCodeQueued,
    recoverOpenCodeDispatches,
    listPendingOpenCodeSessionIds,
    rows,
    transitions
  }
}

const request = (
  requested: 'steer' | 'stop-and-replace' = 'steer',
  content = requested
): MessageDeliveryRendererRequest => ({
  sessionId,
  content,
  requested
})

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

const deferred = <Value = void>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

const createHarness = (
  overrides: Partial<{
    session: PersistedChatSession
    active: boolean
    parentState: 'active' | 'terminal' | 'missing' | 'graph-sync-failed'
    runtimeReady: boolean
    acceptance: boolean
    acceptanceError: Error
    appendError: Error
    uploadError: Error
    interactionRelease: Promise<void>
    sessionAvailabilityError: Error
    deliveryThrowAfter: MessageDeliveryLifecycle
  }> = {}
): Harness => {
  const session = overrides.session ?? createSession()
  const active = { value: overrides.active ?? true }
  const deliveries = createDeliveryStore({ throwAfter: overrides.deliveryThrowAfter })
  const sent: AcpPromptRequest[] = []
  const cancelled = vi.fn(async () => {
    active.value = false
    session.activeRun = undefined
  })
  const runtime = {
    sent,
    cancelled,
    accepted: overrides.acceptance ?? true,
    ...(overrides.acceptanceError ? { acceptanceError: overrides.acceptanceError } : {})
  }
  const options: OpenCodeQueuedDeliveryOwnerOptions = {
    sessions: {
      projectIdForSession: async () => projectId,
      loadSession: async () => session,
      assertSessionAvailable: async () => {
        if (overrides.sessionAvailabilityError) throw overrides.sessionAvailabilityError
      },
      appendUserMessageToInteraction: async ({ messageId, content }) => {
        if (overrides.appendError) throw overrides.appendError
        const persisted = message(messageId, content)
        session.messages = [...session.messages, persisted]
        return persisted
      }
    },
    deliveries,
    resolveActiveTurn: async () => (active.value ? activeSnapshot : undefined),
    resolveParentDeliveryState: async () => overrides.parentState ?? 'terminal',
    runtime: {
      isSessionReady: () => overrides.runtimeReady ?? true,
      sendAppContinuationObserved: async (continuation, onProviderPromptAccepted) => {
        sent.push(continuation)
        if (runtime.acceptanceError) throw runtime.acceptanceError
        if (runtime.accepted) onProviderPromptAccepted()
        return undefined
      },
      cancelPrompt: cancelled,
      waitForSessionInteractionRelease: async () => {
        await overrides.interactionRelease
      }
    },
    ...(overrides.uploadError
      ? {
          uploads: {
            finalizeSessionUploads: async (): Promise<UploadedAttachment[]> => {
              throw overrides.uploadError
            }
          }
        }
      : {}),
    idFactory: (() => {
      let index = 0
      return () => `delivery-${++index}`
    })(),
    queueLimit: 2
  }
  const owner = new OpenCodeQueuedDeliveryOwner(options)
  return { owner, deliveries, session, active, runtime }
}

describe('OpenCodeQueuedDeliveryOwner', () => {
  it('persists an active-turn message without cancelling or dispatching the current prompt', async () => {
    const harness = createHarness()

    const result = await harness.owner.deliver({
      ...request(),
      content: 'keep current prompt unchanged'
    })

    expect(result.status).toBe('accepted')
    expect(result.delivery?.lifecycle).toBe('queued')
    expect(harness.session.messages).toHaveLength(1)
    expect(harness.session.activeRun).toEqual({ promptMessageId, startedAt: 1 })
    expect(harness.runtime.cancelled).not.toHaveBeenCalled()
    expect(harness.runtime.sent).toHaveLength(0)
  })

  it('does not dispatch when the durable parent activeRun has not cleared', async () => {
    const harness = createHarness()
    await harness.owner.deliver({ ...request(), content: 'wait for durable terminal state' })
    harness.active.value = false
    harness.owner.onInteractionReleased(sessionId)
    await flush()

    expect(harness.runtime.sent).toHaveLength(0)
    expect((await harness.deliveries.listForSession(sessionId))[0].lifecycle).toBe('queued')
  })

  it('drains multiple queued messages FIFO with one suppressed continuation per message', async () => {
    const harness = createHarness()
    await harness.owner.deliver({ ...request(), content: 'first' })
    await harness.owner.deliver({ ...request(), content: 'second' })

    harness.active.value = false
    harness.session.activeRun = undefined
    harness.owner.onInteractionReleased(sessionId)
    await vi.waitFor(() => expect(harness.runtime.sent).toHaveLength(2))

    expect(harness.runtime.sent.map(({ text }) => text)).toEqual(['first', 'second'])
    expect(
      harness.runtime.sent.every(({ suppressUserMessage }) => suppressUserMessage === true)
    ).toBe(true)
    expect(
      (await harness.deliveries.listForSession(sessionId)).map(({ lifecycle }) => lifecycle)
    ).toEqual(['completed', 'completed'])
  })

  it('does not dispatch after a failed or blocked FIFO item', async () => {
    const harness = createHarness()
    await harness.owner.deliver({ ...request(), content: 'blocked first' })
    await harness.owner.deliver({ ...request(), content: 'must wait' })
    const first = [...harness.deliveries.rows.values()].sort(
      (left, right) => left.sequence - right.sequence
    )[0]
    await harness.deliveries.transition(first.id, 'blocked', {
      expectedRevision: first.revision,
      safeErrorCode: 'dispatch_ambiguous'
    })

    harness.active.value = false
    harness.session.activeRun = undefined
    harness.owner.onInteractionReleased(sessionId)
    await flush()

    expect(harness.runtime.sent).toHaveLength(0)
    expect((await harness.deliveries.listForSession(sessionId))[1].lifecycle).toBe('queued')
  })

  it('rejects overflow before accepting the additional message', async () => {
    const harness = createHarness()
    await harness.owner.deliver({ ...request(), content: 'one' })
    await harness.owner.deliver({ ...request(), content: 'two' })

    const result = await harness.owner.deliver({ ...request(), content: 'overflow' })

    expect(result).toMatchObject({ status: 'blocked', safeErrorCode: 'queue_overflow' })
    expect(harness.session.messages.map(({ content }) => content)).toEqual(['one', 'two'])
    expect(harness.deliveries.rows).toHaveLength(2)
  })

  it('orders Stop and replace as cancel, release, then exactly one continuation', async () => {
    const harness = createHarness()
    const order: string[] = []
    harness.runtime.cancelled.mockImplementationOnce(async () => {
      order.push('cancel')
      harness.active.value = false
      harness.session.activeRun = undefined
    })
    const originalSend = harness.runtime.sent
    const owner = harness.owner
    const result = await owner.deliver({ ...request('stop-and-replace'), content: 'replacement' })
    order.push('admitted')
    owner.onInteractionReleased(sessionId)
    await vi.waitFor(() => expect(originalSend).toHaveLength(1))
    order.push('continuation')

    expect(result.status).toBe('accepted')
    expect(harness.runtime.cancelled).toHaveBeenCalledOnce()
    expect(order).toEqual(['cancel', 'admitted', 'continuation'])
    expect(originalSend[0]).toMatchObject({ text: 'replacement', suppressUserMessage: true })
  })

  it('keeps a queued row across restart when it was never claimed', async () => {
    const harness = createHarness()
    await harness.owner.deliver({ ...request(), content: 'survives restart' })
    harness.active.value = false
    harness.session.activeRun = undefined

    await harness.owner.recover()
    await vi.waitFor(() => expect(harness.runtime.sent).toHaveLength(1))

    expect(harness.runtime.sent[0].text).toBe('survives restart')
    expect((await harness.deliveries.listForSession(sessionId))[0].lifecycle).toBe('completed')
  })

  it('blocks an ambiguous dispatch after claim and never replays it on readiness', async () => {
    const harness = createHarness({ acceptance: false })
    await harness.owner.deliver({ ...request(), content: 'ambiguous' })
    harness.active.value = false
    harness.session.activeRun = undefined
    harness.owner.onInteractionReleased(sessionId)
    await vi.waitFor(() =>
      expect([...harness.deliveries.rows.values()][0]?.lifecycle).toBe('blocked')
    )

    const row = (await harness.deliveries.listForSession(sessionId))[0]
    expect(row.safeErrorCode).toBe('dispatch_ambiguous')
    await harness.owner.recover()
    harness.owner.onSessionReady(sessionId)
    await flush()
    expect(harness.runtime.sent).toHaveLength(1)
  })

  it('blocks a provider dispatch whose acceptance transition fails and never replays it', async () => {
    const harness = createHarness({ deliveryThrowAfter: 'accepted' })
    await harness.owner.deliver({ ...request(), content: 'acceptance boundary' })
    harness.active.value = false
    harness.session.activeRun = undefined
    harness.owner.onInteractionReleased(sessionId)

    await vi.waitFor(() =>
      expect([...harness.deliveries.rows.values()][0]?.lifecycle).toBe('blocked')
    )
    expect([...harness.deliveries.rows.values()][0]?.safeErrorCode).toBe('dispatch_ambiguous')
    expect(harness.runtime.sent).toHaveLength(1)
    await harness.owner.recover()
    harness.owner.onSessionReady(sessionId)
    await flush()
    expect(harness.runtime.sent).toHaveLength(1)
  })

  it('keeps a durably completed row terminal when completion acknowledgement is lost', async () => {
    const harness = createHarness({ deliveryThrowAfter: 'completed' })
    await harness.owner.deliver({ ...request(), content: 'completion boundary' })
    harness.active.value = false
    harness.session.activeRun = undefined
    harness.owner.onInteractionReleased(sessionId)

    await vi.waitFor(() => expect(harness.runtime.sent).toHaveLength(1))
    const row = [...harness.deliveries.rows.values()][0]
    expect(row.lifecycle).toBe('completed')
  })

  it('retains a parent-recovery barrier across Session readiness callbacks', async () => {
    const harness = createHarness()
    await harness.owner.deliver({ ...request(), content: 'requires recovery' })
    harness.owner.onParentCancellationRequested(sessionId)
    harness.owner.onSessionReady(sessionId)
    await flush()

    expect(harness.runtime.sent).toHaveLength(0)
  })

  it('re-runs a drain when durable parent completion arrives during an existing drain', async () => {
    const release = deferred<void>()
    const harness = createHarness({ interactionRelease: release.promise })
    await harness.owner.deliver({ ...request(), content: 'wake after durable completion' })

    harness.active.value = false
    harness.session.activeRun = undefined
    harness.owner.onSessionPersistenceChanged(sessionId)
    release.resolve()

    await vi.waitFor(() => expect(harness.runtime.sent).toHaveLength(1))
    expect((await harness.deliveries.listForSession(sessionId))[0].lifecycle).toBe('completed')
  })

  it('wakes a queued drain when the routed parent run becomes terminal after release', async () => {
    const harness = createHarness()
    await harness.owner.deliver({ ...request(), content: 'wake after routed finalization' })

    harness.active.value = false
    harness.session.activeRun = undefined
    harness.owner.onParentRunFinalized(sessionId)

    await vi.waitFor(() => expect(harness.runtime.sent).toHaveLength(1))
    expect(harness.runtime.sent[0].text).toBe('wake after routed finalization')
  })

  it('keeps cancellation and deletion barriers fail-closed', async () => {
    const cancelled = createHarness()
    await cancelled.owner.deliver(request())
    cancelled.active.value = false
    cancelled.session.activeRun = undefined
    cancelled.owner.onParentCancellationRequested(sessionId)
    cancelled.owner.onInteractionReleased(sessionId)
    await flush()
    expect(cancelled.runtime.sent).toHaveLength(0)
    expect((await cancelled.deliveries.listForSession(sessionId))[0].lifecycle).toBe('queued')

    const deleted = createHarness()
    await deleted.owner.deliver(request())
    deleted.owner.onSessionDeleted(sessionId)
    await vi.waitFor(() =>
      expect([...deleted.deliveries.rows.values()][0]?.lifecycle).toBe('blocked')
    )
    expect([...deleted.deliveries.rows.values()][0]?.safeErrorCode).toBe('session_deleted')
    expect(deleted.runtime.sent).toHaveLength(0)

    const archived = createHarness({ sessionAvailabilityError: new Error('session_archived') })
    const archivedResult = await archived.owner.deliver(request())
    expect(archivedResult).toMatchObject({ status: 'blocked', safeErrorCode: 'session_archived' })
    expect(archived.runtime.sent).toHaveLength(0)
  })

  it('blocks stale parent bindings and graph-sync failures before provider dispatch', async () => {
    const stale = createHarness({ parentState: 'missing' })
    await stale.owner.deliver(request())
    stale.active.value = false
    stale.session.activeRun = undefined
    stale.owner.onInteractionReleased(sessionId)
    await vi.waitFor(() => expect([...stale.deliveries.rows.values()][0].lifecycle).toBe('blocked'))
    expect([...stale.deliveries.rows.values()][0].safeErrorCode).toBe('stale_parent_binding')
    expect(stale.runtime.sent).toHaveLength(0)

    const syncFailure = createHarness({ parentState: 'graph-sync-failed' })
    await syncFailure.owner.deliver(request())
    syncFailure.active.value = false
    syncFailure.session.activeRun = undefined
    syncFailure.owner.onInteractionReleased(sessionId)
    await vi.waitFor(() =>
      expect([...syncFailure.deliveries.rows.values()][0].lifecycle).toBe('blocked')
    )
    expect([...syncFailure.deliveries.rows.values()][0].safeErrorCode).toBe('graph_sync_failed')
    expect(syncFailure.runtime.sent).toHaveLength(0)
  })

  it('blocks upload and persistence failures before any continuation', async () => {
    const uploadOwner = createHarness({ uploadError: new Error('upload_finalization_failed') })
    const uploadResult = await uploadOwner.owner.deliver({
      ...request(),
      attachments: [
        {
          id: 'upload-1',
          sessionId,
          name: 'input.txt',
          originalName: 'input.txt',
          path: '/workspace/input.txt',
          mimeType: 'text/plain',
          size: 1,
          versionId: 'version-1',
          versionNumber: 1,
          checksum: 'a'.repeat(64)
        }
      ]
    })
    expect(uploadResult).toMatchObject({
      status: 'blocked',
      safeErrorCode: 'upload_finalization_failed'
    })
    expect((await uploadOwner.deliveries.listForSession(sessionId))[0].lifecycle).toBe('abandoned')
    expect(uploadOwner.runtime.sent).toHaveLength(0)

    const persistence = createHarness({ appendError: new Error('persistence_failed') })
    const result = await persistence.owner.deliver(request())
    expect(result).toMatchObject({ status: 'blocked', safeErrorCode: 'persistence_failed' })
    expect((await persistence.deliveries.listForSession(sessionId))[0].lifecycle).toBe('abandoned')
  })

  it('blocks the FIFO head when parent Artifact finalization fails and never drains later items', async () => {
    const harness = createHarness()
    await harness.owner.deliver({ ...request(), content: 'first after artifact failure' })
    await harness.owner.deliver({ ...request(), content: 'later item' })

    await harness.owner.onArtifactFinalizationFailed(sessionId)

    expect(
      (await harness.deliveries.listForSession(sessionId)).map(({ lifecycle }) => lifecycle)
    ).toEqual(['blocked', 'queued'])
    expect((await harness.deliveries.listForSession(sessionId))[0].safeErrorCode).toBe(
      'artifact_finalization_failed'
    )

    harness.active.value = false
    harness.session.activeRun = undefined
    harness.owner.onSessionReady(sessionId)
    harness.owner.onInteractionReleased(sessionId)
    await flush()

    expect(harness.runtime.sent).toHaveLength(0)
  })
})
