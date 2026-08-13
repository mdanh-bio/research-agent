import { randomUUID } from 'node:crypto'

import type { PersistedRuntimeSegment } from '../../shared/conversation-graph'
import type { AgentRuntimePort, AgentRuntimeSandbox } from '../agent-runtime'

export type LegacyCodexHistoryEntry = Readonly<{
  role: 'user' | 'assistant' | 'tool'
  text: string
  completed: true
}>

export type LegacyCodexMigrationRequest = Readonly<{
  appSessionId: string
  agentRunId: string
  agentFrameId: string
  cwd: string
  sandbox: AgentRuntimeSandbox
  model?: string
  backendId?: string
  providerSessionId?: string
  providerIdentity: string
  activeTurnId?: string
  completedHistory: readonly LegacyCodexHistoryEntry[]
}>

export type CodexCompatibilityMigrationResult = Readonly<{
  contextReset: true
  oldProviderIdentity: string
  newRuntimeThreadId: string
  runtimeSegment: PersistedRuntimeSegment
  historyPreamble: string
  historyEntryCount: number
  historyTruncated: boolean
}>

export type CodexCompatibilityOwnerOptions = Readonly<{
  maxHistoryEntries?: number
  maxHistoryChars?: number
  idFactory?: () => string
  now?: () => number
  recordLegacyIdentity?: (input: {
    appSessionId: string
    providerIdentity: string
    providerSessionId?: string
    runtimeSegmentId: string
  }) => void | Promise<void>
}>

const DEFAULT_MAX_HISTORY_ENTRIES = 64
const DEFAULT_MAX_HISTORY_CHARS = 32_000

const requiredIdentifier = (value: unknown, label: string): string => {
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

const requiredText = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > DEFAULT_MAX_HISTORY_CHARS) {
    throw new Error(`${label} must be non-empty and bounded.`)
  }
  return value
}

const validateHistoryEntry = (value: LegacyCodexHistoryEntry): LegacyCodexHistoryEntry => {
  if (!value || typeof value !== 'object')
    throw new Error('Legacy completed history entry is invalid.')
  if (value.role !== 'user' && value.role !== 'assistant' && value.role !== 'tool') {
    throw new Error('Legacy completed history role is invalid.')
  }
  if (value.completed !== true)
    throw new Error('Legacy completed history accepts completed entries only.')
  return Object.freeze({
    ...value,
    text: requiredText(value.text, 'Legacy completed history text')
  })
}

const historyPreamble = (
  entries: readonly LegacyCodexHistoryEntry[],
  maxEntries: number,
  maxChars: number
): { text: string; count: number; truncated: boolean } => {
  const selected: string[] = []
  let chars = 0
  let truncated = entries.length > maxEntries
  for (const entry of entries.slice(-maxEntries)) {
    const validated = validateHistoryEntry(entry)
    const line = `${validated.role}: ${validated.text}`
    if (chars + line.length + 1 > maxChars) {
      truncated = true
      break
    }
    selected.push(line)
    chars += line.length + 1
  }
  return {
    text:
      selected.length === 0
        ? 'The prior ACP Codex context was reset. No bounded completed history was available.'
        : `The prior ACP Codex context was reset. Use this bounded completed history for continuity; do not claim the old provider session was resumed.\n\n${selected.join('\n')}`,
    count: selected.length,
    truncated
  }
}

// Keeps legacy ACP sessions on their existing path until idle. Migration is an explicit main-process
// operation that starts a fresh direct-app-server thread, creates a new runtime segment, and returns a
// bounded replay preamble. It never silently mutates an active ACP turn.
export class CodexCompatibilityOwner {
  private readonly maxHistoryEntries: number
  private readonly maxHistoryChars: number
  private readonly idFactory: () => string
  private readonly now: () => number

  constructor(
    private readonly runtime: Pick<AgentRuntimePort, 'start'>,
    options: CodexCompatibilityOwnerOptions = {}
  ) {
    this.maxHistoryEntries = options.maxHistoryEntries ?? DEFAULT_MAX_HISTORY_ENTRIES
    this.maxHistoryChars = options.maxHistoryChars ?? DEFAULT_MAX_HISTORY_CHARS
    this.idFactory = options.idFactory ?? randomUUID
    this.now = options.now ?? Date.now
    if (!Number.isSafeInteger(this.maxHistoryEntries) || this.maxHistoryEntries < 1) {
      throw new Error('Legacy Codex history entry limit is invalid.')
    }
    if (!Number.isSafeInteger(this.maxHistoryChars) || this.maxHistoryChars < 1) {
      throw new Error('Legacy Codex history character limit is invalid.')
    }
    this.recordLegacyIdentity = options.recordLegacyIdentity
  }

  private readonly recordLegacyIdentity: CodexCompatibilityOwnerOptions['recordLegacyIdentity']

  async migrate(request: LegacyCodexMigrationRequest): Promise<CodexCompatibilityMigrationResult> {
    const appSessionId = requiredIdentifier(request.appSessionId, 'Legacy Codex Session id')
    const providerIdentity = requiredIdentifier(
      request.providerIdentity,
      'Legacy Codex provider identity'
    )
    const agentRunId = requiredIdentifier(request.agentRunId, 'Legacy Codex Agent Run id')
    const agentFrameId = requiredIdentifier(request.agentFrameId, 'Legacy Codex Agent Frame id')
    if (request.providerSessionId !== undefined) {
      requiredIdentifier(request.providerSessionId, 'Legacy Codex provider Session id')
    }
    if (request.backendId !== undefined) requiredIdentifier(request.backendId, 'Codex backend id')
    if (request.model !== undefined) requiredIdentifier(request.model, 'Codex model')
    if (request.activeTurnId) {
      throw new Error('Legacy Codex ACP Session must be idle before explicit migration.')
    }
    request.completedHistory.forEach(validateHistoryEntry)
    const runtimeSegmentId = requiredIdentifier(this.idFactory(), 'Legacy Codex runtime segment id')
    const replay = historyPreamble(
      request.completedHistory,
      this.maxHistoryEntries,
      this.maxHistoryChars
    )
    const runtimeSegment: PersistedRuntimeSegment = {
      id: runtimeSegmentId,
      agentFrameId,
      frameworkId: 'codex',
      ...(request.backendId ? { backendId: request.backendId } : {}),
      ...(request.model ? { model: request.model } : {}),
      startedAt: this.now()
    }
    const session = await this.runtime.start({
      appSessionId,
      agentRunId,
      cwd: request.cwd,
      sandbox: request.sandbox,
      ...(request.model ? { model: request.model } : {})
    })
    await this.recordLegacyIdentity?.({
      appSessionId,
      providerIdentity,
      ...(request.providerSessionId ? { providerSessionId: request.providerSessionId } : {}),
      runtimeSegmentId: runtimeSegment.id
    })
    return Object.freeze({
      contextReset: true,
      oldProviderIdentity: providerIdentity,
      newRuntimeThreadId: session.runtimeThreadId,
      runtimeSegment,
      historyPreamble: replay.text,
      historyEntryCount: replay.count,
      historyTruncated: replay.truncated
    })
  }
}

export { CodexCompatibilityOwner as CodexAcpCompatibilityOwner }
