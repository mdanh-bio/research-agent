import {
  validatePersistedSideQuestion,
  type PersistedSideQuestion,
  type SideQuestionAdmissionResult
} from './side-question'

export const MESSAGE_DELIVERY_MODES = [
  'auto',
  'steer',
  'side-question',
  'stop-and-replace'
] as const

export type MessageDeliveryMode = (typeof MESSAGE_DELIVERY_MODES)[number]
export type ResolvedMessageDeliveryMode = Exclude<MessageDeliveryMode, 'auto'> | 'continue'

export const MESSAGE_DELIVERY_LIFECYCLES = [
  'preparing',
  'ready',
  'queued',
  'dispatching',
  'accepted',
  'dispatched',
  'completed',
  'failed',
  'cancelled',
  'blocked',
  'abandoned'
] as const
export type MessageDeliveryLifecycle = (typeof MESSAGE_DELIVERY_LIFECYCLES)[number]

export const MESSAGE_DELIVERY_DECISION_SOURCES = [
  'explicit',
  'idle-default',
  'router',
  'safe-default',
  'recovery'
] as const
export type MessageDeliveryDecisionSource = (typeof MESSAGE_DELIVERY_DECISION_SOURCES)[number]

export type MessageDeliveryRouterMetadata = Readonly<{
  confidence?: number
  classifierAttemptId?: string
  modelId?: string
  policyId?: string
  policyVersion?: string
  reasonCode?: string
}>

// This is the only message-delivery shape accepted from the renderer. Session, graph, runtime,
// route, backend-generation, turn, and approval identities are resolved by the main process.
// Attachment paths are staging handles only; the main process validates and converts them to the
// path-free persisted upload projection before the message is durable.
export type MessageDeliveryRendererRequest = Readonly<{
  sessionId: string
  content: string
  parts?: import('./session-persistence').MessagePart[]
  attachments?: import('./uploads').UploadedAttachment[]
  requested: MessageDeliveryMode
}>

export type MessageDeliveryRouterResult = Readonly<{
  recommendation: MessageDeliveryRecommendation
  metadata?: MessageDeliveryRouterMetadata
}>

export type MessageDeliveryAdmissionStatus = 'accepted' | 'stale' | 'blocked' | 'failed'

export type MessageDeliveryAdmissionResult = Readonly<{
  status: MessageDeliveryAdmissionStatus
  sessionId: string
  message?: import('./session-persistence').PersistedChatMessage
  delivery?: MessageDeliveryProjection
  safeErrorCode?: string
}>

export type MessageDeliveryCommandResult =
  | (MessageDeliveryAdmissionResult & Readonly<{ kind: 'delivery' }>)
  | Readonly<{
      kind: 'side-question'
      status: SideQuestionAdmissionResult['status']
      sessionId: string
      sideQuestion?: PersistedSideQuestion
      safeErrorCode?: string
    }>

// Main-process metadata only. Prompt text, attachments, bytes, credentials, raw provider payloads,
// and approval secrets remain in their owning Session/runtime stores.
export type MessageDeliveryRequest = Readonly<{
  id: string
  projectId: string
  sessionId: string
  messageId: string
  targetRootRunId: string
  targetPromptMessageId: string
  backend?: string
  runtimeThreadId?: string
  runtimeTurnId?: string
  requested: MessageDeliveryMode
  hasActiveTurn: boolean
  recommendation?: MessageDeliveryRecommendation
  confidenceThreshold?: number
  routerMetadata?: MessageDeliveryRouterMetadata
  // Main-owned admission bound for OpenCode queued steering. This is intentionally not persisted;
  // the journal enforces it in the same transaction that creates the preparing row.
  maxPendingQueueItems?: number
}>

export type MessageDeliveryProjection = Readonly<{
  id: string
  projectId: string
  sessionId: string
  messageId: string
  targetRootRunId: string
  targetPromptMessageId: string
  backend?: string
  runtimeThreadId?: string
  runtimeTurnId?: string
  requested: MessageDeliveryMode
  resolved?: ResolvedMessageDeliveryMode
  source?: MessageDeliveryDecisionSource
  routerMetadata?: MessageDeliveryRouterMetadata
  sequence: number
  lifecycle: MessageDeliveryLifecycle
  safeErrorCode?: string
  createdAt: number
  updatedAt: number
  revision: number
}>

