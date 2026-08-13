import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  validateMessageDeliveryRendererRequest,
  type MessageDeliveryAdmissionResult,
  type MessageDeliveryCommandResult,
  type MessageDeliveryRendererRequest
} from '../../shared/message-delivery'
import type { SideQuestionAdmissionResult } from '../../shared/side-question'

type MessageDeliveryRouterSessionAuthority = Readonly<{
  projectIdForSession(sessionId: string): Promise<string | undefined>
  loadSession(projectId: string, sessionId: string): Promise<PersistedChatSession | undefined>
}>

type MessageDeliveryBackend = 'codex' | 'opencode'

type MessageDeliveryRouterOptions = Readonly<{
  sessions: MessageDeliveryRouterSessionAuthority
  resolveBackend(session: PersistedChatSession): MessageDeliveryBackend | undefined
  openCode: Readonly<{
    deliver(value: MessageDeliveryRendererRequest): Promise<MessageDeliveryAdmissionResult>
  }>
  codex: Readonly<{
    deliver(value: MessageDeliveryRendererRequest): Promise<MessageDeliveryAdmissionResult>
  }>
  sideQuestion: Readonly<{
    ask(value: unknown): Promise<SideQuestionAdmissionResult>
  }>
}>

// Selects a delivery owner from main-owned live Session/runtime state. The renderer still supplies
// only content and the requested mode; it cannot choose a backend or force a native/queued path.
export class MessageDeliveryBackendRouter {
  constructor(private readonly options: MessageDeliveryRouterOptions) {}

  async deliver(value: unknown): Promise<MessageDeliveryCommandResult> {
    const request = validateMessageDeliveryRendererRequest(value)
    const projectId = await this.options.sessions.projectIdForSession(request.sessionId)
    if (!projectId)
      return { kind: 'delivery', ...this.blocked(request.sessionId, 'session_unavailable') }
    const session = await this.options.sessions.loadSession(projectId, request.sessionId)
    if (!session || session.id !== request.sessionId || session.projectId !== projectId) {
      return { kind: 'delivery', ...this.blocked(request.sessionId, 'session_unavailable') }
    }
    const backend = this.options.resolveBackend(session)
    if (!backend)
      return { kind: 'delivery', ...this.blocked(request.sessionId, 'backend_unavailable') }
    // The current Stage 3 classifier seam is intentionally absent, so Auto resolves to the
    // non-destructive side-question default. Route it before either backend owner appends a primary
    // transcript Message; explicit side questions follow the same dedicated child path.
    if (request.requested === 'side-question' || request.requested === 'auto') {
      const result = await this.options.sideQuestion.ask({
        sessionId: request.sessionId,
        question: request.content,
        parts: request.parts,
        attachments: request.attachments
      })
      return { kind: 'side-question', ...result }
    }
    const result =
      backend === 'opencode'
        ? this.options.openCode.deliver(request)
        : this.options.codex.deliver(request)
    return { kind: 'delivery', ...(await result) }
  }

  private blocked(sessionId: string, safeErrorCode: string): MessageDeliveryAdmissionResult {
    return Object.freeze({ status: 'blocked', sessionId, safeErrorCode })
  }
}

export type { MessageDeliveryBackend, MessageDeliveryRouterOptions }
