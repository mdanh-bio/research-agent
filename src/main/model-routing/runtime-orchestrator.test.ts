import { describe, expect, it, vi } from 'vitest'

import type { ModelRoutePolicy, ModelTarget, WorkClass } from '../../shared/model-routing'
import { resolveRouteDecision, type RoutePolicyLayers } from './policy-planner'
import type { ConfiguredRouteResolution } from './configured-policy'
import type { RoutingProfile } from './default-profiles'
import { ModelRoutingLedger } from './ledger'
import { RoutedRunOrchestrator, RoutingRecoveryHandoffRequiredError } from './runtime-orchestrator'

const target = (id: string): ModelTarget => ({
  id,
  backend: 'opencode',
  providerId: `provider-${id}`,
  model: `model-${id}`,
  reasoningEffort: 'medium',
  capabilities: ['text', 'tool_use', 'reasoning', 'long_context'],
  dataBoundary: 'approved_cloud',
  contextWindow: 200_000
})

const targets = [target('strong'), target('medium'), target('cheap')]
const policy: ModelRoutePolicy = {
  id: 'runtime.analysis',
  version: '1',
  workClass: 'analysis',
  primary: targets[0],
  fallbacks: targets.slice(1),
  requiredCapabilities: ['text', 'tool_use', 'reasoning'],
  dataBoundary: 'approved_cloud'
}
const layers: RoutePolicyLayers = { shippedDefaults: { analysis: policy } }
const profile = {
  id: 'balanced',
  name: 'Balanced',
  description: 'test',
  version: '1',
  policies: { analysis: policy }
} as unknown as RoutingProfile

const resolver = vi.fn(
  async (
    _workClass: WorkClass,
    options: {
      projectId: string
      sessionOrAgentPin?: ModelRoutePolicy
      excludedTargetIds?: readonly string[]
    }
  ): Promise<ConfiguredRouteResolution> => ({
    profile,
    decision: resolveRouteDecision(
      { workClass: 'analysis', excludedTargetIds: options.excludedTargetIds },
      layers
    ),
    effectivePolicy: policy,
    layers
  })
)

const fakeLedger = (): ModelRoutingLedger => {
  let attempt = 0
  const ledger = {
    beginAgentRun: vi.fn().mockResolvedValue({
      policySnapshotId: 'snapshot',
      agentRunId: 'run',
      policyHash: 'sha256:policy'
    }),
    beginModelAttempt: vi.fn().mockImplementation(async () => `attempt-${attempt++}`),
    activateModelAttempt: vi.fn().mockResolvedValue(undefined),
    finishModelAttempt: vi.fn().mockResolvedValue(undefined),
    finishReservedModelAttempt: vi.fn().mockResolvedValue(undefined),
    finishAgentRun: vi.fn().mockResolvedValue(undefined),
    markSideEffectsStarted: vi.fn().mockResolvedValue({})
  }
  return ledger as unknown as ModelRoutingLedger
}

const input = {
  projectId: 'project',
  sessionId: 'session',
  promptMessageId: 'message',
  workClass: 'analysis' as const,
  request: { body: 'byte-equivalent request' }
}

