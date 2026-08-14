import { createHash, randomUUID } from 'node:crypto'

import {
  cancelAgentFrame,
  completeAgentFrame,
  createChildAgentFrame,
  failAgentFrame,
  resolveActiveConversationMessages
} from '../../shared/conversation-graph'
import type { ProjectFilesChangedEvent, ProjectFileSource } from '../../shared/project-files'
import {
  materializeSessionConversationGraph,
  sanitizeSessionRuntimeContext,
  validateMessageParts,
  validatePersistedUploadedAttachments,
  type MessagePart,
  type PersistedChatMessage,
  type PersistedChatSession,
  type PersistedSessionStatus,
  type SaveSessionOptions,
  type SessionRuntimeContext,
  type SessionRuntimeContextPatch
} from '../../shared/session-persistence'
import type { PersistedUploadedAttachment } from '../../shared/uploads'
import type { PersistedDelegation } from '../../shared/agent-delegation'
import {
  validatePersistedSideQuestion,
  validateSideQuestionTransition,
  type PersistedSideQuestion,
  type SideQuestionLifecycle
} from '../../shared/side-question'
import { FinalizedArtifactBindingConflictError } from '../artifacts/provenance-message-snapshot'
import { diagnosticErrorFields, type Logger } from '../logger'

type SessionMetadata = Readonly<Pick<PersistedChatSession, 'id' | 'projectId' | 'title'>>

type SessionMetadataSnapshot = Readonly<{
  sessions: readonly SessionMetadata[]
  isComplete: boolean
}>

type PatchSessionRuntimeContextCommand = Readonly<{
  projectId: string
  sessionId: string
  expectedRevision: number
  patch: SessionRuntimeContextPatch
  sessionStatus?: PersistedSessionStatus
  beforePersist?: () => void
}>

type AppendUserMessageToInteractionCommand = Readonly<{
  projectId: string
  sessionId: string
  interactionId: string
  messageId?: string
  content: string
  parts?: MessagePart[]
  uploads?: PersistedUploadedAttachment[]
  beforePersist?: () => void
}>

type CreateSideQuestionCardCommand = Readonly<{
  card: PersistedSideQuestion
}>

type TransitionSideQuestionCardCommand = Readonly<{
  projectId: string
  sessionId: string
  sideQuestionId: string
  lifecycle: SideQuestionLifecycle
  update?: Readonly<{
    answer?: string
    answerTruncated?: boolean
    safeFailureCode?: string
    runtimeSessionId?: string
    runtimeThreadId?: string
    model?: string
    modelProvider?: string
    runtimeLinkClosed?: boolean
    runtimeDisposed?: boolean
    completedAt?: number
  }>
}>

type SessionStateRepository = {
  loadSessionWithDiagnostics(
    projectId: string,
    sessionId: string
  ): Promise<
    | { status: 'found'; session: PersistedChatSession }
    | { status: 'missing' }
    | { status: 'unreadable' }
  >
  saveSession(session: PersistedChatSession): Promise<void>
}

type SessionStateFileIndex = {
  syncSession(session: PersistedChatSession): Promise<ProjectFileSource[]>
}

type SessionStateProvenance = {
  validateFinalizedMessageBindings(session: PersistedChatSession): Promise<void>
  captureFinalizedMessages(session: PersistedChatSession): Promise<void>
}

type SessionStateUploads = {
  upgradeLegacySessionUploads(
    session: PersistedChatSession,
    options: { mode: 'live-save' }
  ): Promise<PersistedChatSession>
}

type SessionPersistenceStateOwnerOptions = {
  repository: SessionStateRepository
  fileIndex: SessionStateFileIndex
  assertMutable(projectId: string, sessionId: string, operation: 'save' | 'mutate'): void
  notifyFilesChanged(event: ProjectFilesChangedEvent): void
  provenance?: SessionStateProvenance
  uploads?: SessionStateUploads
  log: Logger
}

class SessionRuntimeContextRevisionConflictError extends Error {
  readonly code = 'revision-conflict' as const

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(
      `Session runtime context revision conflict: expected ${expectedRevision}, actual ${actualRevision}.`
    )
    this.name = 'SessionRuntimeContextRevisionConflictError'
  }
}

const emptySessionRuntimeContext = (): SessionRuntimeContext => ({ version: 1, revision: 0 })

