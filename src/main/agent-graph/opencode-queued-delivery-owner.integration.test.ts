import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import type { AcpPromptRequest } from '../../shared/acp'
import type { PersistedChatMessage, PersistedChatSession } from '../../shared/session-persistence'
import { ensureProjectSchema, createProjectDbClient } from '../projects/prisma-client'
import { AgentGraphOwner } from './owner'
import { MessageDeliveryJournal } from './delivery-journal'
import {
  OpenCodeQueuedDeliveryOwner,
  type OpenCodeQueuedDeliveryOwnerOptions
} from './opencode-queued-delivery-owner'
import type { ActiveTurnSnapshot } from './message-delivery-owner'

const projectId = 'project-1'
const sessionId = 'session-1'
const promptMessageId = 'prompt-1'

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

const activeSnapshotFor = (rootRunId: string): ActiveTurnSnapshot =>
  Object.freeze({
    sessionId,
    projectId,
    rootRunId,
    backendGeneration: 'runtime-generation-1',
    backend: 'opencode',
    runtimeThreadId: 'opencode-thread-1',
    turnId: 'turn-1',
    promptMessageId,
    cancellationGeneration: 0,
    runtimeSessionId: sessionId
  })

const createSession = (): PersistedChatSession =>
  ({
    id: sessionId,
    projectId,
    title: 'OpenCode persisted queue',
    cwd: '/workspace',
    status: 'running',
    messages: [],
    activeRun: { promptMessageId, startedAt: 1 },
    createdAt: 1,
    updatedAt: 1
  }) as unknown as PersistedChatSession

const createUserMessage = (id: string, content: string): PersistedChatMessage => ({
  id,
  role: 'user',
  content,
  status: 'complete',
  eventIds: [],
  createdAt: 2,
  updatedAt: 2
})

type DiskSessionStore = Readonly<{
  load(): Promise<PersistedChatSession | undefined>
  save(session: PersistedChatSession): Promise<void>
}>

const createDiskSessionStore = (filePath: string): DiskSessionStore => ({
  async load(): Promise<PersistedChatSession | undefined> {
    try {
      return JSON.parse(await readFile(filePath, 'utf8')) as PersistedChatSession
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return undefined
      }
      throw error
    }
  },
  save: async (session) => writeFile(filePath, JSON.stringify(session), 'utf8')
})

let storageRoot: string | undefined
let client: PrismaClient | undefined

afterEach(async () => {
  await client?.$disconnect()
  client = undefined
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

const createOwner = (
  sessionStore: DiskSessionStore,
  journal: MessageDeliveryJournal,
  rootRunId: string,
  active: { value: boolean },
  sent: AcpPromptRequest[]
): OpenCodeQueuedDeliveryOwner => {
  const options: OpenCodeQueuedDeliveryOwnerOptions = {
    sessions: {
      projectIdForSession: async () => projectId,
      loadSession: () => sessionStore.load(),
      assertSessionAvailable: async () => undefined,
      appendUserMessageToInteraction: async ({ messageId, content }) => {
        const session = await sessionStore.load()
        if (!session) throw new Error('session_unavailable')
        const persisted = createUserMessage(messageId, content)
        await sessionStore.save({
          ...session,
          messages: [...session.messages, persisted],
          updatedAt: session.updatedAt + 1
        })
        return persisted
      }
    },
    deliveries: journal,
    resolveActiveTurn: async () => (active.value ? activeSnapshotFor(rootRunId) : undefined),
    resolveParentDeliveryState: async () => 'terminal',
    runtime: {
      isSessionReady: () => true,
      sendAppContinuationObserved: async (request, onProviderPromptAccepted) => {
        sent.push(request)
        onProviderPromptAccepted()
      },
      cancelPrompt: async () => {
        active.value = false
        const session = await sessionStore.load()
        if (session) {
          await sessionStore.save({ ...session, activeRun: undefined, status: 'idle' })
        }
      },
      waitForSessionInteractionRelease: async () => undefined
    },
    idFactory: (() => {
      let sequence = 0
      return () => `delivery-${++sequence}`
    })()
  }
  return new OpenCodeQueuedDeliveryOwner(options)
}

describe('OpenCodeQueuedDeliveryOwner persisted recovery', () => {
  it('recovers a queued item from the SQLite journal after owner restart and dispatches once', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'research-agent-opencode-queue-'))
    client = createProjectDbClient(storageRoot)
    await ensureProjectSchema(client)
    const sessionStore = createDiskSessionStore(join(storageRoot, 'session.json'))

    let rootId = 0
    const graph = new AgentGraphOwner(async () => client!, {
      idFactory: () => `root-id-${++rootId}`
    })
    const root = await graph.createConfiguredDirectRoot({
      projectId,
      sessionId,
      promptMessageId,
      workClass: 'analysis',
      target,
      status: 'running'
    })
    const journal = new MessageDeliveryJournal(async () => client!)
    const session = createSession()
    await sessionStore.save(session)
    const active = { value: true }
    const firstOwnerSent: AcpPromptRequest[] = []
    const firstOwner = createOwner(sessionStore, journal, root.agentRunId, active, firstOwnerSent)

    await expect(
      firstOwner.deliver({
        sessionId,
        content: 'survive the owner restart',
        requested: 'steer'
      })
    ).resolves.toMatchObject({ status: 'accepted', delivery: { lifecycle: 'queued' } })
    await firstOwner.closeAndWait()

    active.value = false
    const terminalSession = await sessionStore.load()
    if (!terminalSession) throw new Error('session_unavailable')
    await sessionStore.save({
      ...terminalSession,
      activeRun: undefined,
      status: 'idle'
    })
    const restartedOwnerSent: AcpPromptRequest[] = []
    const restartedOwner = createOwner(
      sessionStore,
      journal,
      root.agentRunId,
      active,
      restartedOwnerSent
    )
    await restartedOwner.recover()
    await viWaitFor(() => expect(restartedOwnerSent).toHaveLength(1))
    await restartedOwner.closeAndWait()

    const rows = await journal.listForSession(sessionId)
    expect(firstOwnerSent).toHaveLength(0)
    expect(restartedOwnerSent[0]).toMatchObject({
      text: 'survive the owner restart',
      suppressUserMessage: true
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'delivery-2',
      messageId: 'delivery-1',
      targetRootRunId: root.agentRunId,
      lifecycle: 'completed'
    })
    const persisted = await sessionStore.load()
    expect(persisted?.messages.map(({ content }) => content)).toEqual(['survive the owner restart'])
  })
})

const viWaitFor = async (assertion: () => void): Promise<void> => {
  const deadline = Date.now() + 2_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
  }
  throw lastError
}
