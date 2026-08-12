import type { MessagePart, PersistedChatMessage } from '../../shared/session-persistence'
import type { PersistedUploadedAttachment } from '../../shared/uploads'
import type { MessageDeliveryMode, MessageDeliveryProjection } from '../../shared/message-delivery'
import type { AgentRunBudget, AgentGraphLimits } from '../../shared/agent-graph'
import type { ModelTarget, WorkClass } from '../../shared/model-routing'
import { AgentGraphOwner, type AgentRootCreationResult } from './owner'
import { MessageDeliveryJournal } from './delivery-journal'

type SessionMessageAppender = {
  appendUserMessageToInteraction(command: {
    projectId: string
    sessionId: string
    interactionId: string
    messageId: string
    content: string
    parts?: MessagePart[]
    uploads?: PersistedUploadedAttachment[]
  }): Promise<PersistedChatMessage>
}

export type PrepareM2PromptInput = Readonly<{
  projectId: string
  sessionId: string
  content: string
  interactionId?: string
  messageId: string
  deliveryId: string
  requestedMode: MessageDeliveryMode
  hasActiveTurn: boolean
  target: ModelTarget
  workClass: WorkClass
  backend?: string
  runtimeThreadId?: string
  runtimeTurnId?: string
  limits?: AgentGraphLimits
  budget?: AgentRunBudget
  parts?: MessagePart[]
  uploads?: PersistedUploadedAttachment[]
}>

export type PreparedM2Prompt = Readonly<{
  message: PersistedChatMessage
  root: AgentRootCreationResult
  delivery: MessageDeliveryProjection
}>

// Main-process journal owner for the Stage 1 prompt boundary. It deliberately accepts content only
// for the authoritative Session appender; the SQLite journal receives identifiers and safe metadata.
class M2PromptPersistenceOwner {
  constructor(
    private readonly graph: AgentGraphOwner,
    private readonly deliveries: MessageDeliveryJournal,
    private readonly sessions: SessionMessageAppender
  ) {}

  async prepare(input: PrepareM2PromptInput): Promise<PreparedM2Prompt> {
    const messageId = input.messageId
    const root = await this.graph.createConfiguredDirectRoot({
      projectId: input.projectId,
      sessionId: input.sessionId,
      promptMessageId: messageId,
      workClass: input.workClass,
      target: input.target,
      limits: input.limits,
      budget: input.budget,
      status: 'running'
    })
    const preparedDelivery = await this.deliveries.prepareOnce({
      id: input.deliveryId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      messageId,
      targetRootRunId: root.agentRunId,
      targetPromptMessageId: messageId,
      backend: input.backend ?? input.target.backend,
      runtimeThreadId: input.runtimeThreadId,
      runtimeTurnId: input.runtimeTurnId,
      requested: input.requestedMode,
      hasActiveTurn: input.hasActiveTurn
    })

    let message: PersistedChatMessage
    try {
      message = await this.sessions.appendUserMessageToInteraction({
        projectId: input.projectId,
        sessionId: input.sessionId,
        interactionId: input.interactionId ?? messageId,
        messageId,
        content: input.content,
        parts: input.parts,
        uploads: input.uploads
      })
    } catch (error) {
      if (preparedDelivery.created) {
        await this.deliveries
          .reconcile(preparedDelivery.delivery.id, { hasSessionMessage: false })
          .catch(() => undefined)
        await this.graph
          .finishRun(root.agentRunId, 'blocked', { safeFailureCode: 'session_message_missing' })
          .catch(() => undefined)
      }
      throw error
    }

    const promoted = await this.deliveries.reconcile(preparedDelivery.delivery.id, {
      hasSessionMessage: true
    })
    return Object.freeze({ message, root, delivery: promoted })
  }
}

export { M2PromptPersistenceOwner }
