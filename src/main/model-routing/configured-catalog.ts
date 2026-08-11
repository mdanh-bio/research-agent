import type { ModelCapability, ModelTarget } from '../../shared/model-routing'
import {
  isProviderUsableByFramework,
  preferredEndpoint,
  providerEndpoints,
  providerValidationFailed,
  type AgentFrameworkId,
  type AgentFrameworkView,
  type ProviderView,
  type ReasoningEffort
} from '../../shared/settings'
import type { ModelTargetTiers, ModelTier } from './default-profiles'
import { assertSecretFreeRoutingValue } from './secret-safety'
import { resolveProviderReasoningEffortProfile } from '../../shared/provider-reasoning-effort'

export type ConfiguredRoutingCatalogInput = Readonly<{
  frameworkId: AgentFrameworkId
  frameworks: readonly AgentFrameworkView[]
  providers: readonly ProviderView[]
  activeProviderId?: string
  activeModel?: string
}>

export type ConfiguredRoutingCatalog = Readonly<{
  targets: readonly ModelTarget[]
  tiers: ModelTargetTiers
}>

type RouteFamily = 'anthropic' | 'openai' | 'responses' | 'codex-bridge'

const targetDataBoundary = (provider: ProviderView): ModelTarget['dataBoundary'] => {
  // A loopback gateway can still forward bytes to a remote model, so URL shape is not evidence of
  // local execution. Official/subscription providers are explicit approved-cloud identities;
  // arbitrary custom endpoints remain any_configured and therefore fail closed for stricter routes.
  return provider.type === 'custom' ? 'any_configured' : 'approved_cloud'
}

const routeFamilyFor = (
  frameworkId: AgentFrameworkId,
  provider: ProviderView,
  framework: AgentFrameworkView
): RouteFamily | undefined => {
  const endpoints = providerEndpoints(provider)
  const supportedApiTypes = framework.supportedApiTypes ?? ['anthropic']
  if (frameworkId === 'claude-code') return 'anthropic'
  if (frameworkId === 'codex') {
    if (provider.type === 'codex-isolated' || provider.type === 'codex-shared') return 'responses'
    if (endpoints.includes('responses')) return 'responses'
    return endpoints.includes('openai') ? 'codex-bridge' : undefined
  }
  const endpoint = preferredEndpoint(endpoints, supportedApiTypes)
  return endpoint === 'responses' ? 'responses' : endpoint
}

const tierForIndex = (index: number, count: number): ModelTier => {
  if (count === 1) return 'medium'
  if (count === 2) return index === 0 ? 'strong' : 'cheap'
  const third = Math.max(1, Math.floor(count / 3))
  if (index < third) return 'strong'
  if (index >= count - third) return 'cheap'
  return 'medium'
}

const effortForTier = (tier: ModelTier): ReasoningEffort =>
  tier === 'strong' ? 'high' : tier === 'medium' ? 'medium' : 'low'

const targetCapabilities = (
  provider: ProviderView,
  contextWindow: number,
  reasoningSupported: boolean
): ModelCapability[] => [
  'text',
  'tool_use',
  ...(reasoningSupported ? (['reasoning'] as const) : []),
  ...(provider.supportsImageInput ? (['image_input'] as const) : []),
  ...(contextWindow >= 128_000 ? (['long_context'] as const) : [])
]

const targetId = (frameworkId: AgentFrameworkId, providerId: string, model: string): string =>
  `configured:${frameworkId}:${encodeURIComponent(providerId)}:${encodeURIComponent(model)}`

const uniqueTargets = (targets: readonly ModelTarget[]): readonly ModelTarget[] => {
  const seen = new Set<string>()
  return Object.freeze(targets.filter((target) => !seen.has(target.id) && seen.add(target.id)))
}

