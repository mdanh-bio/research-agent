import { randomUUID } from 'node:crypto'

import type { AcpPromptRequest } from '../../shared/acp'
import {
  toRuntimeUploadedAttachment,
  toPersistedUploadedAttachment,
  type PersistedUploadedAttachment,
  type UploadedAttachment
} from '../../shared/uploads'
import type { PersistedChatMessage, PersistedChatSession } from '../../shared/session-persistence'
import { getActiveConversationContext } from '../../shared/conversation-graph'
import type { FileReference } from '../../shared/artifacts'
import {
  resolveMessageDelivery,
  validateMessageDeliveryRendererRequest,
  type MessageDeliveryAdmissionResult,
  type MessageDeliveryProjection,
  type MessageDeliveryRendererRequest
} from '../../shared/message-delivery'
import { validateMessageParts } from '../../shared/session-persistence'
import { DEFAULT_OPENCODE_QUEUE_LIMIT, type MessageDeliveryJournal } from './delivery-journal'
import type {
  OpenCodeParentDeliveryState,
  OpenCodeParentDeliveryStateInput
} from './opencode-queued-delivery-registry'
import type {
  ActiveTurnResolver,
  ActiveTurnSnapshot,
  DeliveryUploadFinalizer,
  SessionAuthority
} from './message-delivery-owner'

type OpenCodeQueuedRuntime = Readonly<{
  isSessionReady(projectId: string, sessionId: string): boolean
  sendAppContinuationObserved(
    request: AcpPromptRequest,
    onProviderPromptAccepted: () => void
  ): Promise<unknown>
  cancelPrompt(sessionId: string): Promise<unknown>
  waitForSessionInteractionRelease(sessionId: string): Promise<void>
}>

type OpenCodeQueuedDeliveryOwnerOptions = Readonly<{
  sessions: SessionAuthority
  deliveries: Pick<
    MessageDeliveryJournal,
    | 'prepareOnce'
    | 'get'
    | 'reconcile'
    | 'transition'
    | 'listForSession'
    | 'claimNextOpenCodeQueued'
    | 'recoverOpenCodeDispatches'
    | 'listPendingOpenCodeSessionIds'
  >
  resolveActiveTurn: ActiveTurnResolver
  runtime: OpenCodeQueuedRuntime
  resolveParentDeliveryState?: (
    input: OpenCodeParentDeliveryStateInput
  ) => Promise<OpenCodeParentDeliveryState>
  uploads?: DeliveryUploadFinalizer
  idFactory?: () => string
  queueLimit?: number
}>

const TERMINAL_LIFECYCLES = new Set(['completed', 'failed', 'cancelled', 'blocked', 'abandoned'])

const FIFO_PASSABLE_LIFECYCLES = new Set(['completed', 'cancelled', 'abandoned'])

const safeErrorCode = (error: unknown, fallback = 'delivery_failed'): string => {
  if (error instanceof Error && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(error.message)) {
    return error.message
  }
  return fallback
}

const sameSnapshot = (left: ActiveTurnSnapshot, right: ActiveTurnSnapshot): boolean =>
  left.sessionId === right.sessionId &&
  left.projectId === right.projectId &&
  left.rootRunId === right.rootRunId &&
  left.backendGeneration === right.backendGeneration &&
  left.backend === right.backend &&
  left.runtimeThreadId === right.runtimeThreadId &&
  left.turnId === right.turnId &&
  left.promptMessageId === right.promptMessageId &&
  left.cancellationGeneration === right.cancellationGeneration &&
  left.runtimeSessionId === right.runtimeSessionId

const runtimeAttachments = (
  message: PersistedChatMessage,
  projectId: string
): UploadedAttachment[] =>
  (message.uploads ?? []).map((attachment) =>
    toRuntimeUploadedAttachment(attachment as PersistedUploadedAttachment, projectId)
  )

