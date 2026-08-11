import type { AgentFrameworkId, ReasoningEffort } from './settings'
import type { AgentGraphKind, AgentObservedUsage, AgentRunBudget } from './agent-graph'

export const WORK_CLASSES = [
  'interaction_router',
  'title',
  'summary',
  'compaction',
  'explore',
  'plan',
  'build',
  'review',
  'literature',
  'analysis',
  'compute'
] as const

export type WorkClass = (typeof WORK_CLASSES)[number]

export const DATA_BOUNDARIES = ['local_only', 'approved_cloud', 'any_configured'] as const
export type DataBoundary = (typeof DATA_BOUNDARIES)[number]

export const MODEL_CAPABILITIES = [
  'text',
  'image_input',
  'tool_use',
  'reasoning',
  'long_context'
] as const
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number]

export type RouteBudget = Readonly<{
  maxInputTokens?: number
  maxOutputTokens?: number
  maxCostUsd?: number
  maxLatencyMs?: number
}>

// A secret-free catalog entry. Provider credentials remain settings-owned and are resolved only after
// the policy layer has selected a target.
export type ModelTarget = Readonly<{
  id: string
  backend: AgentFrameworkId
  providerId: string
  model: string
  reasoningEffort: ReasoningEffort
  capabilities: readonly ModelCapability[]
  dataBoundary: DataBoundary
  contextWindow?: number
}>

// Target ids are display/catalog handles, not security identities. Runtime boundaries must compare
// the complete target so a reused id cannot silently change the backend, provider, model, or data
// handling contract.
export const modelTargetsEqual = (left: ModelTarget, right: ModelTarget): boolean =>
  left.id === right.id &&
  left.backend === right.backend &&
  left.providerId === right.providerId &&
  left.model === right.model &&
  left.reasoningEffort === right.reasoningEffort &&
  left.dataBoundary === right.dataBoundary &&
  left.contextWindow === right.contextWindow &&
  left.capabilities.length === right.capabilities.length &&
  left.capabilities.every((capability, index) => capability === right.capabilities[index])

export type ModelRoutePolicy = Readonly<{
  id: string
  version: string
  workClass: WorkClass
  primary: ModelTarget
  fallbacks: readonly ModelTarget[]
  requiredCapabilities: readonly ModelCapability[]
  dataBoundary: DataBoundary
  budget?: RouteBudget
}>

export type ModelRoutePolicyCollection = Readonly<Partial<Record<WorkClass, ModelRoutePolicy>>>

export type RoutePolicySource =
  'session_or_agent_pin' | 'project_policy' | 'user_policy' | 'shipped_default'

export type RouteRejectionReason =
  'missing_capability' | 'data_boundary' | 'excluded' | 'duplicate_target' | 'alternate_limit'

export type RejectedModelTarget = Readonly<{
  target: ModelTarget
  reason: RouteRejectionReason
  detail: string
}>

export type RouteDecision = Readonly<{
  workClass: WorkClass
  policyId: string
  policyVersion: string
  policySource: RoutePolicySource
  target: ModelTarget
  eligibleAlternates: readonly ModelTarget[]
  requiredCapabilities: readonly ModelCapability[]
  dataBoundary: DataBoundary
  budget?: RouteBudget
  selectionReason: string
  rejectedAlternatives: readonly RejectedModelTarget[]
}>

export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked'

// The task is referenced by the authoritative Session JSON message instead of copying prompt text
// into the routing ledger.
export type AgentTaskReference = Readonly<{
  projectId: string
  sessionId: string
  promptMessageId?: string
}>

export type AgentRun = Readonly<{
  id: string
  graphId?: string
  frameId?: string
  runKind?: AgentGraphKind
  depth?: number
  parentAgentRunId?: string
  policySnapshotId: string
  task: AgentTaskReference
  role: string
  workClass: WorkClass
  runtime: AgentFrameworkId
  status: AgentRunStatus
  budget?: RouteBudget
  artifactStorageSessionId?: string
  observedBudget?: AgentObservedUsage | AgentRunBudget
  cancelRequestedAt?: number
  cancelledAt?: number
  safeFailureCode?: string
  outputArtifactIds: readonly string[]
  createdAt: number
  startedAt?: number
  finishedAt?: number
  updatedAt?: number
  revision?: number
}>

export type ModelFailureCategory =
  | 'timeout'
  | 'rate_limit'
  | 'provider_unavailable'
  | 'malformed_response'
  | 'benign_research_refusal'
  | 'ambiguous_safety'
  | 'authentication'
  | 'invalid_request'
  | 'context_overflow'
  | 'unknown'

export type ModelAttemptTrigger = 'initial' | ModelFailureCategory
export type ModelAttemptResult = 'reserved' | 'running' | 'success' | 'failure' | 'cancelled'

export type ModelAttempt = Readonly<{
  id: string
  agentRunId: string
  sequence: number
  trigger: ModelAttemptTrigger
  target: ModelTarget
  requestHash: string
  result: ModelAttemptResult
  failureCategory?: ModelFailureCategory
  sideEffectsStarted: boolean
  latencyMs?: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  startedAt: number
  finishedAt?: number
}>

export type RuntimeThreadLink = Readonly<{
  id: string
  agentRunId: string
  appSessionId: string
  backend: AgentFrameworkId
  runtimeThreadId: string
  parentRuntimeThreadId?: string
  ephemeral: boolean
  createdAt: number
  closedAt?: number
}>

export type RoutingPolicySnapshot = Readonly<{
  id: string
  projectId?: string
  sessionId?: string
  workClass: WorkClass
  policyId: string
  policyVersion: string
  policySource: RoutePolicySource
  // Canonical secret-free document containing both the effective policy and resolved decision.
  policyJson: string
  policyHash: string
  createdAt: number
}>