// Configured model order is already curated strongest-to-cheapest for official vendors. Partition
// each provider's ordered list into thirds, then fill missing tiers with the nearest concrete target.
// A single configured model therefore appears once in all three tier lists and never becomes a fake
// fallback to itself under another id.
export const createConfiguredRoutingCatalog = (
  input: ConfiguredRoutingCatalogInput
): ConfiguredRoutingCatalog => {
  const framework = input.frameworks.find(({ id }) => id === input.frameworkId)
  if (!framework) throw new Error(`Unknown configured agent framework: ${input.frameworkId}.`)
  const frameworkCompatibility = {
    id: framework.id,
    supportedApiTypes: framework.supportedApiTypes ?? ['anthropic']
  }
  const usableProviders = input.providers.filter(
    (provider) =>
      !providerValidationFailed(provider) &&
      isProviderUsableByFramework(provider, frameworkCompatibility)
  )
  const activeProvider = usableProviders.find(({ id }) => id === input.activeProviderId)
  const preferredFamily = activeProvider
    ? routeFamilyFor(input.frameworkId, activeProvider, framework)
    : undefined
  const familyCounts = new Map<RouteFamily, number>()
  for (const provider of usableProviders) {
    const family = routeFamilyFor(input.frameworkId, provider, framework)
    if (family) familyCounts.set(family, (familyCounts.get(family) ?? 0) + provider.models.length)
  }
  const selectedFamily =
    preferredFamily ??
    [...familyCounts.entries()].sort(
      ([leftFamily, leftCount], [rightFamily, rightCount]) =>
        rightCount - leftCount || leftFamily.localeCompare(rightFamily)
    )[0]?.[0]
  const tiers: Record<ModelTier, ModelTarget[]> = { strong: [], medium: [], cheap: [] }
  const allTargets: ModelTarget[] = []

  for (const provider of usableProviders) {
    if (routeFamilyFor(input.frameworkId, provider, framework) !== selectedFamily) continue
    const models = provider.models.filter((model) => model.trim() !== '')
    if (models.length === 0 && provider.model) models.push(provider.model)
    const orderedModels = models
    const providerTargets = orderedModels.map((model, index) => {
      const tier = tierForIndex(index, orderedModels.length)
      const contextWindow = provider.contextWindow ?? 200_000
      const reasoningSupported = resolveProviderReasoningEffortProfile(provider, model).supported
      const target: ModelTarget = Object.freeze({
        id: targetId(input.frameworkId, provider.id, model),
        backend: input.frameworkId,
        providerId: provider.id,
        model,
        reasoningEffort: reasoningSupported ? effortForTier(tier) : 'default',
        capabilities: Object.freeze(
          targetCapabilities(provider, contextWindow, reasoningSupported)
        ),
        dataBoundary: targetDataBoundary(provider),
        contextWindow
      })
      assertSecretFreeRoutingValue(target)
      return { target, tier }
    })
    for (const { target, tier } of providerTargets) {
      tiers[tier].push(target)
      allTargets.push(target)
    }
    if (providerTargets.length === 1) {
      tiers.strong.push(providerTargets[0].target)
      tiers.cheap.push(providerTargets[0].target)
    } else if (providerTargets.length === 2) {
      tiers.medium.push(providerTargets[0].target)
    }
  }

  const targets = uniqueTargets(allTargets)
  if (targets.length === 0) {
    throw new Error('No configured provider/model is eligible for transparent routing.')
  }
  if (tiers.strong.length === 0) tiers.strong.push(...tiers.medium, ...tiers.cheap)
  if (tiers.medium.length === 0) tiers.medium.push(...tiers.strong, ...tiers.cheap)
  if (tiers.cheap.length === 0) tiers.cheap.push(...tiers.medium, ...tiers.strong)

  return Object.freeze({
    targets,
    tiers: Object.freeze({
      strong: uniqueTargets(tiers.strong),
      medium: uniqueTargets(tiers.medium),
      cheap: uniqueTargets(tiers.cheap)
    })
  })
}
