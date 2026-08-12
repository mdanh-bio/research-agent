import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PersistedChatMessage } from '../../shared/session-persistence'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { MessageDeliveryJournal } from './delivery-journal'
import { AgentGraphOwner } from './owner'
import { M2PromptPersistenceOwner } from './prompt-owner'

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

describe('M2PromptPersistenceOwner', () => {
  it('journals metadata before appending the exact main-owned Session Message and promotes only after it is durable', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'research-agent-m2-prompt-'))
    client = createProjectDbClient(storageRoot)
    await ensureProjectSchema(client)
    let nextId = 0
    const graph = new AgentGraphOwner(async () => client!, {
      idFactory: () => `prompt-id-${++nextId}`
    })
    const journal = new MessageDeliveryJournal(async () => client!)
    let observedPreparing = false
    const sessions = {
      appendUserMessageToInteraction: async (command: {
        projectId: string
        sessionId: string
        interactionId: string
        messageId: string
        content: string
      }): Promise<PersistedChatMessage> => {
        const row = await client!.messageDelivery.findFirst({ orderBy: { sequence: 'desc' } })
        observedPreparing = row?.lifecycle === 'preparing'
        return {
          id: command.messageId,
          role: 'user',
          content: command.content,
          status: 'complete',
          eventIds: [],
          responseToMessageId: command.interactionId,
          createdAt: 1,
          updatedAt: 1
        }
      }
    }
    const owner = new M2PromptPersistenceOwner(graph, journal, sessions)
    const prepared = await owner.prepare({
      projectId: 'project-1',
      sessionId: 'session-1',
      content: 'private prompt content stays in Session JSON',
      interactionId: 'interaction-1',
      messageId: 'message-main-1',
      deliveryId: 'delivery-main-1',
      requestedMode: 'auto',
      hasActiveTurn: false,
      target,
      workClass: 'analysis',
      parts: [{ type: 'text', text: 'private prompt content stays in Session JSON' }]
    })

    expect(observedPreparing).toBe(true)
    expect(prepared.message.id).toBe('message-main-1')
    expect(prepared.delivery.lifecycle).toBe('queued')
    const rows = await client!.messageDelivery.findMany()
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows[0])).not.toContain('private prompt content')
  })

  it('abandons the delivery and blocks the root when Session persistence fails before acknowledgement', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'research-agent-m2-prompt-failure-'))
    client = createProjectDbClient(storageRoot)
    await ensureProjectSchema(client)
    const graph = new AgentGraphOwner(async () => client!)
    const journal = new MessageDeliveryJournal(async () => client!)
    const owner = new M2PromptPersistenceOwner(graph, journal, {
      appendUserMessageToInteraction: async () => {
        throw new Error('session write failed')
      }
    })

    await expect(
      owner.prepare({
        projectId: 'project-1',
        sessionId: 'session-1',
        content: 'will not be acknowledged',
        messageId: 'message-failed',
        deliveryId: 'delivery-failed',
        requestedMode: 'auto',
        hasActiveTurn: false,
        target,
        workClass: 'analysis'
      })
    ).rejects.toThrow('session write failed')

    await expect(client!.messageDelivery.findFirst()).resolves.toMatchObject({
      lifecycle: 'abandoned',
      safeErrorCode: 'session_message_missing'
    })
    await expect(client!.agentRun.findFirst()).resolves.toMatchObject({
      status: 'blocked',
      failureCode: 'session_message_missing'
    })
  })

  it('promotes a durable Session Message after a crash between append and delivery promotion', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'research-agent-m2-prompt-recovery-'))
    client = createProjectDbClient(storageRoot)
    await ensureProjectSchema(client)
    const graph = new AgentGraphOwner(async () => client!)
    const journal = new MessageDeliveryJournal(async () => client!)
    let sessionMessageDurable = false
    const sessions = {
      appendUserMessageToInteraction: async (command: {
        projectId: string
        sessionId: string
        interactionId: string
        messageId: string
        content: string
      }): Promise<PersistedChatMessage> => {
        sessionMessageDurable = true
        return {
          id: command.messageId,
          role: 'user',
          content: command.content,
          status: 'complete',
          eventIds: [],
          responseToMessageId: command.interactionId,
          createdAt: 1,
          updatedAt: 1
        }
      }
    }
    const promotion = vi
      .spyOn(journal, 'reconcile')
      .mockRejectedValueOnce(new Error('crash before promotion'))
    const owner = new M2PromptPersistenceOwner(graph, journal, sessions)

    await expect(
      owner.prepare({
        projectId: 'project-1',
        sessionId: 'session-1',
        content: 'durable before promotion',
        messageId: 'message-recovery',
        deliveryId: 'delivery-recovery',
        requestedMode: 'auto',
        hasActiveTurn: true,
        target,
        workClass: 'analysis'
      })
    ).rejects.toThrow('crash before promotion')
    expect(sessionMessageDurable).toBe(true)
    const pending = await client!.messageDelivery.findFirstOrThrow()
    expect(pending.lifecycle).toBe('preparing')

    promotion.mockRestore()
    await expect(
      owner.prepare({
        projectId: 'project-1',
        sessionId: 'session-1',
        content: 'durable before promotion',
        messageId: 'message-recovery',
        deliveryId: 'delivery-recovery',
        requestedMode: 'auto',
        hasActiveTurn: true,
        target,
        workClass: 'analysis'
      })
    ).resolves.toMatchObject({
      root: { agentRunId: expect.any(String) },
      delivery: { id: pending.id, lifecycle: 'queued' }
    })
    await expect(client!.messageDelivery.count()).resolves.toBe(1)
    await expect(client!.agentRun.findFirst()).resolves.toMatchObject({ status: 'running' })
  })

  it('rejects a conflicting retry without mutating the durable delivery or root', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'research-agent-m2-prompt-conflict-'))
    client = createProjectDbClient(storageRoot)
    await ensureProjectSchema(client)
    const graph = new AgentGraphOwner(async () => client!)
    const journal = new MessageDeliveryJournal(async () => client!)
    const sessions = {
      appendUserMessageToInteraction: async (command: {
        interactionId: string
        messageId: string
        content: string
      }): Promise<PersistedChatMessage> => ({
        id: command.messageId,
        role: 'user',
        content: command.content,
        status: 'complete',
        eventIds: [],
        responseToMessageId: command.interactionId,
        createdAt: 1,
        updatedAt: 1
      })
    }
    const owner = new M2PromptPersistenceOwner(graph, journal, sessions)
    const base = {
      projectId: 'project-1',
      sessionId: 'session-1',
      content: 'original instruction',
      interactionId: 'interaction-1',
      messageId: 'message-conflict',
      deliveryId: 'delivery-conflict',
      requestedMode: 'auto' as const,
      hasActiveTurn: false,
      target,
      workClass: 'analysis' as const
    }
    await owner.prepare(base)

    await expect(owner.prepare({ ...base, requestedMode: 'side-question' })).rejects.toThrow(
      'retry identity conflicts'
    )
    await expect(
      client!.messageDelivery.findUniqueOrThrow({ where: { id: base.deliveryId } })
    ).resolves.toMatchObject({ lifecycle: 'queued', requestedMode: 'auto' })
    await expect(client!.agentRun.findFirst()).resolves.toMatchObject({ status: 'running' })
  })
})
