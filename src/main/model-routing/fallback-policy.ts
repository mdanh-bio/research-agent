import { createHash } from 'node:crypto'

import {
  modelTargetsEqual,
  type DataBoundary,
  type ModelFailureCategory,
  type ModelTarget,
  type RouteDecision
} from '../../shared/model-routing'
import { MAX_AUTOMATIC_ALTERNATES } from './policy-planner'

export type RequestAttachmentIdentity = Readonly<{
  name: string
  sha256: string
  sizeBytes: number
}>

export type RequestIdentityInput = Readonly<{
  body: string | Uint8Array
  attachments?: readonly RequestAttachmentIdentity[]
}>

declare const requestIdentityBrand: unique symbol
export type RequestIdentity = string & { readonly [requestIdentityBrand]: true }

export const REQUEST_IDENTITY_PREFIX = 'sha256:research-agent-request-v2:'
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const REQUEST_IDENTITY_PATTERN = /^sha256:research-agent-request-v2:[0-9a-f]{64}$/

export type BenignRefusalApprovalEvidence = Readonly<{
  approvalId: string
  approvedBy: 'user'
  approvedAt: number
  singleUse: true
  researchScope: Readonly<{
    id: string
    version: string
    projectId: string
    permitsBenignResearchRefusalFallback: true
    dataBoundary: DataBoundary
    approvedProviderIds: readonly string[]
  }>
  sessionId: string
  agentRunId: string
  failedAttemptId: string
  policyId: string
  policyVersion: string
  requestIdentity: RequestIdentity
  sourceTarget: ModelTarget
  alternateTarget: ModelTarget
}>

export type BenignRefusalApprovalExpectation = Readonly<{
  projectId: string
  sessionId: string
  agentRunId: string
  failedAttemptId: string
  policyId: string
  policyVersion: string
  requestIdentity: RequestIdentity
  dataBoundary: DataBoundary
  sourceTarget: ModelTarget
  alternateTarget: ModelTarget
}>

export type ModelFailureEvidence = Readonly<{
  // Refusal categories must be assigned by an audited upstream classifier. This module deliberately
  // does not infer benign research or safety intent from untrusted provider prose.
  category?: ModelFailureCategory
  httpStatus?: number
  code?: string
}>

export type FallbackDisposition = 'automatic' | 'user_review' | 'terminal'

export type ClassifiedModelFailure = Readonly<{
  category: ModelFailureCategory
  disposition: FallbackDisposition
}>

export type FallbackAction = 'retry_alternate' | 'recovery_handoff' | 'user_review' | 'stop'

export type FallbackBlockReason =
  | 'automatic_retry_allowed'
  | 'side_effects_started'
  | 'request_identity_changed'
  | 'alternate_limit_reached'
  | 'no_alternate'
  | 'benign_refusal_approval_required'
  | 'safety_review_required'
  | 'terminal_failure'

export type AutomaticFallbackDecision = Readonly<{
  action: FallbackAction
  reason: FallbackBlockReason
  failure: ClassifiedModelFailure
  nextTarget?: ModelTarget
}>

export type PersistedFallbackAttempt = Readonly<{
  id: string
  sequence: number
  target: ModelTarget
  requestIdentity: RequestIdentity
  sideEffectsStarted: boolean
}>

export type AutomaticFallbackInput = Readonly<{
  failure: ModelFailureEvidence
  routeDecision: Pick<
    RouteDecision,
    'policyId' | 'policyVersion' | 'dataBoundary' | 'target' | 'eligibleAlternates'
  >
  // Must be loaded from the attempt ledger in ascending sequence order. The evaluator derives the
  // retry count, request identity, side-effect state, and next target rather than trusting caller
  // supplied summaries or an arbitrary target.
  attempts: readonly PersistedFallbackAttempt[]
  benignRefusalApproval?: BenignRefusalApprovalEvidence
}>

const updateFramed = (hash: ReturnType<typeof createHash>, value: Uint8Array): void => {
  hash.update(String(value.byteLength))
  hash.update(':')
  hash.update(value)
  hash.update('\0')
}

