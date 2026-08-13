import { randomUUID } from 'node:crypto'

import type { AgentFrameworkId } from '../../shared/settings'
import type { AgentRuntimeInput, AgentRuntimePort } from '../agent-runtime'
import {
  imageAttachmentMimeType,
  toPersistedUploadedAttachment,
  type UploadedAttachment,
  type PersistedUploadedAttachment
} from '../../shared/uploads'
import type {
  MessagePart,
  PersistedChatMessage,
  PersistedChatSession
} from '../../shared/session-persistence'
import {
  validateMessageDeliveryRendererRequest,
  validateMessageDeliveryRouterResult,
  type MessageDeliveryAdmissionResult,
  type MessageDeliveryProjection,
  type MessageDeliveryRendererRequest,
  type MessageDeliveryRouterResult,
  resolveMessageDelivery
} from '../../shared/message-delivery'
import { validateMessageParts } from '../../shared/session-persistence'
import { MessageDeliveryJournal } from './delivery-journal'

// Session files and the persistence coordinator are main-owned authority. The renderer supplies
// only the opaque Session id; the owner resolves its Project before reading or mutating anything.
type SessionAuthority = Readonly<{
  projectIdForSession(sessionId: string): Promise<string | undefined>
  loadSession(projectId: string, sessionId: string): Promise<PersistedSessionAuthority | undefined>
  assertSessionAvailable(projectId: string, sessionId: string): Promise<void>
  appendUserMessageToInteraction(command: {
    projectId: string
    sessionId: string
    interactionId: string
    messageId: string
    content: string
    parts?: MessagePart[]
    uploads?: PersistedUploadedAttachment[]
  }): Promise<PersistedChatMessage>
}>

type PersistedSessionAuthority = PersistedChatSession

export type ActiveTurnSnapshot = Readonly<{
  sessionId: string
  projectId: string
  rootRunId: string
  backendGeneration: string
  backend: AgentFrameworkId
  runtimeThreadId: string
  turnId: string
  promptMessageId: string
  cancellationGeneration: number
  runtimeSessionId: string
}>

type ActiveTurnResolver = (
  session: PersistedSessionAuthority
) => Promise<ActiveTurnSnapshot | undefined>

export type DeliveryUploadFinalizer = Readonly<{
  finalizeSessionUploads(input: {
    projectId: string
    sessionId: string
    attachments: readonly UploadedAttachment[]
  }): Promise<UploadedAttachment[]>
}>

export type RuntimeAdapter = Readonly<{
  readonly backend: AgentFrameworkId
  readonly runtime: AgentRuntimePort
  readonly startReplacement?: (input: {
    snapshot: ActiveTurnSnapshot
    message: PersistedChatMessage
    delivery: MessageDeliveryProjection
    inputs?: readonly AgentRuntimeInput[]
  }) => Promise<void>
  readonly releaseInteraction?: (sessionId: string) => Promise<void>
}>

export type DeliveryOwnerOptions = Readonly<{
  sessions: SessionAuthority
  deliveries: Pick<MessageDeliveryJournal, 'prepareOnce' | 'reconcile' | 'transition'>
  uploads?: DeliveryUploadFinalizer
  resolveActiveTurn: ActiveTurnResolver
  resolveRouter?: (
    request: MessageDeliveryRendererRequest,
    snapshot: ActiveTurnSnapshot
  ) => Promise<MessageDeliveryRouterResult>
  runtimeForSnapshot: (snapshot: ActiveTurnSnapshot) => Promise<RuntimeAdapter | undefined>
  idFactory?: () => string
  confidenceThreshold?: number
}>

const safeErrorCode = (error: unknown, fallback = 'delivery_failed'): string => {
  if (error instanceof Error && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(error.message)) {
    return error.message
  }
  return fallback
}

const runtimeInputs = (
  content: string,
  attachments: readonly UploadedAttachment[] | undefined
): readonly AgentRuntimeInput[] => [
  ...(content.trim() ? [Object.freeze({ kind: 'text' as const, text: content })] : []),
  ...(attachments ?? []).flatMap((attachment): AgentRuntimeInput[] => {
    const mimeType = imageAttachmentMimeType(attachment.name, attachment.mimeType)
    return mimeType
      ? [{ kind: 'image', source: 'path', value: attachment.path, detail: 'auto' }]
      : []
  })
]

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

