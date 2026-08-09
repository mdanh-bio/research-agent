export const MESSAGE_DELIVERY_MODES = [
  'auto',
  'steer',
  'side-question',
  'stop-and-replace'
] as const

export type MessageDeliveryMode = (typeof MESSAGE_DELIVERY_MODES)[number]
export type ResolvedMessageDeliveryMode = Exclude<MessageDeliveryMode, 'auto'> | 'continue'

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
      reason: recommendation.reason?.trim() || 'Interaction router met the confidence threshold.'
    }
  }

  return {
    requested: 'auto',
    resolved: 'side-question',
    source: 'safe-default',
    reason: 'The delivery intent was uncertain, so the active turn remains unchanged.'
  }
}