// Hashes exactly the request bytes plus the ordered attachment identities. Raw prompt/attachment
// content never enters the routing ledger; callers persist only the returned digest.
export const computeRequestIdentity = (input: RequestIdentityInput): RequestIdentity => {
  if (!input || typeof input !== 'object') {
    throw new Error('Request identity input is required.')
  }
  if (typeof input.body !== 'string' && !(input.body instanceof Uint8Array)) {
    throw new Error('Request body must be a string or Uint8Array.')
  }
  if (input.attachments !== undefined && !Array.isArray(input.attachments)) {
    throw new Error('Request attachments must be an array.')
  }
  const hash = createHash('sha256')
  hash.update('research-agent-request-v2\0')
  updateFramed(hash, typeof input.body === 'string' ? Buffer.from(input.body) : input.body)
  for (const attachment of input.attachments ?? []) {
    if (!attachment || typeof attachment !== 'object') {
      throw new Error('Every request attachment identity must be an object.')
    }
    if (typeof attachment.name !== 'string' || !attachment.name.trim()) {
      throw new Error('Attachment name is required.')
    }
    if (!SHA256_DIGEST_PATTERN.test(attachment.sha256)) {
      throw new Error('Attachment sha256 must be a lowercase sha256:<64 hex> digest.')
    }
    if (!Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0) {
      throw new Error('Attachment sizeBytes must be a non-negative safe integer.')
    }
    updateFramed(hash, Buffer.from(attachment.name))
    updateFramed(hash, Buffer.from(attachment.sha256))
    updateFramed(hash, Buffer.from(String(attachment.sizeBytes)))
  }
  return `${REQUEST_IDENTITY_PREFIX}${hash.digest('hex')}` as RequestIdentity
}

export const isRequestIdentity = (value: unknown): value is RequestIdentity =>
  typeof value === 'string' && REQUEST_IDENTITY_PATTERN.test(value)

const assertNonEmpty = (value: unknown, label: string): void => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
}

export const assertBenignRefusalApprovalEvidence = (
  approval: BenignRefusalApprovalEvidence,
  expected: BenignRefusalApprovalExpectation
): void => {
  if (!approval || typeof approval !== 'object') {
    throw new Error('Benign-refusal fallback requires approval evidence.')
  }
  assertNonEmpty(approval.approvalId, 'approvalId')
  if (approval.approvedBy !== 'user' || approval.singleUse !== true) {
    throw new Error('Benign-refusal approval must be explicit, user-issued, and single-use.')
  }
  if (!Number.isSafeInteger(approval.approvedAt) || approval.approvedAt < 0) {
    throw new Error('Benign-refusal approvedAt must be a non-negative epoch millisecond value.')
  }
  if (!approval.researchScope || typeof approval.researchScope !== 'object') {
    throw new Error('Benign-refusal approval requires research-scope evidence.')
  }
  assertNonEmpty(approval.researchScope.id, 'researchScope.id')
  assertNonEmpty(approval.researchScope.version, 'researchScope.version')
  if (approval.researchScope.permitsBenignResearchRefusalFallback !== true) {
    throw new Error('The approved research scope does not permit benign-refusal fallback.')
  }
  if (
    !Array.isArray(approval.researchScope.approvedProviderIds) ||
    !approval.researchScope.approvedProviderIds.includes(expected.alternateTarget.providerId)
  ) {
    throw new Error('The alternate provider is outside the approved research scope.')
  }
  if (
    !approval.researchScope.approvedProviderIds.every(
      (providerId) => typeof providerId === 'string' && providerId.trim()
    )
  ) {
    throw new Error('Approved provider ids must be non-empty.')
  }
  if (
    approval.researchScope.projectId !== expected.projectId ||
    approval.researchScope.dataBoundary !== expected.dataBoundary ||
    approval.sessionId !== expected.sessionId ||
    approval.agentRunId !== expected.agentRunId ||
    approval.failedAttemptId !== expected.failedAttemptId ||
    approval.policyId !== expected.policyId ||
    approval.policyVersion !== expected.policyVersion ||
    approval.requestIdentity !== expected.requestIdentity ||
    !modelTargetsEqual(approval.sourceTarget, expected.sourceTarget) ||
    !modelTargetsEqual(approval.alternateTarget, expected.alternateTarget)
  ) {
    throw new Error('Benign-refusal approval evidence does not match the fallback scope.')
  }
  if (!isRequestIdentity(approval.requestIdentity)) {
    throw new Error('Benign-refusal approval has an invalid request identity.')
  }
}

const failureDisposition = (category: ModelFailureCategory): FallbackDisposition => {
  if (
    category === 'timeout' ||
    category === 'rate_limit' ||
    category === 'provider_unavailable' ||
    category === 'malformed_response'
  ) {
    return 'automatic'
  }
  return category === 'ambiguous_safety' || category === 'benign_research_refusal'
    ? 'user_review'
    : 'terminal'
}

const categoryFromCode = (code: string | undefined): ModelFailureCategory | undefined => {
  const normalized = code?.trim().toLowerCase()
  if (!normalized) return undefined
  if (['etimedout', 'timeout', 'request_timeout'].includes(normalized)) return 'timeout'
  if (['rate_limit', 'rate_limit_exceeded', 'too_many_requests'].includes(normalized)) {
    return 'rate_limit'
  }
  if (
    [
      'econnrefused',
      'econnreset',
      'enotfound',
      'provider_unavailable',
      'service_unavailable'
    ].includes(normalized)
  ) {
    return 'provider_unavailable'
  }
  if (['malformed_response', 'response_parse_error', 'invalid_response'].includes(normalized)) {
    return 'malformed_response'
  }
  if (['authentication', 'authentication_error', 'invalid_api_key'].includes(normalized)) {
    return 'authentication'
  }
  if (['context_length_exceeded', 'context_overflow'].includes(normalized)) {
    return 'context_overflow'
  }
  if (['invalid_request', 'invalid_request_error'].includes(normalized)) return 'invalid_request'
  return undefined
}

