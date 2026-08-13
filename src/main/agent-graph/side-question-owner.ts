import { randomUUID } from 'node:crypto'

import {
  captureStableSideQuestionContext,
  SIDE_QUESTION_MAX_OUTPUT_TOKENS,
  SIDE_QUESTION_RUNTIME_TIMEOUT_MS,
  sideQuestionVersionReferencesFromInputs,
  truncateSideQuestionAnswer,
  validatePersistedSideQuestion,
  validateSideQuestionRendererRequest,
  type PersistedSideQuestion,
  type SideQuestionAdmissionResult,
  type SideQuestionParentResolver,
  type SideQuestionParentSnapshot,
  type SideQuestionRuntimeAdapter,
  type SideQuestionRuntimeSession,
  type SideQuestionRendererRequest
} from '../../shared/side-question'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { AgentGraphOwner } from './owner'
import type { SideQuestionRepository } from './side-question-repository'

type SideQuestionGraph = Pick<
  AgentGraphOwner,
  | 'createSideQuestionChild'
  | 'startRun'
  | 'finishRun'
  | 'getGraphProjection'
  | 'getRunProjection'
  | 'listSessionSideQuestionRuns'
>

type SideQuestionSessions = Readonly<{
  projectIdForSession(sessionId: string): Promise<string | undefined>
  loadSession(projectId: string, sessionId: string): Promise<PersistedChatSession | undefined>
  assertSessionAvailable(projectId: string, sessionId: string): Promise<void>
}>

export type SideQuestionOwnerOptions = Readonly<{
  graph: SideQuestionGraph
  sessions: SideQuestionSessions
  parentResolver: SideQuestionParentResolver
  adapters: Readonly<Record<'codex' | 'opencode', SideQuestionRuntimeAdapter>>
  repository: SideQuestionRepository
  requestApproval: (input: {
    record: PersistedSideQuestion
    parent: SideQuestionParentSnapshot
    approvalDigest: string
    timeoutMs: number
    outputTokenLimit: number
  }) => Promise<boolean>
  cancelApproval?: (sessionId: string) => void
  onChanged?: (record: PersistedSideQuestion) => void
  cleanupRecovery?: (record: PersistedSideQuestion) => Promise<void>
  idFactory?: () => string
  now?: () => number
  timeoutMs?: number
  outputTokenLimit?: number
}>

const terminal = new Set(['completed', 'failed', 'cancelled', 'blocked'])

const safeFailureCode = (error: unknown, fallback: string): string => {
  if (error instanceof Error && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(error.message)) {
    return error.message
  }
  return fallback
}

const withTimeout = async <Value>(
  operation: (signal: AbortSignal) => Promise<Value>,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<Value> => {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectCancelled: ((error: Error) => void) | undefined
  const cancelled = new Promise<never>((_, reject) => {
    rejectCancelled = reject
  })
  const abort = (): void => {
    controller.abort()
    rejectCancelled?.(new Error('side_question_cancelled'))
  }
  if (externalSignal) {
    if (externalSignal.aborted) abort()
    else externalSignal.addEventListener('abort', abort, { once: true })
  }
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('side_question_timeout'))
    }, timeoutMs)
  })
  try {
    return await Promise.race([operation(controller.signal), timeout, cancelled])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    externalSignal?.removeEventListener('abort', abort)
  }
}

// Main-owned side-question authority. It never appends a parent Session Message and never exposes
// a provider session to the renderer. Runtime adapters receive a read-only child policy by type and
// the owner retains the durable result before disposing the ephemeral session.
export class SideQuestionOwner {
  private readonly idFactory: () => string
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly outputTokenLimit: number
  private readonly repository: SideQuestionRepository
  private readonly admissions = new Map<string, Promise<SideQuestionAdmissionResult>>()
  private readonly executions = new Map<string, Promise<void>>()
  private readonly pendingApprovalSessions = new Map<string, string>()
  private readonly controllers = new Map<string, AbortController>()

