import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentRuntimePort, AgentRuntimeSessionState } from '../agent-runtime'
import type { PersistedChatMessage, PersistedChatSession } from '../../shared/session-persistence'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import {
  InMemoryCodexRuntimeThreadLinkStore,
  type CodexRuntimeThreadLink
} from '../codex-app-server/runtime-links'
import {
  DirectCodexDeliveryRegistry,
  type DirectCodexDeliveryRegistryOptions
} from './direct-codex-delivery-registry'
import type { ActiveTurnSnapshot } from './message-delivery-owner'

let storageRoot: string | undefined
let client: PrismaClient | undefined

const link: CodexRuntimeThreadLink = {
  id: 'link-1',
  agentRunId: 'run-1',
  appSessionId: 'session-1',
  backend: 'codex',
  runtimeThreadId: 'thread-1',
  ephemeral: false,
  runtimeOwner: 'codex_app_server',
  authorizedCwd: '/workspace',
  sandbox: 'read-only',
  model: 'model-1',
  modelProvider: 'provider-1',
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  createdAt: 1
}

const session = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession =>
  ({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Direct Codex delivery',
    cwd: '/workspace',
    status: 'running',
    activeRun: { promptMessageId: 'prompt-1', startedAt: 1 },
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }) as PersistedChatSession

const runtimeState = (
  overrides: Partial<AgentRuntimeSessionState> = {}
): AgentRuntimeSessionState => ({
  appSessionId: 'session-1',
  backend: 'codex',
  runtimeThreadId: 'thread-1',
  ephemeral: false,
  cwd: '/workspace',
  sandbox: 'read-only',
  model: 'model-1',
  modelProvider: 'provider-1',
  status: 'running',
  activeTurnId: 'turn-1',
  updatedAt: 1,
  ...overrides
})

const runtime = (
  state: AgentRuntimeSessionState = runtimeState()
): {
  value: AgentRuntimePort
  readState: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} => {
  const readState = vi.fn(async () => state)
  const close = vi.fn(async () => undefined)
  const value = {
    backend: 'codex' as const,
    capabilities: { nativeSteer: vi.fn() },
    start: vi.fn(),
    resume: vi.fn(),
    readState,
    startTurn: vi.fn(),
    cancel: vi.fn(),
    closeSession: vi.fn(),
    close,
    onEvent: vi.fn(() => () => undefined)
  } as unknown as AgentRuntimePort
  return { value, readState, close }
}

const setup = async (): Promise<void> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'research-agent-m2-direct-delivery-'))
  client = createProjectDbClient(storageRoot)
  await ensureProjectSchema(client)
  await client.routingPolicySnapshot.create({
    data: {
      id: 'policy-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      workClass: 'analysis',
      policyId: 'configured_direct',
      policyVersion: '1',
      policySource: 'configured_direct',
      policyJson: '{}',
      policyHash: 'hash-1'
    }
  })
  await client.agentGraph.create({
    data: {
      id: 'graph-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      rootPromptMessageId: 'prompt-1'
    }
  })
  await client.agentRun.create({
    data: {
      id: 'run-1',
      graphId: 'graph-1',
      policySnapshotId: 'policy-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      promptMessageId: 'prompt-1',
      role: 'main-agent',
      workClass: 'analysis',
      runtime: 'codex',
      status: 'running'
    }
  })
  await client.runtimeThreadLink.create({
    data: {
      id: link.id,
      agentRunId: link.agentRunId,
      appSessionId: link.appSessionId,
      backend: link.backend,
      runtimeThreadId: link.runtimeThreadId,
      ephemeral: link.ephemeral,
      runtimeOwner: link.runtimeOwner,
      authorizedCwd: link.authorizedCwd,
      sandbox: link.sandbox,
      model: link.model,
      modelProvider: link.modelProvider,
      approvalPolicy: link.approvalPolicy,
      approvalsReviewer: link.approvalsReviewer,
      createdAt: new Date(link.createdAt)
    }
  })
}

const registryOptions = (
  runtimeValue: AgentRuntimePort,
  overrides: Partial<DirectCodexDeliveryRegistryOptions> = {}
): DirectCodexDeliveryRegistryOptions => ({
  getClient: async () => client!,
  links: new InMemoryCodexRuntimeThreadLinkStore({ links: [link] }),
  applicationVersion: '0.12.1-test',
  dataRoot: '/data-root',
  defaultCwd: '/workspace',
  backendGeneration: 'generation-1',
  provider: vi.fn(async () => ({ kind: 'subscription' as const, model: 'model-1' })),
  createRuntime: vi.fn(() => runtimeValue),
  ...overrides
})

const message: PersistedChatMessage = {
  id: 'message-replacement',
  role: 'user',
  content: 'Replace the active task.',
  status: 'complete',
  eventIds: [],
  createdAt: 2,
  updatedAt: 2
}

const delivery = {
  id: 'delivery-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  messageId: message.id,
  targetRootRunId: 'run-1',
  targetPromptMessageId: 'prompt-1',
  backend: 'codex',
  runtimeThreadId: 'thread-1',
  runtimeTurnId: 'turn-1',
  requested: 'stop-and-replace' as const,
  resolved: 'stop-and-replace' as const,
  source: 'explicit' as const,
  sequence: 0,
  lifecycle: 'dispatched' as const,
  createdAt: 1,
  updatedAt: 1,
  revision: 1
}

