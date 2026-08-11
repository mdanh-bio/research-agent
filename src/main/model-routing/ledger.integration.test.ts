import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import type { ModelRoutePolicy, RouteDecision } from '../../shared/model-routing'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { computeRequestIdentity, type BenignRefusalApprovalEvidence } from './fallback-policy'
import {
  canonicalRoutingPolicyJson,
  canonicalRoutingSnapshotJson,
  ModelRoutingLedger,
  routingPolicyHash
} from './ledger'

let storageRoot: string | undefined
let client: PrismaClient | undefined

afterEach(async () => {
  await client?.$disconnect()
  client = undefined
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

const target = {
  id: 'codex/provider/model',
  backend: 'codex',
  providerId: 'provider',
  model: 'model',
  reasoningEffort: 'high',
  capabilities: ['text', 'tool_use', 'reasoning'],
  dataBoundary: 'approved_cloud',
  contextWindow: 200_000
} as const

const policy: ModelRoutePolicy = {
  id: 'research_max.analysis',
  version: '1',
  workClass: 'analysis',
  primary: target,
  fallbacks: [],
  requiredCapabilities: ['text', 'tool_use', 'reasoning'],
  dataBoundary: 'approved_cloud',
  budget: { maxCostUsd: 2 }
}

const decision: RouteDecision = {
  workClass: 'analysis',
  policyId: policy.id,
  policyVersion: policy.version,
  policySource: 'shipped_default',
  target,
  eligibleAlternates: [],
  requiredCapabilities: policy.requiredCapabilities,
  dataBoundary: policy.dataBoundary,
  budget: policy.budget,
  selectionReason: 'test',
  rejectedAlternatives: []
}

const request = { body: '{"input":"benign biology request"}' } as const
const requestIdentity = computeRequestIdentity(request)

const setup = async (
  verifyBenignRefusalApproval?: (
    approval: BenignRefusalApprovalEvidence
  ) => boolean | Promise<boolean>
): Promise<ModelRoutingLedger> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'research-agent-ledger-'))
  client = createProjectDbClient(storageRoot)
  await ensureProjectSchema(client)
  let id = 0
  let tick = 0
  return new ModelRoutingLedger(async () => client!, {
    idFactory: () => `id-${++id}`,
    now: () => new Date(1_700_000_000_000 + tick++ * 1_000),
    verifyBenignRefusalApproval
  })
}