const terminalDeliveryLifecycles = new Set([
  'completed',
  'failed',
  'cancelled',
  'blocked',
  'abandoned'
])

const hasActiveTurn = (snapshot: ActiveTurnSnapshot | undefined): snapshot is ActiveTurnSnapshot =>
  snapshot !== undefined

// Main-process owner for active-turn delivery. Renderer values are untrusted content; every graph,
// runtime, route, turn, and cancellation identity is captured from main-owned state at admission.
export class MessageDeliveryOwner {
  private readonly idFactory: () => string
  private readonly confidenceThreshold: number
  private readonly inFlight = new Map<string, Promise<MessageDeliveryAdmissionResult>>()

  constructor(private readonly options: DeliveryOwnerOptions) {
    this.idFactory = options.idFactory ?? randomUUID
    this.confidenceThreshold = options.confidenceThreshold ?? 0.75
    if (
      !Number.isFinite(this.confidenceThreshold) ||
      this.confidenceThreshold < 0 ||
      this.confidenceThreshold > 1
    ) {
      throw new Error('Message delivery confidence threshold is invalid.')
    }
  }

  async deliver(value: unknown): Promise<MessageDeliveryAdmissionResult> {
    const request = validateMessageDeliveryRendererRequest(value)
    const current = this.inFlight.get(request.sessionId)
    if (current) {
      // A second click cannot be safely deduplicated because the renderer does not own the durable
      // Message id. Refuse it without changing the first request or consuming the second draft.
      return Promise.resolve(this.blocked(request.sessionId, 'delivery_in_flight'))
    }
    const operation = this.deliverOnce(request)
    this.inFlight.set(request.sessionId, operation)
    return operation.finally(() => {
      if (this.inFlight.get(request.sessionId) === operation)
        this.inFlight.delete(request.sessionId)
    })
  }

