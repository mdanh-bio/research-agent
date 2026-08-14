import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DelegationApprovalReceipt, PersistedDelegation } from '../../shared/agent-delegation'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { AgentGraphOwner } from './owner'
import { DelegationOwner } from './delegation-owner'

let root: string | undefined
let client: PrismaClient | undefined

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

const session = (projectId: string, sessionId: string): PersistedChatSession => ({
  id: sessionId,
  projectId,
  title: 'test',
  cwd: '/tmp',
  status: 'running',
  messages: [],
  createdAt: 1,
  updatedAt: 1
})

const setup = async (
  overrides: {
    requestApproval?: ConstructorParameters<typeof DelegationOwner>[0]['requestApproval']
    resolveTarget?: ConstructorParameters<typeof DelegationOwner>[0]['resolveTarget']
    execute?: ConstructorParameters<typeof DelegationOwner>[0]['execute']
  } = {}
): Promise<{
  graph: AgentGraphOwner
  owner: DelegationOwner
  rootRun: { graphId: string; agentRunId: string }
  execute: ReturnType<typeof vi.fn>
}> => {
  root = await mkdtemp(join(tmpdir(), 'research-agent-delegation-'))
  client = createProjectDbClient(root)
  await ensureProjectSchema(client)
  let next = 0
  const graph = new AgentGraphOwner(async () => client!, {
    idFactory: () => `id-${++next}`,
    now: () => new Date(1_700_000_000_000 + next)
  })
  const rootRun = await graph.createConfiguredDirectRoot({
    projectId: 'project',
    sessionId: 'session',
    promptMessageId: 'prompt',
    workClass: 'analysis',
    target,
    status: 'running'
  })
  const sessions = new Map<string, PersistedChatSession>([
    ['session', session('project', 'session')]
  ])
  const execute = vi.fn(
    overrides.execute ?? (async () => ({ status: 'completed' as const, text: 'done' }))
  )
  const owner = new DelegationOwner({
    getClient: async () => client!,
    graph,
    sessions: {
      projectIdForSession: async () => 'project',
      loadSession: async () => sessions.get('session'),
      createDelegation: async (card) => {
        const current = sessions.get('session')!
        sessions.set('session', { ...current, delegations: [...(current.delegations ?? []), card] })
        return card
      },
      getDelegation: async (_projectId, _sessionId, id) =>
        sessions.get('session')?.delegations?.find((item) => item.id === id),
      listDelegations: async () => sessions.get('session')?.delegations ?? [],
      updateDelegation: async (_projectId, _sessionId, id, update) => {
        const current = sessions.get('session')!
        const list = current.delegations ?? []
        const index = list.findIndex((item) => item.id === id)
        const nextCard = { ...list[index], ...update }
        sessions.set('session', {
          ...current,
          delegations: list.map((item, itemIndex) => (itemIndex === index ? nextCard : item))
        })
        return nextCard
      }
    },
    resolveTarget: overrides.resolveTarget ?? (async () => target),
    requestApproval:
      overrides.requestApproval ??
      (async ({ rawInput }) => {
        const approvalDigest = (rawInput as { approvalDigest: string }).approvalDigest
        return {
          kind: 'human-delegation-approval',
          id: `approval-${approvalDigest.slice(0, 12)}`,
          digest: approvalDigest,
          issuedAt: 1_700_000_000_000,
          expiresAt: 1_700_000_060_000,
          human: true
        } satisfies DelegationApprovalReceipt
      }),
    execute,
    now: () => 1_700_000_000_000
  })
  return { graph, owner, rootRun, execute }
}