const SAFE_ID_PATTERN = /^[^\r\n]{1,256}$/u

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const validateMessageDeliveryIdentifier = (value: unknown, label: string): string => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\u0000') ||
    !SAFE_ID_PATTERN.test(value)
  ) {
    throw new Error(`${label} must be a non-empty bounded identifier.`)
  }
  return value
}

const MESSAGE_DELIVERY_RENDERER_KEYS = new Set([
  'sessionId',
  'content',
  'parts',
  'attachments',
  'requested'
])

export const validateMessageDeliveryRendererRequest = (
  value: unknown
): MessageDeliveryRendererRequest => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Message delivery renderer request must be an object.')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !MESSAGE_DELIVERY_RENDERER_KEYS.has(key))) {
    throw new Error('Message delivery renderer request contains unsupported authority fields.')
  }
  const sessionId = validateMessageDeliveryIdentifier(record.sessionId, 'sessionId')
  if (typeof record.content !== 'string' || record.content.length > 256_000) {
    throw new Error('Message delivery content is invalid.')
  }
  if (
    record.requested !== undefined &&
    !MESSAGE_DELIVERY_MODES.includes(record.requested as MessageDeliveryMode)
  ) {
    throw new Error('Message delivery requested mode is invalid.')
  }
  if (record.parts !== undefined && !Array.isArray(record.parts)) {
    throw new Error('Message delivery parts must be an array.')
  }
  if (record.attachments !== undefined && !Array.isArray(record.attachments)) {
    throw new Error('Message delivery attachments must be an array.')
  }
  if (!record.requested) throw new Error('Message delivery requested mode is required.')
  return Object.freeze({
    sessionId,
    content: record.content,
    ...(record.parts === undefined
      ? {}
      : { parts: record.parts as MessageDeliveryRendererRequest['parts'] }),
    ...(record.attachments === undefined
      ? {}
      : {
          attachments: record.attachments as MessageDeliveryRendererRequest['attachments']
        }),
    requested: record.requested as MessageDeliveryMode
  })
}

const MESSAGE_DELIVERY_ADMISSION_KEYS = new Set([
  'status',
  'sessionId',
  'message',
  'delivery',
  'safeErrorCode'
])

const MESSAGE_DELIVERY_MESSAGE_KEYS = new Set([
  'id',
  'role',
  'content',
  'status',
  'streamId',
  'responseToMessageId',
  'eventIds',
  'artifactIds',
  'uploads',
  'images',
  'parts',
  'turnIntent',
  'turnUsage',
  'turnUsageUnavailable',
  'createdAt',
  'completedAt',
  'failedAt',
  'interrupted',
  'updatedAt'
])

const MESSAGE_DELIVERY_PROJECTION_KEYS = new Set([
  'id',
  'projectId',
  'sessionId',
  'messageId',
  'targetRootRunId',
  'targetPromptMessageId',
  'backend',
  'runtimeThreadId',
  'runtimeTurnId',
  'requested',
  'resolved',
  'source',
  'routerMetadata',
  'sequence',
  'lifecycle',
  'safeErrorCode',
  'createdAt',
  'updatedAt',
  'revision'
])

const assertStrictKeys = (
  value: Record<string, unknown>,
  keys: Set<string>,
  label: string
): void => {
  if (Object.keys(value).some((key) => !keys.has(key))) {
    throw new Error(`${label} contains unsupported fields.`)
  }
}

