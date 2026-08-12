import type { PrismaClient } from '@prisma/client'

import {
  MESSAGE_DELIVERY_DECISION_SOURCES,
  MESSAGE_DELIVERY_LIFECYCLES,
  resolveMessageDelivery,
  validateMessageDeliveryRequest,
  validateMessageDeliveryTransition,
  type MessageDeliveryDecisionSource,
  type MessageDeliveryLifecycle,
  type MessageDeliveryProjection,
  type MessageDeliveryRequest,
  type MessageDeliveryRouterMetadata,
  type ResolvedMessageDeliveryMode,
  validateMessageDeliveryIdentifier,
  validateMessageDeliveryRouterMetadata
} from '../../shared/message-delivery'

type DeliveryClientProvider = () => Promise<PrismaClient>

export type CreateMessageDeliveryInput = MessageDeliveryRequest

export type PreparedMessageDelivery = Readonly<{
  delivery: MessageDeliveryProjection
  created: boolean
}>

export type TransitionMessageDeliveryOptions = Readonly<{
  expectedRevision?: number
  resolved?: ResolvedMessageDeliveryMode
  source?: MessageDeliveryDecisionSource
  runtimeThreadId?: string
  runtimeTurnId?: string
  safeErrorCode?: string
}>

const SAFE_ERROR_CODE = /^[a-z0-9][a-z0-9._-]{0,127}$/u

const safeErrorCode = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  if (!SAFE_ERROR_CODE.test(value)) throw new Error('Message delivery error code is invalid.')
  return value
}

const routerMetadataJson = (
  metadata: MessageDeliveryRouterMetadata | undefined
): string | undefined => {
  if (!metadata) return undefined
  return JSON.stringify({
    ...(metadata.confidence === undefined ? {} : { confidence: metadata.confidence }),
    ...(metadata.classifierAttemptId ? { classifierAttemptId: metadata.classifierAttemptId } : {}),
    ...(metadata.modelId ? { modelId: metadata.modelId } : {}),
    ...(metadata.reasonCode ? { reasonCode: metadata.reasonCode } : {})
  })
}

const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'P2002'

const nullable = (value: string | undefined): string | null => value ?? null

const assertMatchingPreparedDelivery = (
  row: Parameters<typeof toProjection>[0],
  request: MessageDeliveryRequest,
  graphId: string,
  resolvedMode: ResolvedMessageDeliveryMode,
  decisionSource: MessageDeliveryDecisionSource
): void => {
  const expectedRouterMetadata = routerMetadataJson(request.routerMetadata) ?? null
  if (
    row.id !== request.id ||
    row.projectId !== request.projectId ||
    row.sessionId !== request.sessionId ||
    row.messageId !== request.messageId ||
    row.graphId !== graphId ||
    row.targetRootRunId !== request.targetRootRunId ||
    row.targetPromptMessageId !== request.targetPromptMessageId ||
    row.backend !== nullable(request.backend) ||
    (request.runtimeThreadId !== undefined && row.runtimeThreadId !== request.runtimeThreadId) ||
    (request.runtimeTurnId !== undefined && row.runtimeTurnId !== request.runtimeTurnId) ||
    row.requestedMode !== request.requested ||
    row.resolvedMode !== resolvedMode ||
    row.decisionSource !== decisionSource ||
    row.routerMetadataJson !== expectedRouterMetadata
  ) {
    throw new Error('Message Delivery retry identity conflicts with the durable journal row.')
  }
}

const parseRouterMetadata = (value: string | null): MessageDeliveryRouterMetadata | undefined => {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return validateMessageDeliveryRouterMetadata(parsed)
  } catch {
    throw new Error('Stored Message Delivery router metadata is corrupt.')
  }
}

