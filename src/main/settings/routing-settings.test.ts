import { describe, expect, it } from 'vitest'

import { sanitizeSettings } from './repository'

describe('stored routing settings', () => {
  it('defaults missing or invalid profile state to behavior-preserving off', () => {
    expect(sanitizeSettings({ providers: [] }).routing).toBeUndefined()
    expect(
      sanitizeSettings({
        providers: [],
        routing: { profile: 'unexpected', telemetryEnabled: true }
      }).routing
    ).toBeUndefined()
  })

  it('persists known profiles and forces external telemetry off', () => {
    const settings = sanitizeSettings({
      providers: [],
      routing: { profile: 'research_max', telemetryEnabled: true }
    })

    expect(settings.routing).toEqual({ profile: 'research_max', telemetryEnabled: false })
  })

  it('sanitizes bounded per-user and per-project overrides', () => {
    const settings = sanitizeSettings({
      providers: [],
      routing: {
        profile: 'balanced',
        userOverrides: {
          analysis: {
            primaryTargetId: 'target-a',
            fallbackTargetIds: ['target-a', 'target-b', 'target-c', 'target-d'],
            requiredCapabilities: ['text', 'reasoning', 'unknown'],
            dataBoundary: 'approved_cloud',
            budget: { maxInputTokens: 10_000, maxCostUsd: 1.25 }
          },
          unknown: { primaryTargetId: 'ignored' }
        },
        projectOverrides: {
          project: { review: { primaryTargetId: 'target-review' } },
          '': { review: { primaryTargetId: 'ignored' } }
        }
      }
    })

    expect(settings.routing).toEqual({
      profile: 'balanced',
      telemetryEnabled: false,
      userOverrides: {
        analysis: {
          primaryTargetId: 'target-a',
          fallbackTargetIds: ['target-b', 'target-c'],
          requiredCapabilities: ['text', 'reasoning'],
          dataBoundary: 'approved_cloud',
          budget: { maxInputTokens: 10_000, maxCostUsd: 1.25 }
        }
      },
      projectOverrides: {
        project: { review: { primaryTargetId: 'target-review' } }
      }
    })
  })

  it('drops secret-like override data before routing settings can be persisted', () => {
    const secret = 'sk-1234567890abcdefghijklmnop'
    const settings = sanitizeSettings({
      providers: [],
      routing: {
        profile: 'balanced',
        userOverrides: { analysis: { primaryTargetId: secret } }
      }
    })

    expect(settings.routing).toEqual({ profile: 'balanced', telemetryEnabled: false })
    expect(JSON.stringify(settings)).not.toContain(secret)
  })

  it('stores project overrides without inheriting attacker-controlled project ids', () => {
    const settings = sanitizeSettings(
      JSON.parse(
        '{"providers":[],"routing":{"profile":"balanced","projectOverrides":{"__proto__":{"review":{"primaryTargetId":"target-review"}}}}}'
      )
    )

    expect(Object.getPrototypeOf(settings.routing?.projectOverrides)).toBeNull()
    expect(settings.routing?.projectOverrides?.analysis).toBeUndefined()
    expect(settings.routing?.projectOverrides?.__proto__).toEqual({
      review: { primaryTargetId: 'target-review' }
    })
  })
})
