import { Badge } from '@/components/ui/badge'
import { SettingsSection } from './SettingsLayout'
import { WORK_CLASSES, type WorkClass } from '../../../../shared/model-routing'
import {
  ROUTING_PROFILE_FOUNDATION_DEFINITIONS,
  ROUTING_PROFILE_FOUNDATION_STATUS,
  type ModelTier
} from '../../../../shared/routing-profile-foundation'

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

// Read-only visibility for the shipped routing foundation. It intentionally exposes neither a
// profile selector nor an activation switch: no persisted policy is currently applied to sessions.
const RoutingPanel = (): React.JSX.Element => (
  <div className="space-y-5 p-5">
    <SettingsSection
      title="Model routing"
      description="Inspect the shipped work-class mappings before policy persistence and runtime routing are connected."
      aria-label="Model routing"
    >
      <div
        data-routing-status={ROUTING_PROFILE_FOUNDATION_STATUS.state}
        role="status"
        className="rounded-lg border border-border bg-muted/40 px-3 py-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">Foundation / not active</Badge>
          <span className="text-sm font-medium text-foreground">
            Current sessions are unchanged
          </span>
        </div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          No routing policy is persisted or applied to a runtime. Conversations continue to use the
          framework, provider, model, and reasoning effort selected in Model and Agent settings.
        </p>
      </div>
    </SettingsSection>

    <SettingsSection
      title="Shipped profile mappings"
      description="Tiers describe intended relative cost and capability. They do not name or select a configured provider or model."
      aria-label="Shipped profile mappings"
      separated
    >
      <div className="mb-3 grid gap-2 md:grid-cols-3">
        {ROUTING_PROFILE_FOUNDATION_DEFINITIONS.map((profile) => (
          <div key={profile.id} className="rounded-lg border border-border px-3 py-2.5">
            <div className="text-sm font-medium text-foreground">{profile.name}</div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{profile.description}</p>
          </div>
        ))}
      </div>

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

export { RoutingPanel }
