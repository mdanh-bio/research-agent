import { randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient } from '@prisma/client'

import {
  AGENT_GRAPH_KINDS,
  AGENT_GRAPH_TERMINAL_LIFECYCLES,
  AGENT_RUN_KINDS,
  AGENT_RUN_TERMINAL_STATUSES,
  DEFAULT_AGENT_GRAPH_LIMITS,
  validateAgentGraphLimits,
  validateAgentObservedUsage,
  validateAgentRunBudget,
  assertAgentGraphIdentity,
  type AgentGraphKind,
  type AgentGraphLimits,
  type AgentGraphLifecycle,
  type AgentGraphProjection,
  type AgentObservedUsage,
  type AgentRunBudget,
  type AgentRunKind,
  type AgentRunProjection
} from '../../shared/agent-graph'
import type {
  AgentRunStatus,
  ModelRoutePolicy,
  ModelTarget,
  RouteDecision,
  WorkClass
} from '../../shared/model-routing'
import { canonicalRoutingSnapshotJson, routingPolicyHash } from '../model-routing/ledger'

type AgentGraphClient = PrismaClient | Prisma.TransactionClient
type AgentGraphClientProvider = () => Promise<PrismaClient>

export type AgentRootCreationResult = Readonly<{
  graphId: string
  agentRunId: string
  policySnapshotId: string
  frameId: string
  artifactStorageSessionId: string
  policyHash: string
}>

export type CreateRootAgentRunInput = Readonly<{
  projectId: string
  sessionId: string
  promptMessageId: string
  workClass: WorkClass
  role?: string
  target: ModelTarget
  routeDecision?: RouteDecision
  effectivePolicy?: ModelRoutePolicy
  graphKind?: Extract<AgentGraphKind, 'root' | 'interaction-router'>
  limits?: AgentGraphLimits
  budget?: AgentRunBudget
  status?: Extract<AgentRunStatus, 'queued' | 'running'>
}>

export type CreateChildAgentRunInput = Readonly<{
  graphId: string
  parentAgentRunId: string
  runKind: Extract<AgentRunKind, 'delegate' | 'side-question' | 'interaction-router'>
  projectId: string
  sessionId: string
  promptMessageId?: string
  role: string
  workClass: WorkClass
  runtime: ModelTarget['backend']
  policySnapshotId?: string
  budget?: AgentRunBudget
  artifactStorageSessionId?: string
  // Side questions may be asked after the root turn has reached an idle terminal state. This
  // exception is intentionally closed to the side-question run kind; delegate admission still
  // requires a running root and an active graph.
  allowIdleParent?: boolean
}>

export type FinishAgentRunOptions = Readonly<{
  safeFailureCode?: string
  outputArtifactIds?: readonly string[]
  observedUsage?: AgentObservedUsage
  expectedRevision?: number
}>

const TERMINAL_RUN_STATUSES: ReadonlySet<AgentRunStatus> = AGENT_RUN_TERMINAL_STATUSES

const assertNonEmpty = (value: string, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw new Error(`${label} must be a non-empty bounded identifier.`)
  }
  return value
}

