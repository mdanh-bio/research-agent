import { Badge } from '@/components/ui/badge'
import { useSettingsStore } from '@/stores/settings-store'
import { SettingsSection } from './SettingsLayout'
import { WORK_CLASSES, type WorkClass } from '../../../../shared/model-routing'
import {
  ROUTING_PROFILE_FOUNDATION_DEFINITIONS,
  type ModelTier
} from '../../../../shared/routing-profile-foundation'
import {
  isRoutingProfileSelection,
  type RoutingSettingsStatus
} from '../../../../shared/routing-settings'

const WORK_CLASS_LABELS: Readonly<Record<WorkClass, string>> = {
  interaction_router: 'Interaction router',
  title: 'Title',
  summary: 'Summary',
  compaction: 'Compaction',
  explore: 'Explore',
  plan: 'Plan',
  build: 'Build',
  review: 'Review',
  literature: 'Literature',
  analysis: 'Analysis',
  compute: 'Compute'
}

const TIER_LABELS: Readonly<Record<ModelTier, string>> = {
  strong: 'Strong',
  medium: 'Medium',
  cheap: 'Cheap'
}

const STATUS_LABELS: Readonly<Record<RoutingSettingsStatus, string>> = {
  off: 'Off',
  active: 'Active',
  unavailable: 'Unavailable'
}

const RoutingPanel = (): React.JSX.Element => {
  const routing = useSettingsStore((state) => state.routing)
  const providers = useSettingsStore((state) => state.providers)
  const setRoutingProfile = useSettingsStore((state) => state.setRoutingProfile)
  const providerNames = new Map(providers.map((provider) => [provider.id, provider.name] as const))

  return (
    <div className="space-y-5 p-5">
      <SettingsSection
        title="Model routing"
        description="Opt a new runtime generation into deterministic work-class routing. Off preserves the Model and Agent settings path exactly."
        aria-label="Model routing"
      >
        <div
          data-routing-status={routing.status}
          role="status"
          className="rounded-lg border border-border bg-muted/40 px-3 py-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{STATUS_LABELS[routing.status]}</Badge>
            <span className="text-sm font-medium text-foreground">
              {routing.status === 'off'
                ? 'Current sessions use Model and Agent settings'
                : routing.status === 'active'
                  ? 'New routed runs use the effective targets below'
                  : 'The selected profile has no complete eligible route'}
            </span>
          </div>
          {routing.unavailableReason ? (
            <p className="mt-2 text-xs leading-5 text-destructive">{routing.unavailableReason}</p>
          ) : null}
        </div>

        <label className="mt-4 block text-sm font-medium text-foreground" htmlFor="routing-profile">
          Routing profile
        </label>
        <select
          id="routing-profile"
          aria-label="Routing profile"
          className="mt-2 h-9 w-full max-w-sm rounded-md border border-input bg-background px-3 text-sm"
          value={routing.profile}
          onChange={(event) => {
            if (isRoutingProfileSelection(event.target.value)) {
              void setRoutingProfile(event.target.value)
            }
          }}
        >
          <option value="off">Off</option>
          {ROUTING_PROFILE_FOUNDATION_DEFINITIONS.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>

        <label className="mt-4 flex items-start gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={false}
            disabled
            readOnly
            aria-label="External telemetry"
          />
          <span>
            External telemetry/export is off and unavailable. Route provenance is stored only in the
            local project ledger.
          </span>
        </label>
      </SettingsSection>

      <SettingsSection
        title="Effective routes (user default)"
        description="Global preview after user overrides: provider, model, reasoning effort, policy source, and eligible alternates. Project-specific overrides are resolved at dispatch and recorded in that run's ledger snapshot."
        aria-label="Effective routes"
        separated
      >
        {routing.status === 'active' ? (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[760px] border-collapse text-left text-sm">
              <caption className="sr-only">Effective model routes by work class</caption>
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Work class
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Provider / model
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Reasoning
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Boundary
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Source
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Alternates
                  </th>
                </tr>
              </thead>
              <tbody>
                {WORK_CLASSES.map((workClass) => {
                  const route = routing.effectiveRoutes[workClass]
                  return (
                    <tr key={workClass} className="border-t border-border">
                      <th scope="row" className="px-3 py-2 font-medium text-foreground">
                        {WORK_CLASS_LABELS[workClass]}
                      </th>
                      <td className="px-3 py-2 text-muted-foreground">
                        {route
                          ? `${providerNames.get(route.target.providerId) ?? route.target.providerId} / ${route.target.model}`
                          : 'Unavailable'}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {route?.target.reasoningEffort ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {route?.target.dataBoundary ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {route?.source.replaceAll('_', ' ') ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {route?.alternateCount ?? 0}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Select a profile with eligible configured models to resolve effective routes.
          </p>
        )}
      </SettingsSection>

      <SettingsSection
        title="Shipped profile intent"
        description="Tier intent remains visible for comparison; runtime selection always uses the concrete effective routes above."
        aria-label="Shipped profile intent"
        separated
      >
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <caption className="sr-only">Shipped routing work-class tier mappings</caption>
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Work class
                </th>
                {ROUTING_PROFILE_FOUNDATION_DEFINITIONS.map((profile) => (
                  <th key={profile.id} scope="col" className="px-3 py-2 font-medium">
                    {profile.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {WORK_CLASSES.map((workClass) => (
                <tr key={workClass} className="border-t border-border">
                  <th scope="row" className="px-3 py-2 font-medium text-foreground">
                    {WORK_CLASS_LABELS[workClass]}
                  </th>
                  {ROUTING_PROFILE_FOUNDATION_DEFINITIONS.map((profile) => (
                    <td key={profile.id} className="px-3 py-2 text-muted-foreground">
                      {TIER_LABELS[profile.workClassTiers[workClass]]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SettingsSection>
    </div>
  )
}

export { RoutingPanel }
