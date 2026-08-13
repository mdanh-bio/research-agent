import type {
  AgentRunStatus,
  DataBoundary,
  ModelFailureCategory,
  ModelCapability,
  ModelRoutePolicy,
  ModelTarget,
  WorkClass
} from '../../shared/model-routing'
import {
  computeRequestIdentity,
  evaluateAutomaticFallback,
  type ModelFailureEvidence,
  type PersistedFallbackAttempt,
  type RequestIdentityInput
} from './fallback-policy'
import { ModelRoutingLedger } from './ledger'
import { modelTargetsEqual } from '../../shared/model-routing'
import type { ConfiguredRouteResolution, ConfiguredRoutingContext } from './configured-policy'
import type { AgentGraphOwner } from '../agent-graph/owner'

export type PreparedRoutedRequestIdentity = RequestIdentityInput &
  Readonly<{
    requiredCapabilities?: readonly ModelCapability[]
    dataBoundary?: DataBoundary
  }>

export type RoutedRunInput = Readonly<{
  projectId: string
  sessionId: string
  promptMessageId?: string
  workClass: WorkClass
  // Deferred so the behavior-preserving routing-off path does not hash prompt or attachment data.
  request:
    | PreparedRoutedRequestIdentity
    | (() => PreparedRoutedRequestIdentity | Promise<PreparedRoutedRequestIdentity>)
  requiredCapabilities?: readonly ModelCapability[]
  dataBoundary?: DataBoundary
  role?: string
  sessionOrAgentPin?: ModelRoutePolicy
  // Routing-off roots use the exact configured target without evaluating request content.
  directTarget?: ModelTarget | (() => ModelTarget | Promise<ModelTarget>)
}>

export type RoutedDispatchContext =
  | Readonly<{ kind: 'legacy'; agentRunId?: string }>
  | Readonly<{
      kind: 'routed'
      target: ModelTarget
      attemptId: string
      sequence: number
      fallback: boolean
      activate: () => Promise<void>
    }>

export type RoutedDispatchResult<Value> = Readonly<{
  value: Value
  cancelled?: boolean
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}>

type RoutedRunResolver = Readonly<{
  capture: (
    options: Readonly<{
      projectId: string
      sessionOrAgentPin?: ModelRoutePolicy
    }>
  ) => Promise<ConfiguredRoutingContext | undefined>
  resolve: (
    context: ConfiguredRoutingContext,
    request: Readonly<{
      workClass: WorkClass
      requiredCapabilities?: readonly ModelCapability[]
      dataBoundary?: DataBoundary
      excludedTargetIds?: readonly string[]
    }>
  ) => Promise<ConfiguredRouteResolution>
}>

type ActiveAttempt = {
  attemptId: string
  promptMessageId?: string
  sideEffectsStarted: boolean
  activated: boolean
  providerStartedAt?: number
  sideEffectWrite?: Promise<void>
  sideEffectError?: unknown
}

type AgentRunOwner = Pick<
  AgentGraphOwner,
  'createRoutedRoot' | 'createConfiguredDirectRoot' | 'finishRun'
>

export class RoutingRecoveryHandoffRequiredError extends Error {
  constructor(
    readonly category: ModelFailureCategory,
    options: ErrorOptions
  ) {
    super(
      'Automatic routing fallback stopped after a tool call; review the partial run before retrying.',
      options
    )
    this.name = 'RoutingRecoveryHandoffRequiredError'
  }
}

export class RoutingUserReviewRequiredError extends Error {
  constructor(
    readonly category: ModelFailureCategory,
    options: ErrorOptions
  ) {
    super(
      'The routed provider result requires user review before another model may be tried.',
      options
    )
    this.name = 'RoutingUserReviewRequiredError'
  }
}

export class RoutedTargetUnavailableError extends Error {
  readonly routingFailureEvidence: ModelFailureEvidence = Object.freeze({
    category: 'provider_unavailable'
  })