const assertSafeRevision = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`)
  }
  return value
}

const assertSafeFailureCode = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error('Agent failure code contains unsupported characters.')
  }
  return value
}

const assertBudgetCapacity = (
  requested: AgentRunBudget | undefined,
  limit: AgentRunBudget | undefined,
  reserved: AgentRunBudget,
  label: string
): void => {
  if (!requested || !limit) return
  for (const key of [
    'maxWallTimeMs',
    'maxInputTokens',
    'maxOutputTokens',
    'maxCostUsd',
    'maxArtifactBytes'
  ] as const) {
    const request = requested[key]
    const maximum = limit[key]
    if (
      request !== undefined &&
      maximum !== undefined &&
      request + (reserved[key] ?? 0) > maximum
    ) {
      throw new Error(`Child Agent Run budget exceeds the ${label} ${key}.`)
    }
  }
}

const parseJsonObject = <Value>(
  value: string | null | undefined,
  label: string
): Value | undefined => {
  if (value === null || value === undefined) return undefined
  try {
    return JSON.parse(value) as Value
  } catch {
    throw new Error(`Stored ${label} is corrupt.`)
  }
}

const directPolicy = (input: CreateRootAgentRunInput): ModelRoutePolicy => ({
  id: 'configured_direct',
  version: '1',
  workClass: input.workClass,
  primary: input.target,
  fallbacks: [],
  requiredCapabilities: [],
  dataBoundary: input.target.dataBoundary,
  ...(input.budget ? { budget: input.budget } : {})
})

const directDecision = (input: CreateRootAgentRunInput): RouteDecision => ({
  workClass: input.workClass,
  policyId: 'configured_direct',
  policyVersion: '1',
  policySource: 'shipped_default',
  target: input.target,
  eligibleAlternates: [],
  requiredCapabilities: [],
  dataBoundary: input.target.dataBoundary,
  ...(input.budget ? { budget: input.budget } : {}),
  selectionReason: 'Transparent routing is off; use the configured backend/provider/model.',
  rejectedAlternatives: []
})

const configuredDirectSnapshot = (
  input: CreateRootAgentRunInput
): {
  policyJson: string
  policyHash: string
  policy: ModelRoutePolicy
  decision: RouteDecision
} => {
  const policy = directPolicy(input)
  const decision = directDecision(input)
  const base = JSON.parse(canonicalRoutingSnapshotJson(policy, decision)) as Record<string, unknown>
  const policyJson = JSON.stringify({
    ...base,
    routingMode: 'configured_direct',
    transparentRouting: false
  })
  return { policyJson, policyHash: routingPolicyHash(policyJson), policy, decision }
}

const routedSnapshot = (
  input: CreateRootAgentRunInput
): {
  policyJson: string
  policyHash: string
  policy: ModelRoutePolicy
  decision: RouteDecision
} => {
  if (!input.routeDecision || !input.effectivePolicy) {
    throw new Error('A routed root requires its complete policy and route decision.')
  }
  const policyJson = canonicalRoutingSnapshotJson(input.effectivePolicy, input.routeDecision)
  return {
    policyJson,
    policyHash: routingPolicyHash(policyJson),
    policy: input.effectivePolicy,
    decision: input.routeDecision
  }
}

const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'P2002'

const safeOutputArtifactIds = (value: readonly string[] | undefined): string => {
  const ids = [...(value ?? [])]
  for (const id of ids) {
    if (typeof id !== 'string') throw new Error('Output artifact id must be a string.')
    assertNonEmpty(id, 'Output artifact id')
  }
  return JSON.stringify(ids)
}

const graphProjection = (row: {
  id: string
  projectId: string
  sessionId: string
  rootPromptMessageId: string
  kind: string
  lifecycle: string
  maxConcurrency: number
  maxDepth: number
  maxChildren: number
  totalBudgetJson: string | null
  observedUsageJson: string
  cancellationGeneration: number
  cancelRequestedAt: Date | null
  cancellationReason: string | null
  createdAt: Date
  updatedAt: Date
  revision: number
}): AgentGraphProjection => {
  assertNonEmpty(row.id, 'Stored Agent Graph id')
  assertAgentGraphIdentity(row.projectId, row.sessionId, row.rootPromptMessageId)
  if (!['root', 'delegate', 'side-question', 'interaction-router'].includes(row.kind)) {
    throw new Error('Stored Agent Graph kind is corrupt.')
  }
  if (
    !['active', 'cancelling', 'completed', 'failed', 'cancelled', 'blocked'].includes(row.lifecycle)
  ) {
    throw new Error('Stored Agent Graph lifecycle is corrupt.')
  }
  const limits = validateAgentGraphLimits({
    maxConcurrency: row.maxConcurrency,
    maxDepth: row.maxDepth,
    maxChildren: row.maxChildren
  })
  const observedUsage = validateAgentObservedUsage(
    parseJsonObject<AgentObservedUsage>(row.observedUsageJson, 'Agent Graph observed usage')
  )
  assertNonNegativeIntegerStored(
    row.cancellationGeneration,
    'Stored Agent Graph cancellation generation'
  )
  assertSafeRevision(row.revision, 'Stored Agent Graph revision')
  if (
    row.cancellationReason !== null &&
    !['user', 'parent', 'shutdown', 'budget', 'recovery'].includes(row.cancellationReason)
  ) {
    throw new Error('Stored Agent Graph cancellation reason is corrupt.')
  }
  return Object.freeze({
    id: row.id,
    projectId: row.projectId,
    sessionId: row.sessionId,
    rootPromptMessageId: row.rootPromptMessageId,
    kind: row.kind as AgentGraphKind,
    lifecycle: row.lifecycle as AgentGraphLifecycle,
    limits,
    ...(row.totalBudgetJson
      ? {
          totalBudget: validateAgentRunBudget(
            parseJsonObject<AgentRunBudget>(row.totalBudgetJson, 'Agent Graph budget')
          )
        }
      : {}),
    observedUsage,
    cancellationGeneration: row.cancellationGeneration,
    ...(row.cancelRequestedAt ? { cancelRequestedAt: row.cancelRequestedAt.getTime() } : {}),
    ...(row.cancellationReason
      ? {
          cancelReason: row.cancellationReason as
            'user' | 'parent' | 'shutdown' | 'budget' | 'recovery'
        }
      : {}),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    revision: row.revision
  })
}

const runProjection = (row: {
  id: string
  graphId: string | null
  parentAgentRunId: string | null
  frameId: string | null
  policySnapshotId: string
  runKind: string
  depth: number
  projectId: string
  sessionId: string
  promptMessageId: string | null
  role: string
  workClass: string
  runtime: string
  status: string
  budgetJson: string | null
  artifactStorageSessionId: string | null
  observedBudgetJson: string
  outputArtifactIdsJson: string
  cancelRequestedAt: Date | null
  cancelledAt: Date | null
  failureCode: string | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  updatedAt: Date
  revision: number
}): AgentRunProjection => {
  assertNonEmpty(row.id, 'Stored Agent Run id')
  assertAgentGraphIdentity(row.projectId, row.sessionId, row.promptMessageId ?? 'legacy-prompt')
  assertNonNegativeIntegerStored(row.depth, 'Stored Agent Run depth')
  assertSafeRevision(row.revision, 'Stored Agent Run revision')
  if (!['root', 'delegate', 'side-question', 'interaction-router'].includes(row.runKind)) {
    throw new Error('Stored Agent Run kind is corrupt.')
  }
  if (!['queued', 'running', 'completed', 'failed', 'cancelled', 'blocked'].includes(row.status)) {
    throw new Error('Stored Agent Run status is corrupt.')
  }
  if (row.failureCode !== null) assertSafeFailureCode(row.failureCode)
  const outputArtifactIds = parseJsonObject<unknown>(
    row.outputArtifactIdsJson,
    'Agent Run artifacts'
  )
  if (!Array.isArray(outputArtifactIds)) throw new Error('Stored Agent Run artifacts are corrupt.')
  return Object.freeze({
    id: row.id,
    ...(row.graphId ? { graphId: row.graphId } : {}),
    ...(row.parentAgentRunId ? { parentAgentRunId: row.parentAgentRunId } : {}),
    ...(row.frameId ? { frameId: row.frameId } : {}),
    policySnapshotId: row.policySnapshotId,
    runKind: row.runKind as AgentRunKind,
    depth: row.depth,
    projectId: row.projectId,
    sessionId: row.sessionId,
    ...(row.promptMessageId ? { promptMessageId: row.promptMessageId } : {}),
    role: row.role,
    workClass: row.workClass as WorkClass,
    runtime: row.runtime as ModelTarget['backend'],
    status: row.status as AgentRunProjection['status'],
    ...(row.budgetJson
      ? {
          budget: validateAgentRunBudget(
            parseJsonObject<AgentRunBudget>(row.budgetJson, 'Agent Run budget')
          )
        }
      : {}),
    observedBudget: validateAgentObservedUsage(
      parseJsonObject<AgentObservedUsage>(row.observedBudgetJson, 'Agent Run observed budget')
    ),
    ...(row.artifactStorageSessionId
      ? { artifactStorageSessionId: row.artifactStorageSessionId }
      : {}),
    outputArtifactIds: Object.freeze(
      outputArtifactIds.map((id) => {
        if (typeof id !== 'string') throw new Error('Stored Output artifact id is corrupt.')
        return assertNonEmpty(id, 'Output artifact id')
      })
    ),
    ...(row.cancelRequestedAt ? { cancelRequestedAt: row.cancelRequestedAt.getTime() } : {}),
    ...(row.cancelledAt ? { cancelledAt: row.cancelledAt.getTime() } : {}),
    ...(row.failureCode ? { safeFailureCode: row.failureCode } : {}),
    createdAt: row.createdAt.getTime(),
    ...(row.startedAt ? { startedAt: row.startedAt.getTime() } : {}),
    ...(row.finishedAt ? { finishedAt: row.finishedAt.getTime() } : {}),
    updatedAt: row.updatedAt.getTime(),
    revision: row.revision
  })
}

const assertNonNegativeIntegerStored = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is corrupt.`)
  return value
}

