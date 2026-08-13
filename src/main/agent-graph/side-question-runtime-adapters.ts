import type { ActiveSession } from '@agentclientprotocol/sdk'

import type { AgentRuntimeEvent, AgentRuntimePort } from '../agent-runtime'
import type { AcpRuntimeCoordinator } from '../acp/runtime-coordinator'
import {
  sideQuestionPrompt,
  type SideQuestionRuntimeAdapter,
  type SideQuestionRuntimeSession
} from '../../shared/side-question'

const textFromUpdate = (update: unknown): string => {
  if (typeof update !== 'object' || update === null) return ''
  const content = (update as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (typeof content === 'object' && content !== null && 'text' in content) {
    const text = (content as { text?: unknown }).text
    return typeof text === 'string' ? text : ''
  }
  return ''
}

const waitForOpenCodeAnswer = async (session: ActiveSession): Promise<string> => {
  let answer = ''
  for (;;) {
    const message = await session.nextUpdate()
    if (message.kind === 'stop') return answer
    if (message.kind !== 'session_update') continue
    const update = message.update as { sessionUpdate?: string }
    if (update.sessionUpdate === 'agent_message_chunk') answer += textFromUpdate(message.update)
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      throw new Error('side_question_tool_attempt_blocked')
    }
  }
}

export const createOpenCodeSideQuestionAdapter = (
  runtime: Pick<AcpRuntimeCoordinator, 'buildReviewerSessionForSession' | 'disposeReviewerSession'>
): SideQuestionRuntimeAdapter => ({
  backend: 'opencode',
  async create(input): Promise<SideQuestionRuntimeSession> {
    if (input.parent.backend !== 'opencode') throw new Error('side_question_backend_mismatch')
    const built = await runtime.buildReviewerSessionForSession(input.parent.sessionId, {
      cwd: input.parent.cwd,
      mcpServers: [],
      systemPromptAppend:
        'You are a read-only side-question child. Use only the supplied stable context. Do not use tools, modify files, access network services, request approval, or affect the parent task.'
    })
    let disposed = false
    let prompt: Promise<unknown> | undefined
    const close = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      runtime.disposeReviewerSession(built.session)
    }
    return {
      runtimeSessionId: input.childRuntimeSessionId,
      runtimeThreadId: built.session.sessionId,
      model: input.parent.model,
      modelProvider: input.parent.modelProvider,
      async run({ question, context, signal }) {
        if (signal.aborted) throw new Error('side_question_cancelled')
        const onAbort = (): void => {
          close()
        }
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          prompt = built.session.prompt([
            { type: 'text', text: sideQuestionPrompt(context, question) }
          ])
          const answer = await waitForOpenCodeAnswer(built.session)
          await prompt
          return answer
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      },
      async cancel() {
        await close()
      },
      close
    }
  }
})

const collectCodexAnswer = (
  runtime: AgentRuntimePort,
  runtimeSessionId: string,
  run: () => Promise<string>
): { answer: Promise<string>; remove: () => void } => {
  let text = ''
  let turnId: string | undefined
  let resolve!: (value: string) => void
  let reject!: (error: Error) => void
  const answer = new Promise<string>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  const remove = runtime.onEvent((event: AgentRuntimeEvent) => {
    if (event.runtimeThreadId !== runtimeSessionId) return
    if (event.runtimeTurnId) turnId ??= event.runtimeTurnId
    if (turnId && event.runtimeTurnId && event.runtimeTurnId !== turnId) return
    if (event.event.kind === 'message' && event.event.role === 'assistant' && event.event.text) {
      text += event.event.text
    }
    if (event.event.kind === 'tool' || event.event.kind === 'permission') {
      reject(new Error('side_question_tool_attempt_blocked'))
    } else if (event.terminal) {
      if (event.event.kind === 'error') reject(new Error('side_question_provider_failed'))
      else resolve(text)
    }
  })
  void run().catch((error) => reject(error instanceof Error ? error : new Error(String(error))))
  return { answer, remove }
}

export const createCodexSideQuestionAdapter = (
  runtimeForParent: (sessionId: string) => Promise<AgentRuntimePort>
): SideQuestionRuntimeAdapter => ({
  backend: 'codex',
  async create(input): Promise<SideQuestionRuntimeSession> {
    if (input.parent.backend !== 'codex') throw new Error('side_question_backend_mismatch')
    const runtime = await runtimeForParent(input.parent.sessionId)
    if (!runtime.capabilities.nativeFork) throw new Error('side_question_fork_unavailable')
    const state = await runtime.capabilities.nativeFork({
      appSessionId: input.childRuntimeSessionId,
      parentAppSessionId: input.parent.runtimeSessionId,
      agentRunId: input.childAgentRunId,
      cwd: input.parent.cwd,
      model: input.parent.model,
      modelProvider: input.parent.modelProvider,
      sandbox: 'read-only',
      ephemeral: true,
      parentRuntimeThreadId: input.parent.runtimeThreadId,
      lastTurnId: input.parent.lastStableTurnId,
      developerInstructions:
        'Answer only the supplied side question from inherited stable context. Do not use tools, write files, access network services, request approval, or affect the parent task.'
    })
    if (
      !state.ephemeral ||
      state.sandbox !== 'read-only' ||
      state.runtimeThreadId === input.parent.runtimeThreadId
    ) {
      await runtime.closeSession(input.childRuntimeSessionId).catch(() => undefined)
      throw new Error('side_question_fork_provenance_invalid')
    }
    let activeTurnId: string | undefined
    return {
      runtimeSessionId: input.childRuntimeSessionId,
      runtimeThreadId: state.runtimeThreadId,
      model: state.model,
      modelProvider: state.modelProvider,
      async run({ question, context, signal }) {
        if (signal.aborted) throw new Error('side_question_cancelled')
        const collected = collectCodexAnswer(runtime, state.runtimeThreadId, async () => {
          const admission = await runtime.startTurn({
            appSessionId: input.childRuntimeSessionId,
            input: [{ kind: 'text', text: sideQuestionPrompt(context, question) }]
          })
          activeTurnId = admission.runtimeTurnId
          return admission.runtimeTurnId
        })
        const onAbort = (): void => {
          void runtime.cancel(input.childRuntimeSessionId, activeTurnId).catch(() => undefined)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          return await collected.answer
        } finally {
          collected.remove()
          signal.removeEventListener('abort', onAbort)
        }
      },
      async cancel() {
        await runtime.cancel(input.childRuntimeSessionId, activeTurnId)
      },
      async close() {
        await runtime.closeSession(input.childRuntimeSessionId)
      }
    }
  }
})
