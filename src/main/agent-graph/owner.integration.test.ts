import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { AgentGraphOwner } from './owner'

let storageRoot: string | undefined
let client: PrismaClient | undefined

afterEach(async () => {
  await client?.$disconnect()
  client = undefined
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

const target = {
  id: 'configured:opencode:provider:model',
  backend: 'opencode',
  providerId: 'provider',
  model: 'model',
  reasoningEffort: 'default',
  capabilities: ['text', 'tool_use', 'reasoning'],
  dataBoundary: 'any_configured',
  contextWindow: 200_000
} as const

const setup = async (): Promise<AgentGraphOwner> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'research-agent-m2-graph-'))
  client = createProjectDbClient(storageRoot)
  await ensureProjectSchema(client)
  let nextId = 0
  return new AgentGraphOwner(async () => client!, {
    idFactory: () => `m2-id-${++nextId}`,
    now: () => new Date(1_700_000_000_000 + nextId)
  })
}

const rootInput = {
  projectId: 'project-1',
  sessionId: 'session-1',
  promptMessageId: 'message-1',
  workClass: 'analysis' as const,
  target,
  status: 'running' as const
}

describe('AgentGraphOwner', () => {
  it('creates one routing-off root and an accurate secret-free configured_direct snapshot', async () => {
    const owner = await setup()
    const first = await owner.createConfiguredDirectRoot(rootInput)
    const second = await owner.createConfiguredDirectRoot(rootInput)

    expect(second).toEqual(first)
    expect(await client!.agentGraph.count()).toBe(1)
    expect(await client!.agentRun.count()).toBe(1)
    const snapshot = await client!.routingPolicySnapshot.findUniqueOrThrow({
      where: { id: first.policySnapshotId }
    })
    const document = JSON.parse(snapshot.policyJson) as Record<string, unknown>
    expect(document).toMatchObject({ routingMode: 'configured_direct', transparentRouting: false })
    expect(snapshot.policyId).toBe('configured_direct')
    expect(snapshot.policyJson).not.toContain('message text')
    expect(snapshot.policyJson).toContain('provider')
    expect(snapshot.policyJson).toContain('model')
  })

  it('attaches a routed snapshot to the already-owned root without creating a second run', async () => {
    const owner = await setup()
    const policy = {
      id: 'research_max.analysis',
      version: '1',
      workClass: 'analysis' as const,
      primary: target,
      fallbacks: [],
      requiredCapabilities: ['text', 'tool_use', 'reasoning'] as const,
      dataBoundary: 'any_configured' as const
    }
    const decision = {
      workClass: 'analysis' as const,
      policyId: policy.id,
      policyVersion: policy.version,
      policySource: 'shipped_default' as const,
      target,
      eligibleAlternates: [],
      requiredCapabilities: policy.requiredCapabilities,
      dataBoundary: policy.dataBoundary,
      selectionReason: 'test route',
      rejectedAlternatives: []
    }
    const root = await owner.createRoutedRoot({
      ...rootInput,
      routeDecision: decision,
      effectivePolicy: policy
    })
    const stored = await client!.routingPolicySnapshot.findUniqueOrThrow({
      where: { id: root.policySnapshotId }
    })
    expect(stored.policyId).toBe(policy.id)
    expect(stored.policyJson).not.toContain('configured_direct')
    expect(await client!.agentRun.count()).toBe(1)
  })

  it('enforces depth, parent scope, child count, running concurrency, and idempotent terminal completion', async () => {
    const owner = await setup()
    const root = await owner.createConfiguredDirectRoot({
      ...rootInput,
      limits: { maxConcurrency: 2, maxDepth: 1, maxChildren: 2 }
    })
    const child = await owner.createChild({
      graphId: root.graphId,
      parentAgentRunId: root.agentRunId,
      projectId: rootInput.projectId,
      sessionId: rootInput.sessionId,
      runKind: 'delegate',
      role: 'delegate',
      workClass: 'analysis',
      runtime: target.backend,
      promptMessageId: 'message-child-1'
    })
    expect(child.depth).toBe(1)
    const secondChild = await owner.createChild({
      graphId: root.graphId,
      parentAgentRunId: root.agentRunId,
      projectId: rootInput.projectId,
      sessionId: rootInput.sessionId,
      runKind: 'side-question',
      role: 'side-question',
      workClass: 'analysis',
      runtime: target.backend,
      promptMessageId: 'message-child-2'
    })
    expect(secondChild.status).toBe('queued')
    await expect(
      owner.createChild({
        graphId: root.graphId,
        parentAgentRunId: root.agentRunId,
        projectId: rootInput.projectId,
        sessionId: rootInput.sessionId,
        runKind: 'delegate',
        role: 'delegate',
        workClass: 'analysis',
        runtime: target.backend
      })
    ).rejects.toThrow(/child-count/i)

    await expect(owner.startRun(child.id)).resolves.toMatchObject({ status: 'running', depth: 1 })
    await expect(owner.startRun(secondChild.id)).rejects.toThrow(/concurrency/i)
    const completed = await owner.finishRun(child.id, 'completed', {
      outputArtifactIds: ['artifact-1']
    })
    expect(completed.status).toBe('completed')
    await expect(owner.finishRun(child.id, 'completed')).resolves.toMatchObject({
      id: child.id,
      status: 'completed'
    })
    await expect(
      owner.createChild({
        graphId: 'other-graph',
        parentAgentRunId: root.agentRunId,
        projectId: rootInput.projectId,
        sessionId: rootInput.sessionId,
        runKind: 'delegate',
        role: 'delegate',
        workClass: 'analysis',
        runtime: target.backend
      })
    ).rejects.toThrow(/Unknown Agent Graph/)

    await owner.finishRun(root.agentRunId, 'completed')
    await expect(
      owner.createChild({
        graphId: root.graphId,
        parentAgentRunId: root.agentRunId,
        projectId: rootInput.projectId,
        sessionId: rootInput.sessionId,
        runKind: 'delegate',
        role: 'delegate',
        workClass: 'analysis',
        runtime: target.backend
      })
    ).rejects.toThrow(/inactive|running/i)

    const cancellingRoot = await owner.createConfiguredDirectRoot({
      ...rootInput,
      promptMessageId: 'message-cancelling'
    })
    await owner.requestCancellation(cancellingRoot.graphId, 'user')
    await expect(
      owner.createChild({
        graphId: cancellingRoot.graphId,
        parentAgentRunId: cancellingRoot.agentRunId,
        projectId: rootInput.projectId,
        sessionId: rootInput.sessionId,
        runKind: 'delegate',
        role: 'delegate',
        workClass: 'analysis',
        runtime: target.backend
      })
    ).rejects.toThrow(/inactive|cancelling/i)
  })

  it('persists cancellation generation and reason without exposing provider data', async () => {
    const owner = await setup()
    const root = await owner.createConfiguredDirectRoot(rootInput)
    const cancelled = await owner.requestCancellation(root.graphId, 'parent')
    expect(cancelled).toMatchObject({ lifecycle: 'cancelling', cancelReason: 'parent' })
    expect(cancelled.cancellationGeneration).toBe(1)
    const run = await owner.getRunProjection(root.agentRunId)
    expect(run.cancelRequestedAt).toBeDefined()
    expect(JSON.stringify(cancelled)).not.toContain('provider')
  })

  it('fails closed on corrupt graph and run metadata instead of projecting it', async () => {
    const owner = await setup()
    const root = await owner.createConfiguredDirectRoot(rootInput)

    await client!.agentGraph.update({
      where: { id: root.graphId },
      data: { observedUsageJson: '{"inputTokens":-1}' }
    })
    await expect(owner.getGraphProjection(root.graphId)).rejects.toThrow(/non-negative/i)

    await client!.agentGraph.update({
      where: { id: root.graphId },
      data: { observedUsageJson: '{}' }
    })
    await client!.agentRun.update({
      where: { id: root.agentRunId },
      data: { outputArtifactIdsJson: '[42]' }
    })
    await expect(owner.getRunProjection(root.agentRunId)).rejects.toThrow(/artifact id/i)
  })
})