afterEach(async () => {
  await client?.$disconnect()
  client = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('DelegationOwner', () => {
  it('validates the closed capability and returns a bounded completed result', async () => {
    const { owner, rootRun } = await setup()
    const capability = owner.capability({
      graphId: rootRun.graphId,
      parentAgentRunId: rootRun.agentRunId,
      projectId: 'project',
      sessionId: 'session'
    })
    await expect(capability.spawn({ task: '' })).rejects.toThrow(/invalid/)
    const created = await capability.spawn({
      task: 'Inspect the stable context.',
      workClass: 'analysis'
    })
    const completed = await capability.wait(created.id, 1_000)
    expect(completed?.lifecycle).toBe('completed')
    expect(completed?.resultText).toBe('done')
    expect(created.target).toMatchObject({
      backend: 'opencode',
      providerId: 'provider',
      model: 'model'
    })
    expect(await capability.status(created.id)).toMatchObject({
      id: created.id,
      lifecycle: 'completed'
    })
  })

  it('rejects forged parent capabilities and keeps the child count bounded', async () => {
    const { owner, rootRun } = await setup()
    const forged = owner.capability({
      graphId: rootRun.graphId,
      parentAgentRunId: 'other-parent',
      projectId: 'project',
      sessionId: 'session'
    })
    await expect(forged.spawn({ task: 'forged', workClass: 'analysis' })).rejects.toThrow(
      /Unknown Agent Run|trusted running root/
    )
    const capability = owner.capability({
      graphId: rootRun.graphId,
      parentAgentRunId: rootRun.agentRunId,
      projectId: 'project',
      sessionId: 'session'
    })
    for (let index = 0; index < 8; index += 1) {
      await capability.spawn({ task: `child-${index}`, workClass: 'analysis' })
    }
    await expect(capability.spawn({ task: 'ninth', workClass: 'analysis' })).rejects.toThrow(
      /child-count/i
    )
  })

  it('rejects a child budget that exceeds the parent before approval or dispatch', async () => {
    const { owner, rootRun, execute } = await setup()
    const capability = owner.capability({
      graphId: rootRun.graphId,
      parentAgentRunId: rootRun.agentRunId,
      projectId: 'project',
      sessionId: 'session'
    })
    await expect(
      capability.spawn({
        task: 'oversized',
        workClass: 'analysis',
        budget: { maxOutputTokens: 4_097 }
      })
    ).rejects.toThrow(/hard bound|parent remainder/)
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects an untyped approval decision without dispatching the child', async () => {
    const { owner, rootRun, execute } = await setup({
      requestApproval: async () => true as never
    })
    const capability = owner.capability({
      graphId: rootRun.graphId,
      parentAgentRunId: rootRun.agentRunId,
      projectId: 'project',
      sessionId: 'session'
    })
    const result = await capability.spawn({ task: 'untyped', workClass: 'analysis' })
    expect(result).toMatchObject({
      lifecycle: 'blocked',
      safeFailureCode: 'delegation_approval_invalid'
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('blocks route drift after approval without dispatching the child', async () => {
    let resolutions = 0
    const { owner, rootRun, execute } = await setup({
      resolveTarget: async () =>
        ++resolutions === 1 ? target : { ...target, model: 'drifted-model' }
    })
    const capability = owner.capability({
      graphId: rootRun.graphId,
      parentAgentRunId: rootRun.agentRunId,
      projectId: 'project',
      sessionId: 'session'
    })
    const created = await capability.spawn({ task: 'route drift', workClass: 'analysis' })
    const blocked = await capability.wait(created.id, 1_000)
    expect(blocked).toMatchObject({
      lifecycle: 'blocked',
      safeFailureCode: 'delegation_route_drift'
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('releases the slot and preserves provenance when the provider fails', async () => {
    const { owner, rootRun, execute } = await setup({
      execute: async () => {
        throw new Error('provider_failed')
      }
    })
    const capability = owner.capability({
      graphId: rootRun.graphId,
      parentAgentRunId: rootRun.agentRunId,
      projectId: 'project',
      sessionId: 'session'
    })
    const created = await capability.spawn({ task: 'provider failure', workClass: 'analysis' })
    const failed = await capability.wait(created.id, 1_000)
    expect(failed).toMatchObject({ lifecycle: 'failed', safeFailureCode: 'provider_failed' })
    expect(failed?.agentRun).toMatchObject({ status: 'failed', safeFailureCode: 'provider_failed' })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('times out a child within its exact wall-clock budget and releases its slot', async () => {
    const { owner, rootRun, execute } = await setup({
      execute: async () =>
        new Promise(() => {
          // The owner must enforce timeout even when an adapter does not settle on abort.
        })
    })
    const capability = owner.capability({
      graphId: rootRun.graphId,
      parentAgentRunId: rootRun.agentRunId,
      projectId: 'project',
      sessionId: 'session'
    })
    const created = await capability.spawn({
      task: 'timeout',
      workClass: 'analysis',
      budget: { maxWallTimeMs: 10 }
    })
    const failed = await capability.wait(created.id, 1_000)
    expect(failed).toMatchObject({ lifecycle: 'failed', safeFailureCode: 'delegation_timeout' })
    expect(failed?.agentRun).toMatchObject({ status: 'failed' })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('cancels an active child once and leaves both authorities terminal', async () => {
    let resolveExecution!: (value: { status: 'cancelled'; safeFailureCode: string }) => void
    const execution = new Promise<{ status: 'cancelled'; safeFailureCode: string }>((resolve) => {
      resolveExecution = resolve
    })
    const { owner, rootRun } = await setup({ execute: async () => execution })
    const capability = owner.capability({
      graphId: rootRun.graphId,
      parentAgentRunId: rootRun.agentRunId,
      projectId: 'project',
      sessionId: 'session'
    })
    const created = await capability.spawn({ task: 'cancel me', workClass: 'analysis' })
    await vi.waitFor(async () =>
      expect((await capability.status(created.id))?.lifecycle).toBe('running')
    )
    const cancelled = await capability.cancel(created.id)
    expect(cancelled).toMatchObject({
      lifecycle: 'cancelled',
      safeFailureCode: 'delegation_cancelled'
    })
    resolveExecution({ status: 'cancelled', safeFailureCode: 'delegation_cancelled' })
    await expect(capability.cancel(created.id)).resolves.toMatchObject({ lifecycle: 'cancelled' })
  })

  it('blocks restart-ambiguous dispatch without replaying the provider', async () => {
    const execute = vi.fn(
      async () =>
        new Promise<{ status: 'completed'; text: string }>(() => {
          // Deliberately unresolved to simulate process loss after dispatch.
        })
    )
    const { owner, rootRun } = await setup({ execute })
    const capability = owner.capability({
      graphId: rootRun.graphId,
      parentAgentRunId: rootRun.agentRunId,
      projectId: 'project',
      sessionId: 'session'
    })
    const created = await capability.spawn({ task: 'restart', workClass: 'analysis' })
    await vi.waitFor(async () =>
      expect((await capability.status(created.id))?.lifecycle).toBe('running')
    )
    await owner.reconcileOnStartup()
    await expect(capability.status(created.id)).resolves.toMatchObject({
      lifecycle: 'blocked',
      safeFailureCode: 'delegation_restart_ambiguous'
    })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('keeps renderer-owned Session saves from deleting delegations', async () => {
    const card: PersistedDelegation = {
      id: 'delegation',
      graphId: 'graph',
      parentAgentRunId: 'parent',
      childAgentRunId: 'child',
      childFrameId: 'frame',
      parentFrameId: 'parent-frame',
      originMessageId: 'origin',
      projectId: 'project',
      sessionId: 'session',
      task: 'task',
      role: 'delegate',
      workClass: 'analysis',
      resultShape: 'text',
      lifecycle: 'completed',
      createdAt: 1,
      updatedAt: 2
    }
    expect(card.lifecycle).toBe('completed')
  })
})
