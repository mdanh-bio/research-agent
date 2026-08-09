import { describe, expect, it } from 'vitest'

import type { ModelTarget, RouteDecision } from '../../shared/model-routing'
import {
  type BenignRefusalApprovalEvidence,
  classifyModelFailure,
  computeRequestIdentity,
  evaluateAutomaticFallback,
  type PersistedFallbackAttempt
} from './fallback-policy'

const nextTarget: ModelTarget = {
  id: 'alternate',
  backend: 'opencode',
  providerId: 'provider-b',
  model: 'model-b',
  reasoningEffort: 'high',
  capabilities: ['text', 'tool_use'],
  dataBoundary: 'approved_cloud'
}

const secondTarget: ModelTarget = { ...nextTarget, id: 'alternate-2', model: 'model-c' }
const primaryTarget: ModelTarget = { ...nextTarget, id: 'primary', model: 'model-a' }
const routeDecision = {
  policyId: 'research-max.analysis',
  policyVersion: '7',
  dataBoundary: 'approved_cloud',
  target: primaryTarget,
  eligibleAlternates: [nextTarget, secondTarget]
} satisfies Pick<
  RouteDecision,
  'policyId' | 'policyVersion' | 'dataBoundary' | 'target' | 'eligibleAlternates'
>

const attempt = (
  sequence: number,
  target: ModelTarget,
  requestIdentity: ReturnType<typeof computeRequestIdentity>,
  sideEffectsStarted = false
): PersistedFallbackAttempt => ({
  id: `attempt-${sequence}`,
  sequence,
  target,
  requestIdentity,
  sideEffectsStarted
})

const request = {
  body: new TextEncoder().encode('{"input":"benign biology request"}'),
  attachments: [{ name: 'sequence.fasta', sha256: `sha256:${'a'.repeat(64)}`, sizeBytes: 42 }]
} as const

const approval = (
  failedAttempt: PersistedFallbackAttempt,
  alternateTarget: ModelTarget
): BenignRefusalApprovalEvidence => ({
  approvalId: 'approval-1',
  approvedBy: 'user',
  approvedAt: 1_700_000_000_000,
  singleUse: true,
  researchScope: {
    id: 'scope-1',
    version: '2',
    projectId: 'project-1',
    permitsBenignResearchRefusalFallback: true,
    dataBoundary: routeDecision.dataBoundary,
    approvedProviderIds: [alternateTarget.providerId]
  },
  sessionId: 'session-1',
  agentRunId: 'run-1',
  failedAttemptId: failedAttempt.id,
  policyId: routeDecision.policyId,
  policyVersion: routeDecision.policyVersion,
  requestIdentity: failedAttempt.requestIdentity,
  sourceTarget: failedAttempt.target,
  alternateTarget
})

describe('request identity', () => {
  it('is stable for byte-equivalent requests and changes with body or attachment identity', () => {
    const identity = computeRequestIdentity(request)
    expect(computeRequestIdentity(request)).toBe(identity)
    expect(computeRequestIdentity({ ...request, body: '{"input":"changed"}' })).not.toBe(identity)
    expect(
      computeRequestIdentity({
        ...request,
        attachments: [{ name: 'sequence.fasta', sha256: `sha256:${'b'.repeat(64)}`, sizeBytes: 42 }]
      })
    ).not.toBe(identity)
  })

  it('rejects unbranded attachment digests and invalid sizes instead of hashing caller claims', () => {
    expect(() =>
      computeRequestIdentity({
        body: 'request',
        attachments: [{ name: 'input', sha256: 'constant', sizeBytes: 1 }]
      })
    ).toThrow('sha256')
    expect(() =>
      computeRequestIdentity({
        body: 'request',
        attachments: [{ name: 'input', sha256: `sha256:${'a'.repeat(64)}`, sizeBytes: -1 }]
      })
    ).toThrow('sizeBytes')
  })
})

