import type { AgentFrameworkId } from './settings'
import type { FileReference } from './artifacts'
import { resolveActiveConversationMessages } from './conversation-graph'
import type { PersistedChatSession } from './session-persistence'
import { parseArtifactVersionLocator } from './artifact-provenance'
import { parseUploadVersionReference } from './uploads'

export const SIDE_QUESTION_LIFECYCLES = [
  'preparing',
  'awaiting-approval',
  'ready',
  'starting',
  'running',
  'completed',
  'failed',
  'cancelled',
  'blocked'
] as const

export type SideQuestionLifecycle = (typeof SIDE_QUESTION_LIFECYCLES)[number]

export type SideQuestionVersionReference = Readonly<{
  kind: 'artifact-version' | 'upload-version'
  versionId: string
  name: string
  sha256?: string
  sizeBytes?: number
}>

export type SideQuestionContextMessage = Readonly<{
  id: string
  role: 'user' | 'agent'
  content: string
  createdAt: number
}>

export type SideQuestionContext = Readonly<{
  messages: readonly SideQuestionContextMessage[]
  references: readonly SideQuestionVersionReference[]
  truncated: boolean
  stableTurnId?: string
}>

export type SideQuestionParentSnapshot = Readonly<{
  projectId: string
  sessionId: string
  graphId: string
  agentRunId: string
  frameId: string
  promptMessageId: string
  backend: Extract<AgentFrameworkId, 'codex' | 'opencode'>
  runtimeSessionId: string
  runtimeThreadId?: string
  parentRuntimeThreadId?: string
  activeTurnId?: string
  lastStableTurnId?: string
  model?: string
  modelProvider?: string
  cwd: string
  cancellationGeneration: number
}>

export type SideQuestionRuntimeInput = Readonly<{
  question: string
  context: SideQuestionContext
  signal: AbortSignal
}>

export type SideQuestionRuntimeSession = Readonly<{
  runtimeSessionId: string
  runtimeThreadId?: string
  model?: string
  modelProvider?: string
  run(input: SideQuestionRuntimeInput): Promise<string>
  cancel(): Promise<void>
  close(): Promise<void>
}>

export type SideQuestionRuntimeAdapter = Readonly<{
  backend: Extract<AgentFrameworkId, 'codex' | 'opencode'>
  create(input: {
    parent: SideQuestionParentSnapshot
    childAgentRunId: string
    childRuntimeSessionId: string
    context: SideQuestionContext
    question: string
  }): Promise<SideQuestionRuntimeSession>
}>

export type SideQuestionRendererRequest = Readonly<{
  sessionId: string
  question: string
  parts?: readonly unknown[]
  attachments?: readonly unknown[]
}>

export type SideQuestionAdmissionResult = Readonly<{
  status: 'accepted' | 'completed' | 'failed' | 'cancelled' | 'blocked'
  sessionId: string
  sideQuestion?: PersistedSideQuestion
  safeFailureCode?: string
}>

export const validateSideQuestionAdmissionResult = (
  value: unknown
): SideQuestionAdmissionResult => {
  if (!isRecord(value)) throw new Error('Side-question admission result is invalid.')
  if (
    !['accepted', 'completed', 'failed', 'cancelled', 'blocked'].includes(value.status as string)
  ) {
    throw new Error('Side-question admission status is invalid.')
  }
  const sessionId = assertIdentifier(value.sessionId, 'Side-question result Session id')
  if (value.sideQuestion !== undefined)
    validatePersistedSideQuestion(value.sideQuestion as PersistedSideQuestion)
  if (value.safeFailureCode !== undefined && !SAFE_ERROR_CODE.test(String(value.safeFailureCode))) {
    throw new Error('Side-question result failure code is invalid.')
  }
  return Object.freeze({
    status: value.status as SideQuestionAdmissionResult['status'],
    sessionId,
    ...(value.sideQuestion !== undefined
      ? { sideQuestion: value.sideQuestion as PersistedSideQuestion }
      : {}),
    ...(value.safeFailureCode !== undefined
      ? { safeFailureCode: String(value.safeFailureCode) }
      : {})
  })
}