  constructor(private readonly options: SideQuestionOwnerOptions) {
    this.idFactory = options.idFactory ?? randomUUID
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? SIDE_QUESTION_RUNTIME_TIMEOUT_MS
    this.outputTokenLimit = options.outputTokenLimit ?? SIDE_QUESTION_MAX_OUTPUT_TOKENS
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error('Side-question timeout is invalid.')
    }
    if (!Number.isSafeInteger(this.outputTokenLimit) || this.outputTokenLimit < 1) {
      throw new Error('Side-question output limit is invalid.')
    }
    this.repository = options.repository
  }

  async ask(value: unknown): Promise<SideQuestionAdmissionResult> {
    const request = validateSideQuestionRendererRequest(value)
    const pending = this.admissions.get(request.sessionId)
    if (pending) return pending
    const operation = this.askOnce(request)
    this.admissions.set(request.sessionId, operation)
    return operation.finally(() => {
      if (this.admissions.get(request.sessionId) === operation)
        this.admissions.delete(request.sessionId)
    })
  }

  async list(sessionId: string): Promise<readonly PersistedSideQuestion[]> {
    const projectId = await this.options.sessions.projectIdForSession(sessionId)
    return projectId ? this.repository.listForSession(projectId, sessionId) : []
  }

  async cancel(
    sessionId: string,
    sideQuestionId: string
  ): Promise<PersistedSideQuestion | undefined> {
    const projectId = await this.options.sessions.projectIdForSession(sessionId)
    if (!projectId) return undefined
    const current = await this.repository.get(projectId, sessionId, sideQuestionId)
    if (!current || terminal.has(current.lifecycle)) return current
    const controller = this.controllers.get(sideQuestionId)
    // A live child owns its terminal transition: aborting its signal makes runChild clean up the
    // ephemeral session before it records cancellation and releases the graph slot. Marking the
    // card terminal here would race the provider and falsely claim that cleanup had completed.
    if (controller) {
      controller.abort()
      return current
    }
    this.options.cancelApproval?.(sessionId)
    const cancelled = await this.repository.transition(
      projectId,
      sessionId,
      sideQuestionId,
      'cancelled',
      {
        safeFailureCode: 'side_question_cancelled',
        completedAt: this.now()
      }
    )
    await this.options.graph.finishRun(current.childAgentRunId, 'cancelled', {
      safeFailureCode: 'side_question_cancelled'
    })
    this.options.onChanged?.(cancelled)
    return cancelled
  }

  async cancelSession(sessionId: string): Promise<void> {
    const projectId = await this.options.sessions.projectIdForSession(sessionId)
    if (!projectId) return
    const records = await this.repository.listForSession(projectId, sessionId)
    await Promise.all(
      records
        .filter((record) => !terminal.has(record.lifecycle))
        .map((record) => this.cancel(sessionId, record.id).then(() => undefined))
    )
  }

  async close(): Promise<void> {
    for (const sessionId of new Set(this.pendingApprovalSessions.values())) {
      this.options.cancelApproval?.(sessionId)
    }
    for (const controller of this.controllers.values()) controller.abort()
    await Promise.allSettled([...this.admissions.values(), ...this.executions.values()])
    this.controllers.clear()
  }

  async recover(sessions: readonly PersistedChatSession[]): Promise<void> {
    for (const session of sessions) {
      const cards = session.sideQuestions ?? []
      const cardRunIds = new Set(cards.map((record) => record.childAgentRunId))
      const runs = await this.options.graph
        .listSessionSideQuestionRuns(session.projectId, session.id)
        .catch(() => [])
      for (const run of runs) {
        if (cardRunIds.has(run.id) || terminal.has(run.status)) continue
        await this.options.graph
          .finishRun(run.id, 'blocked', { safeFailureCode: 'side_question_card_missing' })
          .catch(() => undefined)
      }
      for (const record of cards) {
        if (terminal.has(record.lifecycle)) {
          const run = await this.options.graph
            .getRunProjection(record.childAgentRunId)
            .catch(() => undefined)
          if (run && !terminal.has(run.status)) {
            const status =
              record.lifecycle === 'completed'
                ? 'completed'
                : record.lifecycle === 'cancelled'
                  ? 'cancelled'
                  : record.lifecycle === 'failed'
                    ? 'failed'
                    : 'blocked'
            await this.options.graph
              .finishRun(run.id, status, {
                ...(record.safeFailureCode ? { safeFailureCode: record.safeFailureCode } : {})
              })
              .catch(() => undefined)
          }
          continue
        }
        // Side-question provider dispatch is never replayed after restart. Pre-dispatch states are
        // terminalized explicitly; starting/running is dispatch-ambiguous and remains blocked even
        // if an ephemeral runtime link can no longer be observed.
        const code =
          record.lifecycle === 'starting' || record.lifecycle === 'running'
            ? 'side_question_dispatch_ambiguous'
            : 'side_question_interrupted_before_dispatch'
        await this.options.cleanupRecovery?.(record).catch(() => undefined)
        await this.options.graph
          .finishRun(record.childAgentRunId, 'blocked', {
            safeFailureCode: code
          })
          .catch(() => undefined)
        const blocked = await this.repository
          .transition(record.projectId, record.sessionId, record.id, 'blocked', {
            safeFailureCode: code,
            runtimeLinkClosed: record.runtimeLinkClosed,
            runtimeDisposed: record.runtimeDisposed,
            completedAt: this.now()
          })
          .catch(() => undefined)
        if (blocked) this.options.onChanged?.(blocked)
      }
    }
  }

  private async askOnce(
    request: SideQuestionRendererRequest
  ): Promise<SideQuestionAdmissionResult> {
    const projectId = await this.options.sessions.projectIdForSession(request.sessionId)
    if (!projectId) return this.blocked(request.sessionId, 'session_unavailable')
    let session: PersistedChatSession | undefined
    let parent: SideQuestionParentSnapshot | undefined
    try {
      session = await this.options.sessions.loadSession(projectId, request.sessionId)
      if (!session || session.id !== request.sessionId || session.projectId !== projectId) {
        return this.blocked(request.sessionId, 'session_unavailable')
      }
      await this.options.sessions.assertSessionAvailable(projectId, request.sessionId)
      parent = await this.options.parentResolver(session)
    } catch (error) {
      return this.blocked(request.sessionId, safeFailureCode(error, 'parent_unavailable'))
    }
    if (!parent) return this.blocked(request.sessionId, 'parent_unavailable')
    if (parent.backend !== 'codex' && parent.backend !== 'opencode') {
      return this.blocked(request.sessionId, 'unsupported_side_question_backend')
    }

    let references
    try {
      references = sideQuestionVersionReferencesFromInputs(request)
    } catch (error) {
      return this.blocked(request.sessionId, safeFailureCode(error, 'immutable_reference_required'))
    }
    const context = captureStableSideQuestionContext({
      session,
      ...(parent.lastStableTurnId ? { stableTurnId: parent.lastStableTurnId } : {}),
      references
    })
    const sideQuestionId = this.idFactory()
    const childRuntimeSessionId = `${sideQuestionId}:runtime`
    const createdAt = this.now()
    let child
    let durableRecord: PersistedSideQuestion | undefined
    try {
      child = await this.options.graph.createSideQuestionChild({
        graphId: parent.graphId,
        parentAgentRunId: parent.agentRunId,
        projectId,
        sessionId: request.sessionId,
        role: 'side-question',
        workClass: 'analysis',
        runtime: parent.backend,
        promptMessageId: parent.promptMessageId,
        budget: { maxWallTimeMs: this.timeoutMs, maxOutputTokens: this.outputTokenLimit },
        allowIdleParent: true
      })
      durableRecord = await this.repository.create({
        id: sideQuestionId,
        projectId,
        sessionId: request.sessionId,
        parentGraphId: parent.graphId,
        parentAgentRunId: parent.agentRunId,
        childAgentRunId: child.id,
        parentFrameId: parent.frameId,
        childFrameId: child.frameId!,
        parentPromptMessageId: parent.promptMessageId,
        ...(parent.runtimeThreadId ? { parentRuntimeThreadId: parent.runtimeThreadId } : {}),
        runtimeSessionId: childRuntimeSessionId,
        backend: parent.backend,
        ...(parent.model ? { model: parent.model } : {}),
        ...(parent.modelProvider ? { modelProvider: parent.modelProvider } : {}),
        ephemeral: true,
        sandbox: 'read-only',
        context,
        question: request.question,
        createdAt
      })
      const awaitingApproval = await this.repository.transition(
        projectId,
        request.sessionId,
        sideQuestionId,
        'awaiting-approval'
      )
      this.options.onChanged?.(awaitingApproval)
      const execution = this.authorizeAndRun(
        awaitingApproval,
        parent,
        request.question,
        childRuntimeSessionId
      )
      this.executions.set(sideQuestionId, execution)
      void execution.finally(() => {
        if (this.executions.get(sideQuestionId) === execution)
          this.executions.delete(sideQuestionId)
      })
      return { status: 'accepted', sessionId: request.sessionId, sideQuestion: awaitingApproval }
    } catch (error) {
      const code = safeFailureCode(error, 'side_question_setup_failed')
      if (durableRecord && !terminal.has(durableRecord.lifecycle)) {
        const blocked = await this.repository
          .transition(projectId, request.sessionId, sideQuestionId, 'blocked', {
            safeFailureCode: code,
            completedAt: this.now()
          })
          .catch(() => undefined)
        if (blocked) this.options.onChanged?.(blocked)
      }
      if (child) {
        await this.options.graph
          .finishRun(child.id, 'blocked', {
            safeFailureCode: code
          })
          .catch(() => undefined)
      }
      return this.blocked(request.sessionId, code)
    }
  }

  private approvalDigest(
    record: PersistedSideQuestion,
    parent: SideQuestionParentSnapshot
  ): string {
    return JSON.stringify({
      question: record.question,
      context: record.context,
      graphId: record.parentGraphId,
      parentRunId: record.parentAgentRunId,
      childRunId: record.childAgentRunId,
      childFrameId: record.childFrameId,
      cancellationGeneration: parent.cancellationGeneration,
      backend: record.backend,
      model: record.model,
      modelProvider: record.modelProvider,
      sandbox: record.sandbox,
      timeoutMs: this.timeoutMs,
      outputTokenLimit: this.outputTokenLimit
    })
  }

  private async authorizeAndRun(
    record: PersistedSideQuestion,
    parent: SideQuestionParentSnapshot,
    question: string,
    childRuntimeSessionId: string
  ): Promise<void> {
    try {
      this.pendingApprovalSessions.set(record.id, record.sessionId)
      const approved = await this.options.requestApproval({
        record,
        parent,
        approvalDigest: this.approvalDigest(record, parent),
        timeoutMs: this.timeoutMs,
        outputTokenLimit: this.outputTokenLimit
      })
      if (!approved) throw new Error('side_question_approval_declined')
      this.pendingApprovalSessions.delete(record.id)
      await this.assertParentUnchanged(record, parent)
      const ready = await this.repository.transition(
        record.projectId,
        record.sessionId,
        record.id,
        'ready'
      )
      this.options.onChanged?.(ready)
      const starting = await this.repository.transition(
        record.projectId,
        record.sessionId,
        record.id,
        'starting'
      )
      this.options.onChanged?.(starting)
      await this.options.graph.startRun(record.childAgentRunId)
      await this.runChild(starting, parent, question, childRuntimeSessionId)
    } catch (error) {
      this.pendingApprovalSessions.delete(record.id)
      const code = safeFailureCode(error, 'side_question_approval_failed')
      const current = await this.repository
        .get(record.projectId, record.sessionId, record.id)
        .catch(() => undefined)
      if (current && !terminal.has(current.lifecycle)) {
        const lifecycle = code === 'side_question_approval_declined' ? 'cancelled' : 'blocked'
        const failed = await this.repository
          .transition(record.projectId, record.sessionId, record.id, lifecycle, {
            safeFailureCode: code,
            completedAt: this.now()
          })
          .catch(() => undefined)
        await this.options.graph
          .finishRun(record.childAgentRunId, lifecycle, { safeFailureCode: code })
          .catch(() => undefined)
        if (failed) this.options.onChanged?.(failed)
      }
    }
  }

  private async assertParentUnchanged(
    record: PersistedSideQuestion,
    expected: SideQuestionParentSnapshot
  ): Promise<void> {
    await this.options.sessions.assertSessionAvailable(record.projectId, record.sessionId)
    const session = await this.options.sessions.loadSession(record.projectId, record.sessionId)
    const current = session ? await this.options.parentResolver(session) : undefined
    if (
      !current ||
      current.graphId !== expected.graphId ||
      current.agentRunId !== expected.agentRunId ||
      current.cancellationGeneration !== expected.cancellationGeneration ||
      current.backend !== expected.backend ||
      current.model !== expected.model ||
      current.modelProvider !== expected.modelProvider
    )
      throw new Error('side_question_parent_drift')
  }

  private async runChild(
    record: PersistedSideQuestion,
    parent: SideQuestionParentSnapshot,
    question: string,
    childRuntimeSessionId: string
  ): Promise<void> {
    const adapter = this.options.adapters[parent.backend]
    const controller = new AbortController()
    this.controllers.set(record.id, controller)
    let runtime
    let cleanupAttempted = false
    let cleanupFailure: unknown
    const disposeRuntime = async (): Promise<void> => {
      if (cleanupAttempted) {
        if (cleanupFailure !== undefined) throw cleanupFailure
        return
      }
      cleanupAttempted = true
      try {
        await this.disposeRuntime(runtime)
      } catch (error) {
        cleanupFailure = error
        throw error
      }
    }
    try {
      runtime = await adapter.create({
        parent,
        childAgentRunId: record.childAgentRunId,
        childRuntimeSessionId,
        context: record.context,
        question
      })
      const running = await this.repository.transition(
        record.projectId,
        record.sessionId,
        record.id,
        'running',
        {
          runtimeSessionId: runtime.runtimeSessionId,
          ...(runtime.runtimeThreadId ? { runtimeThreadId: runtime.runtimeThreadId } : {}),
          ...(runtime.model ? { model: runtime.model } : {}),
          ...(runtime.modelProvider ? { modelProvider: runtime.modelProvider } : {})
        }
      )
      this.options.onChanged?.(running)
      const answer = await withTimeout(
        (signal) => runtime!.run({ question, context: record.context, signal }),
        this.timeoutMs,
        controller.signal
      )
      if (typeof answer !== 'string') throw new Error('side_question_invalid_output')
      const bounded = truncateSideQuestionAnswer(answer)
      await disposeRuntime()
      await this.assertParentUnchanged(record, parent)
      const completed = await this.repository.transition(
        record.projectId,
        record.sessionId,
        record.id,
        'completed',
        {
          answer: bounded.answer,
          answerTruncated: bounded.truncated,
          runtimeSessionId: runtime.runtimeSessionId,
          ...(runtime.runtimeThreadId ? { runtimeThreadId: runtime.runtimeThreadId } : {}),
          ...(runtime.model ? { model: runtime.model } : {}),
          ...(runtime.modelProvider ? { modelProvider: runtime.modelProvider } : {}),
          runtimeLinkClosed: true,
          runtimeDisposed: true,
          completedAt: this.now()
        }
      )
      await this.options.graph.finishRun(record.childAgentRunId, 'completed')
      this.options.onChanged?.(completed)
      return
    } catch (error) {
      let code = safeFailureCode(error, 'side_question_failed')
      let cleanupSucceeded = true
      try {
        await disposeRuntime()
      } catch (cleanupError) {
        // We cannot claim an ephemeral child was reaped if its runtime close failed. Preserve the
        // durable result/error and leave an explicit blocked record for recovery instead.
        code = safeFailureCode(cleanupError, 'side_question_cleanup_failed')
        cleanupSucceeded = false
      }
      const lifecycle: 'failed' | 'cancelled' =
        cleanupSucceeded && code === 'side_question_cancelled' ? 'cancelled' : 'failed'
      const failed = await this.repository
        .transition(
          record.projectId,
          record.sessionId,
          record.id,
          cleanupSucceeded ? lifecycle : 'blocked',
          {
            safeFailureCode: code,
            ...(runtime?.runtimeSessionId ? { runtimeSessionId: runtime.runtimeSessionId } : {}),
            ...(runtime?.runtimeThreadId ? { runtimeThreadId: runtime.runtimeThreadId } : {}),
            runtimeLinkClosed: cleanupSucceeded,
            runtimeDisposed: cleanupSucceeded,
            completedAt: this.now()
          }
        )
        .catch(() => record)
      await this.options.graph
        .finishRun(
          record.childAgentRunId,
          cleanupSucceeded ? (lifecycle === 'cancelled' ? 'cancelled' : 'failed') : 'blocked',
          { safeFailureCode: code }
        )
        .catch(() => undefined)
      this.options.onChanged?.(validatePersistedSideQuestion(failed))
      return
    } finally {
      this.controllers.delete(record.id)
    }
  }

  private async disposeRuntime(runtime: SideQuestionRuntimeSession | undefined): Promise<void> {
    if (!runtime) return
    const [cancelled, closed] = await Promise.allSettled([runtime.cancel(), runtime.close()])
    // Closing is the non-negotiable cleanup boundary. A rejected cancellation is still surfaced so
    // the card cannot claim a clean terminal teardown, but it must never prevent close from running.
    if (closed.status === 'rejected') throw closed.reason
    if (cancelled.status === 'rejected') throw cancelled.reason
  }

  private blocked(sessionId: string, safeFailureCode: string): SideQuestionAdmissionResult {
    return { status: 'blocked', sessionId, safeFailureCode }
  }
}

export type { SideQuestionGraph, SideQuestionSessions }