describe('fallback classification and guardrails', () => {
  it.each([
    [{ httpStatus: 429 }, 'rate_limit'],
    [{ code: 'ETIMEDOUT' }, 'timeout'],
    [{ httpStatus: 503 }, 'provider_unavailable'],
    [{ category: 'malformed_response' as const }, 'malformed_response']
  ])('classifies automatic failure %j as %s', (evidence, category) => {
    expect(classifyModelFailure(evidence)).toEqual({ category, disposition: 'automatic' })
  })

  it('requires explicit review for ambiguous safety and never infers benign intent from prose', () => {
    expect(classifyModelFailure({ category: 'ambiguous_safety' })).toEqual({
      category: 'ambiguous_safety',
      disposition: 'user_review'
    })
    expect(classifyModelFailure({ code: 'policy_refusal' })).toEqual({
      category: 'unknown',
      disposition: 'terminal'
    })
    expect(classifyModelFailure({ category: 'benign_research_refusal' })).toEqual({
      category: 'benign_research_refusal',
      disposition: 'user_review'
    })
  })

  it('allows an unchanged, side-effect-free automatic retry', () => {
    const identity = computeRequestIdentity(request)
    expect(
      evaluateAutomaticFallback({
        failure: { httpStatus: 429 },
        routeDecision,
        attempts: [attempt(0, primaryTarget, identity)]
      })
    ).toMatchObject({
      action: 'retry_alternate',
      reason: 'automatic_retry_allowed',
      nextTarget
    })
  })

  it('blocks replay after side effects and requests a recovery handoff', () => {
    const identity = computeRequestIdentity(request)
    expect(
      evaluateAutomaticFallback({
        failure: { category: 'provider_unavailable' },
        routeDecision,
        attempts: [attempt(0, primaryTarget, identity, true)]
      })
    ).toMatchObject({ action: 'recovery_handoff', reason: 'side_effects_started' })
  })

  it('blocks a changed request and stops after two alternate attempts', () => {
    const identity = computeRequestIdentity(request)
    expect(
      evaluateAutomaticFallback({
        failure: { category: 'timeout' },
        routeDecision,
        attempts: [
          attempt(0, primaryTarget, identity),
          attempt(1, nextTarget, computeRequestIdentity({ body: 'changed' }))
        ]
      })
    ).toMatchObject({ action: 'stop', reason: 'request_identity_changed' })

    expect(
      evaluateAutomaticFallback({
        failure: { category: 'timeout' },
        routeDecision,
        attempts: [
          attempt(0, primaryTarget, identity),
          attempt(1, nextTarget, identity),
          attempt(2, secondTarget, identity)
        ]
      })
    ).toMatchObject({ action: 'stop', reason: 'alternate_limit_reached' })
  })

  it('never retries ambiguous safety failures or terminal authentication errors', () => {
    const identity = computeRequestIdentity(request)
    const base = {
      routeDecision,
      attempts: [attempt(0, primaryTarget, identity)]
    }
    expect(
      evaluateAutomaticFallback({ ...base, failure: { category: 'ambiguous_safety' } })
    ).toMatchObject({ action: 'user_review', reason: 'safety_review_required' })
    expect(evaluateAutomaticFallback({ ...base, failure: { httpStatus: 401 } })).toMatchObject({
      action: 'stop',
      reason: 'terminal_failure'
    })
  })

  it('derives the next target from the resolved route and rejects forged attempt history', () => {
    const identity = computeRequestIdentity(request)
    expect(
      evaluateAutomaticFallback({
        failure: { category: 'timeout' },
        routeDecision,
        attempts: [attempt(0, primaryTarget, identity), attempt(1, nextTarget, identity)]
      })
    ).toMatchObject({ action: 'retry_alternate', nextTarget: secondTarget })

    expect(() =>
      evaluateAutomaticFallback({
        failure: { category: 'timeout' },
        routeDecision,
        attempts: [attempt(0, { ...primaryTarget, providerId: 'attacker-provider' }, identity)]
      })
    ).toThrow('does not match')
  })

  it('requires exact auditable scope evidence before treating benign refusal as automatic', () => {
    const identity = computeRequestIdentity(request)
    const failedAttempt = attempt(0, primaryTarget, identity)
    const base = {
      failure: { category: 'benign_research_refusal' as const },
      routeDecision,
      attempts: [failedAttempt]
    }

    expect(evaluateAutomaticFallback(base)).toMatchObject({
      action: 'user_review',
      reason: 'benign_refusal_approval_required'
    })
    expect(
      evaluateAutomaticFallback({
        ...base,
        benignRefusalApproval: {
          ...approval(failedAttempt, nextTarget),
          alternateTarget: { ...nextTarget, model: 'attacker-model' }
        }
      })
    ).toMatchObject({ action: 'user_review', reason: 'benign_refusal_approval_required' })
    expect(
      evaluateAutomaticFallback({
        ...base,
        benignRefusalApproval: approval(failedAttempt, nextTarget)
      })
    ).toMatchObject({ action: 'retry_alternate', nextTarget })
  })
})