export type SideQuestionParentResolver = (
  session: PersistedChatSession
) => Promise<SideQuestionParentSnapshot | undefined>

// This is the main-owned card stored beside the authoritative Session graph. It deliberately has no
// filesystem path, provider payload, credential, or renderer authority field. Runtime links remain
// in SQLite; this projection survives their ephemeral cleanup.
export type PersistedSideQuestion = Readonly<{
  id: string
  projectId: string
  sessionId: string
  parentGraphId: string
  parentAgentRunId: string
  childAgentRunId: string
  parentFrameId: string
  childFrameId: string
  parentPromptMessageId: string
  parentRuntimeThreadId?: string
  runtimeThreadId?: string
  runtimeSessionId?: string
  backend: Extract<AgentFrameworkId, 'codex' | 'opencode'>
  model?: string
  modelProvider?: string
  ephemeral: true
  sandbox: 'read-only'
  context: SideQuestionContext
  question: string
  lifecycle: SideQuestionLifecycle
  answer?: string
  answerTruncated?: boolean
  safeFailureCode?: string
  runtimeLinkClosed?: boolean
  runtimeDisposed?: boolean
  createdAt: number
  updatedAt: number
  completedAt?: number
}>

export const MAX_SIDE_QUESTION_CONTEXT_MESSAGES = 24
export const MAX_SIDE_QUESTION_CONTEXT_MESSAGE_CHARS = 8_000
export const MAX_SIDE_QUESTION_CONTEXT_CHARS = 64_000
export const MAX_SIDE_QUESTION_REFERENCES = 16
export const MAX_SIDE_QUESTION_QUESTION_CHARS = 64_000
export const MAX_SIDE_QUESTION_ANSWER_CHARS = 32_000

export const SIDE_QUESTION_RUNTIME_TIMEOUT_MS = 60_000
export const SIDE_QUESTION_MAX_OUTPUT_TOKENS = 4_096

const IDENTIFIER_PATTERN = /^[^\r\n]{1,256}$/u
const SAFE_ERROR_CODE = /^[a-z0-9][a-z0-9._-]{0,127}$/u

const assertIdentifier = (value: unknown, label: string): string => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\u0000') ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new Error(`${label} must be a non-empty bounded identifier.`)
  }
  return value
}