const cloneRuntimeContext = (context: SessionRuntimeContext): SessionRuntimeContext =>
  structuredClone(context)

const rebaseSafeSessionFields = (
  authoritative: PersistedChatSession,
  submitted: PersistedChatSession,
  fields: NonNullable<SaveSessionOptions['conflictRebaseFields']>
): PersistedChatSession => {
  const rebased = { ...authoritative }
  for (const field of fields) {
    switch (field) {
      case 'title':
        rebased.title = submitted.title
        break
      case 'permissionProfile':
        rebased.permissionProfile = submitted.permissionProfile
        break
      case 'autoReviewEnabled':
        rebased.autoReviewEnabled = submitted.autoReviewEnabled
        break
      case 'enabledComputeHosts':
        rebased.enabledComputeHosts = submitted.enabledComputeHosts
          ? [...submitted.enabledComputeHosts]
          : undefined
        break
      case 'pinned':
        rebased.pinned = submitted.pinned
        break
      case 'specialistId':
        rebased.specialistId = submitted.specialistId
        break
    }
  }
  rebased.updatedAt = Math.max(authoritative.updatedAt, submitted.updatedAt) + 1
  return rebased
}

const sessionBindingTopologyHash = (session: PersistedChatSession): string => {
  const graph = session.conversationGraph
  const topology = graph
    ? {
        rootFrameId: graph.rootFrameId,
        branches: graph.branches.map(({ id, agentFrameId, headMessageId }) => ({
          id,
          agentFrameId,
          headMessageId
        })),
        messages: graph.messages.map(({ id, agentFrameId, parentMessageId }) => ({
          id,
          agentFrameId,
          parentMessageId
        }))
      }
    : null
  return createHash('sha256').update(JSON.stringify(topology)).digest('hex')
}

type FinalizedArtifactBindingValidation =
  | { status: 'valid' }
  | { status: 'unavailable' }
  | { status: 'conflict'; error: FinalizedArtifactBindingConflictError }

const validateFinalizedArtifactBindings = async (
  provenance: SessionStateProvenance | undefined,
  session: PersistedChatSession,
  log: Logger
): Promise<FinalizedArtifactBindingValidation> => {
  if (!provenance) return { status: 'valid' }

  try {
    await provenance.validateFinalizedMessageBindings(session)
    return { status: 'valid' }
  } catch (error) {
    if (error instanceof FinalizedArtifactBindingConflictError) {
      return { status: 'conflict', error }
    }
    try {
      log.warn('pre-save provenance validation unavailable', {
        operation: 'session-save',
        phase: 'validate-provenance',
        outcome: 'degraded',
        ...diagnosticErrorFields(error)
      })
    } catch {
      // Diagnostics must never change Session durability or recovery behavior.
    }
    return { status: 'unavailable' }
  }
}

// Owns queued Session reads/writes and their in-memory projections. The coordinator remains the sole
// queue owner and calls this module only from inside that serialization boundary.
class SessionPersistenceStateOwner {
  private readonly validatedBindingTopologies = new Map<string, string>()
  private sessionMetadata = new Map<string, SessionMetadata>()
  private isSessionMetadataComplete = false

  constructor(private readonly options: SessionPersistenceStateOwnerOptions) {}

  beginHydration(): void {
    this.validatedBindingTopologies.clear()
  }

  replaceMetadata(sessions: readonly PersistedChatSession[], isComplete: boolean): void {
    this.sessionMetadata = new Map(
      sessions.map((session) => [
        session.id,
        { id: session.id, projectId: session.projectId, title: session.title }
      ])
    )
    this.isSessionMetadataComplete = isComplete
  }

  recordSession(session: PersistedChatSession): void {
    this.sessionMetadata.set(session.id, {
      id: session.id,
      projectId: session.projectId,
      title: session.title
    })
  }

  markMetadataIncomplete(): void {
    this.isSessionMetadataComplete = false
  }

  removeSession(projectId: string, sessionId: string): void {
    this.sessionMetadata.delete(sessionId)
    this.invalidateBindingTopology(projectId, sessionId)
  }

  removeProject(projectId: string, sessionIds: readonly string[]): void {
    for (const [sessionId, metadata] of this.sessionMetadata) {
      if (metadata.projectId === projectId) this.sessionMetadata.delete(sessionId)
    }
    for (const sessionId of sessionIds) this.invalidateBindingTopology(projectId, sessionId)
  }