  private async deliverOnce(
    request: MessageDeliveryRendererRequest
  ): Promise<MessageDeliveryAdmissionResult> {
    const projectId = await this.options.sessions.projectIdForSession(request.sessionId)
    if (!projectId) return this.blocked(request.sessionId, 'session_unavailable')

    let session: PersistedSessionAuthority | undefined
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
    // The ordinary idle Send path remains the only path for idle prompts. Explicit active-turn
    // controls are stale when the turn has already settled; no message or graph row is fabricated.
    if (!hasActiveTurn(snapshot)) return this.stale(request.sessionId)

    const router =
      request.requested === 'auto' && this.options.resolveRouter
        ? await this.resolveRouter(request, snapshot)
        : undefined
    const decision = resolveMessageDelivery({
      requested: request.requested,
      hasActiveTurn: true,
      recommendation: router?.recommendation,
      confidenceThreshold: this.confidenceThreshold
    })
    const messageId = this.idFactory()
    const deliveryId = this.idFactory()

    let finalizedAttachments: UploadedAttachment[] | undefined
    try {
      finalizedAttachments = await this.finalizeAttachments(
        projectId,
        request.sessionId,
        request.attachments
      )
    } catch (error) {
      return this.blocked(request.sessionId, safeErrorCode(error, 'upload_finalization_failed'))
    }

    let message: PersistedChatMessage
    let delivery: MessageDeliveryProjection
    let prepared: Awaited<ReturnType<MessageDeliveryJournal['prepareOnce']>> | undefined
    try {
      prepared = await this.options.deliveries.prepareOnce({
        id: deliveryId,
        projectId,
        sessionId: request.sessionId,
        messageId,
        // Bind to the already-created root and its original prompt. This is the critical invariant
        // that prevents an active-turn control from creating a second graph root.
        targetRootRunId: snapshot.rootRunId,
        targetPromptMessageId: snapshot.promptMessageId,
        backend: snapshot.backend,
        runtimeThreadId: snapshot.runtimeThreadId,
        runtimeTurnId: snapshot.turnId,
        requested: request.requested,
        hasActiveTurn: true,
        recommendation: router?.recommendation,
        confidenceThreshold: this.confidenceThreshold,
        routerMetadata:
          router?.metadata ??
          (request.requested === 'auto' ? { reasonCode: 'router_unavailable' } : undefined)
      })
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

    // The Session object captured at admission is no longer authoritative after the durable append.
    // Reload it and re-check archive/deletion state before resolving a runtime or dispatching any
    // provider action. This closes the persistence-to-side-effect race without borrowing renderer
    // state as authority.
    let freshSession: PersistedSessionAuthority
    try {
      freshSession = await this.loadAvailableSession(projectId, request.sessionId)
    } catch (error) {
      return this.blockDelivery(
        request.sessionId,
        safeErrorCode(error, 'session_unavailable'),
        message,
        delivery
      )
    }

    const latest = await this.options.resolveActiveTurn(freshSession).catch(() => undefined)
    if (!latest || !sameSnapshot(snapshot, latest)) {
      return this.blockDelivery(request.sessionId, 'stale_active_turn', message, delivery, true)
    }

    // Runtime resolution is intentionally after the fresh authority check. Startup/provider
    // failures become a blocked durable delivery; they must not be mistaken for a provider call
    // failure that could be retried automatically.
    let adapter: RuntimeAdapter | undefined
    try {
      adapter = await this.options.runtimeForSnapshot(snapshot)
    } catch {
      return this.blockDelivery(request.sessionId, 'runtime_resolution_failed', message, delivery)
    }
    const capabilityError = this.capabilityError(decision.resolved, snapshot, adapter)
    if (capabilityError)
      return this.blockDelivery(request.sessionId, capabilityError, message, delivery)

    try {
      delivery = await this.options.deliveries.transition(delivery.id, 'dispatched', {
        expectedRevision: delivery.revision,
        runtimeThreadId: snapshot.runtimeThreadId,
        runtimeTurnId: snapshot.turnId,
        resolved: decision.resolved,
        source: decision.source
      })

      // Revalidate immediately before the provider side effect. The runtime receives the exact
      // captured turn id and must reject if it changed internally as well.
      const beforeSideEffectSession = await this.loadAvailableSession(projectId, request.sessionId)
      const beforeSideEffect = await this.options
        .resolveActiveTurn(beforeSideEffectSession)
        .catch(() => undefined)
      if (!beforeSideEffect || !sameSnapshot(snapshot, beforeSideEffect)) {
        return this.blockDelivery(request.sessionId, 'stale_active_turn', message, delivery, true)
      }

      if (decision.resolved === 'steer') {
        const accepted = await adapter!.runtime.capabilities.nativeSteer!({
          appSessionId: snapshot.runtimeSessionId,
          expectedTurnId: snapshot.turnId,
          input: runtimeInputs(request.content, finalizedAttachments),
          clientUserMessageId: message.id
        })
        if (accepted.runtimeTurnId !== snapshot.turnId) {
          return this.blockDelivery(request.sessionId, 'steer_turn_mismatch', message, delivery)
        }
      } else if (decision.resolved === 'stop-and-replace') {
        await adapter!.runtime.interruptAndAwaitTerminal!(
          snapshot.runtimeSessionId,
          snapshot.turnId
        )
        // The local lock is released only after the matching terminal event. Replacement dispatch
        // is therefore ordered after the old provider turn, never merely after interrupt admission.
        await adapter!.releaseInteraction?.(request.sessionId)
        await adapter!.startReplacement!({
          snapshot,
          message,
          delivery,
          inputs: runtimeInputs(request.content, finalizedAttachments)
        })
      } else {
        // Stage 5 owns side-question child creation. Persist the explicit safe decision now, but do
        // not pretend that a child provider action exists in Stage 3.
        return this.blockDelivery(request.sessionId, 'side_question_unavailable', message, delivery)
      }

      const completed = await this.options.deliveries.transition(delivery.id, 'completed', {
        expectedRevision: delivery.revision
      })
      return Object.freeze({
        status: 'accepted',
        sessionId: request.sessionId,
        message,
        delivery: completed
      })
    } catch (error) {
      const failed = await this.options.deliveries
        .transition(delivery.id, 'failed', {
          expectedRevision: delivery.revision,
          safeErrorCode: safeErrorCode(error)
        })
        .catch(() => delivery)
      return Object.freeze({
        status: 'failed',
        sessionId: request.sessionId,
        message,
        delivery: failed,
        safeErrorCode: failed.safeErrorCode
      })
    }
  }

  private async finalizeAttachments(
    projectId: string,
    sessionId: string,
    attachments: readonly UploadedAttachment[] | undefined
  ): Promise<UploadedAttachment[] | undefined> {
    if (!attachments || attachments.length === 0) return undefined
    if (!this.options.uploads) throw new Error('upload_finalization_unavailable')
    const finalized = await this.options.uploads.finalizeSessionUploads({
      projectId,
      sessionId,
      attachments
    })
    const byId = new Map(finalized.map((attachment) => [attachment.id, attachment]))
    for (const attachment of attachments) {
      const result = byId.get(attachment.id)
      if (!result || result.sessionId !== sessionId || !result.versionId) {
        throw new Error('upload_finalization_incomplete')
      }
    }
    return attachments.map((attachment) => byId.get(attachment.id)!)
  }

  private async loadAvailableSession(
    projectId: string,
    sessionId: string
  ): Promise<PersistedSessionAuthority> {
    const session = await this.options.sessions.loadSession(projectId, sessionId)
    if (!session || session.id !== sessionId || session.projectId !== projectId) {
      throw new Error('session_unavailable')
    }
    await this.options.sessions.assertSessionAvailable(projectId, sessionId)
    return session
  }

  private capabilityError(
    resolved: ReturnType<typeof resolveMessageDelivery>['resolved'],
    snapshot: ActiveTurnSnapshot,
    adapter: RuntimeAdapter | undefined
  ): string | undefined {
    if (resolved === 'side-question') return 'side_question_unavailable'
    if (!adapter || adapter.backend !== snapshot.backend) return 'runtime_unavailable'
    if (resolved === 'steer') {
      if (snapshot.backend !== 'codex' || !adapter.runtime.capabilities.nativeSteer) {
        return 'native_steer_unavailable'
      }
    }
    if (resolved === 'stop-and-replace') {
      if (
        snapshot.backend !== 'codex' ||
        !adapter.runtime.interruptAndAwaitTerminal ||
        !adapter.startReplacement
      ) {
        return 'stop_replace_unavailable'
      }
    }
    return undefined
  }

  private async resolveRouter(
    request: MessageDeliveryRendererRequest,
    snapshot: ActiveTurnSnapshot
  ): Promise<MessageDeliveryRouterResult | undefined> {
    try {
      const result = await this.options.resolveRouter?.(request, snapshot)
      return result ? validateMessageDeliveryRouterResult(result) : undefined
    } catch {
      // Auto failures intentionally fall through to the pure safe side-question decision.
      return undefined
    }
  }

  private async blockDelivery(
    sessionId: string,
    safeErrorCode: string,
    message: PersistedChatMessage,
    delivery: MessageDeliveryProjection,
    stale = false
  ): Promise<MessageDeliveryAdmissionResult> {
    const blocked = terminalDeliveryLifecycles.has(delivery.lifecycle)
      ? delivery
      : await this.options.deliveries
          .transition(delivery.id, 'blocked', {
            expectedRevision: delivery.revision,
            safeErrorCode
          })
          .catch(() => delivery)
    return Object.freeze({
      status: stale ? 'stale' : 'blocked',
      sessionId,
      message,
      delivery: blocked,
      safeErrorCode
    })
  }

  private blocked(sessionId: string, safeErrorCode: string): MessageDeliveryAdmissionResult {
    return Object.freeze({ status: 'blocked', sessionId, safeErrorCode })
  }

  private stale(sessionId: string): MessageDeliveryAdmissionResult {
    return Object.freeze({ status: 'stale', sessionId, safeErrorCode: 'stale_active_turn' })
  }
}

export type { SessionAuthority, PersistedSessionAuthority, ActiveTurnResolver }