const continuationFor = (
  message: PersistedChatMessage,
  projectId: string,
  sessionId: string,
  session: PersistedChatSession
): AcpPromptRequest => ({
  sessionId,
  text: message.content,
  suppressUserMessage: true,
  provenanceContext: session.conversationGraph
    ? getActiveConversationContext(session.conversationGraph, message.id)
    : { promptMessageId: message.id },
  ...(message.turnIntent ? { turnIntent: message.turnIntent } : {}),
  ...(message.parts?.some((part) => part.type === 'skill')
    ? {
        forcedSkillIds: message.parts
          .filter(
            (
              part
            ): part is Extract<
              NonNullable<PersistedChatMessage['parts']>[number],
              { type: 'skill' }
            > => part.type === 'skill'
          )
          .map((part) => part.id)
      }
    : {}),
  ...(message.parts?.some((part) => part.type === 'artifact')
    ? {
        referencedArtifacts: message.parts
          .filter(
            (
              part
            ): part is Extract<
              NonNullable<PersistedChatMessage['parts']>[number],
              { type: 'artifact' }
            > => part.type === 'artifact'
          )
          .map(({ type: _type, ...reference }) => {
            void _type
            return reference as FileReference
          })
      }
    : {}),
  ...(message.uploads?.length ? { attachments: runtimeAttachments(message, projectId) } : {})
})

const isQueuedDelivery = (delivery: MessageDeliveryProjection): boolean =>
  delivery.backend === 'opencode' &&
  (delivery.resolved === 'steer' || delivery.resolved === 'stop-and-replace')

// OpenCode has no native active-turn steering. This owner makes that limitation durable and
// explicit: queue admission is separate from provider dispatch, and only a CAS-claimed row may
// cross the ACP continuation boundary.
export class OpenCodeQueuedDeliveryOwner {
  private readonly idFactory: () => string
  private readonly queueLimit: number
  private readonly inFlight = new Map<string, Promise<MessageDeliveryAdmissionResult>>()
  private readonly drains = new Map<string, Promise<void>>()
  private readonly drainRequested = new Set<string>()
  private readonly cancellationBarriers = new Map<string, Promise<void>>()
  private readonly parentRecoveryRequired = new Map<
    string,
    | 'dispatch_ambiguous'
    | 'parent_interrupted'
    | 'session_unavailable'
    | 'artifact_finalization_failed'
  >()
  private disposed = false

  constructor(private readonly options: OpenCodeQueuedDeliveryOwnerOptions) {
    this.idFactory = options.idFactory ?? randomUUID
    this.queueLimit = options.queueLimit ?? DEFAULT_OPENCODE_QUEUE_LIMIT
    if (!Number.isSafeInteger(this.queueLimit) || this.queueLimit < 1) {
      throw new Error('OpenCode delivery queue limit is invalid.')
    }
  }

  async deliver(value: unknown): Promise<MessageDeliveryAdmissionResult> {
    const request = validateMessageDeliveryRendererRequest(value)
    const current = this.inFlight.get(request.sessionId)
    if (current) return Promise.resolve(this.blocked(request.sessionId, 'delivery_in_flight'))
    const operation = this.deliverOnce(request)
    this.inFlight.set(request.sessionId, operation)
    return operation.finally(() => {
      if (this.inFlight.get(request.sessionId) === operation)
        this.inFlight.delete(request.sessionId)
    })
  }

  async recover(): Promise<readonly MessageDeliveryProjection[]> {
    const ambiguous = await this.options.deliveries.recoverOpenCodeDispatches()
    for (const row of ambiguous) {
      this.parentRecoveryRequired.set(row.sessionId, 'dispatch_ambiguous')
    }
    const sessionIds = new Set([
      ...(await this.options.deliveries.listPendingOpenCodeSessionIds()),
      ...ambiguous.map((row) => row.sessionId)
    ])
    for (const sessionId of sessionIds) {
      await this.reconcilePreparing(sessionId)
      const recoverySession = await this.options.deliveries.listForSession(sessionId)
      if (recoverySession.some((row) => row.safeErrorCode === 'dispatch_ambiguous')) {
        this.parentRecoveryRequired.set(sessionId, 'dispatch_ambiguous')
      }
      const rows = await this.options.deliveries.listForSession(sessionId)
      const projectId = rows[0]?.projectId
      if (projectId && this.options.runtime.isSessionReady(projectId, sessionId)) {
        this.scheduleDrain(sessionId)
      }
    }
    return ambiguous
  }

  // Called by the main ACP owner after a prompt's artifact/finalization and interaction release.
  onInteractionReleased(sessionId: string): void {
    this.scheduleDrain(sessionId)
  }

  onParentRunFinalized(sessionId: string): void {
    this.scheduleDrain(sessionId)
  }

