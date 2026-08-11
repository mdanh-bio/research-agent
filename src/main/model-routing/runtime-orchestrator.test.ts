import { describe, expect, it, vi } from 'vitest'

import type { ModelRoutePolicy, ModelTarget } from '../../shared/model-routing'
import { type ConfiguredRouteResolution, type ConfiguredRoutingContext } from './configured-policy'
import type { RoutingProfile } from './default-profiles'
import { ModelRoutingLedger } from './ledger'
import { resolveRouteDecision, type RoutePolicyLayers, type RouteRequest } from './policy-planner'
import {
  RoutedRunOrchestrator,
  RoutedTargetUnavailableError,
  RoutingRecoveryHandoffRequiredError,
  routingFailureEvidenceFromError
} from './runtime-orchestrator'

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
const capturedContext: ConfiguredRoutingContext = Object.freeze({ profile, layers })

const createResolver = (): {
  capture: () => Promise<ConfiguredRoutingContext>
  resolve: (
    context: ConfiguredRoutingContext,
    request: RouteRequest
  ) => Promise<ConfiguredRouteResolution>
} => {
  const capture = vi.fn(async () => capturedContext)
  const resolve = vi.fn(
    async (
      _context: ConfiguredRoutingContext,
      request: RouteRequest
    ): Promise<ConfiguredRouteResolution> => ({
      profile,
      decision: resolveRouteDecision(
        { workClass: 'analysis', excludedTargetIds: request.excludedTargetIds },
        layers
      ),
      effectivePolicy: policy,
      layers
    })
  )
  return { capture, resolve }
}

const fakeLedger = (): ModelRoutingLedger => {
  let attempt = 0
  return {
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
  } as unknown as ModelRoutingLedger
}

const input = {
  projectId: 'project',
  sessionId: 'session',
  promptMessageId: 'message',
  workClass: 'analysis' as const,
  request: { body: 'byte-equivalent request' }
}

const providerError = (status: number, code?: string): Error =>
  Object.assign(new Error('provider rejected request'), {
    data: {
      errorName: 'APIError',
      ...(code ? { code } : {}),
      status
    }
  })