  metadataSnapshot(): SessionMetadataSnapshot {
    return {
      sessions: [...this.sessionMetadata.values()],
      isComplete: this.isSessionMetadataComplete
    }
  }

  sessionProjectId(sessionId: string): string | undefined {
    return this.sessionMetadata.get(sessionId)?.projectId
  }

  invalidateBindingTopology(projectId: string, sessionId: string): void {
    this.validatedBindingTopologies.delete(`${projectId}:${sessionId}`)
  }

  async containsMessageOnActiveBranch(
    projectId: string,
    sessionId: string,
    messageId: string
  ): Promise<boolean> {
    const loaded = await this.options.repository.loadSessionWithDiagnostics(projectId, sessionId)
    if (loaded.status !== 'found') {
      throw new Error(`Cannot read active Message Branch for a ${loaded.status} Session.`)
    }
    const graph = materializeSessionConversationGraph(loaded.session).conversationGraph
    return graph
      ? resolveActiveConversationMessages(graph).some((message) => message.id === messageId)
      : false
  }

  private async loadRuntimeContextSession(
    projectId: string,
    sessionId: string,
    operation: 'read' | 'patch'
  ): Promise<PersistedChatSession> {
    const loaded = await this.options.repository.loadSessionWithDiagnostics(projectId, sessionId)
    if (loaded.status === 'unreadable') {
      throw new Error(
        `Cannot ${operation} Session runtime context because its durable JSON is unreadable.`
      )
    }
    if (loaded.status === 'missing') {
      throw new Error(`Cannot ${operation} runtime context for a missing Session.`)
    }
    return loaded.session
  }

  async readRuntimeContext(projectId: string, sessionId: string): Promise<SessionRuntimeContext> {
    const session = await this.loadRuntimeContextSession(projectId, sessionId, 'read')
    return cloneRuntimeContext(session.runtimeContext ?? emptySessionRuntimeContext())
  }

  async patchRuntimeContext(
    command: PatchSessionRuntimeContextCommand
  ): Promise<SessionRuntimeContext> {
    const { projectId, sessionId, expectedRevision, patch, sessionStatus } = command
    this.options.assertMutable(projectId, sessionId, 'mutate')
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('Session runtime context expected revision must be a non-negative integer.')
    }
    if (Object.keys(patch).some((owner) => owner !== 'plan')) {
      throw new Error('Session runtime context patch contains an unknown authority owner.')
    }

    const session = await this.loadRuntimeContextSession(projectId, sessionId, 'patch')
    const current = session.runtimeContext ?? emptySessionRuntimeContext()
    if (current.revision !== expectedRevision) {
      throw new SessionRuntimeContextRevisionConflictError(expectedRevision, current.revision)
    }
    command.beforePersist?.()

    const candidate: Record<string, unknown> = { ...current }
    for (const [owner, value] of Object.entries(patch)) {
      if (value === undefined) delete candidate[owner]
      else candidate[owner] = value
    }
    candidate.revision = current.revision + 1
    const runtimeContext = sanitizeSessionRuntimeContext(candidate)
    if (!runtimeContext) throw new Error('Session runtime context patch is not JSON-safe.')