  onSessionPersistenceChanged(sessionId: string): void {
    this.scheduleDrain(sessionId)
  }

  // Called after a persisted OpenCode Session is attached following startup/reconnect. A queued row
  // may have survived while the provider session was detached; readiness alone is not permission to
  // interrupt a recovered parent, so the drain rechecks resumeRecovery and the live interaction.
  onSessionReady(sessionId: string): void {
    const recovery = this.parentRecoveryRequired.get(sessionId)
    if (recovery !== 'dispatch_ambiguous' && recovery !== 'artifact_finalization_failed') {
      this.parentRecoveryRequired.delete(sessionId)
    }
    this.scheduleDrain(sessionId)
  }

  onParentCancellationRequested(sessionId: string): void {
    if (!this.cancellationBarriers.has(sessionId)) {
      this.parentRecoveryRequired.set(sessionId, 'parent_interrupted')
    }
  }

  // Artifact publication is part of the parent terminal boundary. If it cannot be finalized after
  // the runtime retry, persist a blocker before the interaction-release callback can wake a queue.
  async onArtifactFinalizationFailed(sessionId: string): Promise<void> {
    this.parentRecoveryRequired.set(sessionId, 'artifact_finalization_failed')
    await this.blockFirstPendingForSession(sessionId, 'artifact_finalization_failed')
  }

  onSessionUnavailable(sessionId: string): void {
    this.parentRecoveryRequired.set(sessionId, 'session_unavailable')
  }

  onSessionDeleted(sessionId: string): void {
    this.parentRecoveryRequired.set(sessionId, 'session_unavailable')
    void this.blockPendingForSession(sessionId, 'session_deleted')
  }

  close(): void {
    this.disposed = true
  }

