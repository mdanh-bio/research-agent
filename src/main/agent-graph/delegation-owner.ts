import { createHash, randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

import {
  DELEGATION_DEFAULT_OUTPUT_TOKENS,
  DELEGATION_DEFAULT_WALL_TIME_MS,
  DELEGATION_MAX_RESULT_CHARS,
  DELEGATION_MAX_WAIT_MS,
  type DelegationCapability,
  type DelegationProjection,
  type DelegationResult,
  type DelegationSpawnRequest,
  type PersistedDelegation,
  type DelegationApprovalReceipt,
  isDelegationApprovalReceipt,
  validateDelegationResult,
  validateDelegationSpawnRequest
} from '../../shared/agent-delegation'
import type { AgentRunProjection, AgentRunBudget } from '../../shared/agent-graph'
import type { ModelTarget } from '../../shared/model-routing'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { AgentGraphOwner } from './owner'

type DelegationGraph = Pick<
  AgentGraphOwner,
  | 'createChild'
  | 'getGraphProjection'
  | 'getRunProjection'
  | 'claimQueuedChild'
  | 'finishRun'
  | 'requestCancellation'
>

type DelegationSessions = Readonly<{
  projectIdForSession(sessionId: string): Promise<string | undefined>
  loadSession(projectId: string, sessionId: string): Promise<PersistedChatSession | undefined>
  createDelegation(card: PersistedDelegation): Promise<PersistedDelegation>
  getDelegation(
    projectId: string,
    sessionId: string,
    delegationId: string
  ): Promise<PersistedDelegation | undefined>
  listDelegations(projectId: string, sessionId: string): Promise<readonly PersistedDelegation[]>
  updateDelegation(
    projectId: string,
    sessionId: string,
    delegationId: string,
    update: Partial<PersistedDelegation>
  ): Promise<PersistedDelegation>
}>

type DelegationOwnerOptions = Readonly<{
  getClient: () => Promise<PrismaClient>
  graph: DelegationGraph
  sessions: DelegationSessions
  resolveTarget: (input: {
    parent: AgentRunProjection
    request: DelegationSpawnRequest
  }) => Promise<ModelTarget>
  requestApproval: (input: {
    sessionId: string
    title: string
    rawInput: unknown
  }) => Promise<false | DelegationApprovalReceipt>
  cancelApproval?: (sessionId: string) => void
  execute: (input: {
    delegation: DelegationProjection
    parent: AgentRunProjection
    target: ModelTarget
    context: PersistedChatSession
    signal: AbortSignal
  }) => Promise<DelegationResult>
  idFactory?: () => string
  now?: () => number
}>

type RuntimeRecord = { controller: AbortController; promise: Promise<void> }

const terminal = new Set(['completed', 'failed', 'cancelled', 'blocked'])
const safeError = (error: unknown, fallback: string): string =>
  error instanceof Error && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(error.message)
    ? error.message
    : fallback

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

const targetApprovalView = (target: ModelTarget): DelegationProjection['target'] => ({
  backend: target.backend,
  providerId: target.providerId,
  model: target.model,
  dataBoundary: target.dataBoundary
})

const boundedBudget = (value: DelegationSpawnRequest['budget']): AgentRunBudget => ({
  maxWallTimeMs: value?.maxWallTimeMs ?? DELEGATION_DEFAULT_WALL_TIME_MS,
  maxOutputTokens: value?.maxOutputTokens ?? DELEGATION_DEFAULT_OUTPUT_TOKENS,
  ...(value?.maxInputTokens === undefined ? {} : { maxInputTokens: value.maxInputTokens }),
  ...(value?.maxCostUsd === undefined ? {} : { maxCostUsd: value.maxCostUsd })
})

const validateBoundedBudget = (value: DelegationSpawnRequest['budget']): AgentRunBudget => {
  const budget = boundedBudget(value)
  if ((budget.maxWallTimeMs ?? 0) > DELEGATION_DEFAULT_WALL_TIME_MS) {
    throw new Error('Delegation wall-time budget exceeds the hard bound.')
  }
  if ((budget.maxOutputTokens ?? 0) > DELEGATION_DEFAULT_OUTPUT_TOKENS) {
    throw new Error('Delegation output budget exceeds the hard bound.')
  }
  return budget
}

const assertBudgetWithin = (
  child: AgentRunBudget,
  limit: AgentRunBudget | undefined,
  label: string
): void => {
  if (!limit) return
  for (const key of ['maxWallTimeMs', 'maxInputTokens', 'maxOutputTokens', 'maxCostUsd'] as const) {
    if (child[key] !== undefined && limit[key] !== undefined && child[key]! > limit[key]!) {
      throw new Error(`Delegation budget exceeds the ${label} ${key}.`)
    }
  }
}

const projection = (
  row: {
    id: string
    graphId: string
    parentAgentRunId: string
    childAgentRunId: string
    childFrameId: string
    parentFrameId: string
    originMessageId: string
    projectId: string
    sessionId: string
    taskDigest: string
    role: string
    workClass: string
    resultShape: string
    budgetJson: string | null
    lifecycle: string
    sequence: number
    approvalId: string | null
    approvalDigest: string | null
    targetJson: string | null
    cancellationGeneration: number
    safeFailureCode: string | null
    createdAt: Date
    updatedAt: Date
    finishedAt: Date | null
    revision: number
    approvalConsumedAt: Date | null
  },
  task: string,
  persisted?: Pick<PersistedDelegation, 'resultText' | 'resultJson'>,
  child?: AgentRunProjection
): DelegationProjection => {
  let budget: AgentRunBudget | undefined
  if (row.budgetJson) budget = JSON.parse(row.budgetJson) as AgentRunBudget
  const target = row.targetJson
    ? (JSON.parse(row.targetJson) as DelegationProjection['target'])
    : undefined
  return Object.freeze({
    id: row.id,
    graphId: row.graphId,
    parentAgentRunId: row.parentAgentRunId,
    childAgentRunId: row.childAgentRunId,
    childFrameId: row.childFrameId,
    parentFrameId: row.parentFrameId,
    originMessageId: row.originMessageId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    task,
    role: row.role,
    workClass: row.workClass as DelegationProjection['workClass'],
    resultShape: row.resultShape as DelegationProjection['resultShape'],
    ...(budget ? { budget } : {}),
    lifecycle: row.lifecycle as DelegationProjection['lifecycle'],
    sequence: row.sequence,
    taskDigest: row.taskDigest,
    ...(row.approvalId ? { approvalId: row.approvalId } : {}),
    ...(row.approvalDigest ? { approvalDigest: row.approvalDigest } : {}),
    ...(target ? { target } : {}),
    cancellationGeneration: row.cancellationGeneration,
    ...(persisted?.resultText ? { resultText: persisted.resultText } : {}),
    ...(persisted?.resultJson ? { resultJson: persisted.resultJson } : {}),
    ...(row.safeFailureCode ? { safeFailureCode: row.safeFailureCode } : {}),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    ...(row.finishedAt ? { finishedAt: row.finishedAt.getTime() } : {}),
    ...(row.approvalConsumedAt ? { approvalConsumedAt: row.approvalConsumedAt.getTime() } : {}),
    revision: row.revision,
    ...(child ? { agentRun: child } : {})
  })
}

export class DelegationOwner {
  private readonly idFactory: () => string
  private readonly now: () => number
  private readonly running = new Map<string, RuntimeRecord>()
  private pumping = false
  private lastServedGraphId: string | undefined

  constructor(private readonly options: DelegationOwnerOptions) {
    this.idFactory = options.idFactory ?? randomUUID
    this.now = options.now ?? Date.now
  }

  /** Reconcile process-restart ambiguity without replaying a provider call. */
  async reconcileOnStartup(): Promise<void> {
    const client = await this.options.getClient()
    const ambiguous = await client.delegation.findMany({
      where: { lifecycle: { in: ['dispatching', 'running'] } },
      select: { id: true, projectId: true, sessionId: true, childAgentRunId: true }
    })
    for (const row of ambiguous) {
      await this.fail(row, 'delegation_restart_ambiguous', 'blocked')
    }
    const awaiting = await client.delegation.findMany({
      where: { lifecycle: 'awaiting_approval' },
      select: { id: true, projectId: true, sessionId: true }
    })
    await client.delegation.updateMany({
      where: { lifecycle: 'awaiting_approval' },
      data: {
        lifecycle: 'blocked',
        safeFailureCode: 'delegation_approval_invalid_after_restart',
        finishedAt: new Date(this.now()),
        revision: { increment: 1 }
      }
    })
    for (const row of awaiting) {
      await this.options.sessions
        .updateDelegation(row.projectId, row.sessionId, row.id, {
          lifecycle: 'blocked',
          safeFailureCode: 'delegation_approval_invalid_after_restart',
          finishedAt: this.now()
        })
        .catch(() => undefined)
    }
    await this.pump()
  }

  capability(
    parent: Readonly<{
      graphId: string
      parentAgentRunId: string
      projectId: string
      sessionId: string
    }>
  ): DelegationCapability {
    return Object.freeze({
      spawn: (request) => this.spawn(parent, request),
      status: (childId) => this.status(parent, childId),
      wait: (childId, timeoutMs) => this.wait(parent, childId, timeoutMs),
      cancel: (childId) => this.cancel(parent, childId)
    })
  }

  async spawn(
    parentScope: Readonly<{
      graphId: string
      parentAgentRunId: string
      projectId: string
      sessionId: string
    }>,
    value: unknown
  ): Promise<DelegationProjection> {
    const request = validateDelegationSpawnRequest(value)
    const parent = await this.options.graph.getRunProjection(parentScope.parentAgentRunId)
    const graph = await this.options.graph.getGraphProjection(parentScope.graphId)
    if (
      parent.graphId !== graph.id ||
      parent.parentAgentRunId ||
      parent.status !== 'running' ||
      graph.lifecycle !== 'active'
    ) {
      throw new Error('Delegation parent is not a trusted running root.')
    }
    if (parent.projectId !== parentScope.projectId || parent.sessionId !== parentScope.sessionId) {
      throw new Error('Delegation parent scope is invalid.')
    }
    const target = await this.options.resolveTarget({ parent, request })
    const budget = validateBoundedBudget(request.budget)
    assertBudgetWithin(budget, parent.budget, 'parent remainder')
    assertBudgetWithin(budget, graph.totalBudget, 'graph remainder')
    const child = await this.options.graph.createChild({
      graphId: graph.id,
      parentAgentRunId: parent.id,
      projectId: parent.projectId,
      sessionId: parent.sessionId,
      runKind: 'delegate',
      role: request.role ?? 'delegate',
      workClass: request.workClass,
      runtime: target.backend,
      budget
    })
    const id = this.idFactory()
    const taskDigest = digest({
      task: request.task,
      role: request.role ?? 'delegate',
      workClass: request.workClass,
      resultShape: request.resultShape ?? 'text',
      budget
    })
    const approvalDigest = digest({
      id,
      graphId: graph.id,
      parentRunId: parent.id,
      childRunId: child.id,
      policySnapshotId: child.policySnapshotId,
      taskDigest,
      target: targetApprovalView(target),
      budget,
      cancellationGeneration: graph.cancellationGeneration,
      readOnly: true,
      batch: false
    })
    const card: PersistedDelegation = {
      id,
      graphId: graph.id,
      parentAgentRunId: parent.id,
      childAgentRunId: child.id,
      childFrameId: child.frameId ?? '',
      parentFrameId: parent.frameId ?? '',
      originMessageId: parent.promptMessageId ?? '',
      projectId: parent.projectId,
      sessionId: parent.sessionId,
      task: request.task,
      role: request.role ?? 'delegate',
      workClass: request.workClass,
      resultShape: request.resultShape ?? 'text',
      budget,
      lifecycle: 'awaiting_approval',
      createdAt: this.now(),
      updatedAt: this.now()
    }
    await this.options.sessions.createDelegation(card)
    const client = await this.options.getClient()
    const sequence =
      (
        await client.delegation.aggregate({
          where: { graphId: graph.id },
          _max: { sequence: true }
        })
      )._max.sequence ?? 0
    await client.delegation.create({
      data: {
        id,
        graphId: graph.id,
        parentAgentRunId: parent.id,
        childAgentRunId: child.id,
        childFrameId: child.frameId ?? '',
        parentFrameId: parent.frameId ?? '',
        originMessageId: parent.promptMessageId ?? '',
        projectId: parent.projectId,
        sessionId: parent.sessionId,
        taskDigest,
        role: card.role,
        workClass: card.workClass,
        resultShape: card.resultShape,
        budgetJson: JSON.stringify(budget),
        lifecycle: 'awaiting_approval',
        sequence: sequence + 1,
        cancellationGeneration: graph.cancellationGeneration,
        revision: 1
      }
    })
    const approval = await this.options.requestApproval({
      sessionId: parent.sessionId,
      title: 'Run read-only delegate',
      rawInput: {
        delegationId: id,
        childAgentRunId: child.id,
        role: card.role,
        workClass: card.workClass,
        backend: target.backend,
        providerId: target.providerId,
        model: target.model,
        dataBoundary: target.dataBoundary,
        budget,
        readOnly: true,
        batch: false,
        approvalDigest
      }
    })
    if (approval === false) {
      await this.options.sessions.updateDelegation(parent.projectId, parent.sessionId, id, {
        lifecycle: 'cancelled',
        safeFailureCode: 'delegation_approval_declined',
        finishedAt: this.now()
      })
      await client.delegation.update({
        where: { id },
        data: {
          lifecycle: 'cancelled',
          safeFailureCode: 'delegation_approval_declined',
          finishedAt: new Date(this.now()),
          revision: { increment: 1 }
        }
      })
      await this.options.graph.finishRun(child.id, 'cancelled', {
        safeFailureCode: 'delegation_approval_declined'
      })
      return this.readProjection(parentScope, id)
    }
    if (
      !isDelegationApprovalReceipt(approval) ||
      approval.digest !== approvalDigest ||
      approval.issuedAt > this.now() ||
      approval.expiresAt < this.now()
    ) {
      await this.options.sessions.updateDelegation(parent.projectId, parent.sessionId, id, {
        lifecycle: 'blocked',
        safeFailureCode: 'delegation_approval_invalid',
        finishedAt: this.now()
      })
      await client.delegation.update({
        where: { id },
        data: {
          lifecycle: 'blocked',
          safeFailureCode: 'delegation_approval_invalid',
          finishedAt: new Date(this.now()),
          revision: { increment: 1 }
        }
      })
      await this.options.graph.finishRun(child.id, 'blocked', {
        safeFailureCode: 'delegation_approval_invalid'
      })
      return this.readProjection(parentScope, id)
    }
    await this.options.sessions.updateDelegation(parent.projectId, parent.sessionId, id, {
      lifecycle: 'queued',
      target: targetApprovalView(target),
      approvalId: approval.id,
      approvalDigest
    })
    await this.options.getClient().then((client) =>
      client.delegation.update({
        where: { id },
        data: {
          lifecycle: 'queued',
          approvalId: approval.id,
          approvalDigest,
          targetJson: JSON.stringify(target),
          revision: { increment: 1 }
        }
      })
    )
    void this.pump().catch(() => undefined)
    return this.readProjection(parentScope, id)
  }

  async status(
    scope: Readonly<{ projectId: string; sessionId: string; parentAgentRunId: string }>,
    childId: string
  ): Promise<DelegationProjection | undefined> {
    const record = await this.options.sessions.getDelegation(
      scope.projectId,
      scope.sessionId,
      childId
    )
    if (!record || record.parentAgentRunId !== scope.parentAgentRunId) return undefined
    return this.readProjection(scope, childId)
  }

  async wait(
    scope: Readonly<{ projectId: string; sessionId: string; parentAgentRunId: string }>,
    childId: string,
    timeoutMs = DELEGATION_MAX_WAIT_MS
  ): Promise<DelegationProjection | undefined> {
    const bounded = Math.min(Math.max(timeoutMs, 0), DELEGATION_MAX_WAIT_MS)
    const deadline = Date.now() + bounded
    for (;;) {
      const current = await this.status(scope, childId)
      if (!current || terminal.has(current.lifecycle)) return current
      if (Date.now() >= deadline) return current
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
  }

  async cancel(
    scope: Readonly<{ projectId: string; sessionId: string; parentAgentRunId: string }>,
    childId: string
  ): Promise<DelegationProjection | undefined> {
    const current = await this.status(scope, childId)
    if (!current || terminal.has(current.lifecycle)) return current
    this.running.get(childId)?.controller.abort()
    await this.options.sessions.updateDelegation(scope.projectId, scope.sessionId, childId, {
      lifecycle: 'cancelled',
      safeFailureCode: 'delegation_cancelled',
      finishedAt: this.now()
    })
    await this.options.getClient().then((client) =>
      client.delegation.updateMany({
        where: { id: childId, lifecycle: { notIn: [...terminal] } },
        data: {
          lifecycle: 'cancelled',
          safeFailureCode: 'delegation_cancelled',
          finishedAt: new Date(this.now()),
          revision: { increment: 1 }
        }
      })
    )
    await this.options.graph
      .finishRun(current.childAgentRunId, 'cancelled', { safeFailureCode: 'delegation_cancelled' })
      .catch(() => undefined)
    return this.status(scope, childId)
  }

  private async readProjection(
    scope: Readonly<{ projectId: string; sessionId: string }>,
    id: string
  ): Promise<DelegationProjection> {
    const record = await this.options.sessions.getDelegation(scope.projectId, scope.sessionId, id)
    if (!record) throw new Error('Delegation not found.')
    const child = await this.options.graph
      .getRunProjection(record.childAgentRunId)
      .catch(() => undefined)
    const row = await this.options
      .getClient()
      .then((client) => client.delegation.findUniqueOrThrow({ where: { id } }))
    return projection(row, record.task, record, child)
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      const client = await this.options.getClient()
      const rows = await client.delegation.findMany({
        where: { lifecycle: 'queued' },
        orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }]
      })
      const graphIds = [...new Set(rows.map((row) => row.graphId))]
      const rotated = graphIds.sort((a, b) => {
        if (a === this.lastServedGraphId) return 1
        if (b === this.lastServedGraphId) return -1
        return 0
      })
      for (const graphId of rotated) {
        const row = rows.find((candidate) => candidate.graphId === graphId)
        if (!row) continue
        if (this.running.has(row.id)) continue
        const parent = await this.options.graph
          .getRunProjection(row.parentAgentRunId)
          .catch(() => undefined)
        const graph = await this.options.graph
          .getGraphProjection(row.graphId)
          .catch(() => undefined)
        const record = await this.options.sessions.getDelegation(
          row.projectId,
          row.sessionId,
          row.id
        )
        const context = await this.options.sessions.loadSession(row.projectId, row.sessionId)
        const approvedTarget = row.targetJson
          ? (JSON.parse(row.targetJson) as ModelTarget)
          : undefined
        if (
          !parent ||
          !graph ||
          !record ||
          !context ||
          !approvedTarget ||
          parent.graphId !== row.graphId ||
          parent.status !== 'running' ||
          graph.lifecycle !== 'active' ||
          graph.cancellationGeneration !== row.cancellationGeneration
        ) {
          await this.fail(row, 'delegation_authority_stale', 'blocked')
          continue
        }
        const currentTarget = await this.options
          .resolveTarget({
            parent,
            request: {
              task: record.task,
              role: record.role,
              workClass: record.workClass,
              resultShape: record.resultShape,
              ...(record.budget ? { budget: record.budget } : {})
            }
          })
          .catch(() => undefined)
        if (
          !currentTarget ||
          digest(targetApprovalView(currentTarget)) !== digest(targetApprovalView(approvedTarget))
        ) {
          await this.fail(row, 'delegation_route_drift', 'blocked')
          continue
        }
        const child = await this.options.graph.claimQueuedChild(row.childAgentRunId)
        if (!child) continue
        // The graph slot is claimed before receipt consumption so a full graph does not spend and
        // reset a receipt. Consumption still occurs before runtime creation and can happen once.
        const consumed = await client.delegation.updateMany({
          where: {
            id: row.id,
            lifecycle: 'queued',
            approvalId: row.approvalId,
            approvalDigest: row.approvalDigest,
            approvalConsumedAt: null,
            cancellationGeneration: row.cancellationGeneration,
            revision: row.revision
          },
          data: { approvalConsumedAt: new Date(this.now()), revision: { increment: 1 } }
        })
        if (consumed.count !== 1) {
          await this.fail(row, 'delegation_approval_replay', 'blocked')
          continue
        }
        this.lastServedGraphId = graphId
        await this.options.sessions.updateDelegation(row.projectId, row.sessionId, row.id, {
          lifecycle: 'dispatching'
        })
        await client.delegation.update({
          where: { id: row.id },
          data: { lifecycle: 'dispatching', revision: { increment: 1 } }
        })
        const controller = new AbortController()
        const promise = this.execute(row, record, child, parent, context, currentTarget, controller)
        this.running.set(row.id, { controller, promise })
        void promise.finally(() => this.running.delete(row.id)).catch(() => undefined)
      }
    } finally {
      this.pumping = false
    }
  }

  private async execute(
    row: { id: string; projectId: string; sessionId: string; childAgentRunId: string },
    _record: PersistedDelegation,
    child: AgentRunProjection,
    parent: AgentRunProjection,
    context: PersistedChatSession,
    target: ModelTarget,
    controller: AbortController
  ): Promise<void> {
    const wallTimeMs =
      child.budget && 'maxWallTimeMs' in child.budget
        ? (child.budget.maxWallTimeMs ?? DELEGATION_DEFAULT_WALL_TIME_MS)
        : DELEGATION_DEFAULT_WALL_TIME_MS
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await this.options.sessions.updateDelegation(row.projectId, row.sessionId, row.id, {
        lifecycle: 'running'
      })
      await this.options.getClient().then((client) =>
        client.delegation.update({
          where: { id: row.id },
          data: { lifecycle: 'running', revision: { increment: 1 } }
        })
      )
      const result = validateDelegationResult(
        await Promise.race([
          this.options.execute({
            delegation: await this.readProjection(
              { projectId: row.projectId, sessionId: row.sessionId },
              row.id
            ),
            parent,
            target,
            context,
            signal: controller.signal
          }),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              controller.abort()
              reject(new Error('delegation_timeout'))
            }, wallTimeMs)
          })
        ])
      )
      const current = await this.options.sessions.getDelegation(
        row.projectId,
        row.sessionId,
        row.id
      )
      if (current && terminal.has(current.lifecycle)) return
      const update: Partial<PersistedDelegation> = {
        lifecycle: result.status,
        ...(result.text ? { resultText: result.text.slice(0, DELEGATION_MAX_RESULT_CHARS) } : {}),
        ...(result.json ? { resultJson: result.json.slice(0, DELEGATION_MAX_RESULT_CHARS) } : {}),
        ...(result.safeFailureCode ? { safeFailureCode: result.safeFailureCode } : {}),
        finishedAt: this.now()
      }
      await this.options.sessions.updateDelegation(row.projectId, row.sessionId, row.id, update)
      await this.options.getClient().then((client) =>
        client.delegation.update({
          where: { id: row.id },
          data: {
            lifecycle: result.status,
            ...(result.safeFailureCode ? { safeFailureCode: result.safeFailureCode } : {}),
            finishedAt: new Date(this.now()),
            revision: { increment: 1 }
          }
        })
      )
      await this.options.graph.finishRun(child.id, result.status, {
        safeFailureCode: result.safeFailureCode
      })
    } catch (error) {
      const current = await this.options.sessions
        .getDelegation(row.projectId, row.sessionId, row.id)
        .catch(() => undefined)
      if (current && terminal.has(current.lifecycle)) return
      await this.fail(row, safeError(error, 'delegation_provider_failed'), 'failed')
    } finally {
      if (timeout) clearTimeout(timeout)
      void this.pump().catch(() => undefined)
    }
  }

  private async fail(
    row: { id: string; projectId: string; sessionId: string; childAgentRunId: string },
    code: string,
    lifecycle: 'failed' | 'blocked'
  ): Promise<void> {
    await this.options.sessions
      .updateDelegation(row.projectId, row.sessionId, row.id, {
        lifecycle,
        safeFailureCode: code,
        finishedAt: this.now()
      })
      .catch(() => undefined)
    await this.options
      .getClient()
      .then((client) =>
        client.delegation.update({
          where: { id: row.id },
          data: {
            lifecycle,
            safeFailureCode: code,
            finishedAt: new Date(this.now()),
            revision: { increment: 1 }
          }
        })
      )
      .catch(() => undefined)
    await this.options.graph
      .finishRun(row.childAgentRunId, lifecycle, { safeFailureCode: code })
      .catch(() => undefined)
  }
}

export type { DelegationOwnerOptions }
