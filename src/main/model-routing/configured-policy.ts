import {
  WORK_CLASSES,
  type ModelRoutePolicy,
  type ModelRoutePolicyCollection,
  type ModelTarget,
  type RouteDecision,
  type WorkClass
} from '../../shared/model-routing'
import {
  DEFAULT_ROUTING_SETTINGS,
  type EffectiveRouteView,
  type RoutingPolicyOverride,
  type RoutingPolicyOverrides,
  type RoutingSettings,
  type RoutingSettingsView
} from '../../shared/routing-settings'
import type { SettingsSnapshot } from '../../shared/settings'
import { createConfiguredRoutingCatalog } from './configured-catalog'
import { createDefaultRoutingProfiles, type RoutingProfile } from './default-profiles'
import { resolveRouteDecision, type RoutePolicyLayers, type RouteRequest } from './policy-planner'
import { assertSecretFreeRoutingValue } from './secret-safety'

export type ConfiguredRouteResolution = Readonly<{
  profile: RoutingProfile
  decision: RouteDecision
  effectivePolicy: ModelRoutePolicy
  layers: RoutePolicyLayers
}>

type ConfiguredPolicyInput = Readonly<{
  settings: Pick<
    SettingsSnapshot,
    'activeModel' | 'activeProviderId' | 'agentFrameworkId' | 'agentFrameworks' | 'providers'
  >
  routing?: RoutingSettings
  projectId?: string
  sessionOrAgentPin?: ModelRoutePolicy
}>

const materializeOverride = (
  profile: RoutingProfile,
  workClass: WorkClass,
  override: RoutingPolicyOverride,
  targets: ReadonlyMap<string, ModelTarget>,
  scope: 'user' | 'project'
): ModelRoutePolicy => {
  const inherited = profile.policies[workClass]
  const resolveTarget = (id: string): ModelTarget => {
    const target = targets.get(id)
    if (!target) throw new Error(`Routing ${scope} override references unavailable target ${id}.`)
    return target
  }
  const primary = resolveTarget(override.primaryTargetId)
  const fallbacks = (override.fallbackTargetIds ?? []).map(resolveTarget)
  const policy: ModelRoutePolicy = Object.freeze({
    id: `${scope}-override.${workClass}`,
    version: '1',
    workClass,
    primary,
    fallbacks: Object.freeze(fallbacks),
    requiredCapabilities: Object.freeze(
      override.requiredCapabilities
        ? [...override.requiredCapabilities]
        : [...inherited.requiredCapabilities]
    ),
    dataBoundary: override.dataBoundary ?? inherited.dataBoundary,
    ...((override.budget ?? inherited.budget)
      ? { budget: Object.freeze({ ...(override.budget ?? inherited.budget) }) }
      : {})
  })
  assertSecretFreeRoutingValue(policy)
  return policy
}

const materializeOverrides = (
  profile: RoutingProfile,
  overrides: RoutingPolicyOverrides | undefined,
  targets: ReadonlyMap<string, ModelTarget>,
  scope: 'user' | 'project'
): ModelRoutePolicyCollection | undefined => {
  if (!overrides) return undefined
  const policies: Partial<Record<WorkClass, ModelRoutePolicy>> = {}
  for (const workClass of WORK_CLASSES) {
    const override = overrides[workClass]
    if (override)
      policies[workClass] = materializeOverride(profile, workClass, override, targets, scope)
  }
  return Object.keys(policies).length > 0 ? Object.freeze(policies) : undefined
}

const configuredLayers = (
  input: ConfiguredPolicyInput
): Readonly<{ profile: RoutingProfile; layers: RoutePolicyLayers }> => {
  const routing = input.routing ?? DEFAULT_ROUTING_SETTINGS
  if (routing.profile === 'off') throw new Error('Transparent routing is off.')
  const catalog = createConfiguredRoutingCatalog({
    frameworkId: input.settings.agentFrameworkId,
    frameworks: input.settings.agentFrameworks,
    providers: input.settings.providers,
    activeProviderId: input.settings.activeProviderId,
    activeModel: input.settings.activeModel
  })
  const profile = createDefaultRoutingProfiles(catalog.tiers).find(
    (candidate) => candidate.id === routing.profile
  )
  if (!profile) throw new Error(`Unknown routing profile: ${routing.profile}.`)
  const targets = new Map(catalog.targets.map((target) => [target.id, target] as const))
  const projectOverrides =
    input.projectId &&
    routing.projectOverrides &&
    Object.hasOwn(routing.projectOverrides, input.projectId)
      ? routing.projectOverrides[input.projectId]
      : undefined
  return Object.freeze({
    profile,
    layers: Object.freeze({
      ...(input.sessionOrAgentPin ? { sessionOrAgentPin: input.sessionOrAgentPin } : {}),
      projectPolicies: materializeOverrides(profile, projectOverrides, targets, 'project'),
      userPolicies: materializeOverrides(profile, routing.userOverrides, targets, 'user'),
      shippedDefaults: profile.policies
    })
  })
}

const effectivePolicyFor = (
  decision: RouteDecision,
  layers: RoutePolicyLayers
): ModelRoutePolicy => {
  const policy =
    decision.policySource === 'session_or_agent_pin'
      ? layers.sessionOrAgentPin
      : decision.policySource === 'project_policy'
        ? layers.projectPolicies?.[decision.workClass]
        : decision.policySource === 'user_policy'
          ? layers.userPolicies?.[decision.workClass]
          : layers.shippedDefaults[decision.workClass]
  if (!policy) throw new Error(`The effective ${decision.policySource} routing policy is missing.`)
  return policy
}

export const resolveConfiguredRoute = (
  request: RouteRequest,
  input: ConfiguredPolicyInput
): ConfiguredRouteResolution => {
  const { profile, layers } = configuredLayers(input)
  const decision = resolveRouteDecision(request, layers)
  const effectivePolicy = effectivePolicyFor(decision, layers)
  assertSecretFreeRoutingValue({ decision, effectivePolicy })
  return Object.freeze({ profile, decision, effectivePolicy, layers })
}

export const createRoutingSettingsView = (
  input: Omit<ConfiguredPolicyInput, 'sessionOrAgentPin'>
): RoutingSettingsView => {
  const routing = input.routing ?? DEFAULT_ROUTING_SETTINGS
  if (routing.profile === 'off') {
    return Object.freeze({
      profile: 'off',
      telemetryEnabled: false,
      status: 'off',
      effectiveRoutes: Object.freeze({})
    })
  }
  try {
    const effectiveRoutes: Partial<Record<WorkClass, EffectiveRouteView>> = {}
    for (const workClass of WORK_CLASSES) {
      const { decision } = resolveConfiguredRoute({ workClass }, input)
      effectiveRoutes[workClass] = Object.freeze({
        workClass,
        source: decision.policySource,
        target: decision.target,
        alternateCount: decision.eligibleAlternates.length
      })
    }
    return Object.freeze({
      profile: routing.profile,
      telemetryEnabled: false,
      status: 'active',
      effectiveRoutes: Object.freeze(effectiveRoutes)
    })
  } catch (error) {
    return Object.freeze({
      profile: routing.profile,
      telemetryEnabled: false,
      status: 'unavailable',
      effectiveRoutes: Object.freeze({}),
      unavailableReason: error instanceof Error ? error.message : String(error)
    })
  }
}