describe('RoutedRunOrchestrator', () => {
  it('is a behavioral no-op when routing is off', async () => {
    const ledger = fakeLedger()
    const resolver = { capture: vi.fn(async () => undefined), resolve: vi.fn() }
    const orchestrator = new RoutedRunOrchestrator(resolver, ledger)
    const dispatch = vi.fn().mockResolvedValue({ value: 'legacy result' })
    const request = vi.fn(() => ({ body: 'must not be hashed while routing is off' }))

    await expect(orchestrator.execute({ ...input, request }, dispatch)).resolves.toBe(
      'legacy result'
    )
    expect(dispatch).toHaveBeenCalledWith({ kind: 'legacy' })
    expect(request).not.toHaveBeenCalled()
    expect(resolver.resolve).not.toHaveBeenCalled()
    expect(ledger.beginAgentRun).not.toHaveBeenCalled()
  })

  it('creates and finalizes one configured-direct root when routing is off', async () => {
    const ledger = fakeLedger()
    const owner = {
      createConfiguredDirectRoot: vi.fn().mockResolvedValue({
        graphId: 'graph-direct',
        agentRunId: 'run-direct',
        policySnapshotId: 'snapshot-direct',
        frameId: 'frame-direct',
        artifactStorageSessionId: 'artifact-session-direct',
        policyHash: 'sha256:direct'
      }),
      finishRun: vi.fn().mockResolvedValue(undefined)
    }
    const resolver = { capture: vi.fn(async () => undefined), resolve: vi.fn() }
    const orchestrator = new RoutedRunOrchestrator(resolver, ledger, Date.now, owner as never)
    const request = vi.fn(() => ({ body: 'must remain outside the direct snapshot' }))

    await expect(
      orchestrator.execute(
        {
          ...input,
          request,
          directTarget: target('configured-direct')
        },
        async (context) => ({ value: context.kind })
      )
    ).resolves.toBe('legacy')

    expect(request).not.toHaveBeenCalled()
    expect(owner.createConfiguredDirectRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        sessionId: 'session',
        promptMessageId: 'message',
        target: target('configured-direct'),
        status: 'running'
      })
    )
    expect(owner.finishRun).toHaveBeenCalledWith('run-direct', 'completed')
    expect(ledger.beginAgentRun).not.toHaveBeenCalled()
  })

  it('validates identity after capture and before creating a durable run', async () => {
    const ledger = fakeLedger()
    const resolver = createResolver()
    const orchestrator = new RoutedRunOrchestrator(resolver, ledger)
    const invalidRequest = vi.fn(() => {
      throw new Error('attachment identity unavailable')
    })

    await expect(
      orchestrator.execute({ ...input, request: invalidRequest }, vi.fn())
    ).rejects.toThrow('attachment identity unavailable')
    expect(ledger.beginAgentRun).not.toHaveBeenCalled()
  })

  it('retries only an eligible reserved target and resolves alternates from the captured context', async () => {
    const ledger = fakeLedger()
    const resolver = createResolver()
    const orchestrator = new RoutedRunOrchestrator(resolver, ledger)
    const seenTargets: string[] = []
    const dispatch = vi.fn().mockImplementation(async (context) => {
      seenTargets.push(context.target.id)
      if (context.sequence === 0) throw new RoutedTargetUnavailableError('target unavailable')
      await context.activate()
      return { value: 'second target' }
    })

    await expect(orchestrator.execute(input, dispatch)).resolves.toBe('second target')
    expect(seenTargets).toEqual(['strong', 'medium'])
    expect(resolver.resolve).toHaveBeenNthCalledWith(
      2,
      capturedContext,
      expect.objectContaining({ excludedTargetIds: ['strong'] })
    )
    expect(ledger.finishReservedModelAttempt).toHaveBeenCalledWith(
      'attempt-0',
      expect.objectContaining({ result: 'failure', failureCategory: 'provider_unavailable' })
    )
  })

  it('stops after two pre-dispatch alternates', async () => {
    const ledger = fakeLedger()
    const orchestrator = new RoutedRunOrchestrator(createResolver(), ledger)
    const dispatch = vi.fn(async () => {
      throw new RoutedTargetUnavailableError('target unavailable')
    })

    await expect(orchestrator.execute(input, dispatch)).rejects.toThrow('target unavailable')
    expect(dispatch).toHaveBeenCalledTimes(3)
    expect(ledger.finishAgentRun).toHaveBeenLastCalledWith('run', 'failed')
  })

  it('never replays after activation, including an eligible provider 429', async () => {
    const ledger = fakeLedger()
    const orchestrator = new RoutedRunOrchestrator(createResolver(), ledger)
    const dispatch = vi.fn().mockImplementation(async (context) => {
      await context.activate()
      throw providerError(429, 'rate_limit')
    })

    await expect(orchestrator.execute(input, dispatch)).rejects.toThrow('provider rejected request')
    expect(dispatch).toHaveBeenCalledOnce()
    expect(ledger.finishModelAttempt).toHaveBeenCalledWith(
      'attempt-0',
      expect.objectContaining({ result: 'failure', failureCategory: 'rate_limit' })
    )
  })

  it('finalizes a pre-dispatch cancellation without claiming the provider ran', async () => {
    const ledger = fakeLedger()
    const orchestrator = new RoutedRunOrchestrator(createResolver(), ledger)

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

  it('accepts only structured provider-origin evidence', () => {
    expect(routingFailureEvidenceFromError(providerError(503, 'server_error'))).toMatchObject({
      httpStatus: 503,
      code: 'server_error'
    })
    expect(
      routingFailureEvidenceFromError(Object.assign(new Error('local parse bug'), { status: 503 }))
    ).toEqual({})
    expect(routingFailureEvidenceFromError(new SyntaxError('local parse bug'))).toEqual({})
  })

  it('marks a side effect by the exact ledger attempt and blocks a post-dispatch failure', async () => {
    const ledger = fakeLedger()
    const orchestrator = new RoutedRunOrchestrator(createResolver(), ledger)
    const dispatch = vi.fn().mockImplementation(async (context) => {
      await context.activate()
      orchestrator.markSideEffectsStarted(context.attemptId)
      throw providerError(429, 'rate_limit')
    })

    await expect(orchestrator.execute(input, dispatch)).rejects.toBeInstanceOf(
      RoutingRecoveryHandoffRequiredError
    )
    expect(ledger.markSideEffectsStarted).toHaveBeenCalledWith('attempt-0')
    expect(ledger.finishAgentRun).toHaveBeenLastCalledWith('run', 'blocked')
  })
})
