import type { AgentFrameworkId } from './settings'
import type { RouteBudget, WorkClass } from './model-routing'

export const AGENT_GRAPH_KINDS = [
  'root',
  'delegate',
  'side-question',
  'interaction-router'
] as const
export type AgentGraphKind = (typeof AGENT_GRAPH_KINDS)[number]

export const AGENT_GRAPH_LIFECYCLES = [
  'active',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'blocked'
] as const
export type AgentGraphLifecycle = (typeof AGENT_GRAPH_LIFECYCLES)[number]

export const AGENT_RUN_KINDS = AGENT_GRAPH_KINDS
export type AgentRunKind = (typeof AGENT_RUN_KINDS)[number]

export const AGENT_GRAPH_TERMINAL_LIFECYCLES = new Set<AgentGraphLifecycle>([
  'completed',
  'failed',
  'cancelled',
  'blocked'
])

export const AGENT_RUN_TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'blocked'
] as const)

export type AgentGraphLimits = Readonly<{
  maxConcurrency: number
  maxDepth: number
  maxChildren: number
  maxWallTimeMs?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  maxCostUsd?: number
  maxArtifactBytes?: number
}>

export type AgentRunBudget = Readonly<{
  maxWallTimeMs?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  maxCostUsd?: number
  maxArtifactBytes?: number
}>

export type AgentObservedUsage = Readonly<{
  wallTimeMs?: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  artifactBytes?: number
  childCount?: number
}>

export type AgentCancellationIntent = Readonly<{
  generation: number
  requestedAt: number
  reason: 'user' | 'parent' | 'shutdown' | 'budget' | 'recovery'
}>

export type AgentResultSummary = Readonly<{
  status: 'completed' | 'failed' | 'cancelled' | 'blocked'
  safeFailureCode?: string
  outputArtifactIds: readonly string[]
  observedUsage?: AgentObservedUsage
}>

export type AgentGraphProjection = Readonly<{
  id: string
  projectId: string
  sessionId: string
  rootPromptMessageId: string
  kind: AgentGraphKind
  lifecycle: AgentGraphLifecycle
  limits: AgentGraphLimits
  totalBudget?: AgentRunBudget
  observedUsage: AgentObservedUsage
  cancellationGeneration: number
  cancelRequestedAt?: number
  cancelReason?: AgentCancellationIntent['reason']
  createdAt: number
  updatedAt: number
  revision: number
}>

export type AgentRunProjection = Readonly<{
  id: string
  graphId?: string
  parentAgentRunId?: string
  frameId?: string
  policySnapshotId?: string
  runKind: AgentRunKind
  depth: number
  projectId: string
  sessionId: string
  promptMessageId?: string
  role: string
  workClass: WorkClass
  runtime: AgentFrameworkId
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked'
  budget?: AgentRunBudget | RouteBudget
  observedBudget: AgentObservedUsage
  artifactStorageSessionId?: string
  outputArtifactIds: readonly string[]
  cancelRequestedAt?: number
  cancelledAt?: number
  safeFailureCode?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  updatedAt: number
  revision: number
}>

export const DEFAULT_AGENT_GRAPH_LIMITS: AgentGraphLimits = Object.freeze({
  maxConcurrency: 4,
  maxDepth: 1,
  maxChildren: 8
})

const MAX_AGENT_GRAPH_LIMITS = Object.freeze({
  maxConcurrency: 4,
  maxDepth: 1,
  maxChildren: 8,
  maxWallTimeMs: Number.MAX_SAFE_INTEGER,
  maxInputTokens: Number.MAX_SAFE_INTEGER,
  maxOutputTokens: Number.MAX_SAFE_INTEGER,
  maxCostUsd: Number.MAX_SAFE_INTEGER,
  maxArtifactBytes: Number.MAX_SAFE_INTEGER
})

const AGENT_GRAPH_CANCEL_REASONS = ['user', 'parent', 'shutdown', 'budget', 'recovery'] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const assertIdentifier = (value: string, label: string): string => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 256 ||
    value.includes('\u0000') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    throw new Error(`${label} must be a non-empty bounded identifier.`)
  }
  return value
}

const assertNonNegativeNumber = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`)
  }
  return value
}

const assertNonNegativeInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`)
  }
  return value as number
}

