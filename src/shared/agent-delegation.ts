import type { AgentRunProjection } from './agent-graph'
import { WORK_CLASSES, type ModelTarget, type WorkClass } from './model-routing'

export const DELEGATION_LIFECYCLES = [
  'awaiting_approval',
  'queued',
  'dispatching',
  'running',
  'completed',
  'failed',
  'cancelled',
  'blocked'
] as const
export type DelegationLifecycle = (typeof DELEGATION_LIFECYCLES)[number]

export type DelegationResultShape = 'text' | 'json'

export type DelegationBudget = Readonly<{
  maxWallTimeMs?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  maxCostUsd?: number
}>

export type DelegationSpawnRequest = Readonly<{
  task: string
  role?: string
  workClass: WorkClass
  resultShape?: DelegationResultShape
  budget?: DelegationBudget
}>

export type DelegationProjection = Readonly<{
  id: string
  graphId: string
  parentAgentRunId: string
  childAgentRunId: string
  childFrameId: string
  parentFrameId: string
  originMessageId: string
  projectId: string
  sessionId: string
  task: string
  role: string
  workClass: WorkClass
  resultShape: DelegationResultShape
  budget?: DelegationBudget
  lifecycle: DelegationLifecycle
  sequence: number
  taskDigest: string
  approvalDigest?: string
  approvalId?: string
  target?: Pick<ModelTarget, 'backend' | 'providerId' | 'model' | 'dataBoundary'>
  resultText?: string
  resultJson?: string
  safeFailureCode?: string
  cancellationGeneration: number
  createdAt: number
  updatedAt: number
  finishedAt?: number
  revision: number
  approvalConsumedAt?: number
  agentRun?: AgentRunProjection
}>

export type PersistedDelegation = Readonly<{
  id: string
  graphId: string
  parentAgentRunId: string
  childAgentRunId: string
  childFrameId: string
  parentFrameId: string
  originMessageId: string
  projectId: string
  sessionId: string
  task: string
  role: string
  workClass: WorkClass
  resultShape: DelegationResultShape
  budget?: DelegationBudget
  lifecycle: DelegationLifecycle
  approvalId?: string
  approvalDigest?: string
  target?: Pick<ModelTarget, 'backend' | 'providerId' | 'model' | 'dataBoundary'>
  resultText?: string
  resultJson?: string
  safeFailureCode?: string
  createdAt: number
  updatedAt: number
  finishedAt?: number
  approvalConsumedAt?: number
}>

/** A one-shot, main-issued approval. Renderer/agent responses must never be treated as this type. */
export type DelegationApprovalReceipt = Readonly<{
  kind: 'human-delegation-approval'
  id: string
  digest: string
  issuedAt: number
  expiresAt: number
  human: true
}>

export const isDelegationApprovalReceipt = (value: unknown): value is DelegationApprovalReceipt => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Partial<DelegationApprovalReceipt>
  return (
    candidate.kind === 'human-delegation-approval' &&
    typeof candidate.id === 'string' &&
    typeof candidate.digest === 'string' &&
    candidate.human === true &&
    typeof candidate.issuedAt === 'number' &&
    Number.isFinite(candidate.issuedAt) &&
    typeof candidate.expiresAt === 'number' &&
    Number.isFinite(candidate.expiresAt) &&
    candidate.expiresAt >= candidate.issuedAt
  )
}

export type DelegationResult = Readonly<{
  status: Extract<DelegationLifecycle, 'completed' | 'failed' | 'cancelled' | 'blocked'>
  text?: string
  json?: string
  safeFailureCode?: string
}>

export const DELEGATION_MAX_TASK_CHARS = 64_000
export const DELEGATION_MAX_RESULT_CHARS = 32_000
export const DELEGATION_DEFAULT_WALL_TIME_MS = 60_000
export const DELEGATION_DEFAULT_OUTPUT_TOKENS = 4_096
export const DELEGATION_MAX_WAIT_MS = 30_000
export const DELEGATION_MAX_INPUT_TOKENS = 65_536

const SAFE_FAILURE = /^[a-z0-9][a-z0-9._-]{0,127}$/u

const assertText = (value: unknown, label: string, max: number): string => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    value.includes('\u0000') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

const validateBudget = (value: DelegationBudget | undefined): DelegationBudget | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Delegation budget is invalid.')
  }
  for (const key of ['maxWallTimeMs', 'maxInputTokens', 'maxOutputTokens', 'maxCostUsd'] as const) {
    const candidate = value[key]
    if (
      candidate !== undefined &&
      (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0)
    ) {
      throw new Error(`Delegation budget ${key} is invalid.`)
    }
  }
  if (value.maxInputTokens !== undefined && value.maxInputTokens > DELEGATION_MAX_INPUT_TOKENS) {
    throw new Error('Delegation budget maxInputTokens exceeds the hard bound.')
  }
  return Object.freeze({ ...value })
}

