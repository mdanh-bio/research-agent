import { createHash, randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

import type {
  AgentRunStatus,
  ModelAttemptResult,
  ModelAttemptTrigger,
  ModelFailureCategory,
  ModelRoutePolicy,
  ModelTarget,
  RouteDecision
} from '../../shared/model-routing'
import { modelTargetsEqual } from '../../shared/model-routing'
import {
  assertBenignRefusalApprovalEvidence,
  computeRequestIdentity,
  type BenignRefusalApprovalEvidence,
  type BenignRefusalApprovalExpectation,
  type RequestIdentityInput
} from './fallback-policy'
import { MAX_AUTOMATIC_ALTERNATES } from './policy-planner'

type RoutingLedgerClientProvider = () => Promise<PrismaClient>

type BeginAgentRunInput = Readonly<{
  projectId: string
  sessionId: string
  promptMessageId?: string
  parentAgentRunId?: string
  role: string
  routeDecision: RouteDecision
  effectivePolicy: ModelRoutePolicy
  status?: 'queued' | 'running'
}>

type BeginAgentRunResult = Readonly<{
  policySnapshotId: string
  agentRunId: string
  policyHash: string
}>

type BeginModelAttemptInput = Readonly<{
  agentRunId: string
  trigger: ModelAttemptTrigger
  target: ModelTarget
  request: RequestIdentityInput
  benignRefusalApproval?: BenignRefusalApprovalEvidence
}>

export type SideEffectMarkResult = Readonly<{
  invalidatedFallbackAttemptIds?: readonly string[]
}>

type FinishModelAttemptInput = Readonly<{
  result: Exclude<ModelAttemptResult, 'reserved' | 'running'>
  failureCategory?: ModelFailureCategory
  latencyMs?: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}>

type LinkRuntimeThreadInput = Readonly<{
  agentRunId: string
  appSessionId: string
  backend: ModelTarget['backend']
  runtimeThreadId: string
  parentRuntimeThreadId?: string
  ephemeral: boolean
}>

type RoutingLedgerOptions = Readonly<{
  idFactory?: () => string
  now?: () => Date
  verifyBenignRefusalApproval?: (
    approval: BenignRefusalApprovalEvidence,
    expected: BenignRefusalApprovalExpectation
  ) => boolean | Promise<boolean>
}>

type RoutingSnapshotDocument = Readonly<{
  schemaVersion: 2
  policy: ModelRoutePolicy
  decision: Pick<
    RouteDecision,
    | 'workClass'
    | 'policyId'
    | 'policyVersion'
    | 'policySource'
    | 'target'
    | 'eligibleAlternates'
    | 'requiredCapabilities'
    | 'dataBoundary'
    | 'budget'
    | 'selectionReason'
    | 'rejectedAlternatives'
  >
}>

const TERMINAL_RUN_STATUSES = new Set<AgentRunStatus>([
  'completed',
  'failed',
  'cancelled',
  'blocked'
])
const AUTOMATIC_FALLBACK_TRIGGERS = new Set<ModelFailureCategory>([
  'timeout',
  'rate_limit',
  'provider_unavailable',
  'malformed_response',
  'benign_research_refusal'
])

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  )
}

export const canonicalRoutingPolicyJson = (policy: ModelRoutePolicy): string =>
  JSON.stringify(canonicalize(policy))

export const canonicalRoutingSnapshotJson = (
  policy: ModelRoutePolicy,
  decision: RouteDecision
): string =>
  JSON.stringify(
    canonicalize({
      schemaVersion: 2,
      policy,
      decision: {
        workClass: decision.workClass,
        policyId: decision.policyId,
        policyVersion: decision.policyVersion,
        policySource: decision.policySource,
        target: decision.target,
        eligibleAlternates: decision.eligibleAlternates,
        requiredCapabilities: decision.requiredCapabilities,
        dataBoundary: decision.dataBoundary,
        budget: decision.budget,
        selectionReason: decision.selectionReason,
        rejectedAlternatives: decision.rejectedAlternatives
      }
    } satisfies RoutingSnapshotDocument)
  )

