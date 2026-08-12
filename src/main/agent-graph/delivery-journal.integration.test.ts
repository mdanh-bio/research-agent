import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import type { MessageDeliveryRequest } from '../../shared/message-delivery'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { MessageDeliveryJournal } from './delivery-journal'
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
  id: 'configured:codex:provider:model',
  backend: 'codex',
  providerId: 'provider',
  model: 'model',
  reasoningEffort: 'default',
  capabilities: ['text', 'tool_use'],
  dataBoundary: 'approved_cloud'
} as const

const setup = async (): Promise<{
  root: Awaited<ReturnType<AgentGraphOwner['createConfiguredDirectRoot']>>
  journal: MessageDeliveryJournal
}> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'research-agent-m2-delivery-'))
  client = createProjectDbClient(storageRoot)
  await ensureProjectSchema(client)
  const graph = new AgentGraphOwner(async () => client!, {
    idFactory: (() => {
      let next = 0
      return () => `delivery-id-${++next}`
    })()
  })
  const root = await graph.createConfiguredDirectRoot({
    projectId: 'project-1',
    sessionId: 'session-1',
    promptMessageId: 'message-root',
    workClass: 'analysis',
    target,
    status: 'running'
  })
  return { root, journal: new MessageDeliveryJournal(async () => client!) }
}

const request = (
  rootRunId: string,
  id: string,
  requested: 'auto' | 'steer' = 'auto'
): MessageDeliveryRequest => ({
  id,
  projectId: 'project-1',
  sessionId: 'session-1',
  messageId: id.replace('delivery', 'message'),
  targetRootRunId: rootRunId,
  targetPromptMessageId: 'message-root',
  requested,
  hasActiveTurn: true,
  ...(requested === 'auto'
    ? { recommendation: { mode: 'side-question' as const, confidence: 0.9 } }
    : {}),
  routerMetadata: { reasonCode: 'test', classifierAttemptId: 'classifier-1' }
})

describe('MessageDeliveryJournal', () => {
  it('keeps content out of SQLite and recovers the three cross-store crash outcomes', async () => {
    const { root, journal } = await setup()
    const abandoned = await journal.prepare(request(root.agentRunId, 'delivery-1'))
    expect(abandoned.lifecycle).toBe('preparing')
    await expect(
      journal.reconcile(abandoned.id, { hasSessionMessage: false })
    ).resolves.toMatchObject({
      lifecycle: 'abandoned',
      safeErrorCode: 'session_message_missing'
    })

    const promoted = await journal.prepare(request(root.agentRunId, 'delivery-2'))
    await expect(
      journal.reconcile(promoted.id, { hasSessionMessage: true })
    ).resolves.toMatchObject({
      lifecycle: 'queued',
      resolved: 'side-question',
      source: 'router'
    })

    const ambiguous = await journal.prepare(request(root.agentRunId, 'delivery-3', 'steer'))
    await expect(
      journal.reconcile(ambiguous.id, { hasSessionMessage: true, dispatchAmbiguous: true })
    ).resolves.toMatchObject({
      lifecycle: 'blocked',
      safeErrorCode: 'dispatch_ambiguous'
    })

    const rows = await client!.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT * FROM "MessageDelivery" ORDER BY "sequence"`
    )
    expect(rows).toHaveLength(3)
    expect(JSON.stringify(rows)).not.toContain('message content')
    expect(rows.map((row) => row.sequence)).toEqual([0, 1, 2])
  })

  it('uses compare-and-set lifecycle transitions and keeps exact retries idempotent', async () => {
    const { root, journal } = await setup()
    const prepared = await journal.prepare(request(root.agentRunId, 'delivery-1'))
    await expect(
      journal.transition(prepared.id, 'queued', { expectedRevision: prepared.revision + 1 })
    ).rejects.toThrow(/revision changed/i)
    const queued = await journal.transition(prepared.id, 'queued', {
      expectedRevision: prepared.revision
    })
    const dispatched = await journal.transition(queued.id, 'dispatched', {
      runtimeThreadId: 'thread-1',
      runtimeTurnId: 'turn-1'
    })
    await expect(journal.transition(dispatched.id, 'completed')).resolves.toMatchObject({
      lifecycle: 'completed',
      runtimeThreadId: 'thread-1',
      runtimeTurnId: 'turn-1'
    })
    await expect(journal.transition(dispatched.id, 'failed')).rejects.toThrow(/cannot transition/i)
    await expect(journal.prepare(request(root.agentRunId, 'delivery-1'))).resolves.toMatchObject({
      id: 'delivery-1',
      lifecycle: 'completed'
    })
    await expect(
      journal.prepare({
        ...request(root.agentRunId, 'delivery-conflict'),
        messageId: 'message-1'
      })
    ).rejects.toThrow('retry identity conflicts')
  })

  it('coalesces concurrent exact preparation into one durable delivery row', async () => {
    const { root, journal } = await setup()
    const input = request(root.agentRunId, 'delivery-concurrent')

    const prepared = await Promise.all([journal.prepareOnce(input), journal.prepareOnce(input)])

    expect(prepared.map(({ created }) => created).sort()).toEqual([false, true])
    expect(prepared[0].delivery.id).toBe(prepared[1].delivery.id)
    await expect(
      client!.messageDelivery.count({
        where: { sessionId: input.sessionId, messageId: input.messageId }
      })
    ).resolves.toBe(1)
  })
})