const toProjection = (row: {
  id: string
  projectId: string
  sessionId: string
  messageId: string
  graphId: string
  targetRootRunId: string
  targetPromptMessageId: string
  backend: string | null
  runtimeThreadId: string | null
  runtimeTurnId: string | null
  requestedMode: string
  resolvedMode: string | null
  decisionSource: string | null
  routerMetadataJson: string | null
  sequence: number
  lifecycle: string
  safeErrorCode: string | null
  createdAt: Date
  updatedAt: Date
  revision: number
}): MessageDeliveryProjection => {
  validateMessageDeliveryIdentifier(row.id, 'Stored Message Delivery id')
  validateMessageDeliveryIdentifier(row.projectId, 'Stored Message Delivery project id')
  validateMessageDeliveryIdentifier(row.sessionId, 'Stored Message Delivery session id')
  validateMessageDeliveryIdentifier(row.messageId, 'Stored Message Delivery message id')
  validateMessageDeliveryIdentifier(row.graphId, 'Stored Message Delivery graph id')
  validateMessageDeliveryIdentifier(row.targetRootRunId, 'Stored Message Delivery root run id')
  validateMessageDeliveryIdentifier(
    row.targetPromptMessageId,
    'Stored Message Delivery target prompt id'
  )
  for (const [value, label] of [
    [row.backend, 'Stored Message Delivery backend'],
    [row.runtimeThreadId, 'Stored Message Delivery runtime thread id'],
    [row.runtimeTurnId, 'Stored Message Delivery runtime turn id']
  ] as const) {
    if (value !== null) validateMessageDeliveryIdentifier(value, label)
  }
  if (!MESSAGE_DELIVERY_LIFECYCLES.includes(row.lifecycle as MessageDeliveryLifecycle)) {
    throw new Error('Stored Message Delivery lifecycle is corrupt.')
  }
  if (
    !['auto', 'steer', 'side-question', 'stop-and-replace'].includes(row.requestedMode) ||
    (row.resolvedMode !== null &&
      !['continue', 'steer', 'side-question', 'stop-and-replace'].includes(row.resolvedMode))
  ) {
    throw new Error('Stored Message Delivery mode is corrupt.')
  }
  if (
    row.decisionSource !== null &&
    !MESSAGE_DELIVERY_DECISION_SOURCES.includes(row.decisionSource as MessageDeliveryDecisionSource)
  ) {
    throw new Error('Stored Message Delivery decision source is corrupt.')
  }
  if (row.safeErrorCode !== null && !SAFE_ERROR_CODE.test(row.safeErrorCode)) {
    throw new Error('Stored Message Delivery error code is corrupt.')
  }
  return Object.freeze({
    id: row.id,
    projectId: row.projectId,
    sessionId: row.sessionId,
    messageId: row.messageId,
    targetRootRunId: row.targetRootRunId,
    targetPromptMessageId: row.targetPromptMessageId,
    ...(row.backend ? { backend: row.backend } : {}),
    ...(row.runtimeThreadId ? { runtimeThreadId: row.runtimeThreadId } : {}),
    ...(row.runtimeTurnId ? { runtimeTurnId: row.runtimeTurnId } : {}),
    requested: row.requestedMode as MessageDeliveryRequest['requested'],
    ...(row.resolvedMode ? { resolved: row.resolvedMode as ResolvedMessageDeliveryMode } : {}),
    ...(row.decisionSource ? { source: row.decisionSource as MessageDeliveryDecisionSource } : {}),
    ...(row.routerMetadataJson
      ? { routerMetadata: parseRouterMetadata(row.routerMetadataJson) }
      : {}),
    sequence: row.sequence,
    lifecycle: row.lifecycle as MessageDeliveryLifecycle,
    ...(row.safeErrorCode ? { safeErrorCode: row.safeErrorCode } : {}),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    revision: row.revision
  })
}

class MessageDeliveryJournal {
  constructor(private readonly getClient: DeliveryClientProvider) {}

  async prepare(input: CreateMessageDeliveryInput): Promise<MessageDeliveryProjection> {
    return (await this.prepareOnce(input)).delivery
  }