export const validateDelegationSpawnRequest = (value: unknown): DelegationSpawnRequest => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Delegation request is invalid.')
  }
  const request = value as Record<string, unknown>
  const task = assertText(request.task, 'Delegation task', DELEGATION_MAX_TASK_CHARS)
  const role =
    request.role === undefined ? 'delegate' : assertText(request.role, 'Delegation role', 256)
  const workClass = request.workClass
  if (typeof workClass !== 'string' || !WORK_CLASSES.includes(workClass as WorkClass)) {
    throw new Error('Delegation work class is invalid.')
  }
  const resultShape = request.resultShape === undefined ? 'text' : request.resultShape
  if (resultShape !== 'text' && resultShape !== 'json')
    throw new Error('Delegation result shape is invalid.')
  return Object.freeze({
    task,
    role,
    workClass: workClass as WorkClass,
    resultShape,
    ...(request.budget ? { budget: validateBudget(request.budget as DelegationBudget) } : {})
  })
}

export const validateDelegationResult = (result: DelegationResult): DelegationResult => {
  if (!['completed', 'failed', 'cancelled', 'blocked'].includes(result.status)) {
    throw new Error('Delegation result status is invalid.')
  }
  if (result.text !== undefined)
    assertText(result.text, 'Delegation result', DELEGATION_MAX_RESULT_CHARS)
  if (result.json !== undefined)
    assertText(result.json, 'Delegation JSON result', DELEGATION_MAX_RESULT_CHARS)
  if (result.safeFailureCode !== undefined && !SAFE_FAILURE.test(result.safeFailureCode)) {
    throw new Error('Delegation failure code is invalid.')
  }
  return Object.freeze({ ...result })
}

export const validatePersistedDelegation = (value: unknown): PersistedDelegation => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Persisted delegation is invalid.')
  }
  const candidate = value as Partial<PersistedDelegation>
  const request = validateDelegationSpawnRequest(candidate)
  if (typeof candidate.id !== 'string' || !candidate.id.trim())
    throw new Error('Delegation id is invalid.')
  for (const [key, item] of [
    ['graphId', candidate.graphId],
    ['parentAgentRunId', candidate.parentAgentRunId],
    ['childAgentRunId', candidate.childAgentRunId],
    ['childFrameId', candidate.childFrameId],
    ['parentFrameId', candidate.parentFrameId],
    ['originMessageId', candidate.originMessageId],
    ['projectId', candidate.projectId],
    ['sessionId', candidate.sessionId]
  ] as const) {
    if (typeof item !== 'string' || !item.trim() || item.length > 256)
      throw new Error(`Delegation ${key} is invalid.`)
  }
  if (!DELEGATION_LIFECYCLES.includes(candidate.lifecycle as DelegationLifecycle))
    throw new Error('Delegation lifecycle is invalid.')
  if (typeof candidate.createdAt !== 'number' || typeof candidate.updatedAt !== 'number')
    throw new Error('Delegation timestamps are invalid.')
  return Object.freeze({
    id: candidate.id,
    graphId: candidate.graphId!,
    parentAgentRunId: candidate.parentAgentRunId!,
    childAgentRunId: candidate.childAgentRunId!,
    childFrameId: candidate.childFrameId!,
    parentFrameId: candidate.parentFrameId!,
    originMessageId: candidate.originMessageId!,
    projectId: candidate.projectId!,
    sessionId: candidate.sessionId!,
    task: request.task,
    role: request.role ?? 'delegate',
    workClass: request.workClass,
    resultShape: request.resultShape ?? 'text',
    ...(request.budget ? { budget: request.budget } : {}),
    lifecycle: candidate.lifecycle!,
    ...(candidate.approvalId ? { approvalId: candidate.approvalId } : {}),
    ...(candidate.approvalDigest ? { approvalDigest: candidate.approvalDigest } : {}),
    ...(candidate.target ? { target: candidate.target } : {}),
    ...(candidate.resultText
      ? {
          resultText: assertText(
            candidate.resultText,
            'Delegation result',
            DELEGATION_MAX_RESULT_CHARS
          )
        }
      : {}),
    ...(candidate.resultJson
      ? {
          resultJson: assertText(
            candidate.resultJson,
            'Delegation JSON result',
            DELEGATION_MAX_RESULT_CHARS
          )
        }
      : {}),
    ...(candidate.safeFailureCode ? { safeFailureCode: candidate.safeFailureCode } : {}),
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    ...(candidate.finishedAt === undefined ? {} : { finishedAt: candidate.finishedAt })
  })
}

export type DelegationCapability = Readonly<{
  spawn(request: unknown): Promise<DelegationProjection>
  status(childId: string): Promise<DelegationProjection | undefined>
  wait(childId: string, timeoutMs?: number): Promise<DelegationProjection | undefined>
  cancel(childId: string): Promise<DelegationProjection | undefined>
}>