const assertSafeInteger = (value: unknown, label: string, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} is invalid.`)
  }
  return value as number
}

const validateMessageDeliveryMessageProjection = (
  value: unknown
): import('./session-persistence').PersistedChatMessage => {
  if (!isRecord(value)) throw new Error('Message delivery message projection is invalid.')
  assertStrictKeys(value, MESSAGE_DELIVERY_MESSAGE_KEYS, 'Message delivery message projection')
  validateMessageDeliveryIdentifier(value.id, 'Message delivery message id')
  if (value.role !== 'user' && value.role !== 'agent') {
    throw new Error('Message delivery message role is invalid.')
  }
  if (typeof value.content !== 'string' || value.content.length > 256_000) {
    throw new Error('Message delivery message content is invalid.')
  }
  if (!['complete', 'streaming', 'error'].includes(value.status as string)) {
    throw new Error('Message delivery message status is invalid.')
  }
  if (
    !Array.isArray(value.eventIds) ||
    value.eventIds.some((eventId) => {
      try {
        validateMessageDeliveryIdentifier(eventId, 'Message delivery event id')
        return false
      } catch {
        return true
      }
    })
  ) {
    throw new Error('Message delivery message event ids are invalid.')
  }
  for (const key of ['streamId', 'responseToMessageId'] as const) {
    if (value[key] !== undefined) validateMessageDeliveryIdentifier(value[key], key)
  }
  assertSafeInteger(value.createdAt, 'Message delivery message createdAt')
  assertSafeInteger(value.updatedAt, 'Message delivery message updatedAt')
  for (const key of ['completedAt', 'failedAt'] as const) {
    if (value[key] !== undefined) assertSafeInteger(value[key], `Message delivery message ${key}`)
  }
  if (value.artifactIds !== undefined && !Array.isArray(value.artifactIds)) {
    throw new Error('Message delivery message artifact ids are invalid.')
  }
  if (value.uploads !== undefined && !Array.isArray(value.uploads)) {
    throw new Error('Message delivery message uploads are invalid.')
  }
  if (value.parts !== undefined && !Array.isArray(value.parts)) {
    throw new Error('Message delivery message parts are invalid.')
  }
  return value as import('./session-persistence').PersistedChatMessage
}

export const validateMessageDeliveryProjection = (value: unknown): MessageDeliveryProjection => {
  if (!isRecord(value)) throw new Error('Message delivery projection is invalid.')
  assertStrictKeys(value, MESSAGE_DELIVERY_PROJECTION_KEYS, 'Message delivery projection')
  for (const key of [
    'id',
    'projectId',
    'sessionId',
    'messageId',
    'targetRootRunId',
    'targetPromptMessageId'
  ] as const) {
    validateMessageDeliveryIdentifier(value[key], `Message delivery ${key}`)
  }
  for (const key of ['backend', 'runtimeThreadId', 'runtimeTurnId'] as const) {
    if (value[key] !== undefined) validateMessageDeliveryIdentifier(value[key], key)
  }
  if (!MESSAGE_DELIVERY_MODES.includes(value.requested as MessageDeliveryMode)) {
    throw new Error('Message delivery projection requested mode is invalid.')
  }
  if (
    value.resolved !== undefined &&
    !['continue', 'steer', 'side-question', 'stop-and-replace'].includes(value.resolved as string)
  ) {
    throw new Error('Message delivery projection resolved mode is invalid.')
  }
  if (
    value.source !== undefined &&
    !MESSAGE_DELIVERY_DECISION_SOURCES.includes(value.source as MessageDeliveryDecisionSource)
  ) {
    throw new Error('Message delivery projection decision source is invalid.')
  }
  if (value.routerMetadata !== undefined)
    validateMessageDeliveryRouterMetadata(value.routerMetadata)
  if (!MESSAGE_DELIVERY_LIFECYCLES.includes(value.lifecycle as MessageDeliveryLifecycle)) {
    throw new Error('Message delivery projection lifecycle is invalid.')
  }
  if (value.safeErrorCode !== undefined) validateSafeMessageDeliveryErrorCode(value.safeErrorCode)
  assertSafeInteger(value.sequence, 'Message delivery projection sequence')
  assertSafeInteger(value.createdAt, 'Message delivery projection createdAt')
  assertSafeInteger(value.updatedAt, 'Message delivery projection updatedAt')
  assertSafeInteger(value.revision, 'Message delivery projection revision', 1)
  return value as MessageDeliveryProjection
}

const validateSafeMessageDeliveryErrorCode = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error('Message delivery safe error code is invalid.')
  }
  return value
}

export const validateMessageDeliveryAdmissionResult = (
  value: unknown
): MessageDeliveryAdmissionResult => {
  if (!isRecord(value)) throw new Error('Message delivery admission result is invalid.')
  assertStrictKeys(value, MESSAGE_DELIVERY_ADMISSION_KEYS, 'Message delivery admission result')
  if (!['accepted', 'stale', 'blocked', 'failed'].includes(value.status as string)) {
    throw new Error('Message delivery admission status is invalid.')
  }
  const sessionId = validateMessageDeliveryIdentifier(
    value.sessionId,
    'Message delivery admission session id'
  )
  const message =
    value.message === undefined
      ? undefined
      : validateMessageDeliveryMessageProjection(value.message)
  const delivery =
    value.delivery === undefined ? undefined : validateMessageDeliveryProjection(value.delivery)
  if (delivery && delivery.sessionId !== sessionId) {
    throw new Error('Message delivery admission projection session differs from the result.')
  }
  if (message && delivery && delivery.messageId !== message.id) {
    throw new Error('Message delivery admission message differs from the journal projection.')
  }
  const safeErrorCode =
    value.safeErrorCode === undefined
      ? undefined
      : validateSafeMessageDeliveryErrorCode(value.safeErrorCode)
  return Object.freeze({
    status: value.status as MessageDeliveryAdmissionStatus,
    sessionId,
    ...(message ? { message } : {}),
    ...(delivery ? { delivery } : {}),
    ...(safeErrorCode ? { safeErrorCode } : {})
  })
}

export const validateMessageDeliveryCommandResult = (
  value: unknown
): MessageDeliveryCommandResult => {
  if (!isRecord(value)) throw new Error('Message delivery command result is invalid.')
  if (value.kind === 'delivery') {
    const admission = { ...value }
    delete admission.kind
    return Object.freeze({ kind: 'delivery', ...validateMessageDeliveryAdmissionResult(admission) })
  }
  if (value.kind === 'side-question') {
    const sessionId = validateMessageDeliveryIdentifier(
      value.sessionId,
      'Side-question result Session id'
    )
    if (
      !['accepted', 'completed', 'failed', 'cancelled', 'blocked'].includes(value.status as string)
    ) {
      throw new Error('Side-question command status is invalid.')
    }
    const sideQuestion =
      value.sideQuestion === undefined
        ? undefined
        : validatePersistedSideQuestion(value.sideQuestion as PersistedSideQuestion)
    const safeErrorCode =
      value.safeErrorCode === undefined
        ? undefined
        : validateSafeMessageDeliveryErrorCode(value.safeErrorCode)
    return Object.freeze({
      kind: 'side-question',
      status: value.status as SideQuestionAdmissionResult['status'],
      sessionId,
      ...(sideQuestion ? { sideQuestion } : {}),
      ...(safeErrorCode ? { safeErrorCode } : {})
    })
  }
  throw new Error('Message delivery command result kind is invalid.')
}

export const validateMessageDeliveryRouterResult = (
  value: unknown
): MessageDeliveryRouterResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Message delivery router result must be an object.')
  }
  const record = value as Record<string, unknown>
  const recommendation = record.recommendation
  if (
    typeof recommendation !== 'object' ||
    recommendation === null ||
    Array.isArray(recommendation)
  ) {
    throw new Error('Message delivery router recommendation is missing.')
  }
  const recommendationRecord = recommendation as Record<string, unknown>
  if (
    !['steer', 'side-question', 'stop-and-replace'].includes(recommendationRecord.mode as string) ||
    !isUnitInterval(recommendationRecord.confidence)
  ) {
    throw new Error('Message delivery router recommendation is invalid.')
  }
  if (
    recommendationRecord.reason !== undefined &&
    (typeof recommendationRecord.reason !== 'string' ||
      recommendationRecord.reason.length > 512 ||
      recommendationRecord.reason.includes('\u0000') ||
      recommendationRecord.reason.includes('\r') ||
      recommendationRecord.reason.includes('\n'))
  ) {
    throw new Error('Message delivery router recommendation reason is invalid.')
  }
  const metadata = validateMessageDeliveryRouterMetadata(record.metadata)
  return Object.freeze({
    recommendation: Object.freeze({
      mode: recommendationRecord.mode as MessageDeliveryRecommendation['mode'],
      confidence: recommendationRecord.confidence,
      ...(recommendationRecord.reason === undefined ? {} : { reason: recommendationRecord.reason })
    }),
    ...(metadata ? { metadata } : {})
  })
}

export const validateMessageDeliveryRouterMetadata = (
  value: unknown
): MessageDeliveryRouterMetadata | undefined => {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('Message delivery router metadata must be an object.')
  if (
    value.confidence !== undefined &&
    (typeof value.confidence !== 'number' ||
      !Number.isFinite(value.confidence) ||
      value.confidence < 0 ||
      value.confidence > 1)
  ) {
    throw new Error('Message delivery router confidence is invalid.')
  }
  const classifierAttemptId =
    value.classifierAttemptId === undefined
      ? undefined
      : validateMessageDeliveryIdentifier(
          value.classifierAttemptId,
          'routerMetadata.classifierAttemptId'
        )
  const modelId =
    value.modelId === undefined
      ? undefined
      : validateMessageDeliveryIdentifier(value.modelId, 'routerMetadata.modelId')
  const policyId =
    value.policyId === undefined
      ? undefined
      : validateMessageDeliveryIdentifier(value.policyId, 'routerMetadata.policyId')
  const policyVersion =
    value.policyVersion === undefined
      ? undefined
      : validateMessageDeliveryIdentifier(value.policyVersion, 'routerMetadata.policyVersion')
  const reasonCode =
    value.reasonCode === undefined
      ? undefined
      : validateMessageDeliveryIdentifier(value.reasonCode, 'routerMetadata.reasonCode')
  return Object.freeze({
    ...(value.confidence === undefined ? {} : { confidence: value.confidence }),
    ...(classifierAttemptId === undefined ? {} : { classifierAttemptId }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(policyId === undefined ? {} : { policyId }),
    ...(policyVersion === undefined ? {} : { policyVersion }),
    ...(reasonCode === undefined ? {} : { reasonCode })
  })
}

export const validateMessageDeliveryRequest = (
  value: MessageDeliveryRequest
): MessageDeliveryRequest => {
  if (!isRecord(value)) throw new Error('Message delivery request must be an object.')
  for (const key of [
    'id',
    'projectId',
    'sessionId',
    'messageId',
    'targetRootRunId',
    'targetPromptMessageId'
  ] as const) {
    validateMessageDeliveryIdentifier(value[key], key)
  }
  for (const key of ['backend', 'runtimeThreadId', 'runtimeTurnId'] as const) {
    if (value[key] !== undefined) validateMessageDeliveryIdentifier(value[key], key)
  }
  if (!MESSAGE_DELIVERY_MODES.includes(value.requested)) {
    throw new Error('Message delivery requested mode is invalid.')
  }
  if (typeof value.hasActiveTurn !== 'boolean') {
    throw new Error('Message delivery active-turn state is invalid.')
  }
  if (
    value.confidenceThreshold !== undefined &&
    (!Number.isFinite(value.confidenceThreshold) ||
      value.confidenceThreshold < 0 ||
      value.confidenceThreshold > 1)
  ) {
    throw new Error('Message delivery confidence threshold is invalid.')
  }
  if (
    value.maxPendingQueueItems !== undefined &&
    (!Number.isSafeInteger(value.maxPendingQueueItems) || value.maxPendingQueueItems < 1)
  ) {
    throw new Error('Message delivery pending queue limit is invalid.')
  }
  if (value.recommendation !== undefined) {
    if (!isRecord(value.recommendation)) {
      throw new Error('Message delivery recommendation must be an object.')
    }
    if (
      !['steer', 'side-question', 'stop-and-replace'].includes(
        value.recommendation.mode as string
      ) ||
      typeof value.recommendation.confidence !== 'number' ||
      !Number.isFinite(value.recommendation.confidence) ||
      value.recommendation.confidence < 0 ||
      value.recommendation.confidence > 1
    ) {
      throw new Error('Message delivery recommendation is invalid.')
    }
    if (
      value.recommendation.reason !== undefined &&
      (typeof value.recommendation.reason !== 'string' ||
        value.recommendation.reason.length > 512 ||
        value.recommendation.reason.includes('\u0000') ||
        value.recommendation.reason.includes('\r') ||
        value.recommendation.reason.includes('\n'))
    ) {
      throw new Error('Message delivery recommendation reason is invalid.')
    }
  }
  const routerMetadata = validateMessageDeliveryRouterMetadata(value.routerMetadata)
  return Object.freeze({ ...value, ...(routerMetadata ? { routerMetadata } : {}) })
}

export const validateMessageDeliveryTransition = (
  current: MessageDeliveryLifecycle,
  next: MessageDeliveryLifecycle
): void => {
  if (
    !MESSAGE_DELIVERY_LIFECYCLES.includes(current) ||
    !MESSAGE_DELIVERY_LIFECYCLES.includes(next)
  ) {
    throw new Error('Message delivery lifecycle is invalid.')
  }
  if (current === next) return
  const allowed: Readonly<Record<MessageDeliveryLifecycle, readonly MessageDeliveryLifecycle[]>> = {
    preparing: ['ready', 'queued', 'abandoned', 'blocked'],
    ready: ['queued', 'dispatched', 'failed', 'cancelled', 'blocked'],
    queued: ['dispatching', 'dispatched', 'failed', 'cancelled', 'blocked'],
    dispatching: ['accepted', 'failed', 'cancelled', 'blocked'],
    accepted: ['completed', 'failed', 'cancelled', 'blocked'],
    dispatched: ['completed', 'failed', 'cancelled', 'blocked'],
    completed: [],
    failed: [],
    cancelled: [],
    blocked: [],
    abandoned: []
  }
  if (!allowed[current].includes(next)) {
    throw new Error(`Message delivery cannot transition from ${current} to ${next}.`)
  }
}

export type MessageDeliveryRecommendation = Readonly<{
  mode: Exclude<MessageDeliveryMode, 'auto'>
  confidence: number
  reason?: string
}>

export type ResolveMessageDeliveryInput = Readonly<{
  requested: MessageDeliveryMode
  hasActiveTurn: boolean
  recommendation?: MessageDeliveryRecommendation
  confidenceThreshold?: number
}>

export type MessageDeliveryDecision = Readonly<{
  requested: MessageDeliveryMode
  resolved: ResolvedMessageDeliveryMode
  source: 'explicit' | 'idle-default' | 'router' | 'safe-default'
  reason: string
}>

const ROUTER_MODES = new Set<MessageDeliveryRecommendation['mode']>([
  'steer',
  'side-question',
  'stop-and-replace'
])

const isUnitInterval = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

// Auto routing chooses only a delivery path; it never edits the message. When an active turn exists,
// uncertainty resolves to a read-only side question because that cannot cancel or redirect the work.
export const resolveMessageDelivery = (
  input: ResolveMessageDeliveryInput
): MessageDeliveryDecision => {
  if (input.requested !== 'auto') {
    return {
      requested: input.requested,
      resolved: input.requested,
      source: 'explicit',
      reason: 'User selected the delivery mode.'
    }
  }
  if (!input.hasActiveTurn) {
    return {
      requested: 'auto',
      resolved: 'continue',
      source: 'idle-default',
      reason: 'No active turn exists.'
    }
  }

  const threshold = input.confidenceThreshold === undefined ? 0.75 : input.confidenceThreshold
  const recommendation = input.recommendation
  if (
    isUnitInterval(threshold) &&
    recommendation &&
    ROUTER_MODES.has(recommendation.mode) &&
    isUnitInterval(recommendation.confidence) &&
    recommendation.confidence >= threshold
  ) {
    return {
      requested: 'auto',
      resolved: recommendation.mode,
      source: 'router',
      reason:
        typeof recommendation.reason === 'string' && recommendation.reason.trim()
          ? recommendation.reason.trim()
          : 'Interaction router met the confidence threshold.'
    }
  }

  return {
    requested: 'auto',
    resolved: 'side-question',
    source: 'safe-default',
    reason: 'The delivery intent was uncertain, so the active turn remains unchanged.'
  }
}