  async prepareOnce(input: CreateMessageDeliveryInput): Promise<PreparedMessageDelivery> {
    const request = validateMessageDeliveryRequest(input)
    const decision = resolveMessageDelivery({
      requested: request.requested,
      hasActiveTurn: request.hasActiveTurn,
      recommendation: request.recommendation,
      confidenceThreshold: request.confidenceThreshold
    })
    const client = await this.getClient()
    const prepareInTransaction = async (): Promise<PreparedMessageDelivery> =>
      client.$transaction(async (transaction) => {
        const rootRun = await transaction.agentRun.findUnique({
          where: { id: request.targetRootRunId }
        })
        if (
          !rootRun ||
          !rootRun.graphId ||
          rootRun.runKind !== 'root' ||
          rootRun.parentAgentRunId
        ) {
          throw new Error('Message Delivery target root Agent Run is missing or legacy.')
        }
        const graph = await transaction.agentGraph.findUnique({ where: { id: rootRun.graphId } })
        if (
          !graph ||
          graph.projectId !== request.projectId ||
          graph.sessionId !== request.sessionId ||
          graph.rootPromptMessageId !== rootRun.promptMessageId
        ) {
          throw new Error('Message Delivery target graph is missing or out of scope.')
        }
        if (request.targetPromptMessageId !== rootRun.promptMessageId) {
          throw new Error(
            'Message Delivery message identity does not match its target root prompt.'
          )
        }
        const existing = await transaction.messageDelivery.findFirst({
          where: {
            OR: [{ id: request.id }, { sessionId: request.sessionId, messageId: request.messageId }]
          }
        })
        if (existing) {
          assertMatchingPreparedDelivery(
            existing,
            request,
            graph.id,
            decision.resolved,
            decision.source
          )
          return Object.freeze({ delivery: toProjection(existing), created: false })
        }
        const last = await transaction.messageDelivery.findFirst({
          where: { sessionId: request.sessionId },
          orderBy: { sequence: 'desc' },
          select: { sequence: true }
        })
        const sequence = (last?.sequence ?? -1) + 1
        const createdAt = new Date()
        const row = await transaction.messageDelivery.create({
          data: {
            id: request.id,
            projectId: request.projectId,
            sessionId: request.sessionId,
            messageId: request.messageId,
            graphId: graph.id,
            targetRootRunId: request.targetRootRunId,
            targetPromptMessageId: request.targetPromptMessageId,
            backend: request.backend,
            runtimeThreadId: request.runtimeThreadId,
            runtimeTurnId: request.runtimeTurnId,
            requestedMode: request.requested,
            resolvedMode: decision.resolved,
            decisionSource: decision.source,
            routerMetadataJson: routerMetadataJson(request.routerMetadata),
            sequence,
            lifecycle: 'preparing',
            createdAt,
            revision: 1
          }
        })
        return Object.freeze({ delivery: toProjection(row), created: true })
      })

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await prepareInTransaction()
      } catch (error) {
        if (!isUniqueConstraintError(error) || attempt === 2) throw error
        const raced = await client.messageDelivery.findFirst({
          where: {
            OR: [{ id: request.id }, { sessionId: request.sessionId, messageId: request.messageId }]
          }
        })
        if (!raced) continue
        const rootRun = await client.agentRun.findUnique({ where: { id: request.targetRootRunId } })
        if (!rootRun?.graphId) throw error
        assertMatchingPreparedDelivery(
          raced,
          request,
          rootRun.graphId,
          decision.resolved,
          decision.source
        )
        return Object.freeze({ delivery: toProjection(raced), created: false })
      }
    }
    throw new Error('Message Delivery preparation retry limit was exhausted.')
  }

  async get(deliveryId: string): Promise<MessageDeliveryProjection> {
    const row = await (
      await this.getClient()
    ).messageDelivery.findUnique({ where: { id: deliveryId } })
    if (!row) throw new Error(`Unknown Message Delivery: ${deliveryId}`)
    return toProjection(row)
  }

  async transition(
    deliveryId: string,
    lifecycle: MessageDeliveryLifecycle,
    options: TransitionMessageDeliveryOptions = {}
  ): Promise<MessageDeliveryProjection> {
    const client = await this.getClient()
    const now = new Date()
    const errorCode = safeErrorCode(options.safeErrorCode)
    if (
      options.resolved !== undefined &&
      !['continue', 'steer', 'side-question', 'stop-and-replace'].includes(options.resolved)
    ) {
      throw new Error('Message delivery resolved mode is invalid.')
    }
    if (
      options.source !== undefined &&
      !MESSAGE_DELIVERY_DECISION_SOURCES.includes(options.source)
    ) {
      throw new Error('Message delivery decision source is invalid.')
    }
    if (options.runtimeThreadId !== undefined) {
      validateMessageDeliveryIdentifier(options.runtimeThreadId, 'Runtime thread id')
    }
    if (options.runtimeTurnId !== undefined) {
      validateMessageDeliveryIdentifier(options.runtimeTurnId, 'Runtime turn id')
    }
    return client.$transaction(async (transaction) => {
      const current = await transaction.messageDelivery.findUnique({ where: { id: deliveryId } })
      if (!current) throw new Error(`Unknown Message Delivery: ${deliveryId}`)
      if (current.lifecycle === lifecycle && options.expectedRevision === undefined) {
        return toProjection(current)
      }
      validateMessageDeliveryTransition(current.lifecycle as MessageDeliveryLifecycle, lifecycle)
      if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
        throw new Error(`Message Delivery ${deliveryId} revision changed before transition.`)
      }
      const changed = await transaction.messageDelivery.updateMany({
        where: {
          id: deliveryId,
          lifecycle: current.lifecycle,
          revision: options.expectedRevision ?? current.revision
        },
        data: {
          lifecycle,
          resolvedMode: options.resolved,
          decisionSource: options.source,
          runtimeThreadId: options.runtimeThreadId,
          runtimeTurnId: options.runtimeTurnId,
          safeErrorCode: errorCode,
          updatedAt: now,
          revision: { increment: 1 }
        }
      })
      if (changed.count !== 1) {
        if (options.expectedRevision === undefined) {
          const raced = await transaction.messageDelivery.findUnique({ where: { id: deliveryId } })
          if (raced?.lifecycle === lifecycle) return toProjection(raced)
        }
        throw new Error(`Message Delivery ${deliveryId} changed before transition.`)
      }
      return toProjection(
        await transaction.messageDelivery.findUniqueOrThrow({ where: { id: deliveryId } })
      )
    })
  }

  async reconcile(
    deliveryId: string,
    state: Readonly<{ hasSessionMessage: boolean; dispatchAmbiguous?: boolean }>
  ): Promise<MessageDeliveryProjection> {
    const current = await this.get(deliveryId)
    if (
      state.dispatchAmbiguous &&
      !['completed', 'failed', 'cancelled', 'blocked', 'abandoned'].includes(current.lifecycle)
    ) {
      return this.transition(deliveryId, 'blocked', { safeErrorCode: 'dispatch_ambiguous' })
    }
    if (current.lifecycle !== 'preparing') return current
    return state.hasSessionMessage
      ? this.transition(deliveryId, 'queued')
      : this.transition(deliveryId, 'abandoned', { safeErrorCode: 'session_message_missing' })
  }
}

export { MessageDeliveryJournal }