    await this.options.repository.saveSession({
      ...session,
      ...(sessionStatus ? { status: sessionStatus } : {}),
      runtimeContext,
      updatedAt: Math.max(session.updatedAt + 1, Date.now())
    })
    return cloneRuntimeContext(runtimeContext)
  }

  async appendUserMessage(
    command: AppendUserMessageToInteractionCommand
  ): Promise<PersistedChatMessage> {
    const { projectId, sessionId, interactionId } = command
    const content = command.content.trim()
    const messageId = command.messageId?.trim() || `message-${randomUUID()}`
    if (
      !messageId ||
      messageId.length > 256 ||
      messageId.includes('\u0000') ||
      messageId.includes('\r') ||
      messageId.includes('\n')
    ) {
      throw new Error('User Message id must be a bounded identifier.')
    }
    const parts = validateMessageParts(command.parts)
    const uploads = validatePersistedUploadedAttachments(command.uploads)
    if (!content && (uploads?.length ?? 0) === 0) {
      throw new Error('User Message content or uploads must be non-empty.')
    }
    this.options.assertMutable(projectId, sessionId, 'mutate')
    const session = await this.loadRuntimeContextSession(projectId, sessionId, 'patch')
    const materialized = materializeSessionConversationGraph(session)
    const existing =
      materialized.messages.find((candidate) => candidate.id === messageId) ??
      materialized.conversationGraph?.messages.find((candidate) => candidate.id === messageId)
    if (existing) {
      const expectedParts = parts && parts.length > 0 ? parts : undefined
      const expectedUploads = uploads && uploads.length > 0 ? uploads : undefined
      if (
        existing.role !== 'user' ||
        existing.content !== content ||
        existing.status !== 'complete' ||
        existing.responseToMessageId !== interactionId ||
        JSON.stringify(existing.parts) !== JSON.stringify(expectedParts) ||
        JSON.stringify(existing.uploads) !== JSON.stringify(expectedUploads)
      ) {
        throw new Error(`User Message retry conflicts with durable Message: ${messageId}`)
      }
      return structuredClone(existing)
    }
    command.beforePersist?.()
    const timestamp = Math.max(session.updatedAt + 1, Date.now())
    const message: PersistedChatMessage = {
      id: messageId,
      role: 'user',
      content,
      status: 'complete',
      eventIds: [],
      responseToMessageId: interactionId,
      ...(parts && parts.length > 0 ? { parts } : {}),
      ...(uploads && uploads.length > 0 ? { uploads } : {}),
      createdAt: timestamp,
      updatedAt: timestamp
    }
    const durable = materializeSessionConversationGraph({
      ...session,
      messages: [...session.messages, message],
      updatedAt: timestamp
    })
    await this.options.repository.saveSession(durable)
    this.recordSession(durable)
    return message
  }

  async createSideQuestionCard(
    command: CreateSideQuestionCardCommand
  ): Promise<PersistedSideQuestion> {
    const card = validatePersistedSideQuestion(command.card)
    this.options.assertMutable(card.projectId, card.sessionId, 'mutate')
    const session = materializeSessionConversationGraph(
      await this.loadRuntimeContextSession(card.projectId, card.sessionId, 'patch')
    )
    if (session.sideQuestions?.some((candidate) => candidate.id === card.id)) {
      throw new Error(`Side Question already exists: ${card.id}`)
    }
    if (
      session.sideQuestions?.some((candidate) => candidate.childAgentRunId === card.childAgentRunId)
    ) {
      throw new Error('Side Question child Agent Run is already bound to a card.')
    }
    if (!session.conversationGraph) throw new Error('Side Question Session graph is unavailable.')
    const conversationGraph = createChildAgentFrame(session.conversationGraph, {
      id: card.childFrameId,
      parentFrameId: card.parentFrameId,
      originMessageId: card.parentPromptMessageId,
      kind: 'side-question',
      createdAt: card.createdAt,
      agentName: 'Side question'
    })
    const durable = {
      ...session,
      conversationGraph,
      sideQuestions: [...(session.sideQuestions ?? []), card],
      updatedAt: Math.max(session.updatedAt + 1, card.updatedAt, Date.now())
    }
    await this.options.repository.saveSession(durable)
    this.recordSession(durable)
    return structuredClone(card)
  }

  async createDelegation(card: PersistedDelegation): Promise<PersistedDelegation> {
    this.options.assertMutable(card.projectId, card.sessionId, 'mutate')
    const session = materializeSessionConversationGraph(
      await this.loadRuntimeContextSession(card.projectId, card.sessionId, 'patch')
    )
    if (session.delegations?.some((candidate) => candidate.id === card.id)) {
      throw new Error(`Delegation already exists: ${card.id}`)
    }
    if (!session.conversationGraph) throw new Error('Delegation Session graph is unavailable.')
    const conversationGraph = createChildAgentFrame(session.conversationGraph, {
      id: card.childFrameId,
      parentFrameId: card.parentFrameId,
      originMessageId: card.originMessageId,
      kind: 'delegate',
      createdAt: card.createdAt,
      agentName: card.role,
      delegateName: card.role
    })
    const durable = {
      ...session,
      conversationGraph,
      delegations: [...(session.delegations ?? []), structuredClone(card)],
      updatedAt: Math.max(session.updatedAt + 1, card.updatedAt, Date.now())
    }
    await this.options.repository.saveSession(durable)
    this.recordSession(durable)
    return structuredClone(card)
  }

  async getDelegation(
    projectId: string,
    sessionId: string,
    delegationId: string
  ): Promise<PersistedDelegation | undefined> {
    const session = await this.loadRuntimeContextSession(projectId, sessionId, 'read')
    return structuredClone(session.delegations?.find((candidate) => candidate.id === delegationId))
  }

  async listDelegations(
    projectId: string,
    sessionId: string
  ): Promise<readonly PersistedDelegation[]> {
    const session = await this.loadRuntimeContextSession(projectId, sessionId, 'read')
    return structuredClone(session.delegations ?? [])
  }

  async updateDelegation(
    projectId: string,
    sessionId: string,
    delegationId: string,
    update: Partial<PersistedDelegation>
  ): Promise<PersistedDelegation> {
    this.options.assertMutable(projectId, sessionId, 'mutate')
    const session = materializeSessionConversationGraph(
      await this.loadRuntimeContextSession(projectId, sessionId, 'patch')
    )
    const index = session.delegations?.findIndex((candidate) => candidate.id === delegationId) ?? -1
    if (index < 0) throw new Error(`Unknown Delegation: ${delegationId}`)
    const current = session.delegations![index]
    const next = {
      ...current,
      ...structuredClone(update),
      updatedAt: Math.max(current.updatedAt + 1, Date.now())
    }
    const delegations = [...session.delegations!]
    delegations[index] = next
    const durable = { ...session, delegations, updatedAt: next.updatedAt }
    await this.options.repository.saveSession(durable)
    this.recordSession(durable)
    return structuredClone(next)
  }

  async getSideQuestionCard(
    projectId: string,
    sessionId: string,
    sideQuestionId: string
  ): Promise<PersistedSideQuestion | undefined> {
    const session = await this.loadRuntimeContextSession(projectId, sessionId, 'read')
    return structuredClone(
      session.sideQuestions?.find((candidate) => candidate.id === sideQuestionId)
    )
  }

  async listSideQuestionCards(
    projectId: string,
    sessionId: string
  ): Promise<readonly PersistedSideQuestion[]> {
    const session = await this.loadRuntimeContextSession(projectId, sessionId, 'read')
    return structuredClone(session.sideQuestions ?? [])
  }

  async transitionSideQuestionCard(
    command: TransitionSideQuestionCardCommand
  ): Promise<PersistedSideQuestion> {
    this.options.assertMutable(command.projectId, command.sessionId, 'mutate')
    const session = materializeSessionConversationGraph(
      await this.loadRuntimeContextSession(command.projectId, command.sessionId, 'patch')
    )
    const index =
      session.sideQuestions?.findIndex((candidate) => candidate.id === command.sideQuestionId) ?? -1
    if (index < 0) throw new Error(`Unknown Side Question: ${command.sideQuestionId}`)
    const current = session.sideQuestions![index]
    validateSideQuestionTransition(current.lifecycle, command.lifecycle)
    const now = Math.max(current.updatedAt + 1, Date.now())
    const next = validatePersistedSideQuestion({
      ...current,
      ...command.update,
      lifecycle: command.lifecycle,
      updatedAt: now
    })
    const sideQuestions = [...session.sideQuestions!]
    sideQuestions[index] = next
    let conversationGraph = session.conversationGraph
    if (!conversationGraph) throw new Error('Side Question Session graph is unavailable.')
    if (command.lifecycle === 'completed') {
      conversationGraph = completeAgentFrame(conversationGraph, current.childFrameId, now)
    } else if (command.lifecycle === 'cancelled') {
      conversationGraph = cancelAgentFrame(conversationGraph, current.childFrameId, now)
    } else if (command.lifecycle === 'failed' || command.lifecycle === 'blocked') {
      conversationGraph = failAgentFrame(conversationGraph, current.childFrameId, now)
    }
    const durable = { ...session, conversationGraph, sideQuestions, updatedAt: now }
    await this.options.repository.saveSession(durable)
    this.recordSession(durable)
    return structuredClone(next)
  }

  async saveSession(
    session: PersistedChatSession,
    options: SaveSessionOptions = {}
  ): Promise<PersistedChatSession> {
    this.options.assertMutable(session.projectId, session.id, 'save')
    const authoritative = await this.options.repository.loadSessionWithDiagnostics(
      session.projectId,
      session.id
    )
    if (authoritative.status === 'unreadable') {
      throw new Error(
        'Cannot save Session projection because main-owned runtime context is unreadable.'
      )
    }
    const rendererOwnedSession: PersistedChatSession = { ...session }
    delete rendererOwnedSession.runtimeContext
    delete rendererOwnedSession.archivedAt
    delete rendererOwnedSession.sideQuestions
    delete rendererOwnedSession.delegations
    const authority = authoritative.status === 'found' ? authoritative.session : undefined
    const mainOwnedStatus =
      authority?.status === 'waiting-plan-approval' ||
      rendererOwnedSession.status === 'waiting-plan-approval'
        ? (authority?.status ?? 'idle')
        : undefined
    const mergedSession: PersistedChatSession = {
      ...rendererOwnedSession,
      ...(authority?.runtimeContext ? { runtimeContext: authority.runtimeContext } : {}),
      ...(authority?.archivedAt ? { archivedAt: authority.archivedAt } : {}),
      ...(authority?.sideQuestions ? { sideQuestions: authority.sideQuestions } : {}),
      ...(authority?.delegations ? { delegations: authority.delegations } : {}),
      ...(mainOwnedStatus ? { status: mainOwnedStatus } : {}),
      updatedAt:
        authority?.runtimeContext || mainOwnedStatus
          ? Math.max(rendererOwnedSession.updatedAt, (authority?.updatedAt ?? -1) + 1, Date.now())
          : rendererOwnedSession.updatedAt
    }

    const materializedSession = materializeSessionConversationGraph(mergedSession)
    let durableSession = this.options.uploads
      ? await this.options.uploads.upgradeLegacySessionUploads(materializedSession, {
          mode: 'live-save'
        })
      : materializedSession
    const key = `${session.projectId}:${session.id}`
    let bindingTopology = sessionBindingTopologyHash(durableSession)
    let bindingValidation: FinalizedArtifactBindingValidation =
      this.validatedBindingTopologies.get(key) === bindingTopology
        ? { status: 'valid' }
        : await validateFinalizedArtifactBindings(
            this.options.provenance,
            durableSession,
            this.options.log
          )
    if (bindingValidation.status === 'conflict') {
      const conflictRebaseFields = options.conflictRebaseFields ?? []
      if (conflictRebaseFields.length === 0) throw bindingValidation.error

      const latest = await this.options.repository.loadSessionWithDiagnostics(
        session.projectId,
        session.id
      )
      if (latest.status !== 'found') throw bindingValidation.error
      const rebasedSession = rebaseSafeSessionFields(
        latest.session,
        durableSession,
        conflictRebaseFields
      )
      durableSession = this.options.uploads
        ? await this.options.uploads.upgradeLegacySessionUploads(rebasedSession, {
            mode: 'live-save'
          })
        : rebasedSession
      bindingTopology = sessionBindingTopologyHash(durableSession)
      bindingValidation =
        this.validatedBindingTopologies.get(key) === bindingTopology
          ? { status: 'valid' }
          : await validateFinalizedArtifactBindings(
              this.options.provenance,
              durableSession,
              this.options.log
            )
      if (bindingValidation.status === 'conflict') throw bindingValidation.error
    }

    await this.options.repository.saveSession(durableSession)
    this.recordSession(durableSession)
    if (bindingValidation.status === 'valid') {
      this.validatedBindingTopologies.set(key, bindingTopology)
    }
    await this.options.provenance?.captureFinalizedMessages(durableSession)
    let changedSources: ProjectFileSource[]
    try {
      changedSources = await this.options.fileIndex.syncSession(durableSession)
    } catch (error) {
      this.markMetadataIncomplete()
      this.options.notifyFilesChanged({
        projectId: session.projectId,
        sources: ['artifact', 'upload'],
        kind: 'reset'
      })
      throw error
    }
    if (changedSources.length > 0) {
      this.options.notifyFilesChanged({
        projectId: session.projectId,
        sessionId: session.id,
        sources: changedSources,
        kind: 'upsert'
      })
    }
    return durableSession
  }
}

export { SessionPersistenceStateOwner, SessionRuntimeContextRevisionConflictError }
export type {
  AppendUserMessageToInteractionCommand,
  CreateSideQuestionCardCommand,
  PatchSessionRuntimeContextCommand,
  TransitionSideQuestionCardCommand,
  SessionMetadata,
  SessionMetadataSnapshot
}
