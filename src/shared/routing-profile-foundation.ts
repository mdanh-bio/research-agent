import type { WorkClass } from './model-routing'

export type ModelTier = 'strong' | 'medium' | 'cheap'

export type RoutingProfileId = 'research_max' | 'balanced' | 'economy'

export type RoutingProfileFoundationDefinition = Readonly<{
  id: RoutingProfileId
  name: string
  description: string
  workClassTiers: Readonly<Record<WorkClass, ModelTier>>
}>

// This is intentionally a renderer-safe, secret-free description of the shipped design presets.
// It is also the single source used by the main-process policy factory, so the settings table cannot
// drift from the policies that a future orchestrator may explicitly persist and apply.
export const ROUTING_PROFILE_FOUNDATION_DEFINITIONS: readonly RoutingProfileFoundationDefinition[] =
  Object.freeze([
    Object.freeze({
      id: 'research_max',
      name: 'Research Max',
      description:
        'Prioritizes the strongest configured models for scientific reasoning and review.',
      workClassTiers: Object.freeze({
        interaction_router: 'cheap',
        title: 'cheap',
        summary: 'cheap',
        compaction: 'medium',
        explore: 'cheap',
        plan: 'strong',
        build: 'medium',
        review: 'strong',
        literature: 'strong',
        analysis: 'medium',
        compute: 'medium'
      })
    }),
    Object.freeze({
      id: 'balanced',
      name: 'Balanced',
      description: 'Reserves strong models for planning and review while controlling routine cost.',
      workClassTiers: Object.freeze({
        interaction_router: 'cheap',
        title: 'cheap',
        summary: 'cheap',
        compaction: 'cheap',
        explore: 'cheap',
        plan: 'strong',
        build: 'medium',
        review: 'strong',
        literature: 'medium',
        analysis: 'medium',
        compute: 'medium'
      })
    }),
    Object.freeze({
      id: 'economy',
      name: 'Economy',
      description: 'Uses cheap models by default and medium models for higher-risk reasoning.',
      workClassTiers: Object.freeze({
        interaction_router: 'cheap',
        title: 'cheap',
        summary: 'cheap',
        compaction: 'cheap',
        explore: 'cheap',
        plan: 'medium',
        build: 'cheap',
        review: 'medium',
        literature: 'medium',
        analysis: 'medium',
        compute: 'cheap'
      })
    })
  ])

// There is no settings-owned persisted policy or production conversation integration yet. Keep the
// renderer fail-closed until both exist; a future live status must come from authoritative runtime
// evidence rather than changing this shipped-foundation descriptor.
export const ROUTING_PROFILE_FOUNDATION_STATUS = Object.freeze({
  state: 'foundation_not_active' as const,
  persistedPolicy: false as const,
  appliedToRuntime: false as const
})
