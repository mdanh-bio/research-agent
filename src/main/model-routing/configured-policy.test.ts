import { describe, expect, it } from 'vitest'

import type { ModelRoutePolicy, WorkClass } from '../../shared/model-routing'
import type { RoutingSettings } from '../../shared/routing-settings'
import type { AgentFrameworkView, ProviderView } from '../../shared/settings'
import { createConfiguredRoutingCatalog } from './configured-catalog'
import { resolveConfiguredRoute } from './configured-policy'

const frameworks: AgentFrameworkView[] = [
  {
    id: 'opencode',
    displayName: 'OpenCode',
    supportsSkills: true,
    supportedApiTypes: ['openai']
  }
]
const providers: ProviderView[] = [
  {
    id: 'configured-provider',
    type: 'custom',
    name: 'Configured provider',
    apiEndpoints: ['openai'],
    baseUrl: 'http://localhost:8317/v1',
    model: 'strong',
    models: ['strong', 'medium', 'cheap'],
    contextWindow: 200_000,
    supportsImageInput: true,
    hasKey: false,
    needsKey: false
  }
]
const settings = {
  agentFrameworkId: 'opencode' as const,
  agentFrameworks: frameworks,
  providers,
  activeProviderId: 'configured-provider',
  activeModel: 'strong'
}
const catalog = createConfiguredRoutingCatalog({
  frameworkId: settings.agentFrameworkId,
  frameworks,
  providers,
  activeProviderId: settings.activeProviderId,
  activeModel: settings.activeModel
})
const [strong, medium, cheap] = [
  catalog.tiers.strong[0]!,
  catalog.tiers.medium[0]!,
  catalog.tiers.cheap[0]!
]

const override = (primaryTargetId: string): RoutingSettings['userOverrides'] => ({
  analysis: { primaryTargetId }
})

describe('configured routing policy precedence', () => {
  it.each<WorkClass>(['analysis', 'plan', 'summary'])(
    'resolves a shipped profile deterministically for %s',
    (workClass) => {
      const first = resolveConfiguredRoute(
        { workClass },
        { settings, routing: { profile: 'research_max', telemetryEnabled: false } }
      )
      const second = resolveConfiguredRoute(
        { workClass },
        { settings, routing: { profile: 'research_max', telemetryEnabled: false } }
      )
      expect(second.decision).toEqual(first.decision)
      expect(first.decision.policySource).toBe('shipped_default')
    }
  )

  it('enforces pin over project over user over shipped target selection', () => {
    const routing: RoutingSettings = {
      profile: 'research_max',
      telemetryEnabled: false,
      userOverrides: override(cheap.id),
      projectOverrides: {
        project: { analysis: { primaryTargetId: medium.id } }
      }
    }
    expect(
      resolveConfiguredRoute({ workClass: 'analysis' }, { settings, routing }).decision.target
    ).toEqual(cheap)
    expect(
      resolveConfiguredRoute({ workClass: 'analysis' }, { settings, routing, projectId: 'project' })
        .decision.target
    ).toEqual(medium)

    const pin: ModelRoutePolicy = {
      id: 'session-pin',
      version: '1',
      workClass: 'analysis',
      primary: strong,
      fallbacks: [],
      requiredCapabilities: ['text', 'reasoning'],
      dataBoundary: 'any_configured'
    }
    const pinned = resolveConfiguredRoute(
      { workClass: 'analysis' },
      { settings, routing, projectId: 'project', sessionOrAgentPin: pin }
    )
    expect(pinned.decision.policySource).toBe('session_or_agent_pin')
    expect(pinned.decision.target).toEqual(strong)
  })

  it('fails visibly when an override references a removed configured target', () => {
    expect(() =>
      resolveConfiguredRoute(
        { workClass: 'analysis' },
        {
          settings,
          routing: {
            profile: 'balanced',
            telemetryEnabled: false,
            userOverrides: override('configured:missing')
          }
        }
      )
    ).toThrow(/unavailable target/)
  })

  it('filters concrete tier targets by both requested capability and data boundary', () => {
    const constrainedSettings = {
      ...settings,
      providers: [
        { ...providers[0], supportsImageInput: false },
        {
          ...providers[0],
          id: 'custom-vision',
          name: 'Custom vision',
          model: 'custom-vision',
          models: ['custom-vision'],
          supportsImageInput: true
        },
        {
          id: 'approved-cloud',
          type: 'official' as const,
          vendorId: 'xai' as const,
          name: 'Approved cloud',
          apiEndpoints: ['openai' as const],
          models: ['cloud-vision'],
          supportsImageInput: true,
          hasKey: true,
          needsKey: false
        }
      ]
    }
    const resolved = resolveConfiguredRoute(
      {
        workClass: 'analysis',
        requiredCapabilities: ['image_input'],
        dataBoundary: 'approved_cloud'
      },
      {
        settings: constrainedSettings,
        routing: { profile: 'balanced', telemetryEnabled: false }
      }
    )

    expect(resolved.decision.target).toMatchObject({
      providerId: 'approved-cloud',
      model: 'cloud-vision',
      dataBoundary: 'approved_cloud'
    })
    expect(resolved.decision.rejectedAlternatives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'missing_capability' }),
        expect.objectContaining({ reason: 'data_boundary' })
      ])
    )
  })
})