describe('ModelRoutingLedger', () => {
  it('records a canonical policy, monotonic side effects, one final attempt, and a thread link', async () => {
    const ledger = await setup()
    const run = await ledger.beginAgentRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      promptMessageId: 'message-in-session-json',
      role: 'analyst',
      routeDecision: decision,
      effectivePolicy: policy,
      status: 'running'
    })
    const attemptId = await ledger.beginModelAttempt({
      agentRunId: run.agentRunId,
      trigger: 'initial',
      target,
      request
    })

    await ledger.activateModelAttempt(attemptId)
    await ledger.markSideEffectsStarted(attemptId)
    await ledger.markSideEffectsStarted(attemptId)
    await ledger.finishModelAttempt(attemptId, {
      result: 'success',
      latencyMs: 125,
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.012345
    })
    const threadLinkId = await ledger.linkRuntimeThread({
      agentRunId: run.agentRunId,
      appSessionId: 'session-1',
      backend: 'codex',
      runtimeThreadId: 'thread-1',
      ephemeral: false
    })
    await ledger.finishAgentRun(run.agentRunId, 'completed')

    await expect(ledger.finishModelAttempt(attemptId, { result: 'cancelled' })).rejects.toThrow(
      'already finalized'
    )
    await expect(ledger.finishAgentRun(run.agentRunId, 'failed')).rejects.toThrow(
      'already finalized'
    )

    await expect(
      client!.agentRun.findUniqueOrThrow({
        where: { id: run.agentRunId },
        include: { policySnapshot: true, modelAttempts: true, runtimeThreadLinks: true }
      })
    ).resolves.toMatchObject({
      status: 'completed',
      promptMessageId: 'message-in-session-json',
      budgetJson: '{"maxCostUsd":2}',
      policySnapshot: {
        policyHash: run.policyHash,
        policyJson: canonicalRoutingSnapshotJson(policy, decision)
      },
      modelAttempts: [
        {
          sequence: 0,
          requestHash: requestIdentity,
          sideEffectsStarted: true,
          result: 'success',
          costUsdMicros: 12_345n
        }
      ],
      runtimeThreadLinks: [{ id: threadLinkId, runtimeThreadId: 'thread-1' }]
    })
  })

  it('rejects policy/decision drift and invalid terminal metadata', async () => {
    const ledger = await setup()
    await expect(
      ledger.beginAgentRun({
        projectId: 'project-1',
        sessionId: 'session-1',
        role: 'analyst',
        routeDecision: { ...decision, policyVersion: '2' },
        effectivePolicy: policy
      })
    ).rejects.toThrow('does not match')
    await expect(
      ledger.beginAgentRun({
        projectId: 'project-1',
        sessionId: 'session-1',
        role: 'analyst',
        routeDecision: {
          ...decision,
          target: { ...target, providerId: 'attacker-provider' }
        },
        effectivePolicy: policy
      })
    ).rejects.toThrow('exactly match')
    await expect(
      ledger.beginAgentRun({
        projectId: 'project-1',
        sessionId: 'session-1',
        role: 'analyst',
        routeDecision: { ...decision, budget: { maxCostUsd: 999 } },
        effectivePolicy: policy
      })
    ).rejects.toThrow('budget')
    const alternateA = { ...target, id: 'alternate-a', model: 'model-a' }
    const alternateB = { ...target, id: 'alternate-b', model: 'model-b' }
    await expect(
      ledger.beginAgentRun({
        projectId: 'project-1',
        sessionId: 'session-1',
        role: 'analyst',
        routeDecision: {
          ...decision,
          eligibleAlternates: [alternateB, alternateA]
        },
        effectivePolicy: { ...policy, fallbacks: [alternateA, alternateB] }
      })
    ).rejects.toThrow('configured order')

    const run = await ledger.beginAgentRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      role: 'analyst',
      routeDecision: decision,
      effectivePolicy: policy
    })
    await expect(
      ledger.beginModelAttempt({
        agentRunId: run.agentRunId,
        trigger: 'initial',
        target,
        requestHash: 'sha256:caller-controlled-constant'
      } as unknown as Parameters<ModelRoutingLedger['beginModelAttempt']>[0])
    ).rejects.toThrow('Request identity input is required')
    const attemptId = await ledger.beginModelAttempt({
      agentRunId: run.agentRunId,
      trigger: 'initial',
      target,
      request
    })
    await ledger.activateModelAttempt(attemptId)
    await expect(ledger.finishModelAttempt(attemptId, { result: 'failure' })).rejects.toThrow(
      'failure category'
    )
    await expect(ledger.finishAgentRun(run.agentRunId, 'running')).rejects.toThrow('non-terminal')
  })

  it('finalizes a pre-dispatch reservation without claiming it ran and permits eligible fallback', async () => {
    const alternate = { ...target, id: 'alternate-reserved', model: 'model-b' }
    const fallbackPolicy = { ...policy, fallbacks: [alternate] }
    const fallbackDecision = { ...decision, eligibleAlternates: [alternate] }
    const ledger = await setup()
    const run = await ledger.beginAgentRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      role: 'analyst',
      routeDecision: fallbackDecision,
      effectivePolicy: fallbackPolicy,
      status: 'running'
    })
    const initial = await ledger.beginModelAttempt({
      agentRunId: run.agentRunId,
      trigger: 'initial',
      target,
      request
    })

    await ledger.finishReservedModelAttempt(initial, {
      result: 'failure',
      failureCategory: 'provider_unavailable',
      latencyMs: 8
    })
    const fallback = await ledger.beginModelAttempt({
      agentRunId: run.agentRunId,
      trigger: 'provider_unavailable',
      target: alternate,
      request
    })

    await expect(
      client!.modelAttempt.findMany({
        where: { agentRunId: run.agentRunId },
        orderBy: { sequence: 'asc' }
      })
    ).resolves.toMatchObject([
      { id: initial, result: 'failure', failureCategory: 'provider_unavailable', latencyMs: 8 },
      { id: fallback, result: 'reserved', failureCategory: null }
    ])
    await expect(ledger.activateModelAttempt(initial)).rejects.toThrow('active reservation')
  })

  it('reserves alternates from the persisted decision and requires unchanged, effect-free failures', async () => {
    const alternate = { ...target, id: 'alternate', model: 'model-b' }
    const fallbackPolicy = { ...policy, fallbacks: [alternate] }
    const fallbackDecision = { ...decision, eligibleAlternates: [alternate] }
    const ledger = await setup()
    const run = await ledger.beginAgentRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      role: 'analyst',
      routeDecision: fallbackDecision,
      effectivePolicy: fallbackPolicy,
      status: 'running'
    })
    const initial = await ledger.beginModelAttempt({
      agentRunId: run.agentRunId,
      trigger: 'initial',
      target,
      request
    })
    await ledger.activateModelAttempt(initial)
    await ledger.finishModelAttempt(initial, {
      result: 'failure',
      failureCategory: 'timeout'
    })

    await expect(
      ledger.beginModelAttempt({
        agentRunId: run.agentRunId,
        trigger: 'timeout',
        target: { ...alternate, id: 'forged' },
        request
      })
    ).rejects.toThrow('persisted route decision')
    await expect(
      ledger.beginModelAttempt({
        agentRunId: run.agentRunId,
        trigger: 'timeout',
        target: alternate,
        request: { body: 'changed' }
      })
    ).rejects.toThrow('unchanged request')
    await expect(
      ledger.beginModelAttempt({
        agentRunId: run.agentRunId,
        trigger: 'timeout',
        target: alternate,
        request
      })
    ).resolves.toBe('id-6')
  })

  it('records late effects monotonically and atomically invalidates a fallback reservation', async () => {
    const alternate = { ...target, id: 'alternate', model: 'model-b' }
    const ledger = await setup()
    const run = await ledger.beginAgentRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      role: 'analyst',
      routeDecision: { ...decision, eligibleAlternates: [alternate] },
      effectivePolicy: { ...policy, fallbacks: [alternate] },
      status: 'running'
    })
    const initial = await ledger.beginModelAttempt({
      agentRunId: run.agentRunId,
      trigger: 'initial',
      target,
      request
    })
    await ledger.activateModelAttempt(initial)
    await ledger.finishModelAttempt(initial, { result: 'failure', failureCategory: 'timeout' })
    const fallback = await ledger.beginModelAttempt({
      agentRunId: run.agentRunId,
      trigger: 'timeout',
      target: alternate,
      request
    })

    await expect(ledger.markSideEffectsStarted(initial)).resolves.toEqual({
      invalidatedFallbackAttemptIds: [fallback]
    })
    await expect(ledger.markSideEffectsStarted(initial)).resolves.toEqual({})
    await expect(ledger.activateModelAttempt(fallback)).rejects.toThrow('active reservation')
    await expect(
      client!.modelAttempt.findMany({
        where: { agentRunId: run.agentRunId },
        orderBy: { sequence: 'asc' },
        select: { result: true, sideEffectsStarted: true }
      })
    ).resolves.toEqual([
      { result: 'failure', sideEffectsStarted: true },
      { result: 'cancelled', sideEffectsStarted: false }
    ])
  })

  it('cancels a later active second alternate when the initial attempt reports effects late', async () => {
    const alternateA = { ...target, id: 'alternate-a', model: 'model-b' }
    const alternateB = { ...target, id: 'alternate-b', model: 'model-c' }
    const ledger = await setup()
    const run = await ledger.beginAgentRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      role: 'analyst',
      routeDecision: { ...decision, eligibleAlternates: [alternateA, alternateB] },
      effectivePolicy: { ...policy, fallbacks: [alternateA, alternateB] },
      status: 'running'
    })
    const initial = await ledger.beginModelAttempt({
      agentRunId: run.agentRunId,
      trigger: 'initial',
      target,
      request
    })
    await ledger.activateModelAttempt(initial)
    await ledger.finishModelAttempt(initial, { result: 'failure', failureCategory: 'timeout' })

    const firstFallback = await ledger.beginModelAttempt({
      agentRunId: run.agentRunId,
      trigger: 'timeout',
      target: alternateA,
      request
    })
    await ledger.activateModelAttempt(firstFallback)
    await ledger.finishModelAttempt(firstFallback, {
      result: 'failure',
      failureCategory: 'timeout'
    })

    const secondFallback = await ledger.beginModelAttempt({
      agentRunId: run.agentRunId,
      trigger: 'timeout',
      target: alternateB,
      request
    })
    await ledger.activateModelAttempt(secondFallback)

    await expect(ledger.markSideEffectsStarted(initial)).resolves.toEqual({
      invalidatedFallbackAttemptIds: [secondFallback]
    })
    await expect(
      ledger.finishModelAttempt(secondFallback, { result: 'cancelled' })
    ).rejects.toThrow('already finalized')
    await expect(
      client!.modelAttempt.findMany({
        where: { agentRunId: run.agentRunId },
        orderBy: { sequence: 'asc' },
        select: { id: true, result: true, sideEffectsStarted: true }
      })
    ).resolves.toEqual([
      { id: initial, result: 'failure', sideEffectsStarted: true },
      { id: firstFallback, result: 'failure', sideEffectsStarted: false },
      { id: secondFallback, result: 'cancelled', sideEffectsStarted: false }
    ])
  })

  it('does not reserve a second alternate after any earlier attempt reports side effects', async () => {
    const alternateA = { ...target, id: 'alternate-a', model: 'model-b' }
    const alternateB = { ...target, id: 'alternate-b', model: 'model-c' }
    const ledger = await setup()
    const run = await ledger.beginAgentRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      role: 'analyst',
      routeDecision: { ...decision, eligibleAlternates: [alternateA, alternateB] },
      effectivePolicy: { ...policy, fallbacks: [alternateA, alternateB] },
      status: 'running'
    })
    const initial = await ledger.beginModelAttempt({
      agentRunId: run.agentRunId,
      trigger: 'initial',
      target,
      request
    })
    await ledger.activateModelAttempt(initial)
    await ledger.finishModelAttempt(initial, { result: 'failure', failureCategory: 'timeout' })

    const firstFallback = await ledger.beginModelAttempt({
      agentRunId: run.agentRunId,
      trigger: 'timeout',
      target: alternateA,
      request
    })
    await ledger.activateModelAttempt(firstFallback)
    await ledger.finishModelAttempt(firstFallback, {
      result: 'failure',
      failureCategory: 'timeout'
    })

    await expect(ledger.markSideEffectsStarted(initial)).resolves.toEqual({})
    await expect(
      ledger.beginModelAttempt({
        agentRunId: run.agentRunId,
        trigger: 'timeout',
        target: alternateB,
        request
      })
    ).rejects.toThrow('blocked after model side effects begin')
    await expect(
      client!.modelAttempt.findMany({
        where: { agentRunId: run.agentRunId },
        orderBy: { sequence: 'asc' },
        select: { id: true, result: true, sideEffectsStarted: true }
      })
    ).resolves.toEqual([
      { id: initial, result: 'failure', sideEffectsStarted: true },
      { id: firstFallback, result: 'failure', sideEffectsStarted: false }
    ])
  })

  it('linearizes a side-effect race against fallback reservation without a dispatchable replay', async () => {
    const alternate = { ...target, id: 'alternate', model: 'model-b' }
    const ledger = await setup()
    const run = await ledger.beginAgentRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      role: 'analyst',
      routeDecision: { ...decision, eligibleAlternates: [alternate] },
      effectivePolicy: { ...policy, fallbacks: [alternate] },
      status: 'running'
    })
    const initial = await ledger.beginModelAttempt({
      agentRunId: run.agentRunId,
      trigger: 'initial',
      target,
      request
    })
    await ledger.activateModelAttempt(initial)
    await ledger.finishModelAttempt(initial, { result: 'failure', failureCategory: 'timeout' })

    const [reservation] = await Promise.allSettled([
      ledger.beginModelAttempt({
        agentRunId: run.agentRunId,
        trigger: 'timeout',
        target: alternate,
        request
      }),
      ledger.markSideEffectsStarted(initial)
    ])
    const persisted = await client!.modelAttempt.findMany({
      where: { agentRunId: run.agentRunId },
      orderBy: { sequence: 'asc' },
      select: { id: true, result: true, sideEffectsStarted: true }
    })

    expect(persisted[0]).toMatchObject({ result: 'failure', sideEffectsStarted: true })
    if (reservation.status === 'fulfilled') {
      expect(persisted[1]).toMatchObject({ id: reservation.value, result: 'cancelled' })
      await expect(ledger.activateModelAttempt(reservation.value)).rejects.toThrow(
        'active reservation'
      )
    } else {
      expect(reservation.reason).toBeInstanceOf(Error)
      expect(String(reservation.reason)).toContain('side effects')
      expect(persisted).toHaveLength(1)
    }
  })

  it('fails closed for benign refusal without verified, scope-bound approval evidence', async () => {
    const alternate = { ...target, id: 'alternate', providerId: 'provider-b', model: 'model-b' }
    const ledger = await setup((approval) => approval.approvalId === 'approved-once')
    const run = await ledger.beginAgentRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      role: 'analyst',
      routeDecision: { ...decision, eligibleAlternates: [alternate] },
      effectivePolicy: { ...policy, fallbacks: [alternate] },
      status: 'running'
    })
    const initial = await ledger.beginModelAttempt({
      agentRunId: run.agentRunId,
      trigger: 'initial',
      target,
      request
    })
    await ledger.activateModelAttempt(initial)
    await ledger.finishModelAttempt(initial, {
      result: 'failure',
      failureCategory: 'benign_research_refusal'
    })

    await expect(
      ledger.beginModelAttempt({
        agentRunId: run.agentRunId,
        trigger: 'benign_research_refusal',
        target: alternate,
        request
      })
    ).rejects.toThrow('auditable approval')

    const approval: BenignRefusalApprovalEvidence = {
      approvalId: 'approved-once',
      approvedBy: 'user',
      approvedAt: 1_700_000_000_000,
      singleUse: true,
      researchScope: {
        id: 'scope-1',
        version: '3',
        projectId: 'project-1',
        permitsBenignResearchRefusalFallback: true,
        dataBoundary: 'approved_cloud',
        approvedProviderIds: ['provider-b']
      },
      sessionId: 'session-1',
      agentRunId: run.agentRunId,
      failedAttemptId: initial,
      policyId: policy.id,
      policyVersion: policy.version,
      requestIdentity,
      sourceTarget: target,
      alternateTarget: alternate
    }
    await expect(
      ledger.beginModelAttempt({
        agentRunId: run.agentRunId,
        trigger: 'benign_research_refusal',
        target: alternate,
        request,
        benignRefusalApproval: {
          ...approval,
          researchScope: { ...approval.researchScope, approvedProviderIds: ['attacker-provider'] }
        }
      })
    ).rejects.toThrow('outside the approved research scope')

    const fallback = await ledger.beginModelAttempt({
      agentRunId: run.agentRunId,
      trigger: 'benign_research_refusal',
      target: alternate,
      request,
      benignRefusalApproval: approval
    })
    await expect(
      client!.modelAttempt.findUniqueOrThrow({ where: { id: fallback } })
    ).resolves.toMatchObject({
      result: 'reserved',
      fallbackApprovalId: 'approved-once',
      fallbackApprovalJson: expect.stringContaining('scope-1')
    })

    const secondRun = await ledger.beginAgentRun({
      projectId: 'project-1',
      sessionId: 'session-2',
      role: 'analyst',
      routeDecision: { ...decision, eligibleAlternates: [alternate] },
      effectivePolicy: { ...policy, fallbacks: [alternate] },
      status: 'running'
    })
    const secondInitial = await ledger.beginModelAttempt({
      agentRunId: secondRun.agentRunId,
      trigger: 'initial',
      target,
      request
    })
    await ledger.activateModelAttempt(secondInitial)
    await ledger.finishModelAttempt(secondInitial, {
      result: 'failure',
      failureCategory: 'benign_research_refusal'
    })
    await expect(
      ledger.beginModelAttempt({
        agentRunId: secondRun.agentRunId,
        trigger: 'benign_research_refusal',
        target: alternate,
        request,
        benignRefusalApproval: {
          ...approval,
          sessionId: 'session-2',
          agentRunId: secondRun.agentRunId,
          failedAttemptId: secondInitial
        }
      })
    ).rejects.toThrow('Unique constraint')
  })

  it('produces a stable digest for semantically identical policy object key order', () => {
    const json = canonicalRoutingPolicyJson(policy)
    const reordered = canonicalRoutingPolicyJson({
      dataBoundary: policy.dataBoundary,
      requiredCapabilities: policy.requiredCapabilities,
      fallbacks: policy.fallbacks,
      primary: policy.primary,
      workClass: policy.workClass,
      version: policy.version,
      id: policy.id,
      budget: policy.budget
    })
    expect(reordered).toBe(json)
    expect(routingPolicyHash(reordered)).toBe(routingPolicyHash(json))
  })
})