  constructor(message: string) {
    super(message)
    this.name = 'RoutedTargetUnavailableError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const finiteStatus = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined

const stringCode = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= 128 ? value : undefined

const providerErrorKind = (value: unknown): boolean =>
  typeof value === 'string' &&
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '-') === 'provider-error'

const balancedJson = (value: string): Record<string, unknown> | undefined => {
  const start = value.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}' && --depth === 0) {
      try {
        const parsed: unknown = JSON.parse(value.slice(start, index + 1))
        return isRecord(parsed) ? parsed : undefined
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

const FAILURE_CATEGORIES = new Set<ModelFailureCategory>([
  'timeout',
  'rate_limit',
  'provider_unavailable',
  'malformed_response',
  'benign_research_refusal',
  'ambiguous_safety',
  'authentication',
  'invalid_request',
  'context_overflow',
  'unknown'
])

// Provider bridges attach structured status/code data. Never infer a safety or refusal category from
// provider prose; benign-refusal fallback therefore remains impossible without an audited category.
export const routingFailureEvidenceFromError = (error: unknown): ModelFailureEvidence => {
  if (!isRecord(error)) return Object.freeze({})
  const explicit = isRecord(error.routingFailureEvidence) ? error.routingFailureEvidence : undefined
  const data = isRecord(error.data) ? error.data : undefined
  const providerOrigin =
    Boolean(explicit) || data?.errorName === 'APIError' || providerErrorKind(data?.errorKind)
  if (!providerOrigin) return Object.freeze({})
  const messagePayload =
    !explicit &&
    typeof error.message === 'string' &&
    (data?.errorName === 'APIError' || providerErrorKind(data?.errorKind))
      ? balancedJson(error.message)
      : undefined
  const nested =
    (data && isRecord(data.error) ? data.error : undefined) ??
    (messagePayload && isRecord(messagePayload.error) ? messagePayload.error : undefined)
  const rawCategory = stringCode(explicit?.category ?? data?.failureCategory ?? data?.errorKind)
  const category =
    rawCategory && FAILURE_CATEGORIES.has(rawCategory as ModelFailureCategory)
      ? (rawCategory as ModelFailureCategory)
      : undefined
  const httpStatus =
    finiteStatus(explicit?.httpStatus) ??
    finiteStatus(data?.status) ??
    finiteStatus(data?.httpStatus) ??
    finiteStatus(nested?.status) ??
    finiteStatus(messagePayload?.status) ??
    finiteStatus(error.status)
  const code =
    stringCode(explicit?.code) ??
    stringCode(data?.code) ??
    stringCode(nested?.code) ??
    stringCode(messagePayload?.code) ??
    stringCode(error.code) ??
    (error.name === 'TimeoutError' ? 'timeout' : undefined)
  return Object.freeze({
    ...(category ? { category } : {}),
    ...(httpStatus ? { httpStatus } : {}),
    ...(code ? { code } : {})
  })
}

// Owns one routed prompt's resolution, immutable snapshot, attempt lifecycle, and bounded fallback.
// The caller owns the actual provider dispatch and applies each concrete target before invoking it.
export class RoutedRunOrchestrator {
  private readonly activeAttempts = new Map<string, ActiveAttempt>()

  constructor(
    private readonly resolver: RoutedRunResolver,
    private readonly ledger: ModelRoutingLedger,
    private readonly now: () => number = Date.now,
    private readonly runOwner?: AgentRunOwner
  ) {}

  async execute<Value>(
    input: RoutedRunInput,
    dispatch: (context: RoutedDispatchContext) => Promise<RoutedDispatchResult<Value>>
  ): Promise<Value> {
    const routingContext = await this.resolver.capture({
      projectId: input.projectId,
      sessionOrAgentPin: input.sessionOrAgentPin
    })
    if (!routingContext) {
      if (!this.runOwner || input.directTarget === undefined) {
        return (await dispatch(Object.freeze({ kind: 'legacy' }))).value
      }
      const target =
        typeof input.directTarget === 'function' ? await input.directTarget() : input.directTarget
      const root = await this.runOwner.createConfiguredDirectRoot({
        projectId: input.projectId,
        sessionId: input.sessionId,
        promptMessageId: input.promptMessageId ?? `prompt-${this.now()}`,
        workClass: input.workClass,
        role: input.role,
        target,
        budget: undefined,
        status: 'running'
      })
      try {
        const result = await dispatch(
          Object.freeze({ kind: 'legacy', agentRunId: root.agentRunId })
        )
        await this.runOwner.finishRun(root.agentRunId, result.cancelled ? 'cancelled' : 'completed')
        return result.value
      } catch (error) {
        await this.runOwner
          .finishRun(root.agentRunId, 'failed', { safeFailureCode: 'provider_failure' })
          .catch(() => undefined)
        throw error
      }
    }

    const request = typeof input.request === 'function' ? await input.request() : input.request
    const requestIdentity = computeRequestIdentity(request)
    const requiredCapabilities = request.requiredCapabilities ?? input.requiredCapabilities
    const dataBoundary = request.dataBoundary ?? input.dataBoundary
    const initial = await this.resolver.resolve(routingContext, {
      workClass: input.workClass,
      ...(requiredCapabilities ? { requiredCapabilities } : {}),
      ...(dataBoundary ? { dataBoundary } : {})
    })
    const run = this.runOwner
      ? await this.runOwner.createRoutedRoot({
          projectId: input.projectId,
          sessionId: input.sessionId,
          promptMessageId: input.promptMessageId ?? `prompt-${this.now()}`,
          role: input.role ?? 'main-agent',
          workClass: input.workClass,
          target: initial.decision.target,
          routeDecision: initial.decision,
          effectivePolicy: initial.effectivePolicy,
          status: 'running'
        })
      : await this.ledger.beginAgentRun({
          projectId: input.projectId,
          sessionId: input.sessionId,
          promptMessageId: input.promptMessageId,
          role: input.role ?? 'main-agent',
          routeDecision: initial.decision,
          effectivePolicy: initial.effectivePolicy,
          status: 'running'
        })
    const attempts: PersistedFallbackAttempt[] = []
    const excludedTargetIds: string[] = []
    let target = initial.decision.target
    let trigger: ModelFailureCategory | 'initial' = 'initial'
    let runFinalized = false
    const finalizeRun = async (
      status: Extract<AgentRunStatus, 'completed' | 'failed' | 'cancelled' | 'blocked'>
    ): Promise<void> => {
      await this.finishRun(run.agentRunId, status)
      runFinalized = true
    }

    try {
      for (let sequence = 0; ; sequence += 1) {
        const attemptId = await this.ledger.beginModelAttempt({
          agentRunId: run.agentRunId,
          trigger,
          target,
          request
        })
        const active: ActiveAttempt = {
          attemptId,
          promptMessageId: input.promptMessageId,
          sideEffectsStarted: false,
          activated: false
        }
        this.activeAttempts.set(attemptId, active)
        const reservedAt = this.now()
        const activate = async (): Promise<void> => {
          if (active.activated) return
          await this.ledger.activateModelAttempt(attemptId)
          active.activated = true
          active.providerStartedAt = this.now()
        }
        try {
          let result: RoutedDispatchResult<Value>
          try {
            result = await dispatch(
              Object.freeze({
                kind: 'routed',
                target,
                attemptId,
                sequence,
                fallback: sequence > 0,
                activate
              })
            )
          } catch (error) {
            await this.assertSideEffectWrite(active)
            const evidence = routingFailureEvidenceFromError(error)
            const attempt = Object.freeze({
              id: attemptId,
              sequence,
              target,
              requestIdentity,
              sideEffectsStarted: active.sideEffectsStarted
            })
            const latencyMs = Math.max(0, this.now() - (active.providerStartedAt ?? reservedAt))
            if (active.activated) {
              // Activation occurs immediately before session.prompt().  Once that boundary is
              // crossed, ACP may have accepted or partially processed the request, so replaying on
              // the persistent session cannot prove byte-equivalent provider input.
              const failure = evaluateAutomaticFallback({
                failure: evidence,
                routeDecision: initial.decision,
                attempts: [...attempts, attempt]
              })
              await this.ledger.finishModelAttempt(attemptId, {
                result: 'failure',
                failureCategory: failure.failure.category,
                latencyMs
              })
              attempts.push(attempt)
              if (active.sideEffectsStarted) {
                await finalizeRun('blocked')
                throw new RoutingRecoveryHandoffRequiredError(failure.failure.category, {
                  cause: error
                })
              }
              await finalizeRun('failed')
              throw error
            } else {
              const failure = evaluateAutomaticFallback({
                failure: evidence,
                routeDecision: initial.decision,
                attempts: [...attempts, attempt]
              })
              await this.ledger.finishReservedModelAttempt(attemptId, {
                result: 'failure',
                failureCategory: failure.failure.category,
                latencyMs
              })
              attempts.push(attempt)
              if (failure.action === 'recovery_handoff') {
                await finalizeRun('blocked')
                throw new RoutingRecoveryHandoffRequiredError(failure.failure.category, {
                  cause: error
                })
              }
              if (failure.action === 'user_review') {
                await finalizeRun('blocked')
                throw new RoutingUserReviewRequiredError(failure.failure.category, { cause: error })
              }
              if (failure.action !== 'retry_alternate' || !failure.nextTarget) {
                await finalizeRun('failed')
                throw error
              }
              excludedTargetIds.push(target.id)
              const rerouted = await this.resolver.resolve(routingContext, {
                workClass: input.workClass,
                ...(requiredCapabilities ? { requiredCapabilities } : {}),
                ...(dataBoundary ? { dataBoundary } : {}),
                excludedTargetIds: Object.freeze([...excludedTargetIds])
              })
              if (!modelTargetsEqual(rerouted.decision.target, failure.nextTarget)) {
                throw new Error(
                  'Re-resolved fallback target does not match the captured route order.',
                  { cause: error }
                )
              }
              trigger = failure.failure.category
              target = rerouted.decision.target
              continue
            }
          }

          await this.assertSideEffectWrite(active)
          const latencyMs = Math.max(0, this.now() - (active.providerStartedAt ?? reservedAt))
          if (active.activated) {
            await this.ledger.finishModelAttempt(attemptId, {
              result: result.cancelled ? 'cancelled' : 'success',
              latencyMs,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              costUsd: result.costUsd
            })
          } else if (result.cancelled) {
            await this.ledger.finishReservedModelAttempt(attemptId, {
              result: 'cancelled',
              latencyMs
            })
          } else {
            const error = new Error(
              'A routed provider result arrived before its attempt was activated.'
            )
            await this.ledger.finishReservedModelAttempt(attemptId, {
              result: 'failure',
              failureCategory: 'unknown',
              latencyMs
            })
            await finalizeRun('failed')
            throw error
          }
          await finalizeRun(result.cancelled ? 'cancelled' : 'completed')
          return result.value
        } finally {
          if (this.activeAttempts.get(attemptId) === active) {
            this.activeAttempts.delete(attemptId)
          }
        }
      }
    } catch (error) {
      if (!runFinalized) await finalizeRun('failed')
      throw error
    }
  }

  markSideEffectsStarted(attemptId: string): void {
    const active = this.activeAttempts.get(attemptId)
    if (active?.sideEffectsStarted) return
    if (active) active.sideEffectsStarted = true
    const write = this.ledger.markSideEffectsStarted(attemptId).then(
      () => undefined,
      (error) => {
        if (active) active.sideEffectError = error
      }
    )
    if (active) active.sideEffectWrite = write
  }

  private async assertSideEffectWrite(active: ActiveAttempt): Promise<void> {
    await active.sideEffectWrite
    if (active.sideEffectError) throw active.sideEffectError
  }

  private async finishRun(
    agentRunId: string,
    status: Extract<AgentRunStatus, 'completed' | 'failed' | 'cancelled' | 'blocked'>
  ): Promise<void> {
    if (this.runOwner) {
      await this.runOwner.finishRun(agentRunId, status)
      return
    }
    await this.ledger.finishAgentRun(agentRunId, status)
  }
}
