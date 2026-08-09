import type { CodexAppServerClient } from './client'
import type { CodexUserInput } from './types'

type ThreadEnvelope = { thread?: { id?: string } }
type TurnEnvelope = { turn?: { id?: string } }

export type ResearchThreadLink = Readonly<{
  applicationSessionId: string
  runtime: 'codex'
  threadId: string
  parentThreadId?: string
  relationship: 'root' | 'side-question'
  ephemeral: boolean
}>

export interface ResearchThreadLinkStore {
  save(link: ResearchThreadLink): Promise<void>
}

export type SideQuestionRequest = Readonly<{
  applicationSessionId: string
  parentThreadId: string
  text: string
  clientUserMessageId?: string
}>

export type SteerRequest = Readonly<{
  threadId: string
  turnId: string
  text: string
  clientUserMessageId?: string
}>

const textInput = (text: string): readonly CodexUserInput[] => [
  { type: 'text', text, text_elements: [] }
]

const requiredId = (value: unknown, kind: 'thread' | 'turn'): string => {
  if (typeof value === 'string' && value.trim()) return value
  throw new Error(`Codex app-server returned no ${kind} id.`)
}

// Owns the closed interaction semantics that need native Codex thread controls. It intentionally
// excludes shellCommand/process APIs because those bypass the thread sandbox.
export class CodexResearchThreadService {
  constructor(
    private readonly client: CodexAppServerClient,
    private readonly links: ResearchThreadLinkStore
  ) {}

  async startRoot(
    applicationSessionId: string,
    params: Parameters<CodexAppServerClient['startThread']>[0]
  ): Promise<string> {
    const response = await this.client.startThread<ThreadEnvelope>(params)
    const threadId = requiredId(response.thread?.id, 'thread')
    await this.links.save({
      applicationSessionId,
      runtime: 'codex',
      threadId,
      relationship: 'root',
      ephemeral: false
    })
    return threadId
  }

  async askSideQuestion(request: SideQuestionRequest): Promise<{
    threadId: string
    turnId: string
  }> {
    const fork = await this.client.forkThread<ThreadEnvelope>({
      threadId: request.parentThreadId,
      ephemeral: true,
      sandbox: 'read-only',
      developerInstructions:
        'Answer the user question from inherited context. Treat the parent work as reference-only; do not modify files, run consequential tools, or redirect the parent task.'
    })
    const threadId = requiredId(fork.thread?.id, 'thread')
    await this.links.save({
      applicationSessionId: request.applicationSessionId,
      runtime: 'codex',
      threadId,
      parentThreadId: request.parentThreadId,
      relationship: 'side-question',
      ephemeral: true
    })
    const turn = await this.client.startTurn<TurnEnvelope>({
      threadId,
      input: textInput(request.text),
      clientUserMessageId: request.clientUserMessageId
    })
    return { threadId, turnId: requiredId(turn.turn?.id, 'turn') }
  }

  async steer(request: SteerRequest): Promise<string> {
    const result = await this.client.steerTurn<{ turnId?: string }>({
      threadId: request.threadId,
      expectedTurnId: request.turnId,
      input: textInput(request.text),
      clientUserMessageId: request.clientUserMessageId
    })
    return requiredId(result.turnId, 'turn')
  }

  async stopAndReplace(request: SteerRequest): Promise<string> {
    await this.client.interruptTurn({ threadId: request.threadId, turnId: request.turnId })
    const result = await this.client.startTurn<TurnEnvelope>({
      threadId: request.threadId,
      input: textInput(request.text),
      clientUserMessageId: request.clientUserMessageId
    })
    return requiredId(result.turn?.id, 'turn')
  }
}