class AgentGraphOwner {
  private readonly idFactory: () => string
  private readonly now: () => Date

  constructor(
    private readonly getClient: AgentGraphClientProvider,
    options: Readonly<{ idFactory?: () => string; now?: () => Date }> = {}
  ) {
    this.idFactory = options.idFactory ?? randomUUID
    this.now = options.now ?? (() => new Date())
  }

  async createRoutedRoot(input: CreateRootAgentRunInput): Promise<AgentRootCreationResult> {
    if (!input.routeDecision || !input.effectivePolicy) {
      throw new Error('A routed root requires its complete policy and route decision.')
    }
    return this.createRoot(input)
  }

  async createConfiguredDirectRoot(
    input: CreateRootAgentRunInput
  ): Promise<AgentRootCreationResult> {
    return this.createRoot({ ...input, routeDecision: undefined, effectivePolicy: undefined })
  }

  private async createRoot(input: CreateRootAgentRunInput): Promise<AgentRootCreationResult> {
    const projectId = assertNonEmpty(input.projectId, 'projectId')
    const sessionId = assertNonEmpty(input.sessionId, 'sessionId')
    const promptMessageId = assertNonEmpty(input.promptMessageId, 'promptMessageId')
    const role = assertNonEmpty(input.role ?? 'main-agent', 'role')
    const limits = validateAgentGraphLimits(input.limits ?? DEFAULT_AGENT_GRAPH_LIMITS)
    const budget = validateAgentRunBudget(input.budget)
    const status = input.status ?? 'running'
    if (!['queued', 'running'].includes(status)) {
      throw new Error('Agent root status must be queued or running.')
    }
    const snapshot =
      input.routeDecision && input.effectivePolicy
        ? routedSnapshot(input)
        : configuredDirectSnapshot(input)
    const client = await this.getClient()
    const unique = { projectId, sessionId, rootPromptMessageId: promptMessageId }

    const existing = await client.agentGraph.findUnique({
      where: { projectId_sessionId_rootPromptMessageId: unique }
    })
    if (existing) return this.rootResult(client, existing.id)

    const graphId = this.idFactory()
    const policySnapshotId = this.idFactory()
    const agentRunId = this.idFactory()
    const frameId = this.idFactory()
    const artifactStorageSessionId = this.idFactory()
    const createdAt = this.now()
    const graphKind = input.graphKind ?? 'root'
    if (!AGENT_GRAPH_KINDS.includes(graphKind)) {
      throw new Error('Agent graph kind is invalid.')
    }

    try {
      return await client.$transaction(async (transaction) => {
        const concurrent = await transaction.agentGraph.findUnique({
          where: { projectId_sessionId_rootPromptMessageId: unique }
        })
        if (concurrent) return this.rootResult(transaction, concurrent.id)

        await transaction.routingPolicySnapshot.create({
          data: {
            id: policySnapshotId,
            projectId,
            sessionId,
            workClass: input.workClass,
            policyId: snapshot.policy.id,
            policyVersion: snapshot.policy.version,
            policySource: snapshot.decision.policySource,
            policyJson: snapshot.policyJson,
            policyHash: snapshot.policyHash,
            createdAt
          }
        })
        await transaction.agentGraph.create({
          data: {
            id: graphId,
            projectId,
            sessionId,
            rootPromptMessageId: promptMessageId,
            kind: graphKind,
            lifecycle: 'active',
            maxConcurrency: limits.maxConcurrency,
            maxDepth: limits.maxDepth,
            maxChildren: limits.maxChildren,
            totalBudgetJson: budget ? JSON.stringify(budget) : undefined,
            observedUsageJson: '{}',
            cancellationGeneration: 0,
            createdAt,
            revision: 1
          }
        })
        await transaction.agentRun.create({
          data: {
            id: agentRunId,
            graphId,
            frameId,
            runKind: 'root',
            depth: 0,
            policySnapshotId,
            projectId,
            sessionId,
            promptMessageId,
            role,
            workClass: input.workClass,
            runtime: input.target.backend,
            status,
            budgetJson: budget ? JSON.stringify(budget) : undefined,
            artifactStorageSessionId,
            observedBudgetJson: '{}',
            outputArtifactIdsJson: '[]',
            createdAt,
            startedAt: status === 'running' ? createdAt : undefined,
            revision: 1
          }
        })
        return {
          graphId,
          agentRunId,
          policySnapshotId,
          frameId,
          artifactStorageSessionId,
          policyHash: snapshot.policyHash
        }
      })
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const raced = await client.agentGraph.findUnique({
          where: { projectId_sessionId_rootPromptMessageId: unique }
        })
        if (raced) return this.rootResult(client, raced.id)
      }
      throw error
    }
  }

  private async rootResult(
    client: AgentGraphClient,
    graphId: string
  ): Promise<AgentRootCreationResult> {
    const run = await client.agentRun.findFirst({
      where: { graphId, runKind: 'root' },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        frameId: true,
        policySnapshotId: true,
        artifactStorageSessionId: true
      }
    })
    if (!run || !run.frameId || !run.artifactStorageSessionId) {
      throw new Error(`Agent Graph ${graphId} is corrupt: its root Agent Run is missing.`)
    }
    const snapshot = await client.routingPolicySnapshot.findUnique({
      where: { id: run.policySnapshotId },
      select: { policyHash: true }
    })
    if (!snapshot)
      throw new Error(`Agent Graph ${graphId} is corrupt: its policy snapshot is missing.`)
    return {
      graphId,
      agentRunId: run.id,
      policySnapshotId: run.policySnapshotId,
      frameId: run.frameId,
      artifactStorageSessionId: run.artifactStorageSessionId,
      policyHash: snapshot.policyHash
    }
  }

  async createChild(input: CreateChildAgentRunInput): Promise<AgentRunProjection> {
    const projectId = assertNonEmpty(input.projectId, 'projectId')
    const sessionId = assertNonEmpty(input.sessionId, 'sessionId')
    const graphId = assertNonEmpty(input.graphId, 'graphId')
    const parentAgentRunId = assertNonEmpty(input.parentAgentRunId, 'parentAgentRunId')
    const role = assertNonEmpty(input.role, 'role')
    const budget = validateAgentRunBudget(input.budget)
    if (!AGENT_RUN_KINDS.includes(input.runKind)) {
      throw new Error('Child Agent Run kind is invalid.')
    }
    if (input.promptMessageId !== undefined) {
      assertNonEmpty(input.promptMessageId, 'promptMessageId')
    }
    assertNonEmpty(input.runtime, 'runtime')
    const client = await this.getClient()
    const childId = this.idFactory()
    const frameId = this.idFactory()
    const artifactStorageSessionId = input.artifactStorageSessionId ?? this.idFactory()
    assertNonEmpty(artifactStorageSessionId, 'artifactStorageSessionId')
    const createdAt = this.now()

    return client.$transaction(async (transaction) => {
      const graph = await transaction.agentGraph.findUnique({ where: { id: graphId } })
      if (!graph) throw new Error(`Unknown Agent Graph: ${graphId}`)
      if (graph.projectId !== projectId || graph.sessionId !== sessionId) {
        throw new Error('Child Agent Run scope does not match its Agent Graph.')
      }
      const isSideQuestion = input.runKind === 'side-question'
      const idleSideQuestionAdmission = isSideQuestion && input.allowIdleParent === true
      if (
        graph.lifecycle !== 'active' &&
        !(idleSideQuestionAdmission && graph.lifecycle === 'completed')
      ) {
        throw new Error('A child cannot be admitted to an inactive or cancelling Agent Graph.')
      }
      const limits = validateAgentGraphLimits({
        maxConcurrency: graph.maxConcurrency,
        maxDepth: graph.maxDepth,
        maxChildren: graph.maxChildren
      })
      const parent = await transaction.agentRun.findUnique({ where: { id: parentAgentRunId } })
      if (
        !parent ||
        parent.graphId !== graphId ||
        parent.projectId !== projectId ||
        parent.sessionId !== sessionId
      ) {
        throw new Error('Child Agent Run parent is missing or belongs to another graph.')
      }
      if (
        parent.status !== 'running' &&
        !(idleSideQuestionAdmission && parent.status === 'completed')
      ) {
        throw new Error('A child requires a running parent Agent Run.')
      }
      if (parent.runKind !== 'root' || parent.depth !== 0 || parent.depth >= limits.maxDepth) {
        throw new Error('Child Agent Run depth exceeds the graph limit.')
      }
      const childCount = await transaction.agentRun.count({
        where: { graphId, parentAgentRunId: { not: null }, runKind: { not: 'root' } }
      })
      if (childCount >= limits.maxChildren) {
        throw new Error('Agent Graph child-count limit has been reached.')
      }
      const reserved = (
        await transaction.agentRun.findMany({
          where: { graphId, parentAgentRunId: { not: null }, runKind: { not: 'root' } },
          select: { budgetJson: true }
        })
      ).reduce<AgentRunBudget>((total, row) => {
        const item = row.budgetJson
          ? validateAgentRunBudget(parseJsonObject<AgentRunBudget>(row.budgetJson, 'Child budget'))
          : undefined
        return {
          maxWallTimeMs: (total.maxWallTimeMs ?? 0) + (item?.maxWallTimeMs ?? 0),
          maxInputTokens: (total.maxInputTokens ?? 0) + (item?.maxInputTokens ?? 0),
          maxOutputTokens: (total.maxOutputTokens ?? 0) + (item?.maxOutputTokens ?? 0),
          maxCostUsd: (total.maxCostUsd ?? 0) + (item?.maxCostUsd ?? 0),
          maxArtifactBytes: (total.maxArtifactBytes ?? 0) + (item?.maxArtifactBytes ?? 0)
        }
      }, {})
      const parentBudget = parent.budgetJson
        ? validateAgentRunBudget(
            parseJsonObject<AgentRunBudget>(parent.budgetJson, 'Parent Agent Run budget')
          )
        : undefined
      const graphBudget = graph.totalBudgetJson
        ? validateAgentRunBudget(
            parseJsonObject<AgentRunBudget>(graph.totalBudgetJson, 'Agent Graph budget')
          )
        : undefined
      assertBudgetCapacity(budget, parentBudget, reserved, 'parent remainder')
      assertBudgetCapacity(budget, graphBudget, reserved, 'graph remainder')
      if (idleSideQuestionAdmission && graph.lifecycle === 'completed') {
        // Re-open only the graph admission window. The completed root run, its frame, prompt, and
        // cancellation generation remain unchanged; the graph closes again when this child settles.
        await transaction.agentGraph.updateMany({
          where: { id: graphId, lifecycle: 'completed', revision: graph.revision },
          data: { lifecycle: 'active', updatedAt: createdAt, revision: { increment: 1 } }
        })
      }
      const policySnapshotId = input.policySnapshotId ?? parent.policySnapshotId
      const policySnapshot = await transaction.routingPolicySnapshot.findUnique({
        where: { id: policySnapshotId },
        select: { projectId: true, sessionId: true }
      })
      if (
        !policySnapshot ||
        policySnapshot.projectId !== projectId ||
        policySnapshot.sessionId !== sessionId
      ) {
        throw new Error('Child Agent Run policy snapshot is missing or out of scope.')
      }
      const created = await transaction.agentRun.create({
        data: {
          id: childId,
          graphId,
          frameId,
          runKind: input.runKind,
          depth: parent.depth + 1,
          parentAgentRunId,
          policySnapshotId,
          projectId,
          sessionId,
          promptMessageId: input.promptMessageId,
          role,
          workClass: input.workClass,
          runtime: input.runtime,
          status: 'queued',
          budgetJson: budget ? JSON.stringify(budget) : undefined,
          artifactStorageSessionId,
          observedBudgetJson: '{}',
          outputArtifactIdsJson: '[]',
          createdAt,
          revision: 1
        }
      })
      return runProjection(created)
    })
  }

  async createSideQuestionChild(
    input: Omit<CreateChildAgentRunInput, 'runKind' | 'allowIdleParent'> & {
      allowIdleParent?: boolean
    }
  ): Promise<AgentRunProjection> {
    return this.createChild({
      ...input,
      runKind: 'side-question',
      allowIdleParent: input.allowIdleParent ?? true
    })
  }

  async startRun(runId: string, expectedRevision?: number): Promise<AgentRunProjection> {
    const client = await this.getClient()
    const now = this.now()
    return client.$transaction(async (transaction) => {
      const run = await transaction.agentRun.findUnique({ where: { id: runId } })
      if (!run) throw new Error(`Unknown Agent Run: ${runId}`)
      if (!run.graphId) throw new Error('Legacy M1 Agent Runs are read-only.')
      if (run.status === 'running') return runProjection(run)
      if (run.status !== 'queued')
        throw new Error(`Agent Run ${runId} cannot start from ${run.status}.`)
      if (expectedRevision !== undefined && run.revision !== expectedRevision) {
        throw new Error(`Agent Run ${runId} revision changed before start.`)
      }
      const graph = await transaction.agentGraph.findUnique({ where: { id: run.graphId } })
      if (!graph || graph.lifecycle !== 'active') throw new Error('Agent Graph is not active.')
      const limits = validateAgentGraphLimits({
        maxConcurrency: graph.maxConcurrency,
        maxDepth: graph.maxDepth,
        maxChildren: graph.maxChildren
      })
      const activeCount = await transaction.agentRun.count({
        where: { graphId: run.graphId, status: 'running' }
      })
      if (activeCount >= limits.maxConcurrency) {
        throw new Error('Agent Graph concurrency limit has been reached.')
      }
      const changed = await transaction.agentRun.updateMany({
        where: {
          id: runId,
          status: 'queued',
          revision: expectedRevision ?? run.revision
        },
        data: { status: 'running', startedAt: now, updatedAt: now, revision: { increment: 1 } }
      })
      if (changed.count !== 1) {
        const raced = await transaction.agentRun.findUnique({ where: { id: runId } })
        if (raced?.status === 'running') return runProjection(raced)
        throw new Error(`Agent Run ${runId} changed before start.`)
      }
      return runProjection(await transaction.agentRun.findUniqueOrThrow({ where: { id: runId } }))
    })
  }

  // Claims a queued child slot atomically. Admission is deliberately separate from execution: the
  // fourth admitted child may wait in FIFO order until one of the four running-node slots releases.
  async claimQueuedChild(
    runId: string,
    expectedRevision?: number
  ): Promise<AgentRunProjection | undefined> {
    const client = await this.getClient()
    const now = this.now()
    return client.$transaction(async (transaction) => {
      const run = await transaction.agentRun.findUnique({ where: { id: runId } })
      if (!run || !run.graphId) return undefined
      if (run.status === 'running') return runProjection(run)
      if (run.status !== 'queued') return undefined
      if (expectedRevision !== undefined && run.revision !== expectedRevision) return undefined
      const graph = await transaction.agentGraph.findUnique({ where: { id: run.graphId } })
      if (!graph || graph.lifecycle !== 'active') return undefined
      const limits = validateAgentGraphLimits({
        maxConcurrency: graph.maxConcurrency,
        maxDepth: graph.maxDepth,
        maxChildren: graph.maxChildren
      })
      const activeCount = await transaction.agentRun.count({
        where: { graphId: run.graphId, status: 'running' }
      })
      if (activeCount >= limits.maxConcurrency) return undefined
      const changed = await transaction.agentRun.updateMany({
        where: { id: runId, status: 'queued', revision: expectedRevision ?? run.revision },
        data: { status: 'running', startedAt: now, updatedAt: now, revision: { increment: 1 } }
      })
      if (changed.count !== 1) return undefined
      await transaction.agentGraph.updateMany({
        where: { id: run.graphId, revision: graph.revision, lifecycle: 'active' },
        data: { revision: { increment: 1 }, updatedAt: now }
      })
      return runProjection(await transaction.agentRun.findUniqueOrThrow({ where: { id: runId } }))
    })
  }

  async finishRun(
    runId: string,
    status: Extract<AgentRunStatus, 'completed' | 'failed' | 'cancelled' | 'blocked'>,
    options: FinishAgentRunOptions = {}
  ): Promise<AgentRunProjection> {
    if (!TERMINAL_RUN_STATUSES.has(status)) throw new Error(`Agent Run cannot finish as ${status}.`)
    const safeFailureCode = assertSafeFailureCode(options.safeFailureCode)
    const observedUsage = validateAgentObservedUsage(options.observedUsage)
    const client = await this.getClient()
    const now = this.now()
    return client.$transaction(async (transaction) => {
      const run = await transaction.agentRun.findUnique({ where: { id: runId } })
      if (!run) throw new Error(`Unknown Agent Run: ${runId}`)
      if (!run.graphId) throw new Error('Legacy M1 Agent Runs are read-only.')
      if (run.status === status && run.finishedAt) return runProjection(run)
      if (
        run.status === 'completed' ||
        run.status === 'failed' ||
        run.status === 'cancelled' ||
        run.status === 'blocked'
      ) {
        throw new Error(`Agent Run ${runId} is already terminal.`)
      }
      if (options.expectedRevision !== undefined && run.revision !== options.expectedRevision) {
        throw new Error(`Agent Run ${runId} revision changed before completion.`)
      }
      const changed = await transaction.agentRun.updateMany({
        where: {
          id: runId,
          finishedAt: null,
          revision: options.expectedRevision ?? run.revision
        },
        data: {
          status,
          finishedAt: now,
          cancelledAt: status === 'cancelled' ? now : undefined,
          failureCode: safeFailureCode,
          observedBudgetJson: JSON.stringify(observedUsage),
          outputArtifactIdsJson: safeOutputArtifactIds(options.outputArtifactIds),
          updatedAt: now,
          revision: { increment: 1 }
        }
      })
      if (changed.count !== 1) {
        const raced = await transaction.agentRun.findUnique({ where: { id: runId } })
        if (raced?.status === status && raced.finishedAt) return runProjection(raced)
        throw new Error(`Agent Run ${runId} changed before completion.`)
      }
      const finished = await transaction.agentRun.findUniqueOrThrow({ where: { id: runId } })
      await this.reconcileGraphAfterRun(transaction, finished.graphId!, now)
      return runProjection(finished)
    })
  }

  private async reconcileGraphAfterRun(
    transaction: Prisma.TransactionClient,
    graphId: string,
    now: Date
  ): Promise<void> {
    const activeCount = await transaction.agentRun.count({
      where: { graphId, status: { in: ['queued', 'running'] } }
    })
    if (activeCount > 0) return
    const runs = await transaction.agentRun.findMany({
      where: { graphId },
      select: { status: true, runKind: true, parentAgentRunId: true }
    })
    const root = runs.find(
      ({ runKind, parentAgentRunId }) => runKind === 'root' && !parentAgentRunId
    )
    if (!root) throw new Error(`Agent Graph ${graphId} has no root Agent Run.`)
    // Child outcomes remain visible on their own runs/cards but cannot rewrite the root task's
    // terminal result. This matters when a completed idle root is temporarily reopened solely to
    // admit a side question: a failed child must not turn the successful parent graph into failed.
    const lifecycle: AgentGraphLifecycle =
      root.status === 'blocked'
        ? 'blocked'
        : root.status === 'failed'
          ? 'failed'
          : root.status === 'cancelled'
            ? 'cancelled'
            : 'completed'
    await transaction.agentGraph.updateMany({
      where: { id: graphId, lifecycle: { notIn: ['completed', 'failed', 'cancelled', 'blocked'] } },
      data: { lifecycle, updatedAt: now, revision: { increment: 1 } }
    })
  }

  async requestCancellation(
    graphId: string,
    reason: 'user' | 'parent' | 'shutdown' | 'budget' | 'recovery'
  ): Promise<AgentGraphProjection> {
    const client = await this.getClient()
    const now = this.now()
    return client.$transaction(async (transaction) => {
      const graph = await transaction.agentGraph.findUnique({ where: { id: graphId } })
      if (!graph) throw new Error(`Unknown Agent Graph: ${graphId}`)
      if (AGENT_GRAPH_TERMINAL_LIFECYCLES.has(graph.lifecycle as AgentGraphLifecycle)) {
        return graphProjection(graph)
      }
      if (graph.lifecycle === 'cancelling') return graphProjection(graph)
      await transaction.agentRun.updateMany({
        where: { graphId, status: { in: ['queued', 'running'] }, cancelRequestedAt: null },
        data: { cancelRequestedAt: now, updatedAt: now, revision: { increment: 1 } }
      })
      const updated = await transaction.agentGraph.updateMany({
        where: {
          id: graphId,
          revision: graph.revision,
          lifecycle: { in: ['active', 'cancelling'] }
        },
        data: {
          lifecycle: 'cancelling',
          cancellationGeneration: { increment: 1 },
          cancelRequestedAt: now,
          cancellationReason: reason,
          updatedAt: now,
          revision: { increment: 1 }
        }
      })
      if (updated.count !== 1)
        throw new Error(`Agent Graph ${graphId} changed before cancellation.`)
      return graphProjection(
        await transaction.agentGraph.findUniqueOrThrow({ where: { id: graphId } })
      )
    })
  }

  async getGraphProjection(graphId: string): Promise<AgentGraphProjection> {
    const graph = await (await this.getClient()).agentGraph.findUnique({ where: { id: graphId } })
    if (!graph) throw new Error(`Unknown Agent Graph: ${graphId}`)
    return graphProjection(graph)
  }

  async getRunProjection(runId: string): Promise<AgentRunProjection> {
    const run = await (await this.getClient()).agentRun.findUnique({ where: { id: runId } })
    if (!run) throw new Error(`Unknown Agent Run: ${runId}`)
    return runProjection(run)
  }

  async listRunProjections(graphId: string): Promise<readonly AgentRunProjection[]> {
    const runs = await (
      await this.getClient()
    ).agentRun.findMany({
      where: { graphId },
      orderBy: { createdAt: 'asc' }
    })
    return Object.freeze(runs.map(runProjection))
  }

  async listSessionSideQuestionRuns(
    projectId: string,
    sessionId: string
  ): Promise<readonly AgentRunProjection[]> {
    const runs = await (
      await this.getClient()
    ).agentRun.findMany({
      where: { projectId, sessionId, runKind: 'side-question' },
      orderBy: { createdAt: 'asc' }
    })
    return Object.freeze(runs.map(runProjection))
  }
}

export { AgentGraphOwner }
