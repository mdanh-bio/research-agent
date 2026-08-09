import { describe, expect, it } from 'vitest'

import type {
  DataBoundary,
  ModelCapability,
  ModelRoutePolicy,
  ModelTarget,
  WorkClass
} from '../../shared/model-routing'
import { createDefaultRoutingProfiles } from './default-profiles'
import {
  MAX_AUTOMATIC_ALTERNATES,
  NoEligibleModelRouteError,
  resolveRouteDecision
} from './policy-planner'

const target = (id: string, overrides: Partial<ModelTarget> = {}): ModelTarget => ({
  id,
  backend: 'codex',
  providerId: `provider-${id}`,
  model: `model-${id}`,
  reasoningEffort: 'high',
  capabilities: ['text', 'tool_use', 'reasoning', 'long_context'],
  dataBoundary: 'approved_cloud',
  ...overrides
})

const policy = (
  id: string,
  workClass: WorkClass = 'analysis',
  overrides: Partial<ModelRoutePolicy> = {}
): ModelRoutePolicy => ({
  id,
  version: '7',
  workClass,
  primary: target(`${id}-primary`),
  fallbacks: [target(`${id}-fallback`)],
  requiredCapabilities: ['text'],
  dataBoundary: 'any_configured',
  ...overrides
})

describe('resolveRouteDecision', () => {
  it('applies session, project, user, and shipped precedence deterministically', () => {
    const shipped = policy('shipped')
    const user = policy('user')
    const project = policy('project')
    const pin = policy('pin')
    const common = {
      workClass: 'analysis' as const,
      shippedDefaults: { analysis: shipped }
    }

    expect(resolveRouteDecision(common, common).policyId).toBe('shipped')
    expect(
      resolveRouteDecision(common, { ...common, userPolicies: { analysis: user } }).policyId
    ).toBe('user')
    expect(
      resolveRouteDecision(common, {
        ...common,
        userPolicies: { analysis: user },
        projectPolicies: { analysis: project }
      }).policyId
    ).toBe('project')
    expect(
      resolveRouteDecision(common, {
        ...common,
        userPolicies: { analysis: user },
        projectPolicies: { analysis: project },
        sessionOrAgentPin: pin
      }).policyId
    ).toBe('pin')
  })

  it('filters by merged capabilities and the stricter data boundary without reordering', () => {
    const imageLocal = target('image-local', {
      capabilities: ['text', 'image_input'],
      dataBoundary: 'local_only'
    })
    const textLocal = target('text-local', {
      capabilities: ['text'],
      dataBoundary: 'local_only'
    })
    const imageCloud = target('image-cloud', {
      capabilities: ['text', 'image_input'],
      dataBoundary: 'approved_cloud'
    })
    const configured = policy('capabilities', 'analysis', {
      primary: imageCloud,
      fallbacks: [textLocal, imageLocal],
      requiredCapabilities: ['text'],
      dataBoundary: 'approved_cloud'
    })

    const decision = resolveRouteDecision(
      {
        workClass: 'analysis',
        requiredCapabilities: ['image_input'],
        dataBoundary: 'local_only'
      },
      { shippedDefaults: { analysis: configured } }
    )

    expect(decision.target.id).toBe('image-local')
    expect(decision.requiredCapabilities).toEqual(['text', 'image_input'])
    expect(decision.dataBoundary).toBe('local_only')
    expect(decision.rejectedAlternatives.map(({ target, reason }) => [target.id, reason])).toEqual([
      ['image-cloud', 'data_boundary'],
      ['text-local', 'missing_capability']
    ])
  })

  it('retains at most two automatic alternates and records duplicates or overflow', () => {
    const primary = target('primary')
    const duplicate = { ...primary }
    const configured = policy('limits', 'analysis', {
      primary,
      fallbacks: [target('alternate-1'), duplicate, target('alternate-2'), target('alternate-3')]
    })

    const decision = resolveRouteDecision(
      { workClass: 'analysis' },
      { shippedDefaults: { analysis: configured } }
    )

    expect(decision.eligibleAlternates.map(({ id }) => id)).toEqual(['alternate-1', 'alternate-2'])
    expect(decision.eligibleAlternates).toHaveLength(MAX_AUTOMATIC_ALTERNATES)
    expect(decision.rejectedAlternatives.map(({ reason }) => reason)).toEqual([
      'duplicate_target',
      'alternate_limit'
    ])
  })

  it('binds an immutable validated policy budget into the route decision', () => {
    const configured = policy('budgeted', 'analysis', {
      budget: { maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostUsd: 1.25 }
    })
    const decision = resolveRouteDecision(
      { workClass: 'analysis' },
      { shippedDefaults: { analysis: configured } }
    )

    expect(decision.budget).toEqual(configured.budget)
    expect(Object.isFrozen(decision.budget)).toBe(true)
    expect(() =>
      resolveRouteDecision(
        { workClass: 'analysis' },
        {
          shippedDefaults: {
            analysis: { ...configured, budget: { maxCostUsd: Number.NaN } }
          }
        }
      )
    ).toThrow('maxCostUsd')
  })

  it('fails closed with auditable rejection reasons when no target is eligible', () => {
    const configured = policy('closed', 'analysis', {
      primary: target('cloud', { dataBoundary: 'approved_cloud' }),
      fallbacks: []
    })

    expect(() =>
      resolveRouteDecision(
        { workClass: 'analysis', dataBoundary: 'local_only' },
        { shippedDefaults: { analysis: configured } }
      )
    ).toThrowError(NoEligibleModelRouteError)

    try {
      resolveRouteDecision(
        { workClass: 'analysis', dataBoundary: 'local_only' },
        { shippedDefaults: { analysis: configured } }
      )
    } catch (error) {
      expect(error).toMatchObject({
        policyId: 'closed',
        rejections: [expect.objectContaining({ reason: 'data_boundary' })]
      })
    }
  })
})

describe('default routing profiles', () => {
  const capabilities: readonly ModelCapability[] = [
    'text',
    'image_input',
    'tool_use',
    'reasoning',
    'long_context'
  ]
  const withBoundary = (id: string, dataBoundary: DataBoundary): ModelTarget =>
    target(id, { capabilities, dataBoundary })

  it('builds complete Research Max, Balanced, and Economy policy maps from configured tiers', () => {
    const profiles = createDefaultRoutingProfiles({
      strong: [withBoundary('strong', 'approved_cloud')],
      medium: [withBoundary('medium', 'approved_cloud')],
      cheap: [withBoundary('cheap', 'local_only')]
    })

    expect(profiles.map(({ name }) => name)).toEqual(['Research Max', 'Balanced', 'Economy'])
    expect(profiles[0]!.policies.plan.primary.id).toBe('strong')
    expect(profiles[0]!.policies.analysis.primary.id).toBe('medium')
    expect(profiles[0]!.policies.title.primary.id).toBe('cheap')
    expect(profiles[1]!.policies.literature.primary.id).toBe('medium')
    expect(profiles[2]!.policies.build.primary.id).toBe('cheap')
    expect(Object.keys(profiles[0]!.policies)).toHaveLength(11)
  })
})
