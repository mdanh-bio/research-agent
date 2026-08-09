import {
  WORK_CLASSES,
  type DataBoundary,
  type ModelCapability,
  type ModelRoutePolicy,
  type ModelTarget,
  type WorkClass
} from '../../shared/model-routing'
import {
  ROUTING_PROFILE_FOUNDATION_DEFINITIONS,
  type ModelTier,
  type RoutingProfileId
} from '../../shared/routing-profile-foundation'
import { MAX_AUTOMATIC_ALTERNATES } from './policy-planner'

export type { ModelTier, RoutingProfileId } from '../../shared/routing-profile-foundation'

export type ModelTargetTiers = Readonly<Record<ModelTier, readonly ModelTarget[]>>

export type RoutingProfile = Readonly<{
  id: RoutingProfileId
  name: string
  description: string
  version: string
  policies: Readonly<Record<WorkClass, ModelRoutePolicy>>
}>

export const DEFAULT_ROUTING_PROFILE_DEFINITIONS = ROUTING_PROFILE_FOUNDATION_DEFINITIONS

const REQUIRED_CAPABILITIES: Readonly<Record<WorkClass, readonly ModelCapability[]>> = {
  interaction_router: ['text'],
  title: ['text'],
  summary: ['text'],
  compaction: ['text', 'long_context'],
  explore: ['text', 'tool_use'],
  plan: ['text', 'reasoning'],
  build: ['text', 'tool_use'],
  review: ['text', 'reasoning'],
  literature: ['text', 'tool_use'],
  analysis: ['text', 'tool_use', 'reasoning'],
  compute: ['text', 'tool_use']
}

const fallbackTierOrder = (
  profileId: RoutingProfileId,
  primaryTier: ModelTier
): readonly ModelTier[] => {
  if (profileId === 'economy') {
    if (primaryTier === 'cheap') return ['cheap', 'medium', 'strong']
    return [primaryTier, 'cheap', 'strong']
  }
  if (primaryTier === 'strong') return ['strong', 'medium', 'cheap']
  if (primaryTier === 'medium') return ['medium', 'strong', 'cheap']
  return ['cheap', 'medium', 'strong']
}

const orderedTargets = (
  profileId: RoutingProfileId,
  primaryTier: ModelTier,
  tiers: ModelTargetTiers
): ModelTarget[] => {
  const result: ModelTarget[] = []
  const seen = new Set<string>()
  for (const tier of fallbackTierOrder(profileId, primaryTier)) {
    for (const target of tiers[tier]) {
      if (seen.has(target.id)) continue
      seen.add(target.id)
      result.push(target)
      if (result.length === MAX_AUTOMATIC_ALTERNATES + 1) return result
    }
  }
  return result
}

const assertTierCatalog = (tiers: ModelTargetTiers): void => {
  for (const tier of ['strong', 'medium', 'cheap'] as const) {
    if (tiers[tier].length === 0) throw new Error(`The ${tier} model tier must not be empty.`)
  }
}

export const createDefaultRoutingProfiles = (
  tiers: ModelTargetTiers,
  options: Readonly<{ dataBoundary?: DataBoundary }> = {}
): readonly RoutingProfile[] => {
  assertTierCatalog(tiers)
  const dataBoundary = options.dataBoundary ?? 'any_configured'

  return Object.freeze(
    DEFAULT_ROUTING_PROFILE_DEFINITIONS.map((definition) => {
      const policies = Object.fromEntries(
        WORK_CLASSES.map((workClass) => {
          const targets = orderedTargets(definition.id, definition.workClassTiers[workClass], tiers)
          const primary = targets[0]
          if (!primary) throw new Error(`No model target is configured for ${definition.name}.`)

          const policy: ModelRoutePolicy = Object.freeze({
            id: `${definition.id}.${workClass}`,
            version: '1',
            workClass,
            primary,
            fallbacks: Object.freeze(targets.slice(1)),
            requiredCapabilities: REQUIRED_CAPABILITIES[workClass],
            dataBoundary
          })
          return [workClass, policy]
        })
      ) as Record<WorkClass, ModelRoutePolicy>

      return Object.freeze({
        id: definition.id,
        name: definition.name,
        description: definition.description,
        version: '1',
        policies: Object.freeze(policies)
      })
    })
  )
}