const assertTimestamp = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`)
  }
  return value as number
}

const assertBoundedText = (value: unknown, label: string, max: number): string => {
  if (typeof value !== 'string' || value.length > max) {
    throw new Error(`${label} is invalid or exceeds its bound.`)
  }
  return value
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const validateSideQuestionRendererRequest = (
  value: unknown
): SideQuestionRendererRequest => {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !['sessionId', 'question', 'parts', 'attachments'].includes(key)
    )
  ) {
    throw new Error('Side-question request contains unsupported fields.')
  }
  const sessionId = assertIdentifier(value.sessionId, 'Side-question Session id')
  const question = assertBoundedText(
    value.question,
    'Side-question question',
    MAX_SIDE_QUESTION_QUESTION_CHARS
  )
  if (!question.trim()) throw new Error('Side-question question must be non-empty.')
  if (value.parts !== undefined && !Array.isArray(value.parts)) {
    throw new Error('Side-question parts must be an array.')
  }
  if (value.attachments !== undefined && !Array.isArray(value.attachments)) {
    throw new Error('Side-question attachments must be an array.')
  }
  return Object.freeze({
    sessionId,
    question,
    ...(value.parts === undefined ? {} : { parts: Object.freeze([...value.parts]) }),
    ...(value.attachments === undefined
      ? {}
      : { attachments: Object.freeze([...value.attachments]) })
  })
}

export const validateSideQuestionVersionReference = (
  value: SideQuestionVersionReference
): SideQuestionVersionReference => {
  if (!isRecord(value)) {
    throw new Error('Side-question Version reference kind is invalid.')
  }
  const keys = new Set(['kind', 'versionId', 'name', 'sha256', 'sizeBytes'])
  if (Object.keys(value).some((key) => !keys.has(key)) || 'path' in value) {
    throw new Error('Side-question references must use immutable Version identities, not paths.')
  }
  if (!['artifact-version', 'upload-version'].includes(value.kind as string)) {
    throw new Error('Side-question Version reference kind is invalid.')
  }
  const versionId = assertIdentifier(value.versionId, 'Side-question Version id')
  const name = assertBoundedText(value.name, 'Side-question Version name', 512)
  if (!name.trim()) throw new Error('Side-question Version name must be non-empty.')
  if (value.sha256 !== undefined && !/^[0-9a-f]{64}$/iu.test(value.sha256)) {
    throw new Error('Side-question Version checksum is invalid.')
  }
  if (
    value.sizeBytes !== undefined &&
    (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0)
  ) {
    throw new Error('Side-question Version size is invalid.')
  }
  return Object.freeze({
    kind: value.kind,
    versionId,
    name,
    ...(value.sha256 ? { sha256: value.sha256.toLowerCase() } : {}),
    ...(value.sizeBytes === undefined ? {} : { sizeBytes: value.sizeBytes })
  })
}

export const validateSideQuestionContext = (value: SideQuestionContext): SideQuestionContext => {
  if (!isRecord(value) || !Array.isArray(value.messages) || !Array.isArray(value.references)) {
    throw new Error('Side-question context is invalid.')
  }
  if (value.messages.length > MAX_SIDE_QUESTION_CONTEXT_MESSAGES) {
    throw new Error('Side-question context contains too many messages.')
  }
  const messages = value.messages.map((message) => {
    if (!isRecord(message)) throw new Error('Side-question context message is invalid.')
    return Object.freeze({
      id: assertIdentifier(message.id, 'Side-question context message id'),
      role:
        message.role === 'user' || message.role === 'agent'
          ? message.role
          : (() => {
              throw new Error('Side-question context message role is invalid.')
            })(),
      content: assertBoundedText(
        message.content,
        'Side-question context message content',
        MAX_SIDE_QUESTION_CONTEXT_MESSAGE_CHARS
      ),
      createdAt: assertTimestamp(message.createdAt, 'Side-question context message createdAt')
    })
  })
  const references = value.references.map(validateSideQuestionVersionReference)
  if (references.length > MAX_SIDE_QUESTION_REFERENCES) {
    throw new Error('Side-question context contains too many Version references.')
  }
  const contextChars = messages.reduce((total, message) => total + message.content.length, 0)
  if (contextChars > MAX_SIDE_QUESTION_CONTEXT_CHARS) {
    throw new Error('Side-question context exceeds its character bound.')
  }
  return Object.freeze({
    messages: Object.freeze(messages),
    references: Object.freeze(references),
    truncated: value.truncated === true,
    ...(value.stableTurnId
      ? { stableTurnId: assertIdentifier(value.stableTurnId, 'Stable turn id') }
      : {})
  })
}

export const validatePersistedSideQuestion = (
  value: PersistedSideQuestion
): PersistedSideQuestion => {
  if (!isRecord(value)) throw new Error('Persisted side question is invalid.')
  const backend = value.backend
  if (backend !== 'codex' && backend !== 'opencode') {
    throw new Error('Persisted side-question backend is invalid.')
  }
  if (value.ephemeral !== true || value.sandbox !== 'read-only') {
    throw new Error('Persisted side-question runtime policy is invalid.')
  }
  if (!SIDE_QUESTION_LIFECYCLES.includes(value.lifecycle as SideQuestionLifecycle)) {
    throw new Error('Persisted side-question lifecycle is invalid.')
  }
  const question = assertBoundedText(
    value.question,
    'Side-question question',
    MAX_SIDE_QUESTION_QUESTION_CHARS
  )
  if (!question.trim()) throw new Error('Side-question question must be non-empty.')
  if (value.answer !== undefined) {
    assertBoundedText(value.answer, 'Side-question answer', MAX_SIDE_QUESTION_ANSWER_CHARS)
  }
  if (value.safeFailureCode !== undefined && !SAFE_ERROR_CODE.test(value.safeFailureCode)) {
    throw new Error('Side-question failure code is invalid.')
  }
  for (const [field, valueToCheck] of [
    ['createdAt', value.createdAt],
    ['updatedAt', value.updatedAt],
    ['completedAt', value.completedAt]
  ] as const) {
    if (valueToCheck !== undefined) assertTimestamp(valueToCheck, `Side-question ${field}`)
  }
  return Object.freeze({
    id: assertIdentifier(value.id, 'Side-question id'),
    projectId: assertIdentifier(value.projectId, 'Side-question project id'),
    sessionId: assertIdentifier(value.sessionId, 'Side-question session id'),
    parentGraphId: assertIdentifier(value.parentGraphId, 'Side-question parent graph id'),
    parentAgentRunId: assertIdentifier(value.parentAgentRunId, 'Side-question parent run id'),
    childAgentRunId: assertIdentifier(value.childAgentRunId, 'Side-question child run id'),
    parentFrameId: assertIdentifier(value.parentFrameId, 'Side-question parent frame id'),
    childFrameId: assertIdentifier(value.childFrameId, 'Side-question child frame id'),
    parentPromptMessageId: assertIdentifier(
      value.parentPromptMessageId,
      'Side-question parent prompt id'
    ),
    ...(value.parentRuntimeThreadId
      ? {
          parentRuntimeThreadId: assertIdentifier(
            value.parentRuntimeThreadId,
            'Parent runtime thread id'
          )
        }
      : {}),
    ...(value.runtimeThreadId
      ? {
          runtimeThreadId: assertIdentifier(
            value.runtimeThreadId,
            'Side-question runtime thread id'
          )
        }
      : {}),
    ...(value.runtimeSessionId
      ? {
          runtimeSessionId: assertIdentifier(
            value.runtimeSessionId,
            'Side-question runtime Session id'
          )
        }
      : {}),
    backend,
    ...(value.model ? { model: assertIdentifier(value.model, 'Side-question model') } : {}),
    ...(value.modelProvider
      ? { modelProvider: assertIdentifier(value.modelProvider, 'Side-question model provider') }
      : {}),
    ephemeral: true,
    sandbox: 'read-only',
    context: validateSideQuestionContext(value.context),
    question,
    lifecycle: value.lifecycle,
    ...(value.answer !== undefined ? { answer: value.answer } : {}),
    ...(value.answerTruncated ? { answerTruncated: true } : {}),
    ...(value.safeFailureCode ? { safeFailureCode: value.safeFailureCode } : {}),
    ...(value.runtimeLinkClosed ? { runtimeLinkClosed: true } : {}),
    ...(value.runtimeDisposed ? { runtimeDisposed: true } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.completedAt === undefined ? {} : { completedAt: value.completedAt })
  })
}

export const validateSideQuestionTransition = (
  current: SideQuestionLifecycle,
  next: SideQuestionLifecycle
): void => {
  if (!SIDE_QUESTION_LIFECYCLES.includes(current) || !SIDE_QUESTION_LIFECYCLES.includes(next)) {
    throw new Error('Side-question lifecycle is invalid.')
  }
  if (current === next) return
  const allowed: Readonly<Record<SideQuestionLifecycle, readonly SideQuestionLifecycle[]>> = {
    preparing: ['awaiting-approval', 'failed', 'cancelled', 'blocked'],
    'awaiting-approval': ['ready', 'failed', 'cancelled', 'blocked'],
    ready: ['starting', 'failed', 'cancelled', 'blocked'],
    starting: ['running', 'failed', 'cancelled', 'blocked'],
    running: ['completed', 'failed', 'cancelled', 'blocked'],
    completed: [],
    failed: [],
    cancelled: [],
    blocked: []
  }
  if (!allowed[current].includes(next)) {
    throw new Error(`Side-question cannot transition from ${current} to ${next}.`)
  }
}

const versionReferenceFromFileReference = (
  reference: FileReference
): SideQuestionVersionReference => {
  if (reference.source === 'linked-folder') {
    throw new Error('Side-question references must use immutable Version identities.')
  }
  const locator =
    reference.source === 'artifact'
      ? parseArtifactVersionLocator(reference.path)
      : parseUploadVersionReference(reference.path)
  const versionId = reference.versionId ?? locator?.versionId
  if (!versionId || !locator || locator.versionId !== versionId) {
    throw new Error('Side-question references must use immutable Version identities.')
  }
  return validateSideQuestionVersionReference({
    kind: reference.source === 'artifact' ? 'artifact-version' : 'upload-version',
    versionId,
    name: reference.name
  })
}

export const sideQuestionVersionReferencesFromInputs = (input: {
  parts?: readonly unknown[]
  attachments?: readonly unknown[]
}): readonly SideQuestionVersionReference[] => {
  const references: SideQuestionVersionReference[] = []
  for (const part of input.parts ?? []) {
    if (!isRecord(part) || part.type !== 'artifact') continue
    references.push(versionReferenceFromFileReference(part as unknown as FileReference))
  }
  for (const attachment of input.attachments ?? []) {
    if (!isRecord(attachment)) throw new Error('Side-question upload reference is invalid.')
    const versionId = attachment.versionId
    if (typeof versionId !== 'string' || !versionId.trim()) {
      throw new Error('Side-question uploads must use immutable Version identities.')
    }
    const name = typeof attachment.name === 'string' ? attachment.name : ''
    const rawSizeBytes = attachment.size
    const sizeBytes =
      typeof rawSizeBytes === 'number' && Number.isSafeInteger(rawSizeBytes) && rawSizeBytes >= 0
        ? rawSizeBytes
        : undefined
    const checksum = attachment.checksum ?? attachment.sha256
    references.push(
      validateSideQuestionVersionReference({
        kind: 'upload-version',
        versionId,
        name,
        ...(typeof checksum === 'string' ? { sha256: checksum } : {}),
        ...(sizeBytes === undefined ? {} : { sizeBytes })
      })
    )
  }
  if (references.length > MAX_SIDE_QUESTION_REFERENCES) {
    throw new Error('Side-question contains too many Version references.')
  }
  return Object.freeze(references)
}

export const captureStableSideQuestionContext = (input: {
  session: PersistedChatSession
  stableTurnId?: string
  references?: readonly SideQuestionVersionReference[]
}): SideQuestionContext => {
  const materialized = input.session.conversationGraph ? input.session.conversationGraph : undefined
  const activeBranchMessages = materialized
    ? resolveActiveConversationMessages(materialized)
    : (input.session.messages ?? [])
  const messages = activeBranchMessages
    .filter((message) => message.status === 'complete')
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt
    }))
  const selected = messages.slice(-MAX_SIDE_QUESTION_CONTEXT_MESSAGES)
  const contextMessages = selected
  let truncated = selected.length !== messages.length
  let chars = contextMessages.reduce((total, message) => total + message.content.length, 0)
  while (chars > MAX_SIDE_QUESTION_CONTEXT_CHARS && contextMessages.length > 0) {
    const removed = contextMessages.shift()
    chars -= removed?.content.length ?? 0
    truncated = true
  }
  return validateSideQuestionContext({
    messages: contextMessages,
    references: [...(input.references ?? [])].map(validateSideQuestionVersionReference),
    truncated,
    ...(input.stableTurnId ? { stableTurnId: input.stableTurnId } : {})
  })
}

export const sideQuestionPrompt = (context: SideQuestionContext, question: string): string => {
  const boundedQuestion = assertBoundedText(
    question,
    'Side-question question',
    MAX_SIDE_QUESTION_QUESTION_CHARS
  )
  const history = context.messages
    .map((message) => `${message.role.toUpperCase()} [${message.id}]: ${message.content}`)
    .join('\n')
  const references = context.references
    .map((reference) => `${reference.kind}:${reference.versionId} (${reference.name})`)
    .join(', ')
  return [
    'Answer the side question using only the bounded stable context below.',
    'This is a read-only child: do not write files, execute commands, use network expansion, compute, mutate settings, or request approval.',
    history ? `Stable context:\n${history}` : 'Stable context: (none)',
    references
      ? `Immutable Version references: ${references}`
      : 'Immutable Version references: (none)',
    `Side question:\n${boundedQuestion}`
  ].join('\n\n')
}

export const truncateSideQuestionAnswer = (
  value: string
): { answer: string; truncated: boolean } =>
  value.length > MAX_SIDE_QUESTION_ANSWER_CHARS
    ? { answer: `${value.slice(0, MAX_SIDE_QUESTION_ANSWER_CHARS)}\n…`, truncated: true }
    : { answer: value, truncated: false }
