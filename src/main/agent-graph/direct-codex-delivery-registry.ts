import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'

import type { PrismaClient } from '@prisma/client'

import type { PersistedChatSession } from '../../shared/session-persistence'
import type { AgentRuntimePort } from '../agent-runtime'
import {
  CodexRuntimeGenerationOwner,
  type CodexRuntimeGenerationOptions
} from '../codex-app-server/codex-runtime'
import {
  codexRuntimeThreadLinkFromRow,
  PrismaCodexRuntimeThreadLinkStore,
  type CodexRuntimeThreadLink,
  type CodexRuntimeThreadLinkStore
} from '../codex-app-server/runtime-links'
import type { CodexAppServerProviderHandoff } from '../codex-app-server/start'
import type { ActiveTurnSnapshot, RuntimeAdapter } from './message-delivery-owner'
import type { SideQuestionParentSnapshot } from '../../shared/side-question'

type DirectCodexAuthorityRow = Readonly<{
  link: CodexRuntimeThreadLink
  run: Readonly<{
    id: string
    graphId: string | null
    frameId: string | null
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

type DirectCodexDeliveryRegistryOptions = Readonly<{
  getClient: () => Promise<PrismaClient>
  links?: CodexRuntimeThreadLinkStore
  applicationVersion: string
  dataRoot: string
  defaultCwd?: string
  provider?: () => Promise<CodexAppServerProviderHandoff | undefined>
  backendGeneration?: string
  createRuntime?: (options: CodexRuntimeGenerationOptions) => AgentRuntimePort
}>

const identifier = (value: unknown, label: string): string => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 256 ||
    value.includes('\u0000') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

const directCodexLinks = (
  links: readonly CodexRuntimeThreadLink[]
): readonly CodexRuntimeThreadLink[] =>
  Object.freeze(
    links.filter(
      (link) =>
        link.backend === 'codex' &&
        link.runtimeOwner === 'codex_app_server' &&
        link.closedAt === undefined
    )
  )

// This query is intentionally separate from the runtime-link store. A valid provider thread is not
// enough authority for delivery: the linked Agent Run must still be the exact root of the same
// project/session graph and the graph must still be active.
const readAuthority = async (
  client: PrismaClient,
  sessionId: string
): Promise<DirectCodexAuthorityRow | undefined> => {
  const linkRows = await client.runtimeThreadLink.findMany({
    where: {
      appSessionId: sessionId,
      backend: 'codex',
      runtimeOwner: 'codex_app_server',
      closedAt: null
    },
    orderBy: { createdAt: 'desc' }
  })
  if (linkRows.length !== 1) return undefined
  const linkRow = linkRows[0]
  const run = await client.agentRun.findUnique({ where: { id: linkRow.agentRunId } })
  if (!run || !run.graphId) return undefined
  const graph = await client.agentGraph.findUnique({ where: { id: run.graphId } })
  if (!graph) return undefined
  return {
    link: codexRuntimeThreadLinkFromRow(linkRow),
    run,
    graph
  }
}

// Main-owned registry for the Stage 3 delivery seam. It never searches ACP ownership maps and it
// never treats a legacy ACP session id as a direct Codex runtime session.
export class DirectCodexDeliveryRegistry {
  private readonly links: CodexRuntimeThreadLinkStore
  private readonly backendGeneration: string
  private readonly defaultCwd: string
  private readonly createRuntime: NonNullable<DirectCodexDeliveryRegistryOptions['createRuntime']>
  private runtime: AgentRuntimePort | undefined
  private runtimePromise: Promise<AgentRuntimePort> | undefined

  constructor(private readonly options: DirectCodexDeliveryRegistryOptions) {
    this.links =
      options.links ??
      new PrismaCodexRuntimeThreadLinkStore(() =>
        options.getClient().then((client) => client.runtimeThreadLink)
      )
    this.backendGeneration = identifier(
      options.backendGeneration ?? randomUUID(),
      'Codex delivery backend generation'
    )
    this.defaultCwd = options.defaultCwd ?? homedir()
    this.createRuntime =
      options.createRuntime ?? ((runtimeOptions) => new CodexRuntimeGenerationOwner(runtimeOptions))
  }

  async resolveActiveTurn(session: PersistedChatSession): Promise<ActiveTurnSnapshot | undefined> {
    if (!session.activeRun?.promptMessageId) return undefined
    const authority = await this.authorityFor(
      session.id,
      session.projectId,
      session.activeRun.promptMessageId
    )
    if (!authority) return undefined
    let runtime: AgentRuntimePort
    try {
      runtime = await this.ensureRuntime(authority.link)
    } catch {
      // Runtime startup/provider resolution is an authority failure, not an invitation to borrow
      // ACP ownership. The delivery owner will preserve the draft and report the safe failure.
      throw new Error('runtime_resolution_failed')
    }
    let state
    try {
      state = await runtime.readState(session.id)
    } catch {
      throw new Error('runtime_resolution_failed')
    }
    if (
      state.backend !== 'codex' ||
      state.runtimeThreadId !== authority.link.runtimeThreadId ||
      state.status !== 'running' ||
      !state.activeTurnId
    ) {
      return undefined
    }
    return Object.freeze({
      sessionId: session.id,
      projectId: session.projectId,
      rootRunId: authority.run.id,
      backendGeneration: this.backendGeneration,
      backend: 'codex',
      runtimeThreadId: authority.link.runtimeThreadId,
      turnId: state.activeTurnId,
      promptMessageId: session.activeRun.promptMessageId,
      cancellationGeneration: authority.graph.cancellationGeneration,
      runtimeSessionId: authority.link.appSessionId
    })
  }

  async runtimeForSnapshot(snapshot: ActiveTurnSnapshot): Promise<RuntimeAdapter | undefined> {
    if (snapshot.backend !== 'codex' || snapshot.backendGeneration !== this.backendGeneration) {
      return undefined
    }
    const authority = await this.authorityFor(
      snapshot.sessionId,
      snapshot.projectId,
      snapshot.promptMessageId
    )
    if (
      !authority ||
      authority.link.agentRunId !== snapshot.rootRunId ||
      authority.link.runtimeThreadId !== snapshot.runtimeThreadId ||
      authority.link.appSessionId !== snapshot.runtimeSessionId ||
      authority.graph.cancellationGeneration !== snapshot.cancellationGeneration
    ) {
      return undefined
    }
    let runtime: AgentRuntimePort
    try {
      runtime = await this.ensureRuntime(authority.link)
    } catch {
      throw new Error('runtime_resolution_failed')
    }
    return Object.freeze({
      backend: 'codex' as const,
      runtime,
      startReplacement: async ({ snapshot: replacementSnapshot, message, inputs }) => {
        await this.assertReplacementTarget(replacementSnapshot, runtime)
        await runtime.startTurn({
          appSessionId: replacementSnapshot.runtimeSessionId,
          input: inputs ?? [{ kind: 'text', text: message.content }],
          clientUserMessageId: message.id
        })
      },
      releaseInteraction: async () => undefined
    })
  }

  async resolveSideQuestionParent(
    session: PersistedChatSession
  ): Promise<SideQuestionParentSnapshot | undefined> {
    const promptMessageId =
      session.activeRun?.promptMessageId ??
      [...session.messages].reverse().find((message) => message.role === 'user')?.id
    if (!promptMessageId) return undefined
    const authority = await this.authorityForAnyRoot(session.id, session.projectId, promptMessageId)
    if (!authority) return undefined
    const runtime = await this.ensureRuntime(authority.link).catch(() => undefined)
    if (!runtime) return undefined
    const state = await runtime.readState(authority.link.appSessionId).catch(() => undefined)
    if (
      !state ||
      state.backend !== 'codex' ||
      state.runtimeThreadId !== authority.link.runtimeThreadId
    ) {
      return undefined
    }
    return Object.freeze({
      projectId: session.projectId,
      sessionId: session.id,
      graphId: authority.graph.id,
      agentRunId: authority.run.id,
      frameId:
        authority.run.frameId ??
        (() => {
          throw new Error('side_question_parent_frame_missing')
        })(),
      promptMessageId,
      backend: 'codex',
      runtimeSessionId: authority.link.appSessionId,
      runtimeThreadId: authority.link.runtimeThreadId,
      activeTurnId: state.activeTurnId,
      lastStableTurnId: state.lastTerminalTurnId,
      model: authority.link.model,
      modelProvider: authority.link.modelProvider,
      cwd: authority.link.authorizedCwd,
      cancellationGeneration: authority.graph.cancellationGeneration
    })
  }

  async runtimeForSideQuestionParent(sessionId: string): Promise<AgentRuntimePort> {
    const authority = await readAuthority(await this.options.getClient(), sessionId)
    if (!authority) throw new Error('side_question_parent_unavailable')
    return this.ensureRuntime(authority.link)
  }

  async cleanupSideQuestionRuntime(parentSessionId: string, childSessionId: string): Promise<void> {
    const runtime = await this.runtimeForSideQuestionParent(parentSessionId)
    await runtime.closeSession(childSessionId)
  }

  async close(): Promise<void> {
    const runtime = this.runtime
    this.runtime = undefined
    this.runtimePromise = undefined
    await runtime?.close().catch(() => undefined)
  }

  get runtimeGeneration(): AgentRuntimePort | undefined {
    return this.runtime
  }

  private async assertReplacementTarget(
    snapshot: ActiveTurnSnapshot,
    runtime: AgentRuntimePort
  ): Promise<void> {
    const authority = await this.authorityFor(
      snapshot.sessionId,
      snapshot.projectId,
      snapshot.promptMessageId
    )
    if (
      !authority ||
      authority.link.agentRunId !== snapshot.rootRunId ||
      authority.link.runtimeThreadId !== snapshot.runtimeThreadId ||
      authority.link.appSessionId !== snapshot.runtimeSessionId ||
      authority.graph.cancellationGeneration !== snapshot.cancellationGeneration
    ) {
      throw new Error('replacement_target_stale')
    }

    let state
    try {
      state = await runtime.readState(snapshot.runtimeSessionId)
    } catch {
      throw new Error('replacement_runtime_unavailable')
    }
    if (
      state.backend !== 'codex' ||
      state.runtimeThreadId !== snapshot.runtimeThreadId ||
      state.status !== 'idle' ||
      state.activeTurnId !== undefined
    ) {
      throw new Error('replacement_target_not_idle')
    }
  }

  private async authorityFor(
    sessionId: string,
    projectId: string,
    promptMessageId: string
  ): Promise<DirectCodexAuthorityRow | undefined> {
    identifier(sessionId, 'Codex delivery session id')
    identifier(projectId, 'Codex delivery project id')
    identifier(promptMessageId, 'Codex delivery prompt message id')
    const authority = await readAuthority(await this.options.getClient(), sessionId)
    if (!authority) return undefined
    const { link, run, graph } = authority
    if (
      run.id !== link.agentRunId ||
      run.graphId !== graph.id ||
      run.parentAgentRunId !== null ||
      run.runKind !== 'root' ||
      run.projectId !== projectId ||
      run.sessionId !== sessionId ||
      run.promptMessageId !== promptMessageId ||
      run.status !== 'running' ||
      graph.projectId !== projectId ||
      graph.sessionId !== sessionId ||
      graph.rootPromptMessageId !== promptMessageId ||
      graph.kind !== 'root' ||
      graph.lifecycle !== 'active'
    ) {
      return undefined
    }
    return authority
  }

  private async authorityForAnyRoot(
    sessionId: string,
    projectId: string,
    promptMessageId: string
  ): Promise<DirectCodexAuthorityRow | undefined> {
    const authority = await readAuthority(await this.options.getClient(), sessionId)
    if (!authority) return undefined
    const { link, run, graph } = authority
    if (
      run.id !== link.agentRunId ||
      run.graphId !== graph.id ||
      run.parentAgentRunId !== null ||
      run.runKind !== 'root' ||
      run.projectId !== projectId ||
      run.sessionId !== sessionId ||
      run.promptMessageId !== promptMessageId ||
      !['running', 'completed'].includes(run.status) ||
      graph.projectId !== projectId ||
      graph.sessionId !== sessionId ||
      graph.rootPromptMessageId !== promptMessageId ||
      graph.kind !== 'root' ||
      !['active', 'completed'].includes(graph.lifecycle)
    )
      return undefined
    return authority
  }

  private async ensureRuntime(link: CodexRuntimeThreadLink): Promise<AgentRuntimePort> {
    if (this.runtime) return this.runtime
    if (this.runtimePromise) return this.runtimePromise
    const start = async (): Promise<AgentRuntimePort> => {
      const links = directCodexLinks(await this.links.listActive())
      const authorizedRoots = [
        ...new Set([this.options.dataRoot, ...links.map((item) => item.authorizedCwd)])
      ]
      const provider = await this.options.provider?.()
      const runtime = this.createRuntime({
        applicationVersion: this.options.applicationVersion,
        dataRoot: this.options.dataRoot,
        authorizedRoots,
        defaultCwd: this.defaultCwd,
        workspaceWriteRoots: links
          .filter((item) => item.sandbox === 'workspace-write')
          .map((item) => item.authorizedCwd),
        provider,
        links: this.links
      })
      try {
        await runtime.readState(link.appSessionId)
      } catch (error) {
        await runtime.close().catch(() => undefined)
        throw error
      }
      this.runtime = runtime
      return runtime
    }
    const pending = start()
    this.runtimePromise = pending
    try {
      return await pending
    } finally {
      if (this.runtimePromise === pending) this.runtimePromise = undefined
    }
  }
}

export type { DirectCodexDeliveryRegistryOptions }
