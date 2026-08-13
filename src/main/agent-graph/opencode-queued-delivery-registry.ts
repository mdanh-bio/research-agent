import type { PrismaClient } from '@prisma/client'

import type { PersistedChatSession } from '../../shared/session-persistence'
import type { AgentFrameworkId } from '../../shared/settings'
import type { ActiveTurnSnapshot } from './message-delivery-owner'

type OpenCodeQueuedRuntimeAuthority = Readonly<{
  getSessionFramework(sessionId: string): AgentFrameworkId | undefined
  hasLiveSession(projectId: string, sessionId: string): boolean
  getActiveDeliveryTurn(
    sessionId: string,
    promptMessageId: string
  ):
    | Readonly<{
        backend: 'opencode'
        backendGeneration: string
        runtimeThreadId: string
        turnId: string
        runtimeSessionId: string
      }>
    | undefined
}>

type OpenCodeRootAuthority = Readonly<{
  run: Readonly<{
    id: string
    graphId: string | null
    parentAgentRunId: string | null
    runKind: string
    projectId: string
    sessionId: string
    promptMessageId: string | null
    status: string
  }>
  graph: Readonly<{
    id: string
    projectId: string
    sessionId: string
    rootPromptMessageId: string
    kind: string
    lifecycle: string
    cancellationGeneration: number
  }>
}>

type OpenCodeQueuedDeliveryRegistryOptions = Readonly<{
  getClient: () => Promise<PrismaClient>
  runtime: OpenCodeQueuedRuntimeAuthority
}>

type OpenCodeParentDeliveryState = 'active' | 'terminal' | 'missing' | 'graph-sync-failed'

type OpenCodeParentDeliveryStateInput = Readonly<{
  projectId: string
  sessionId: string
  rootRunId: string
  promptMessageId: string
}>

const readRootAuthority = async (
  client: PrismaClient,
  session: PersistedChatSession
): Promise<OpenCodeRootAuthority | undefined> => {
  const promptMessageId = session.activeRun?.promptMessageId
  if (!promptMessageId) return undefined
  const run = await client.agentRun.findFirst({
    where: {
      projectId: session.projectId,
      sessionId: session.id,
      graphId: { not: null },
      parentAgentRunId: null,
      runKind: 'root',
      promptMessageId,
      status: 'running'
    },
    orderBy: { createdAt: 'desc' }
  })
  if (!run?.graphId) return undefined
  const graph = await client.agentGraph.findUnique({ where: { id: run.graphId } })
  if (!graph) return undefined
  return { run, graph }
}

// Resolves only the current OpenCode ACP Session plus its exact graph root. A queued row is never
// retargeted to a newer prompt merely because that newer prompt is live.
export class OpenCodeQueuedDeliveryRegistry {
  constructor(private readonly options: OpenCodeQueuedDeliveryRegistryOptions) {}

  isSession(sessionId: string): boolean {
    return this.options.runtime.getSessionFramework(sessionId) === 'opencode'
  }

  isSessionReady(projectId: string, sessionId: string): boolean {
    return this.options.runtime.hasLiveSession(projectId, sessionId)
  }

  async resolveActiveTurn(session: PersistedChatSession): Promise<ActiveTurnSnapshot | undefined> {
    if (this.options.runtime.getSessionFramework(session.id) !== 'opencode') return undefined
    if (!this.options.runtime.hasLiveSession(session.projectId, session.id)) return undefined
    const provider = this.options.runtime.getActiveDeliveryTurn(
      session.id,
      session.activeRun?.promptMessageId ?? ''
    )
    if (!provider) return undefined
    const authority = await readRootAuthority(await this.options.getClient(), session)
    if (!authority) return undefined
    const { run, graph } = authority
    if (
      run.graphId !== graph.id ||
      run.parentAgentRunId !== null ||
      run.runKind !== 'root' ||
      run.projectId !== session.projectId ||
      run.sessionId !== session.id ||
      run.promptMessageId !== session.activeRun?.promptMessageId ||
      run.status !== 'running' ||
      graph.projectId !== session.projectId ||
      graph.sessionId !== session.id ||
      graph.rootPromptMessageId !== session.activeRun?.promptMessageId ||
      graph.kind !== 'root' ||
      graph.lifecycle !== 'active'
    ) {
      return undefined
    }
    return Object.freeze({
      sessionId: session.id,
      projectId: session.projectId,
      rootRunId: run.id,
      backendGeneration: provider.backendGeneration,
      backend: 'opencode',
      runtimeThreadId: provider.runtimeThreadId,
      turnId: provider.turnId,
      promptMessageId: session.activeRun!.promptMessageId,
      cancellationGeneration: graph.cancellationGeneration,
      runtimeSessionId: provider.runtimeSessionId
    })
  }

  async resolveParentDeliveryState(
    input: OpenCodeParentDeliveryStateInput
  ): Promise<OpenCodeParentDeliveryState> {
    const client = await this.options.getClient()
    const run = await client.agentRun.findUnique({ where: { id: input.rootRunId } })
    if (!run) return 'missing'
    if (
      run.graphId === null ||
      run.parentAgentRunId !== null ||
      run.runKind !== 'root' ||
      run.projectId !== input.projectId ||
      run.sessionId !== input.sessionId ||
      run.promptMessageId !== input.promptMessageId
    ) {
      return 'missing'
    }
    const graph = await client.agentGraph.findUnique({ where: { id: run.graphId } })
    if (
      !graph ||
      graph.projectId !== input.projectId ||
      graph.sessionId !== input.sessionId ||
      graph.rootPromptMessageId !== input.promptMessageId
    ) {
      return 'missing'
    }
    if (run.status === 'running' || run.status === 'queued') return 'active'
    if (!['completed', 'failed', 'cancelled', 'blocked'].includes(run.status)) {
      return 'graph-sync-failed'
    }
    if (!['completed', 'failed', 'cancelled', 'blocked'].includes(graph.lifecycle)) {
      return 'graph-sync-failed'
    }
    return 'terminal'
  }
}

export type {
  OpenCodeParentDeliveryState,
  OpenCodeParentDeliveryStateInput,
  OpenCodeQueuedDeliveryRegistryOptions,
  OpenCodeQueuedRuntimeAuthority
}