const validateBudgetFields = <Budget extends Readonly<Record<string, unknown>>>(
  value: Budget | undefined,
  label: string
): Budget | undefined => {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error(`${label} must be an object.`)
  for (const key of [
    'maxWallTimeMs',
    'maxInputTokens',
    'maxOutputTokens',
    'maxCostUsd',
    'maxArtifactBytes'
  ]) {
    if (value[key] !== undefined) assertNonNegativeNumber(value[key], `${label}.${key}`)
  }
  return value
}

export const validateAgentGraphLimits = (value: AgentGraphLimits): AgentGraphLimits => {
  if (!isRecord(value)) throw new Error('Agent graph limits must be an object.')
  for (const key of ['maxConcurrency', 'maxDepth', 'maxChildren'] as const) {
    const number = assertNonNegativeInteger(value[key], `Agent graph ${key}`)
    if (number > MAX_AGENT_GRAPH_LIMITS[key]) {
      throw new Error(`Agent graph ${key} exceeds the application hard cap.`)
    }
    if (key === 'maxConcurrency' && number === 0) {
      throw new Error('Agent graph maxConcurrency must be at least one.')
    }
  }
  const budget = validateBudgetFields(value, 'Agent graph limits')
  for (const key of [
    'maxWallTimeMs',
    'maxInputTokens',
    'maxOutputTokens',
    'maxCostUsd',
    'maxArtifactBytes'
  ] as const) {
    const number = budget?.[key]
    if (number !== undefined && number > MAX_AGENT_GRAPH_LIMITS[key]) {
      throw new Error(`Agent graph ${key} exceeds the application hard cap.`)
    }
  }
  return Object.freeze({ ...value })
}

export const validateAgentRunBudget = (
  value: AgentRunBudget | undefined
): AgentRunBudget | undefined =>
  validateBudgetFields(value, 'Agent run budget') as AgentRunBudget | undefined

export const validateAgentObservedUsage = (
  value: AgentObservedUsage | undefined
): AgentObservedUsage => {
  if (value === undefined) return Object.freeze({})
  if (!isRecord(value)) throw new Error('Agent observed usage must be an object.')
  for (const key of [
    'wallTimeMs',
    'inputTokens',
    'outputTokens',
    'costUsd',
    'artifactBytes',
    'childCount'
  ]) {
    if (value[key] !== undefined) assertNonNegativeNumber(value[key], `Agent observed usage ${key}`)
  }
  return Object.freeze({ ...value })
}

export const validateAgentCancellationIntent = (
  value: AgentCancellationIntent
): AgentCancellationIntent => {
  if (!isRecord(value)) throw new Error('Agent cancellation intent must be an object.')
  assertNonNegativeInteger(value.generation, 'Agent cancellation generation')
  assertNonNegativeNumber(value.requestedAt, 'Agent cancellation requestedAt')
  if (
    !AGENT_GRAPH_CANCEL_REASONS.includes(
      value.reason as (typeof AGENT_GRAPH_CANCEL_REASONS)[number]
    )
  ) {
    throw new Error('Agent cancellation reason is invalid.')
  }
  return Object.freeze({ ...value }) as AgentCancellationIntent
}

export const validateAgentResultSummary = (value: AgentResultSummary): AgentResultSummary => {
  if (!isRecord(value) || !AGENT_RUN_TERMINAL_STATUSES.has(value.status as never)) {
    throw new Error('Agent result summary status is invalid.')
  }
  if (!Array.isArray(value.outputArtifactIds)) {
    throw new Error('Agent result summary artifact ids must be an array.')
  }
  const outputArtifactIds = value.outputArtifactIds.map((id) =>
    assertIdentifier(String(id), 'Artifact id')
  )
  if (value.safeFailureCode !== undefined) {
    assertIdentifier(value.safeFailureCode, 'Safe failure code')
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value.safeFailureCode)) {
      throw new Error('Safe failure code contains unsupported characters.')
    }
  }
  return Object.freeze({
    ...value,
    outputArtifactIds: Object.freeze(outputArtifactIds),
    ...(value.observedUsage
      ? { observedUsage: validateAgentObservedUsage(value.observedUsage) }
      : {})
  })
}

export const assertAgentGraphIdentity = (
  projectId: string,
  sessionId: string,
  promptMessageId: string
): void => {
  assertIdentifier(projectId, 'Project id')
  assertIdentifier(sessionId, 'Session id')
  assertIdentifier(promptMessageId, 'Prompt Message id')
}