export const routingPolicyHash = (policyJson: string): string =>
  `sha256:${createHash('sha256').update(policyJson).digest('hex')}`

const assertNonEmpty = (value: string, label: string): string => {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required.`)
  return normalized
}

const assertNonNegativeInteger = (value: number | undefined, label: string): void => {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`)
  }
}

const assertNonNegativeFinite = (value: number | undefined, label: string): void => {
  if (value === undefined) return
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`)
  }
}

const canonicalValuesEqual = (left: unknown, right: unknown): boolean =>
  JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))

const DATA_BOUNDARY_RANK = {
  local_only: 0,
  approved_cloud: 1,
  any_configured: 2
} as const

const assertDecisionMatchesPolicy = (decision: RouteDecision, policy: ModelRoutePolicy): void => {
  if (
    decision.workClass !== policy.workClass ||
    decision.policyId !== policy.id ||
    decision.policyVersion !== policy.version
  ) {
    throw new Error('The route decision does not match the effective policy snapshot.')
  }
  if (!canonicalValuesEqual(decision.budget, policy.budget)) {
    throw new Error('The route decision budget does not match the effective policy snapshot.')
  }
  if (
    decision.eligibleAlternates.length > MAX_AUTOMATIC_ALTERNATES ||
    !policy.requiredCapabilities.every((capability) =>
      decision.requiredCapabilities.includes(capability)
    ) ||
    DATA_BOUNDARY_RANK[decision.dataBoundary] > DATA_BOUNDARY_RANK[policy.dataBoundary]
  ) {
    throw new Error('The route decision weakens an effective policy constraint.')
  }
  const configuredTargets = [policy.primary, ...policy.fallbacks]
  const routedTargets = [decision.target, ...decision.eligibleAlternates]
  const routedIds = new Set<string>()
  for (const routedTarget of routedTargets) {
    if (routedIds.has(routedTarget.id)) {
      throw new Error('The route decision repeats a selected target id.')
    }
    routedIds.add(routedTarget.id)
    if (
      !decision.requiredCapabilities.every((capability) =>
        routedTarget.capabilities.includes(capability)
      ) ||
      DATA_BOUNDARY_RANK[routedTarget.dataBoundary] > DATA_BOUNDARY_RANK[decision.dataBoundary]
    ) {
      throw new Error('The route decision contains an ineligible selected target.')
    }
  }
  let configuredIndex = -1
  for (const routedTarget of routedTargets) {
    configuredIndex = configuredTargets.findIndex(
      (configuredTarget, index) =>
        index > configuredIndex && modelTargetsEqual(configuredTarget, routedTarget)
    )
    if (configuredIndex < 0) {
      throw new Error(
        'The selected model targets do not exactly match the effective policy in configured order.'
      )
    }
  }

  // Every configured occurrence must be represented exactly once as selected, eligible, or
  // rejected. This catches same-id model/provider substitution and hidden alternate injection.
  const remainingTargets = [...configuredTargets]
  for (const representedTarget of [
    ...routedTargets,
    ...decision.rejectedAlternatives.map(({ target }) => target)
  ]) {
    const index = remainingTargets.findIndex((target) =>
      modelTargetsEqual(target, representedTarget)
    )
    if (index < 0) {
      throw new Error('The route decision contains a target outside the effective policy.')
    }
    remainingTargets.splice(index, 1)
  }
  if (remainingTargets.length > 0) {
    throw new Error('The route decision omits configured policy targets.')
  }
}

const parseRoutingSnapshot = (value: string): RoutingSnapshotDocument => {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('The persisted routing snapshot is not valid JSON.')
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 2 ||
    !(parsed as { policy?: unknown }).policy ||
    !(parsed as { decision?: unknown }).decision
  ) {
    throw new Error('The persisted routing snapshot has an unsupported shape.')
  }
  return parsed as RoutingSnapshotDocument
}

type PersistedTargetProjection = Readonly<{
  backend: string
  providerId: string
  model: string
  reasoningEffort: string
  targetCapabilitiesJson: string
  targetDataBoundary: string
  targetContextWindow: number | null
}>

const persistedTargetMatches = (
  persisted: PersistedTargetProjection,
  expected: ModelTarget
): boolean => {
  let capabilities: unknown
  try {
    capabilities = JSON.parse(persisted.targetCapabilitiesJson)
  } catch {
    return false
  }
  return (
    persisted.backend === expected.backend &&
    persisted.providerId === expected.providerId &&
    persisted.model === expected.model &&
    persisted.reasoningEffort === expected.reasoningEffort &&
    persisted.targetDataBoundary === expected.dataBoundary &&
    (persisted.targetContextWindow ?? undefined) === expected.contextWindow &&
    Array.isArray(capabilities) &&
    capabilities.length === expected.capabilities.length &&
    capabilities.every((capability, index) => capability === expected.capabilities[index])
  )
}

// Owns the append/finalize lifecycle for transparent routing metadata. It stores identifiers and
// ledger-computed request identities only; authoritative prompt/message content remains in Session
// persistence.
export class ModelRoutingLedger {
  private readonly idFactory: () => string
  private readonly now: () => Date
  private readonly verifyBenignRefusalApproval?: RoutingLedgerOptions['verifyBenignRefusalApproval']

  constructor(
    private readonly getClient: RoutingLedgerClientProvider,
    options: RoutingLedgerOptions = {}
  ) {
    this.idFactory = options.idFactory ?? randomUUID
    this.now = options.now ?? (() => new Date())
    this.verifyBenignRefusalApproval = options.verifyBenignRefusalApproval
  }

  async beginAgentRun(input: BeginAgentRunInput): Promise<BeginAgentRunResult> {
    assertDecisionMatchesPolicy(input.routeDecision, input.effectivePolicy)
    const projectId = assertNonEmpty(input.projectId, 'projectId')
    const sessionId = assertNonEmpty(input.sessionId, 'sessionId')
    const role = assertNonEmpty(input.role, 'role')
    const policySnapshotId = this.idFactory()
    const agentRunId = this.idFactory()
    const createdAt = this.now()
    const policyJson = canonicalRoutingSnapshotJson(input.effectivePolicy, input.routeDecision)
    const policyHash = routingPolicyHash(policyJson)
    const status = input.status ?? 'queued'
    const client = await this.getClient()

    await client.$transaction(async (transaction) => {
      await transaction.routingPolicySnapshot.create({
        data: {
          id: policySnapshotId,
          projectId,
          sessionId,
          workClass: input.routeDecision.workClass,
          policyId: input.routeDecision.policyId,
          policyVersion: input.routeDecision.policyVersion,
          policySource: input.routeDecision.policySource,
          policyJson,
          policyHash,
          createdAt
        }
      })
      await transaction.agentRun.create({
        data: {
          id: agentRunId,
          parentAgentRunId: input.parentAgentRunId,
          policySnapshotId,
          projectId,
          sessionId,
          promptMessageId: input.promptMessageId,
          role,
          workClass: input.routeDecision.workClass,
          runtime: input.routeDecision.target.backend,
          status,
          budgetJson: input.routeDecision.budget
            ? JSON.stringify(canonicalize(input.routeDecision.budget))
            : undefined,
          createdAt,
          startedAt: status === 'running' ? createdAt : undefined
        }
      })
    })

    return { policySnapshotId, agentRunId, policyHash }
  }

  // Reserves a ledger slot but does not authorize provider dispatch. Call activateModelAttempt only
  // immediately before dispatch; a late side-effect notification atomically invalidates the slot.
  async beginModelAttempt(input: BeginModelAttemptInput): Promise<string> {
    const requestHash = computeRequestIdentity(input.request)
    const attemptId = this.idFactory()
    const startedAt = this.now()
    const client = await this.getClient()

    await client.$transaction(async (transaction) => {
      const latest = await transaction.modelAttempt.findFirst({
        where: { agentRunId: input.agentRunId },
        orderBy: { sequence: 'desc' },
        select: {
          id: true,
          sequence: true,
          requestHash: true,
          result: true,
          failureCategory: true,
          sideEffectsStarted: true,
          finishedAt: true,
          backend: true,
          providerId: true,
          model: true,
          reasoningEffort: true,
          targetCapabilitiesJson: true,
          targetDataBoundary: true,
          targetContextWindow: true
        }
      })
      const run = await transaction.agentRun.findUnique({
        where: { id: input.agentRunId },
        select: {
          projectId: true,
          sessionId: true,
          policySnapshot: { select: { policyJson: true } },
          finishedAt: true
        }
      })
      if (!run) throw new Error(`Unknown agent run: ${input.agentRunId}`)
      if (run.finishedAt) throw new Error(`Agent run ${input.agentRunId} is already finalized.`)

      const snapshot = parseRoutingSnapshot(run.policySnapshot.policyJson)
      const sequence = (latest?.sequence ?? -1) + 1
      const expectedTarget =
        sequence === 0
          ? snapshot.decision.target
          : snapshot.decision.eligibleAlternates[sequence - 1]
      if (!expectedTarget || !modelTargetsEqual(expectedTarget, input.target)) {
        throw new Error('The model attempt target does not match the persisted route decision.')
      }
      if (sequence === 0 && input.trigger !== 'initial') {
        throw new Error('The first model attempt must use the initial trigger.')
      }
      if (sequence > 0) {
        if (input.trigger === 'initial') {
          throw new Error('An alternate model attempt requires a failure trigger.')
        }
        if (!AUTOMATIC_FALLBACK_TRIGGERS.has(input.trigger)) {
          throw new Error(
            `Failure category ${input.trigger} is not eligible for automatic fallback.`
          )
        }
        if (
          !latest ||
          latest.result !== 'failure' ||
          latest.finishedAt === null ||
          latest.failureCategory !== input.trigger
        ) {
          throw new Error('An alternate attempt must follow its finalized failed attempt.')
        }
        const expectedPreviousTarget =
          sequence === 1
            ? snapshot.decision.target
            : snapshot.decision.eligibleAlternates[sequence - 2]
        if (!expectedPreviousTarget || !persistedTargetMatches(latest, expectedPreviousTarget)) {
          throw new Error('The persisted prior attempt target does not match the route snapshot.')
        }
        const priorSideEffect = await transaction.modelAttempt.findFirst({
          where: {
            agentRunId: input.agentRunId,
            sequence: { lt: sequence },
            sideEffectsStarted: true
          },
          select: { id: true }
        })
        if (priorSideEffect) {
          throw new Error('Automatic fallback is blocked after model side effects begin.')
        }
        if (latest.requestHash !== requestHash) {
          throw new Error('Automatic fallback requires an unchanged request identity.')
        }

        if (input.trigger === 'benign_research_refusal') {
          if (!input.benignRefusalApproval || !this.verifyBenignRefusalApproval) {
            throw new Error(
              'Benign-refusal fallback requires auditable approval evidence and a configured verifier.'
            )
          }
          const expectedApproval: BenignRefusalApprovalExpectation = {
            projectId: run.projectId,
            sessionId: run.sessionId,
            agentRunId: input.agentRunId,
            failedAttemptId: latest.id,
            policyId: snapshot.decision.policyId,
            policyVersion: snapshot.decision.policyVersion,
            requestIdentity: requestHash,
            dataBoundary: snapshot.decision.dataBoundary,
            sourceTarget: expectedPreviousTarget,
            alternateTarget: expectedTarget
          }
          assertBenignRefusalApprovalEvidence(input.benignRefusalApproval, expectedApproval)
          if (
            !(await this.verifyBenignRefusalApproval(input.benignRefusalApproval, expectedApproval))
          ) {
            throw new Error('Benign-refusal approval evidence could not be verified.')
          }
        } else if (input.benignRefusalApproval) {
          throw new Error('Benign-refusal approval evidence is invalid for this failure trigger.')
        }
      } else if (input.benignRefusalApproval) {
        throw new Error(
          'The initial model attempt cannot consume benign-refusal approval evidence.'
        )
      }
      await transaction.modelAttempt.create({
        data: {
          id: attemptId,
          agentRunId: input.agentRunId,
          sequence,
          trigger: input.trigger,
          backend: input.target.backend,
          providerId: input.target.providerId,
          model: input.target.model,
          reasoningEffort: input.target.reasoningEffort,
          targetCapabilitiesJson: JSON.stringify(input.target.capabilities),
          targetDataBoundary: input.target.dataBoundary,
          targetContextWindow: input.target.contextWindow,
          requestHash,
          result: 'reserved',
          fallbackApprovalId: input.benignRefusalApproval?.approvalId,
          fallbackApprovalJson: input.benignRefusalApproval
            ? JSON.stringify(canonicalize(input.benignRefusalApproval))
            : undefined,
          startedAt
        }
      })
    })
    return attemptId
  }

  async activateModelAttempt(attemptId: string): Promise<void> {
    const client = await this.getClient()
    const activated = await client.$transaction(async (transaction) => {
      const attempt = await transaction.modelAttempt.findUnique({
        where: { id: attemptId },
        select: { agentRunId: true, sequence: true, result: true, finishedAt: true }
      })
      if (!attempt) throw new Error(`Unknown model attempt: ${attemptId}`)
      if (attempt.result !== 'reserved' || attempt.finishedAt) {
        throw new Error(`Model attempt ${attemptId} is not an active reservation.`)
      }
      if (attempt.sequence > 0) {
        const priorAttempts = await transaction.modelAttempt.findMany({
          where: {
            agentRunId: attempt.agentRunId,
            sequence: { lt: attempt.sequence }
          },
          select: { sideEffectsStarted: true }
        })
        if (
          priorAttempts.length !== attempt.sequence ||
          priorAttempts.some(({ sideEffectsStarted }) => sideEffectsStarted)
        ) {
          await transaction.modelAttempt.updateMany({
            where: { id: attemptId, result: 'reserved', finishedAt: null },
            data: { result: 'cancelled', finishedAt: this.now() }
          })
          return false
        }
      }
      const changed = await transaction.modelAttempt.updateMany({
        where: { id: attemptId, result: 'reserved', finishedAt: null },
        data: { result: 'running' }
      })
      if (changed.count !== 1) {
        throw new Error(`Model attempt ${attemptId} is not an active reservation.`)
      }
      return true
    })
    if (!activated) {
      throw new Error('Fallback reservation was invalidated by prior model side effects.')
    }
  }

  async markSideEffectsStarted(attemptId: string): Promise<SideEffectMarkResult> {
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      const existing = await transaction.modelAttempt.findUnique({
        where: { id: attemptId },
        select: { agentRunId: true, sequence: true }
      })
      if (!existing) throw new Error(`Unknown model attempt: ${attemptId}`)

      // Deliberately has no finishedAt predicate: effect observation can arrive after a provider
      // failure event. The bit is monotonic and never reset.
      await transaction.modelAttempt.updateMany({
        where: { id: attemptId, sideEffectsStarted: false },
        data: { sideEffectsStarted: true }
      })

      const activeSuccessors = await transaction.modelAttempt.findMany({
        where: {
          agentRunId: existing.agentRunId,
          sequence: { gt: existing.sequence },
          finishedAt: null,
          result: { in: ['reserved', 'running'] }
        },
        orderBy: { sequence: 'asc' },
        select: { id: true }
      })
      if (activeSuccessors.length > 0) {
        const successorIds = activeSuccessors.map(({ id }) => id)
        const invalidated = await transaction.modelAttempt.updateMany({
          where: {
            id: { in: successorIds },
            finishedAt: null,
            result: { in: ['reserved', 'running'] }
          },
          data: { result: 'cancelled', finishedAt: this.now() }
        })
        if (invalidated.count !== successorIds.length) {
          throw new Error('Could not atomically invalidate every later model fallback attempt.')
        }
        if (invalidated.count > 0) {
          return Object.freeze({
            invalidatedFallbackAttemptIds: Object.freeze(successorIds)
          })
        }
      }
      return Object.freeze({})
    })
  }

  async finishModelAttempt(attemptId: string, input: FinishModelAttemptInput): Promise<void> {
    if (input.result === 'failure' && !input.failureCategory) {
      throw new Error('A failed model attempt requires a failure category.')
    }
    if (input.result !== 'failure' && input.failureCategory) {
      throw new Error('Only failed model attempts may record a failure category.')
    }
    assertNonNegativeInteger(input.latencyMs, 'latencyMs')
    assertNonNegativeInteger(input.inputTokens, 'inputTokens')
    assertNonNegativeInteger(input.outputTokens, 'outputTokens')
    assertNonNegativeFinite(input.costUsd, 'costUsd')

    const client = await this.getClient()
    const changed = await client.modelAttempt.updateMany({
      where: { id: attemptId, finishedAt: null, result: 'running' },
      data: {
        result: input.result,
        failureCategory: input.failureCategory,
        latencyMs: input.latencyMs,
        inputTokens: input.inputTokens === undefined ? undefined : BigInt(input.inputTokens),
        outputTokens: input.outputTokens === undefined ? undefined : BigInt(input.outputTokens),
        costUsdMicros:
          input.costUsd === undefined ? undefined : BigInt(Math.round(input.costUsd * 1_000_000)),
        finishedAt: this.now()
      }
    })
    if (changed.count !== 1) {
      const exists = await client.modelAttempt.count({ where: { id: attemptId } })
      throw new Error(
        exists === 0
          ? `Unknown model attempt: ${attemptId}`
          : `Model attempt ${attemptId} is already finalized.`
      )
    }
  }

  async finishAgentRun(agentRunId: string, status: AgentRunStatus): Promise<void> {
    if (!TERMINAL_RUN_STATUSES.has(status)) {
      throw new Error(`Agent run cannot be finalized with non-terminal status ${status}.`)
    }
    const client = await this.getClient()
    const changed = await client.agentRun.updateMany({
      where: { id: agentRunId, finishedAt: null },
      data: { status, finishedAt: this.now() }
    })
    if (changed.count !== 1) {
      const exists = await client.agentRun.count({ where: { id: agentRunId } })
      throw new Error(
        exists === 0
          ? `Unknown agent run: ${agentRunId}`
          : `Agent run ${agentRunId} is already finalized.`
      )
    }
  }

  async linkRuntimeThread(input: LinkRuntimeThreadInput): Promise<string> {
    const id = this.idFactory()
    const client = await this.getClient()
    await client.runtimeThreadLink.create({
      data: {
        id,
        agentRunId: input.agentRunId,
        appSessionId: assertNonEmpty(input.appSessionId, 'appSessionId'),
        backend: input.backend,
        runtimeThreadId: assertNonEmpty(input.runtimeThreadId, 'runtimeThreadId'),
        parentRuntimeThreadId: input.parentRuntimeThreadId,
        ephemeral: input.ephemeral,
        createdAt: this.now()
      }
    })
    return id
  }
}