export const classifyModelFailure = (evidence: ModelFailureEvidence): ClassifiedModelFailure => {
  let category = evidence.category ?? categoryFromCode(evidence.code)
  if (!category) {
    const status = evidence.httpStatus
    if (status === 408 || status === 504) category = 'timeout'
    else if (status === 429) category = 'rate_limit'
    else if (status === 401 || status === 403) category = 'authentication'
    else if (status === 413) category = 'context_overflow'
    else if (status !== undefined && status >= 500) category = 'provider_unavailable'
    else if (status === 400 || status === 404 || status === 409 || status === 422) {
      category = 'invalid_request'
    } else category = 'unknown'
  }
  return Object.freeze({ category, disposition: failureDisposition(category) })
}

export const evaluateAutomaticFallback = (
  input: AutomaticFallbackInput
): AutomaticFallbackDecision => {
  if (input.attempts.length === 0) {
    throw new Error('At least one persisted model attempt is required.')
  }
  if (input.attempts.length > MAX_AUTOMATIC_ALTERNATES + 1) {
    throw new Error('Persisted attempt history exceeds the automatic fallback limit.')
  }
  for (const [index, attempt] of input.attempts.entries()) {
    const expectedTarget =
      index === 0 ? input.routeDecision.target : input.routeDecision.eligibleAlternates[index - 1]
    if (
      attempt.sequence !== index ||
      !expectedTarget ||
      !modelTargetsEqual(attempt.target, expectedTarget) ||
      !isRequestIdentity(attempt.requestIdentity)
    ) {
      throw new Error('Persisted attempt history does not match the resolved route decision.')
    }
  }

  const originalAttempt = input.attempts[0]!
  const currentAttempt = input.attempts.at(-1)!
  const alternateAttemptsUsed = input.attempts.length - 1
  const nextTarget = input.routeDecision.eligibleAlternates[alternateAttemptsUsed]

  let failure = classifyModelFailure(input.failure)
  if (failure.category === 'benign_research_refusal') {
    if (!input.benignRefusalApproval || !nextTarget) {
      return Object.freeze({
        action: 'user_review',
        reason: 'benign_refusal_approval_required',
        failure
      })
    }
    try {
      assertBenignRefusalApprovalEvidence(input.benignRefusalApproval, {
        projectId: input.benignRefusalApproval.researchScope.projectId,
        sessionId: input.benignRefusalApproval.sessionId,
        agentRunId: input.benignRefusalApproval.agentRunId,
        failedAttemptId: currentAttempt.id,
        policyId: input.routeDecision.policyId,
        policyVersion: input.routeDecision.policyVersion,
        requestIdentity: currentAttempt.requestIdentity,
        dataBoundary: input.routeDecision.dataBoundary,
        sourceTarget: currentAttempt.target,
        alternateTarget: nextTarget
      })
    } catch {
      return Object.freeze({
        action: 'user_review',
        reason: 'benign_refusal_approval_required',
        failure
      })
    }
    // Structural validation is advisory here; the authoritative ledger additionally verifies the
    // approval issuer and enforces single use before reserving an attempt.
    failure = Object.freeze({ category: failure.category, disposition: 'automatic' })
  }
  if (failure.disposition === 'user_review') {
    return Object.freeze({ action: 'user_review', reason: 'safety_review_required', failure })
  }
  if (failure.disposition === 'terminal') {
    return Object.freeze({ action: 'stop', reason: 'terminal_failure', failure })
  }
  if (input.attempts.some((attempt) => attempt.sideEffectsStarted)) {
    return Object.freeze({ action: 'recovery_handoff', reason: 'side_effects_started', failure })
  }
  if (originalAttempt.requestIdentity !== currentAttempt.requestIdentity) {
    return Object.freeze({ action: 'stop', reason: 'request_identity_changed', failure })
  }
  if (alternateAttemptsUsed >= MAX_AUTOMATIC_ALTERNATES) {
    return Object.freeze({ action: 'stop', reason: 'alternate_limit_reached', failure })
  }
  if (!nextTarget) {
    return Object.freeze({ action: 'stop', reason: 'no_alternate', failure })
  }

  return Object.freeze({
    action: 'retry_alternate',
    reason: 'automatic_retry_allowed',
    failure,
    nextTarget
  })
}
