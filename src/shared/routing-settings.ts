import type {
  DataBoundary,
  ModelCapability,
  ModelTarget,
  RouteBudget,
  RoutePolicySource,
  WorkClass
} from './model-routing'
import type { RoutingProfileId } from './routing-profile-foundation'

export type RoutingProfileSelection = 'off' | RoutingProfileId

// Overrides persist only catalog target ids and policy constraints. Concrete targets are resolved
// again from the current, renderer-safe configured-model catalog before a run begins, so provider
// credentials can never be copied into settings or a policy snapshot.
export type RoutingPolicyOverride = Readonly<{
  primaryTargetId: string
  fallbackTargetIds?: readonly string[]
  requiredCapabilities?: readonly ModelCapability[]
  dataBoundary?: DataBoundary
  budget?: RouteBudget
}>

export type RoutingPolicyOverrides = Readonly<Partial<Record<WorkClass, RoutingPolicyOverride>>>

export type RoutingSettings = Readonly<{
  profile: RoutingProfileSelection
  // Reserved for a future explicit exporter. M1 keeps it false and performs no external export.
  telemetryEnabled: boolean
  userOverrides?: RoutingPolicyOverrides
  projectOverrides?: Readonly<Record<string, RoutingPolicyOverrides>>
}>

export const DEFAULT_ROUTING_SETTINGS: RoutingSettings = Object.freeze({
  profile: 'off',
  telemetryEnabled: false
})

export type EffectiveRouteView = Readonly<{
  workClass: WorkClass
  source: RoutePolicySource
  target: ModelTarget
  alternateCount: number
}>

export type RoutingSettingsStatus = 'off' | 'active' | 'unavailable'

export type RoutingSettingsView = Readonly<{
  profile: RoutingProfileSelection
  telemetryEnabled: false
  status: RoutingSettingsStatus
  effectiveRoutes: Readonly<Partial<Record<WorkClass, EffectiveRouteView>>>
  unavailableReason?: string
}>

export type SetRoutingSettingsRequest = Readonly<{
  profile: RoutingProfileSelection
}>

export const ROUTING_PROFILE_SELECTIONS: readonly RoutingProfileSelection[] = Object.freeze([
  'off',
  'research_max',
  'balanced',
  'economy'
])

export const isRoutingProfileSelection = (value: unknown): value is RoutingProfileSelection =>
  typeof value === 'string' && (ROUTING_PROFILE_SELECTIONS as readonly string[]).includes(value)
