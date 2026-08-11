import type {
  AgentRunStatus,
  ModelFailureCategory,
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
import type { ConfiguredRouteResolution } from './configured-policy'

export type RoutedRunInput = Readonly<{
  projectId: string
  sessionId: string
  promptMessageId?: string
  workClass: WorkClass
  // Deferred so the behavior-preserving routing-off path does not hash prompt or attachment data.
  request: RequestIdentityInput | (() => RequestIdentityInput)
  role?: string
  sessionOrAgentPin?: ModelRoutePolicy
}>

export type RoutedDispatchContext =
  | Readonly<{ kind: 'legacy' }>
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

type RoutedRunResolver = (
  workClass: WorkClass,
  options: Readonly<{
    projectId: string
    sessionOrAgentPin?: ModelRoutePolicy
    excludedTargetIds?: readonly string[]
  }>
) => Promise<ConfiguredRouteResolution | undefined>

type ActiveAttempt = {
  attemptId: string
  promptMessageId?: string
  sideEffectsStarted: boolean
  activated: boolean
  providerStartedAt?: number
  sideEffectWrite?: Promise<void>
  sideEffectError?: unknown
}

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
  if (error instanceof SyntaxError) return Object.freeze({ category: 'malformed_response' })
  if (!isRecord(error)) return Object.freeze({})
  const explicit = isRecord(error.routingFailureEvidence) ? error.routingFailureEvidence : undefined
  const data = isRecord(error.data) ? error.data : undefined
  const nested = data && isRecord(data.error) ? data.error : undefined
  const rawCategory = stringCode(explicit?.category ?? data?.failureCategory)
  const category =
    rawCategory && FAILURE_CATEGORIES.has(rawCategory as ModelFailureCategory)
      ? (rawCategory as ModelFailureCategory)
      : undefined
  const httpStatus =
    finiteStatus(explicit?.httpStatus) ??
    finiteStatus(error.status) ??
    finiteStatus(data?.httpStatus) ??
    finiteStatus(data?.status) ??
    finiteStatus(nested?.status)
  const code =
    stringCode(explicit?.code) ??
    stringCode(error.code) ??
    stringCode(data?.code) ??
    stringCode(nested?.code) ??
    (error.name === 'TimeoutError' ? 'timeout' : undefined)
  return Object.freeze({
    ...(category ? { category } : {}),
    ...(httpStatus ? { httpStatus } : {}),
    ...(code ? { code } : {})
  })
}

const attemptKey = (sessionId: string): string => sessionId

// Owns one routed prompt's resolution, immutable snapshot, attempt lifecycle, and bounded fallback.
// The caller owns the actual provider dispatch and applies each concrete target before invoking it.
export class RoutedRunOrchestrator {
  private readonly activeAttempts = new Map<string, ActiveAttempt>()

  constructor(
    private readonly resolveRoute: RoutedRunResolver,
    private readonly ledger: ModelRoutingLedger,
    private readonly now: () => number = Date.now
  ) {}

  async execute<Value>(
    input: RoutedRunInput,
    dispatch: (context: RoutedDispatchContext) => Promise<RoutedDispatchResult<Value>>
  ): Promise<Value> {
    const initial = await this.resolveRoute(input.workClass, {
      projectId: input.projectId,
      sessionOrAgentPin: input.sessionOrAgentPin
    })
    if (!initial) return (await dispatch(Object.freeze({ kind: 'legacy' }))).value

    const request = typeof input.request === 'function' ? input.request() : input.request
    const requestIdentity = computeRequestIdentity(request)
    const run = await this.ledger.beginAgentRun({
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
    const finalizeRun = async (status: AgentRunStatus): Promise<void> => {
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
        this.activeAttempts.set(attemptKey(input.sessionId), active)
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
            const failure = evaluateAutomaticFallback({
              failure: evidence,
              routeDecision: initial.decision,
              attempts: [...attempts, attempt]
            })
            const latencyMs = Math.max(0, this.now() - (active.providerStartedAt ?? reservedAt))
            if (active.activated) {
              await this.ledger.finishModelAttempt(attemptId, {
                result: 'failure',
                failureCategory: failure.failure.category,
                latencyMs
              })
            } else {
              await this.ledger.finishReservedModelAttempt(attemptId, {
                result: 'failure',
                failureCategory: failure.failure.category,
                latencyMs
              })
            }
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
            const rerouted = await this.resolveRoute(input.workClass, {
              projectId: input.projectId,
              sessionOrAgentPin: input.sessionOrAgentPin,
              excludedTargetIds: Object.freeze([...excludedTargetIds])
            })
            if (!rerouted || !modelTargetsEqual(rerouted.decision.target, failure.nextTarget)) {
              throw new Error(
                'Re-resolved fallback target does not match the persisted route order.',
                { cause: error }
              )
            }
            trigger = failure.failure.category
            target = rerouted.decision.target
            continue
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
          if (this.activeAttempts.get(attemptKey(input.sessionId)) === active) {
            this.activeAttempts.delete(attemptKey(input.sessionId))
          }
        }
      }
    } catch (error) {
      if (!runFinalized) await finalizeRun('failed')
      throw error
    }
  }

  markSideEffectsStarted(sessionId: string, promptMessageId?: string): void {
    const active = this.activeAttempts.get(attemptKey(sessionId))
    if (!active?.activated || active.sideEffectsStarted) return
    if (promptMessageId && active.promptMessageId && promptMessageId !== active.promptMessageId)
      return
    active.sideEffectsStarted = true
    active.sideEffectWrite = this.ledger.markSideEffectsStarted(active.attemptId).then(
      () => undefined,
      (error) => {
        active.sideEffectError = error
      }
    )
  }

  private async assertSideEffectWrite(active: ActiveAttempt): Promise<void> {
    await active.sideEffectWrite
    if (active.sideEffectError) throw active.sideEffectError
  }

  private async finishRun(agentRunId: string, status: AgentRunStatus): Promise<void> {
    await this.ledger.finishAgentRun(agentRunId, status)
  }
}
