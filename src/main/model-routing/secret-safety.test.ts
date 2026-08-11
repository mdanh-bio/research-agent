import { describe, expect, it } from 'vitest'

import { canonicalRoutingSnapshotJson } from './ledger'
import { resolveRouteDecision } from './policy-planner'
import { assertSecretFreeRoutingValue } from './secret-safety'

const target = {
  id: 'configured:opencode:provider:model',
  backend: 'opencode' as const,
  providerId: 'provider',
  model: 'model',
  reasoningEffort: 'medium' as const,
  capabilities: ['text', 'reasoning'] as const,
  dataBoundary: 'approved_cloud' as const,
  contextWindow: 200_000
}
const policy = {
  id: 'balanced.analysis',
  version: '1',
  workClass: 'analysis' as const,
  primary: target,
  fallbacks: [],
  requiredCapabilities: ['text', 'reasoning'] as const,
  dataBoundary: 'approved_cloud' as const
}

describe('routing secret safety', () => {
  it('accepts the complete secret-free policy and decision vocabulary', () => {
    const decision = resolveRouteDecision(
      { workClass: 'analysis' },
      { shippedDefaults: { analysis: policy } }
    )
    expect(() => canonicalRoutingSnapshotJson(policy, decision)).not.toThrow()
  })

  it.each([
    { apiKey: 'not-even-a-real-key' },
    { target: { providerId: 'sk-1234567890abcdefghijklmnop' } },
    { fallback: { authorization: 'Bearer private-value' } }
  ])('rejects secret-bearing routing data %#', (value) => {
    expect(() => assertSecretFreeRoutingValue(value)).toThrow(/Secret/)
  })
})
