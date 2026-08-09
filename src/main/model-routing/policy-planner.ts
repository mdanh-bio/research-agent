import type {
  DataBoundary,
  ModelCapability,
  ModelRoutePolicy,
  ModelRoutePolicyCollection,
  ModelTarget,
  RejectedModelTarget,
  RouteBudget,
  RouteDecision,
  RoutePolicySource,
  WorkClass
} from '../../shared/model-routing'

export const MAX_AUTOMATIC_ALTERNATES = 2

export type RoutePolicyLayers = Readonly<{
  sessionOrAgentPin?: ModelRoutePolicy
  projectPolicies?: ModelRoutePolicyCollection
  userPolicies?: ModelRoutePolicyCollection
  shippedDefaults: ModelRoutePolicyCollection
}>

export type RouteRequest = Readonly<{
  workClass: WorkClass
  requiredCapabilities?: readonly ModelCapability[]
  dataBoundary?: DataBoundary
  excludedTargetIds?: readonly string[]
}>

type SelectedPolicy = Readonly<{
  policy: ModelRoutePolicy
  source: RoutePolicySource
}>

const DATA_BOUNDARY_RANK: Readonly<Record<DataBoundary, number>> = {
  local_only: 0,
  approved_cloud: 1,
  any_configured: 2
}

const stricterBoundary = (left: DataBoundary, right: DataBoundary): DataBoundary =>
  DATA_BOUNDARY_RANK[left] <= DATA_BOUNDARY_RANK[right] ? left : right

const selectPolicy = (workClass: WorkClass, layers: RoutePolicyLayers): SelectedPolicy => {
  if (layers.sessionOrAgentPin) {
    if (layers.sessionOrAgentPin.workClass !== workClass) {
      throw new Error(
        `Pinned routing policy ${layers.sessionOrAgentPin.id} is for ${layers.sessionOrAgentPin.workClass}, not ${workClass}.`
      )
    }
    return { policy: layers.sessionOrAgentPin, source: 'session_or_agent_pin' }
  }

  const candidates: readonly [ModelRoutePolicy | undefined, RoutePolicySource][] = [
    [layers.projectPolicies?.[workClass], 'project_policy'],
    [layers.userPolicies?.[workClass], 'user_policy'],
    [layers.shippedDefaults[workClass], 'shipped_default']
  ]
  const selected = candidates.find(([policy]) => policy !== undefined)
  if (!selected?.[0]) throw new Error(`No routing policy is configured for ${workClass}.`)
  if (selected[0].workClass !== workClass) {
    throw new Error(
      `Routing policy ${selected[0].id} is stored under ${workClass} but declares ${selected[0].workClass}.`
    )
  }
  return { policy: selected[0], source: selected[1] }
}

const uniqueCapabilities = (
  policyCapabilities: readonly ModelCapability[],
  requestCapabilities: readonly ModelCapability[]
): ModelCapability[] => [...new Set([...policyCapabilities, ...requestCapabilities])]

const immutableTargetSnapshot = (target: ModelTarget): ModelTarget =>
  Object.freeze({ ...target, capabilities: Object.freeze([...target.capabilities]) })

const immutableBudgetSnapshot = (budget: RouteBudget | undefined): RouteBudget | undefined => {
  if (!budget) return undefined
  const integerFields = [
    ['maxInputTokens', budget.maxInputTokens],
    ['maxOutputTokens', budget.maxOutputTokens],
    ['maxLatencyMs', budget.maxLatencyMs]
  ] as const
  for (const [label, value] of integerFields) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`Routing budget ${label} must be a non-negative safe integer.`)
    }
  }
  if (
    budget.maxCostUsd !== undefined &&
    (!Number.isFinite(budget.maxCostUsd) || budget.maxCostUsd < 0)
  ) {
    throw new Error('Routing budget maxCostUsd must be a non-negative finite number.')
  }
  return Object.freeze({ ...budget })
}

const rejection = (
  target: ModelRoutePolicy['primary'],
  reason: RejectedModelTarget['reason'],
  detail: string
): RejectedModelTarget => Object.freeze({ target: immutableTargetSnapshot(target), reason, detail })

export class NoEligibleModelRouteError extends Error {
  readonly workClass: WorkClass
  readonly policyId: string
  readonly rejections: readonly RejectedModelTarget[]

  constructor(workClass: WorkClass, policyId: string, rejections: readonly RejectedModelTarget[]) {
    super(`No eligible model route remains for ${workClass} under policy ${policyId}.`)
    this.name = 'NoEligibleModelRouteError'
    this.workClass = workClass
    this.policyId = policyId
    this.rejections = rejections
  }
}

// Pure and order-preserving: precedence and the policy's primary/fallback order are the only inputs
// that can affect the result. Provider availability is represented explicitly through excluded ids.
export const resolveRouteDecision = (
  request: RouteRequest,
  layers: RoutePolicyLayers
): RouteDecision => {
  const { policy, source } = selectPolicy(request.workClass, layers)
  const requiredCapabilities = uniqueCapabilities(
    policy.requiredCapabilities,
    request.requiredCapabilities ?? []
  )
  const dataBoundary = request.dataBoundary
    ? stricterBoundary(policy.dataBoundary, request.dataBoundary)
    : policy.dataBoundary
  const excluded = new Set(request.excludedTargetIds ?? [])
  const seen = new Set<string>()
  const eligible: ModelRoutePolicy['primary'][] = []
  const rejections: RejectedModelTarget[] = []

  for (const target of [policy.primary, ...policy.fallbacks]) {
    if (seen.has(target.id)) {
      rejections.push(
        rejection(target, 'duplicate_target', `Target id ${target.id} appears more than once.`)
      )
      continue
    }
    seen.add(target.id)

    if (excluded.has(target.id)) {
      rejections.push(rejection(target, 'excluded', `Target ${target.id} is unavailable.`))
      continue
    }

    const missingCapabilities = requiredCapabilities.filter(
      (capability) => !target.capabilities.includes(capability)
    )
    if (missingCapabilities.length > 0) {
      rejections.push(
        rejection(
          target,
          'missing_capability',
          `Target ${target.id} lacks: ${missingCapabilities.join(', ')}.`
        )
      )
      continue
    }

    if (DATA_BOUNDARY_RANK[target.dataBoundary] > DATA_BOUNDARY_RANK[dataBoundary]) {
      rejections.push(
        rejection(
          target,
          'data_boundary',
          `Target ${target.id} requires ${target.dataBoundary}; route permits ${dataBoundary}.`
        )
      )
      continue
    }

    if (eligible.length > MAX_AUTOMATIC_ALTERNATES) {
      rejections.push(
        rejection(
          target,
          'alternate_limit',
          `Only ${MAX_AUTOMATIC_ALTERNATES} automatic alternates may be retained.`
        )
      )
      continue
    }
    eligible.push(immutableTargetSnapshot(target))
  }

  const target = eligible[0]
  if (!target) {
    throw new NoEligibleModelRouteError(request.workClass, policy.id, Object.freeze(rejections))
  }

  return Object.freeze({
    workClass: request.workClass,
    policyId: policy.id,
    policyVersion: policy.version,
    policySource: source,
    target,
    eligibleAlternates: Object.freeze(eligible.slice(1, MAX_AUTOMATIC_ALTERNATES + 1)),
    requiredCapabilities: Object.freeze(requiredCapabilities),
    dataBoundary,
    budget: immutableBudgetSnapshot(policy.budget),
    selectionReason: `Selected the first eligible target from ${source}.`,
    rejectedAlternatives: Object.freeze(rejections)
  })
}