describe('RoutedRunOrchestrator', () => {
  it('is a behavioral no-op when routing resolves off', async () => {
    const ledger = fakeLedger()
    const orchestrator = new RoutedRunOrchestrator(async () => undefined, ledger)
    const dispatch = vi.fn().mockResolvedValue({ value: 'legacy result' })
    const request = vi.fn(() => ({ body: 'must not be hashed while routing is off' }))

    await expect(orchestrator.execute({ ...input, request }, dispatch)).resolves.toBe(
      'legacy result'
    )
    expect(dispatch).toHaveBeenCalledWith({ kind: 'legacy' })
    expect(request).not.toHaveBeenCalled()
    expect(ledger.beginAgentRun).not.toHaveBeenCalled()
  })

  it('validates request identity before creating a durable run', async () => {
    const ledger = fakeLedger()
    const orchestrator = new RoutedRunOrchestrator(resolver, ledger)
    const invalidRequest = vi.fn(() => {
      throw new Error('attachment identity unavailable')
    })

    await expect(
      orchestrator.execute({ ...input, request: invalidRequest }, vi.fn())
    ).rejects.toThrow('attachment identity unavailable')
    expect(ledger.beginAgentRun).not.toHaveBeenCalled()
  })

  it('re-resolves eligible failures in policy order and stops after two alternates', async () => {
    resolver.mockClear()
    const ledger = fakeLedger()
    const orchestrator = new RoutedRunOrchestrator(resolver, ledger)
    const seenTargets: string[] = []
    const dispatch = vi.fn().mockImplementation(async (context) => {
      seenTargets.push(context.target.id)
      await context.activate()
      if (context.sequence === 0) throw Object.assign(new Error('limited'), { status: 429 })
      if (context.sequence === 1) throw Object.assign(new Error('down'), { status: 503 })
      return { value: 'fallback result', inputTokens: 10, outputTokens: 4 }
    })

    await expect(orchestrator.execute(input, dispatch)).resolves.toBe('fallback result')
    expect(seenTargets).toEqual(['strong', 'medium', 'cheap'])
    expect(resolver).toHaveBeenNthCalledWith(
      2,
      'analysis',
      expect.objectContaining({ excludedTargetIds: ['strong'] })
    )
    expect(resolver).toHaveBeenNthCalledWith(
      3,
      'analysis',
      expect.objectContaining({ excludedTargetIds: ['strong', 'medium'] })
    )
    expect(ledger.beginModelAttempt).toHaveBeenCalledTimes(3)
    expect(ledger.finishAgentRun).toHaveBeenLastCalledWith('run', 'completed')
  })

  it('never dispatches a fourth model after the two-alternate cap', async () => {
    const ledger = fakeLedger()
    const orchestrator = new RoutedRunOrchestrator(resolver, ledger)
    const dispatch = vi.fn().mockImplementation(async (context) => {
      await context.activate()
      throw Object.assign(new Error('down'), { status: 503 })
    })

    await expect(orchestrator.execute(input, dispatch)).rejects.toThrow('down')
    expect(dispatch).toHaveBeenCalledTimes(3)
    expect(ledger.finishAgentRun).toHaveBeenLastCalledWith('run', 'failed')
  })

  it('keeps target-application failures reserved and activates only at provider dispatch', async () => {
    const ledger = fakeLedger()
    const orchestrator = new RoutedRunOrchestrator(resolver, ledger)
    const dispatch = vi.fn().mockImplementation(async (context) => {
      if (context.sequence === 0) {
        throw Object.assign(new Error('target unavailable'), { status: 503 })
      }
      await context.activate()
      return { value: 'second target' }
    })

    await expect(orchestrator.execute(input, dispatch)).resolves.toBe('second target')
    expect(ledger.activateModelAttempt).toHaveBeenCalledTimes(1)
    expect(ledger.activateModelAttempt).toHaveBeenCalledWith('attempt-1')
    expect(ledger.finishReservedModelAttempt).toHaveBeenCalledWith(
      'attempt-0',
      expect.objectContaining({ result: 'failure', failureCategory: 'provider_unavailable' })
    )
  })

  it('finalizes a pre-dispatch cancellation without claiming the provider ran', async () => {
    const ledger = fakeLedger()
    const orchestrator = new RoutedRunOrchestrator(resolver, ledger)

    await expect(
      orchestrator.execute(input, async () => ({ value: 'cancelled', cancelled: true }))
    ).resolves.toBe('cancelled')
    expect(ledger.activateModelAttempt).not.toHaveBeenCalled()
    expect(ledger.finishReservedModelAttempt).toHaveBeenCalledWith(
      'attempt-0',
      expect.objectContaining({ result: 'cancelled' })
    )
    expect(ledger.finishAgentRun).toHaveBeenCalledWith('run', 'cancelled')
  })

  it('does not retry an AbortError without explicit timeout evidence', async () => {
    const ledger = fakeLedger()
    const orchestrator = new RoutedRunOrchestrator(resolver, ledger)
    const aborted = Object.assign(new Error('user cancelled'), { name: 'AbortError' })
    const dispatch = vi.fn().mockImplementation(async (context) => {
      await context.activate()
      throw aborted
    })

    await expect(orchestrator.execute(input, dispatch)).rejects.toBe(aborted)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(ledger.finishModelAttempt).toHaveBeenCalledWith(
      'attempt-0',
      expect.objectContaining({ result: 'failure', failureCategory: 'unknown' })
    )
    expect(ledger.finishAgentRun).toHaveBeenLastCalledWith('run', 'failed')
  })

  it('marks any observed tool call as a replay guard and hands off after failure', async () => {
    const ledger = fakeLedger()
    const orchestrator = new RoutedRunOrchestrator(resolver, ledger)
    const dispatch = vi.fn().mockImplementation(async (context) => {
      await context.activate()
      orchestrator.markSideEffectsStarted('session', 'message')
      throw Object.assign(new Error('limited'), { status: 429 })
    })

    await expect(orchestrator.execute(input, dispatch)).rejects.toBeInstanceOf(
      RoutingRecoveryHandoffRequiredError
    )
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(ledger.markSideEffectsStarted).toHaveBeenCalledWith('attempt-0')
    expect(ledger.finishAgentRun).toHaveBeenLastCalledWith('run', 'blocked')
  })
})
