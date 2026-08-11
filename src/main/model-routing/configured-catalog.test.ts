import { describe, expect, it } from 'vitest'

import type { AgentFrameworkView, ProviderView } from '../../shared/settings'
import { createConfiguredRoutingCatalog } from './configured-catalog'

const framework: AgentFrameworkView = {
  id: 'opencode',
  displayName: 'OpenCode',
  supportsSkills: true,
  supportedApiTypes: ['anthropic', 'openai']
}

const provider = (overrides: Partial<ProviderView> = {}): ProviderView => ({
  id: 'provider-local',
  type: 'custom',
  name: 'Local gateway',
  apiEndpoints: ['openai'],
  baseUrl: 'http://127.0.0.1:8317/v1',
  model: 'strong-model',
  models: ['strong-model', 'medium-model', 'cheap-model'],
  contextWindow: 200_000,
  supportsImageInput: false,
  hasKey: false,
  needsKey: false,
  ...overrides
})

describe('createConfiguredRoutingCatalog', () => {
  it('maps configured model order into concrete tiers and declares runtime constraints', () => {
    const catalog = createConfiguredRoutingCatalog({
      frameworkId: 'opencode',
      frameworks: [framework],
      providers: [provider()],
      activeProviderId: 'provider-local',
      activeModel: 'strong-model'
    })

    expect(catalog.tiers.strong.map(({ model }) => model)).toEqual(['strong-model'])
    expect(catalog.tiers.medium.map(({ model }) => model)).toEqual(['medium-model'])
    expect(catalog.tiers.cheap.map(({ model }) => model)).toEqual(['cheap-model'])
    expect(catalog.tiers.strong[0]).toMatchObject({
      backend: 'opencode',
      providerId: 'provider-local',
      reasoningEffort: 'high',
      dataBoundary: 'any_configured',
      capabilities: ['text', 'tool_use', 'reasoning', 'long_context']
    })
  })

  it('keeps only the active transport family and carries image/cloud boundaries', () => {
    const catalog = createConfiguredRoutingCatalog({
      frameworkId: 'opencode',
      frameworks: [framework],
      providers: [
        provider(),
        provider({
          id: 'provider-cloud',
          name: 'Cloud',
          type: 'official',
          vendorId: 'openai',
          baseUrl: 'https://api.example.test',
          models: ['cloud-model'],
          model: 'cloud-model',
          supportsImageInput: true
        }),
        provider({
          id: 'anthropic-only',
          apiEndpoints: ['anthropic'],
          models: ['other-family']
        })
      ],
      activeProviderId: 'provider-local'
    })

    expect(catalog.targets.map(({ providerId }) => providerId)).toEqual([
      'provider-local',
      'provider-local',
      'provider-local',
      'provider-cloud'
    ])
    expect(catalog.targets.at(-1)).toMatchObject({
      dataBoundary: 'approved_cloud',
      capabilities: ['text', 'tool_use', 'reasoning', 'image_input', 'long_context']
    })
  })

  it('does not invent fallback identities when only one model is configured', () => {
    const catalog = createConfiguredRoutingCatalog({
      frameworkId: 'opencode',
      frameworks: [framework],
      providers: [provider({ models: ['only-model'], model: 'only-model' })]
    })

    expect(catalog.targets).toHaveLength(1)
    expect(catalog.tiers.strong[0]).toBe(catalog.tiers.medium[0])
    expect(catalog.tiers.medium[0]).toBe(catalog.tiers.cheap[0])
  })

  it('does not declare reasoning for a custom model whose configured effort profile is unsupported', () => {
    const catalog = createConfiguredRoutingCatalog({
      frameworkId: 'opencode',
      frameworks: [framework],
      providers: [
        provider({
          models: ['text-only-effort'],
          model: 'text-only-effort',
          reasoningEffortPreset: 'unsupported'
        })
      ]
    })

    expect(catalog.targets[0].reasoningEffort).toBe('default')
    expect(catalog.targets[0].capabilities).not.toContain('reasoning')
  })

  it('rejects secret-like material before it can enter a target id', () => {
    expect(() =>
      createConfiguredRoutingCatalog({
        frameworkId: 'opencode',
        frameworks: [framework],
        providers: [provider({ id: 'sk-1234567890abcdefghijklmnop' })]
      })
    ).toThrow(/Secret-like material/)
  })
})