afterEach(async () => {
  await client?.$disconnect()
  client = undefined
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

describe('DirectCodexDeliveryRegistry', () => {
  it('binds an active turn only to the direct Codex root, graph, thread, and generation', async () => {
    await setup()
    const fake = runtime()
    const registry = new DirectCodexDeliveryRegistry(registryOptions(fake.value))

    await expect(registry.resolveActiveTurn(session())).resolves.toMatchObject({
      sessionId: 'session-1',
      projectId: 'project-1',
      rootRunId: 'run-1',
      backendGeneration: 'generation-1',
      runtimeThreadId: 'thread-1',
      runtimeSessionId: 'session-1',
      turnId: 'turn-1',
      promptMessageId: 'prompt-1',
      cancellationGeneration: 0
    })
    expect(fake.readState).toHaveBeenCalledWith('session-1')
    expect(registry.runtimeGeneration).toBe(fake.value)
  })

  it('rejects a stale replacement when cancellation authority changes', async () => {
    await setup()
    const fake = runtime(runtimeState({ status: 'idle', activeTurnId: undefined }))
    const registry = new DirectCodexDeliveryRegistry(registryOptions(fake.value))
    const snapshot: ActiveTurnSnapshot = {
      sessionId: 'session-1',
      projectId: 'project-1',
      rootRunId: 'run-1',
      backendGeneration: 'generation-1',
      backend: 'codex',
      runtimeThreadId: 'thread-1',
      turnId: 'turn-1',
      promptMessageId: 'prompt-1',
      cancellationGeneration: 0,
      runtimeSessionId: 'session-1'
    }
    const adapter = await registry.runtimeForSnapshot(snapshot)
    const startReplacement = adapter?.startReplacement
    expect(startReplacement).toBeDefined()
    await client!.agentGraph.update({
      where: { id: 'graph-1' },
      data: { cancellationGeneration: 1 }
    })

    await expect(startReplacement!({ snapshot, message, delivery })).rejects.toThrow(
      'replacement_target_stale'
    )
    expect(fake.value.startTurn).not.toHaveBeenCalled()
  })

  it('fails closed when duplicate active direct links exist for one Session', async () => {
    await setup()
    await client!.runtimeThreadLink.create({
      data: {
        id: 'link-duplicate',
        agentRunId: link.agentRunId,
        appSessionId: link.appSessionId,
        backend: link.backend,
        runtimeThreadId: 'thread-duplicate',
        ephemeral: link.ephemeral,
        runtimeOwner: link.runtimeOwner,
        authorizedCwd: link.authorizedCwd,
        sandbox: link.sandbox,
        model: link.model,
        modelProvider: link.modelProvider,
        approvalPolicy: link.approvalPolicy,
        approvalsReviewer: link.approvalsReviewer,
        createdAt: new Date(2)
      }
    })
    const fake = runtime()
    const registry = new DirectCodexDeliveryRegistry(registryOptions(fake.value))

    await expect(registry.resolveActiveTurn(session())).resolves.toBeUndefined()
    expect(fake.readState).not.toHaveBeenCalled()
  })

  it('enforces the idle barrier before a replacement start', async () => {
    await setup()
    const fake = runtime(runtimeState({ status: 'running', activeTurnId: 'turn-2' }))
    const registry = new DirectCodexDeliveryRegistry(registryOptions(fake.value))
    const snapshot: ActiveTurnSnapshot = {
      sessionId: 'session-1',
      projectId: 'project-1',
      rootRunId: 'run-1',
      backendGeneration: 'generation-1',
      backend: 'codex',
      runtimeThreadId: 'thread-1',
      turnId: 'turn-1',
      promptMessageId: 'prompt-1',
      cancellationGeneration: 0,
      runtimeSessionId: 'session-1'
    }
    const adapter = await registry.runtimeForSnapshot(snapshot)
    const startReplacement = adapter?.startReplacement
    expect(startReplacement).toBeDefined()

    await expect(startReplacement!({ snapshot, message, delivery })).rejects.toThrow(
      'replacement_target_not_idle'
    )
    expect(fake.value.startTurn).not.toHaveBeenCalled()
  })

  it('fails closed on provider/startup failure and disposes a partially started runtime', async () => {
    await setup()
    const fake = runtime()
    const provider = vi.fn(async () => {
      throw new Error('provider_handoff_failed')
    })
    const registry = new DirectCodexDeliveryRegistry(registryOptions(fake.value, { provider }))

    await expect(registry.resolveActiveTurn(session())).rejects.toThrow('runtime_resolution_failed')
    expect(provider).toHaveBeenCalledOnce()
    expect(fake.close).not.toHaveBeenCalled()

    const startupFailure = runtime()
    startupFailure.readState.mockRejectedValueOnce(new Error('startup_failed'))
    const startupRegistry = new DirectCodexDeliveryRegistry(registryOptions(startupFailure.value))
    await expect(startupRegistry.resolveActiveTurn(session())).rejects.toThrow(
      'runtime_resolution_failed'
    )
    expect(startupFailure.close).toHaveBeenCalledOnce()
  })

  it('closes the owned runtime generation exactly once and does not retain it', async () => {
    await setup()
    const fake = runtime()
    const registry = new DirectCodexDeliveryRegistry(registryOptions(fake.value))

    await registry.resolveActiveTurn(session())
    await registry.close()
    await registry.close()

    expect(fake.close).toHaveBeenCalledOnce()
    expect(registry.runtimeGeneration).toBeUndefined()
  })
})