  async closeAndWait(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.drains.values(), ...this.cancellationBarriers.values()])
    this.drains.clear()
    this.cancellationBarriers.clear()
  }

  private async deliverOnce(
    request: MessageDeliveryRendererRequest
  ): Promise<MessageDeliveryAdmissionResult> {
    const projectId = await this.options.sessions.projectIdForSession(request.sessionId)
    if (!projectId) return this.blocked(request.sessionId, 'session_unavailable')

    let session: PersistedChatSession | undefined
    try {
      session = await this.options.sessions.loadSession(projectId, request.sessionId)
      if (!session || session.id !== request.sessionId || session.projectId !== projectId) {
        return this.blocked(request.sessionId, 'session_unavailable')
      }
      await this.options.sessions.assertSessionAvailable(projectId, request.sessionId)
    } catch (error) {
      return this.blocked(request.sessionId, safeErrorCode(error, 'session_unavailable'))
    }

    let snapshot: ActiveTurnSnapshot | undefined
    try {
      snapshot = await this.options.resolveActiveTurn(session)
    } catch {
      return this.blocked(request.sessionId, 'runtime_resolution_failed')
    }
    if (!snapshot || snapshot.backend !== 'opencode') {
      return this.stale(request.sessionId)
    }

    const decision = resolveMessageDelivery({
      requested: request.requested,
      hasActiveTurn: true
    })
    const messageId = this.idFactory()
    const deliveryId = this.idFactory()
    let message: PersistedChatMessage
    let delivery: MessageDeliveryProjection
    let prepared: Awaited<ReturnType<MessageDeliveryJournal['prepareOnce']>> | undefined
    try {
      prepared = await this.options.deliveries.prepareOnce({
        id: deliveryId,
        projectId,
        sessionId: request.sessionId,
        messageId,
        targetRootRunId: snapshot.rootRunId,
        targetPromptMessageId: snapshot.promptMessageId,
        backend: 'opencode',
        runtimeThreadId: snapshot.runtimeThreadId,
        runtimeTurnId: snapshot.turnId,
        requested: request.requested,
        hasActiveTurn: true,
        maxPendingQueueItems: this.queueLimit
      })
      let finalizedAttachments: UploadedAttachment[] | undefined
      if (request.attachments?.length) {
        if (!this.options.uploads) throw new Error('upload_finalization_unavailable')
        finalizedAttachments = await this.options.uploads.finalizeSessionUploads({
          projectId,
          sessionId: request.sessionId,
          attachments: request.attachments
        })
        const byId = new Map(finalizedAttachments.map((attachment) => [attachment.id, attachment]))
        for (const attachment of request.attachments) {
          const finalized = byId.get(attachment.id)
          if (!finalized?.versionId || finalized.sessionId !== request.sessionId) {
            throw new Error('upload_finalization_incomplete')
          }
        }
        finalizedAttachments = request.attachments.map((attachment) => byId.get(attachment.id)!)
      }
      message = await this.options.sessions.appendUserMessageToInteraction({
        projectId,
        sessionId: request.sessionId,
        interactionId: snapshot.promptMessageId,
        messageId,
        content: request.content,
        parts: validateMessageParts(request.parts),
        uploads: finalizedAttachments?.map(toPersistedUploadedAttachment)
      })
      delivery = await this.options.deliveries.reconcile(prepared.delivery.id, {
        hasSessionMessage: true
      })
    } catch (error) {
      if (prepared?.created) {
        await this.options.deliveries
          .reconcile(prepared.delivery.id, { hasSessionMessage: false })
          .catch(() => undefined)
      }
      return this.blocked(request.sessionId, safeErrorCode(error, 'persistence_failed'))
    }

    let latest: ActiveTurnSnapshot | undefined
    try {
      latest = await this.currentSnapshot(projectId, request.sessionId)
    } catch (error) {
      return this.blockDelivery(
        request.sessionId,
        safeErrorCode(error, 'runtime_resolution_failed'),
        message,
        delivery
      )
    }
    if (latest && !sameSnapshot(snapshot, latest)) {
      return this.blockDelivery(request.sessionId, 'stale_active_turn', message, delivery)
    }

    if (decision.resolved === 'side-question' || decision.resolved === 'continue') {
      return this.blockDelivery(request.sessionId, 'side_question_unavailable', message, delivery)
    }

    if (decision.resolved === 'stop-and-replace') {
      this.startCancellationBarrier(request.sessionId, delivery.id)
      this.scheduleDrain(request.sessionId)
    } else {
      this.scheduleDrain(request.sessionId)
    }

    return Object.freeze({
      status: 'accepted',
      sessionId: request.sessionId,
      message,
      delivery
    })
  }

  private startCancellationBarrier(sessionId: string, deliveryId: string): void {
    if (this.cancellationBarriers.has(sessionId)) return
    // Install the barrier before invoking cancelPrompt. The coordinator reports cancellation
    // synchronously, and that callback must recognize this as an intentional replacement rather than
    // converting it into a persistent parent-recovery barrier.
    const barrier = Promise.resolve().then(() => this.cancelAndDrain(sessionId, deliveryId))
    this.cancellationBarriers.set(sessionId, barrier)
    void barrier.finally(() => {
      if (this.cancellationBarriers.get(sessionId) === barrier) {
        this.cancellationBarriers.delete(sessionId)
        this.scheduleDrain(sessionId)
      }
    })
  }

  private async cancelAndDrain(sessionId: string, deliveryId: string): Promise<void> {
    try {
      await this.options.runtime.cancelPrompt(sessionId)
    } catch (error) {
      const delivery = await this.options.deliveries.get(deliveryId).catch(() => undefined)
      if (delivery && !TERMINAL_LIFECYCLES.has(delivery.lifecycle)) {
        await this.options.deliveries
          .transition(delivery.id, 'failed', {
            expectedRevision: delivery.revision,
            safeErrorCode: safeErrorCode(error, 'cancel_failed')
          })
          .catch(() => undefined)
      }
      return
    }
    try {
      await this.options.runtime.waitForSessionInteractionRelease(sessionId)
    } catch (error) {
      const delivery = await this.options.deliveries.get(deliveryId).catch(() => undefined)
      if (delivery) await this.blockDeliveryById(delivery, safeErrorCode(error, 'release_failed'))
      return
    }
  }

  private scheduleDrain(sessionId: string): void {
    if (this.disposed) return
    const current = this.drains.get(sessionId)
    if (current) {
      this.drainRequested.add(sessionId)
      return
    }
    const drain = this.drain(sessionId)
    this.drains.set(sessionId, drain)
    void drain.finally(() => {
      if (this.drains.get(sessionId) !== drain) return
      this.drains.delete(sessionId)
      if (this.drainRequested.delete(sessionId) && !this.disposed) {
        this.scheduleDrain(sessionId)
      }
    })
  }

  private async drain(sessionId: string): Promise<void> {
    if (
      this.disposed ||
      this.parentRecoveryRequired.has(sessionId) ||
      this.cancellationBarriers.has(sessionId)
    )
      return
    for (;;) {
      const rows = await this.options.deliveries.listForSession(sessionId)
      const first = rows.find((candidate) => !FIFO_PASSABLE_LIFECYCLES.has(candidate.lifecycle))
      if (!first) return
      if (!isQueuedDelivery(first)) return
      if (!this.options.runtime.isSessionReady(first.projectId, sessionId)) return

      const session = await this.loadAvailableSession(first.projectId, sessionId).catch(
        () => undefined
      )
      if (!session) {
        await this.blockDeliveryById(first, 'session_unavailable')
        return
      }
      if (session.resumeRecovery?.promptMessageId === first.targetPromptMessageId) return
      // Always await the interaction owner, even when the persisted activeRun still points at the
      // original parent. App continuations retain that parent identity while owning a distinct ACP
      // interaction, and a callback may have fired just before this row was persisted.
      await this.options.runtime.waitForSessionInteractionRelease(sessionId)
      if (this.drainBarrier(sessionId)) return
      const fresh = await this.loadAvailableSession(first.projectId, sessionId).catch(
        () => undefined
      )
      if (!fresh || fresh.resumeRecovery?.promptMessageId === first.targetPromptMessageId) return
      if (this.drainBarrier(sessionId)) return
      if (fresh.activeRun) {
        if (fresh.activeRun.promptMessageId !== first.targetPromptMessageId) {
          await this.blockDeliveryById(first, 'stale_parent_binding')
        }
        return
      }
      let current: ActiveTurnSnapshot | undefined
      try {
        current = await this.options.resolveActiveTurn(fresh)
      } catch (error) {
        await this.blockDeliveryById(first, safeErrorCode(error, 'runtime_resolution_failed'))
        return
      }
      if (current) {
        await this.blockDeliveryById(first, 'stale_parent_binding')
        return
      }

      if (this.options.resolveParentDeliveryState) {
        let parentState: OpenCodeParentDeliveryState
        try {
          parentState = await this.options.resolveParentDeliveryState({
            projectId: first.projectId,
            sessionId,
            rootRunId: first.targetRootRunId,
            promptMessageId: first.targetPromptMessageId
          })
        } catch {
          await this.blockDeliveryById(first, 'graph_sync_failed')
          return
        }
        if (parentState === 'active') return
        if (parentState === 'missing') {
          await this.blockDeliveryById(first, 'stale_parent_binding')
          return
        }
        if (parentState === 'graph-sync-failed') {
          await this.blockDeliveryById(first, 'graph_sync_failed')
          return
        }
      }

      if (this.drainBarrier(sessionId)) return
      const claimed = await this.options.deliveries.claimNextOpenCodeQueued(sessionId)
      if (!claimed) return
      const barrier = this.drainBarrier(sessionId)
      if (barrier) {
        await this.blockDeliveryById(claimed, barrier)
        return
      }
      const message = fresh.messages.find((candidate) => candidate.id === claimed.messageId)
      if (!message) {
        await this.blockDeliveryById(claimed, 'session_message_missing')
        return
      }

      let accepted = false
      let acceptance: Promise<MessageDeliveryProjection> | undefined
      try {
        const request = continuationFor(message, claimed.projectId, sessionId, fresh)
        await this.options.runtime.sendAppContinuationObserved(request, () => {
          if (accepted) return
          accepted = true
          acceptance = this.options.deliveries.transition(claimed.id, 'accepted', {
            expectedRevision: claimed.revision
          })
        })
        if (!accepted || !acceptance) {
          await this.blockDeliveryById(claimed, 'dispatch_ambiguous')
          return
        }
        const acceptedDelivery = await acceptance
        await this.options.deliveries.transition(claimed.id, 'completed', {
          expectedRevision: acceptedDelivery.revision
        })
      } catch (error) {
        if (accepted && acceptance) {
          const acceptedDelivery = await acceptance.catch(() => undefined)
          if (acceptedDelivery) {
            const durable = await this.options.deliveries.get(claimed.id).catch(() => undefined)
            if (durable && TERMINAL_LIFECYCLES.has(durable.lifecycle)) return
            await this.options.deliveries
              .transition(claimed.id, 'failed', {
                expectedRevision: acceptedDelivery.revision,
                safeErrorCode: safeErrorCode(error, 'continuation_failed')
              })
              .catch(() => undefined)
          } else {
            const durable = await this.options.deliveries.get(claimed.id).catch(() => undefined)
            if (durable) await this.blockDeliveryById(durable, 'dispatch_ambiguous')
          }
        } else {
          await this.blockDeliveryById(claimed, 'dispatch_ambiguous')
        }
        return
      }
    }
  }

  private drainBarrier(
    sessionId: string
  ):
    | 'dispatch_ambiguous'
    | 'parent_interrupted'
    | 'session_unavailable'
    | 'artifact_finalization_failed'
    | undefined {
    if (this.parentRecoveryRequired.has(sessionId)) {
      return this.parentRecoveryRequired.get(sessionId)
    }
    if (this.cancellationBarriers.has(sessionId)) return 'dispatch_ambiguous'
    return undefined
  }

  private async currentSnapshot(
    projectId: string,
    sessionId: string
  ): Promise<ActiveTurnSnapshot | undefined> {
    const session = await this.loadAvailableSession(projectId, sessionId)
    return this.options.resolveActiveTurn(session)
  }

  private async reconcilePreparing(sessionId: string): Promise<void> {
    const rows = await this.options.deliveries.listForSession(sessionId)
    const projectId = rows[0]?.projectId
    if (!projectId) return
    const session = await this.loadAvailableSession(projectId, sessionId).catch(() => undefined)
    for (const row of rows) {
      if (row.lifecycle !== 'preparing') continue
      const hasMessage = Boolean(session?.messages.some((message) => message.id === row.messageId))
      await this.options.deliveries
        .reconcile(row.id, { hasSessionMessage: hasMessage })
        .catch(() => undefined)
    }
  }

  private async loadAvailableSession(
    projectId: string,
    sessionId: string
  ): Promise<PersistedChatSession> {
    const session = await this.options.sessions.loadSession(projectId, sessionId)
    if (!session || session.id !== sessionId || session.projectId !== projectId) {
      throw new Error('session_unavailable')
    }
    await this.options.sessions.assertSessionAvailable(projectId, sessionId)
    return session
  }

  private async blockDeliveryById(
    delivery: MessageDeliveryProjection,
    code: string
  ): Promise<MessageDeliveryProjection> {
    if (TERMINAL_LIFECYCLES.has(delivery.lifecycle)) return delivery
    return this.options.deliveries
      .transition(delivery.id, 'blocked', {
        expectedRevision: delivery.revision,
        safeErrorCode: code
      })
      .catch(() => delivery)
  }

  private async blockPendingForSession(sessionId: string, code: string): Promise<void> {
    const rows = await this.options.deliveries.listForSession(sessionId).catch(() => [])
    for (const row of rows) {
      if (TERMINAL_LIFECYCLES.has(row.lifecycle)) continue
      await this.blockDeliveryById(row, code)
    }
  }

  private async blockFirstPendingForSession(sessionId: string, code: string): Promise<void> {
    const rows = await this.options.deliveries.listForSession(sessionId).catch(() => [])
    const first = rows.find((row) => !FIFO_PASSABLE_LIFECYCLES.has(row.lifecycle))
    if (first) await this.blockDeliveryById(first, code)
  }

  private async blockDelivery(
    sessionId: string,
    code: string,
    message: PersistedChatMessage,
    delivery: MessageDeliveryProjection
  ): Promise<MessageDeliveryAdmissionResult> {
    const blocked = await this.blockDeliveryById(delivery, code)
    return Object.freeze({
      status: 'blocked',
      sessionId,
      message,
      delivery: blocked,
      safeErrorCode: code
    })
  }

  private blocked(sessionId: string, safeErrorCode: string): MessageDeliveryAdmissionResult {
    return Object.freeze({ status: 'blocked', sessionId, safeErrorCode })
  }

  private stale(sessionId: string): MessageDeliveryAdmissionResult {
    return Object.freeze({ status: 'stale', sessionId, safeErrorCode: 'stale_active_turn' })
  }
}

export type { OpenCodeQueuedDeliveryOwnerOptions, OpenCodeQueuedRuntime }
