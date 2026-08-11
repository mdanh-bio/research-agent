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
  reasonCode?: string
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
  const reasonCode =
    value.reasonCode === undefined
      ? undefined
      : validateMessageDeliveryIdentifier(value.reasonCode, 'routerMetadata.reasonCode')
  return Object.freeze({
    ...(value.confidence === undefined ? {} : { confidence: value.confidence }),
    ...(classifierAttemptId === undefined ? {} : { classifierAttemptId }),
    ...(modelId === undefined ? {} : { modelId }),
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
    queued: ['dispatched', 'failed', 'cancelled', 'blocked'],
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
