import {
  sanitizeAcpContextUsage,
  toAcpTurnTokenUsage,
  type AcpContextUsage,
  type AcpRuntimeEvent,
  type AcpTurnTokenUsage
} from '../../shared/acp'
import type { CodexAppServerNotification } from './types'

type JsonRecord = Record<string, unknown>

export type CodexNotificationProjection = Readonly<{
  kind: 'projected' | 'ignored' | 'malformed'
  threadId?: string
  turnId?: string
  terminal?: boolean
  event?: Omit<AcpRuntimeEvent, 'id' | 'timestamp'>
  reason?: string
}>

export const CODEX_APP_SERVER_NOTIFICATION_METHODS = Object.freeze([
  'turn/started',
  'turn/completed',
  'thread/tokenUsage/updated',
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'item/mcpToolCall/progress',
  'item/started',
  'item/completed',
  'item/plan/delta',
  'error'
] as const)

// Codex 0.147.0 emits ambient account, remote-control, config, and process notifications even for a
// minimal app-server connection. Negotiate those exact pinned methods away during initialize so an
// unexpected method can still fail closed instead of forcing the client to accept a broad envelope.
export const CODEX_APP_SERVER_OPTOUT_NOTIFICATION_METHODS = Object.freeze([
  'account/login/completed',
  'account/rateLimits/updated',
  'account/updated',
  'app/list/updated',
  'command/exec/outputDelta',
  'configWarning',
  'deprecationNotice',
  'externalAgentConfig/import/completed',
  'externalAgentConfig/import/progress',
  'fs/changed',
  'fuzzyFileSearch/sessionCompleted',
  'fuzzyFileSearch/sessionUpdated',
  'guardianWarning',
  'hook/completed',
  'hook/started',
  'item/autoApprovalReview/completed',
  'item/autoApprovalReview/started',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/patchUpdated',
  'item/reasoning/textDelta',
  'mcpServer/oauthLogin/completed',
  'mcpServer/startupStatus/updated',
  'model/rerouted',
  'model/safetyBuffering/updated',
  'model/verification',
  'process/exited',
  'process/outputDelta',
  'remoteControl/status/changed',
  'serverRequest/resolved',
  'skills/changed',
  'thread/archived',
  'thread/closed',
  'thread/compacted',
  'thread/deleted',
  'thread/environment/connected',
  'thread/environment/disconnected',
  'thread/goal/cleared',
  'thread/goal/updated',
  'thread/name/updated',
  'thread/realtime/closed',
  'thread/realtime/error',
  'thread/realtime/itemAdded',
  'thread/realtime/outputAudio/delta',
  'thread/realtime/sdp',
  'thread/realtime/started',
  'thread/realtime/transcript/delta',
  'thread/realtime/transcript/done',
  'thread/settings/updated',
  'thread/started',
  'thread/status/changed',
  'thread/unarchived',
  'turn/diff/updated',
  'turn/moderationMetadata',
  'turn/plan/updated',
  'warning',
  'windows/worldWritableWarning',
  'windowsSandbox/setupCompleted'
] as const)

const ALLOWED_METHODS = new Set<string>(CODEX_APP_SERVER_NOTIFICATION_METHODS)
const TERMINAL_METHODS = new Set(['turn/completed'])
const TURN_SCOPED_METHODS = new Set<string>(
  CODEX_APP_SERVER_NOTIFICATION_METHODS.filter(
    (method) =>
      method.startsWith('turn/') ||
      method.startsWith('item/') ||
      method === 'thread/tokenUsage/updated' ||
      method === 'error'
  )
)
const MAX_TEXT_CHARS = 16_384
const MAX_TITLE_CHARS = 512

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const boundedString = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== 'string' || !value) return undefined
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
}

const requiredString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() && value.length <= 256 ? value : undefined

const recordAt = (value: unknown, key: string): JsonRecord | undefined =>
  isRecord(value) && isRecord(value[key]) ? value[key] : undefined

const stringAt = (value: unknown, ...keys: readonly string[]): string | undefined => {
  if (!isRecord(value)) return undefined
  for (const key of keys) {
    const candidate = requiredString(value[key])
    if (candidate) return candidate
  }
  return undefined
}

const numberAt = (value: unknown, ...keys: readonly string[]): number | undefined => {
  if (!isRecord(value)) return undefined
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0) {
      return candidate
    }
  }
  return undefined
}

const threadIdOf = (params: unknown): string | undefined =>
  stringAt(params, 'threadId') ??
  stringAt(recordAt(params, 'thread'), 'id') ??
  stringAt(recordAt(params, 'item'), 'threadId')

const turnIdOf = (params: unknown): string | undefined =>
  stringAt(params, 'turnId') ??
  stringAt(recordAt(params, 'turn'), 'id') ??
  stringAt(recordAt(params, 'item'), 'turnId')

const itemIdOf = (params: unknown): string | undefined =>
  stringAt(params, 'itemId') ?? stringAt(recordAt(params, 'item'), 'id')

const itemOf = (params: unknown): JsonRecord | undefined => recordAt(params, 'item')

const textOf = (params: unknown, item: JsonRecord | undefined): string | undefined => {
  const direct = stringAt(params, 'delta', 'text', 'summary', 'message')
  if (direct) return boundedString(direct, MAX_TEXT_CHARS)
  const nested = stringAt(item, 'delta', 'text', 'summary', 'message')
  return boundedString(nested, MAX_TEXT_CHARS)
}

const titleOf = (params: unknown, item: JsonRecord | undefined, fallback: string): string =>
  boundedString(
    stringAt(params, 'title', 'name') ?? stringAt(item, 'title', 'name'),
    MAX_TITLE_CHARS
  ) ?? fallback

const errorTextOf = (params: unknown): string | undefined => {
  const error = recordAt(params, 'error') ?? recordAt(recordAt(params, 'turn'), 'error')
  return boundedString(
    stringAt(error, 'message', 'detail') ?? stringAt(params, 'message', 'error'),
    MAX_TEXT_CHARS
  )
}

const normalizeUsage = (value: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(value)) return undefined
  const cachedReadTokens =
    value.cachedReadTokens ?? value.cachedInputTokens ?? value.cached_input_tokens
  const cachedWriteTokens =
    value.cachedWriteTokens ?? value.cacheWriteInputTokens ?? value.cached_write_tokens
  return {
    inputTokens: value.inputTokens ?? value.input_tokens,
    ...(cachedReadTokens === undefined ? {} : { cachedReadTokens }),
    ...(cachedWriteTokens === undefined ? {} : { cachedWriteTokens }),
    outputTokens: value.outputTokens ?? value.output_tokens,
    totalTokens: value.totalTokens ?? value.total_tokens,
    contextWindow: value.contextWindow ?? value.modelContextWindow,
    turnCount: value.turnCount ?? value.turn_count
  }
}

const usageOf = (params: unknown, scope: 'last' | 'total'): Record<string, unknown> | undefined => {
  if (!isRecord(params)) return undefined
  const envelope = recordAt(params, 'tokenUsage') ?? recordAt(params, 'usage')
  const scoped = envelope ? normalizeUsage(envelope[scope]) : undefined
  const usage =
    scoped ??
    normalizeUsage(envelope) ??
    normalizeUsage(recordAt(params, 'turn')?.usage) ??
    normalizeUsage(recordAt(params, 'turn')?.tokenUsage) ??
    normalizeUsage(params)
  if (!usage) return undefined
  if (scope === 'total' && envelope) {
    const contextWindow = numberAt(envelope, 'modelContextWindow', 'contextWindow')
    if (contextWindow !== undefined) usage.contextWindow = contextWindow
  }
  return usage
}

const contextUsageOf = (params: unknown): AcpContextUsage | undefined => {
  const usage = usageOf(params, 'total')
  if (!usage) return undefined
  const input = numberAt(usage, 'inputTokens')
  const cachedRead = numberAt(usage, 'cachedReadTokens') ?? 0
  const total = numberAt(usage, 'totalTokens', 'contextTokens')
  const used = total ?? (input === undefined ? undefined : input + cachedRead)
  if (used === undefined || !Number.isSafeInteger(used)) return undefined
  return sanitizeAcpContextUsage({
    used,
    ...(numberAt(usage, 'contextWindow', 'size')
      ? { size: numberAt(usage, 'contextWindow', 'size') }
      : {})
  })
}

const turnUsageOf = (params: unknown): AcpTurnTokenUsage | undefined => {
  const usage = usageOf(params, 'last')
  return usage ? toAcpTurnTokenUsage(usage) : undefined
}

const event = (
  kind: AcpRuntimeEvent['kind'],
  level: AcpRuntimeEvent['level'],
  title: string,
  extra: Partial<Omit<AcpRuntimeEvent, 'id' | 'timestamp' | 'kind' | 'level'>> = {}
): Omit<AcpRuntimeEvent, 'id' | 'timestamp'> => ({ kind, level, title, ...extra })

// Converts only the stable, bounded notification subset into the app's existing event projection.
// Unknown methods and raw provider envelopes are intentionally not exposed.
export const projectCodexNotification = (
  notification: CodexAppServerNotification
): CodexNotificationProjection => {
  if (!ALLOWED_METHODS.has(notification.method)) {
    return Object.freeze({ kind: 'ignored', reason: 'unsupported-notification' })
  }

  const threadId = threadIdOf(notification.params)
  if (!threadId) return Object.freeze({ kind: 'malformed', reason: 'missing-thread-id' })
  const turnId = turnIdOf(notification.params)
  const item = itemOf(notification.params)
  const method = notification.method
  const terminal = TERMINAL_METHODS.has(method)
  if (TURN_SCOPED_METHODS.has(method) && !turnId) {
    return Object.freeze({ kind: 'malformed', reason: 'missing-turn-id' })
  }

  if (method === 'turn/started') {
    if (!turnId) return Object.freeze({ kind: 'malformed', reason: 'missing-turn-id' })
    return Object.freeze({
      kind: 'projected',
      threadId,
      ...(turnId ? { turnId } : {}),
      event: event('system', 'info', 'Codex turn started', { status: 'in_progress' })
    })
  }

  if (terminal) {
    if (!turnId) return Object.freeze({ kind: 'malformed', reason: 'missing-turn-id' })
    const turnStatus = stringAt(recordAt(notification.params, 'turn'), 'status')
    if (turnStatus !== 'completed' && turnStatus !== 'interrupted' && turnStatus !== 'failed') {
      return Object.freeze({ kind: 'malformed', reason: 'invalid-terminal-status' })
    }
    const text = errorTextOf(notification.params)
    const terminalStatus =
      turnStatus === 'interrupted' ? 'cancelled' : turnStatus === 'failed' ? 'failed' : 'completed'
    return Object.freeze({
      kind: 'projected',
      threadId,
      ...(turnId ? { turnId } : {}),
      terminal: true,
      event:
        terminalStatus === 'failed'
          ? event('error', 'error', 'Codex turn failed', {
              status: terminalStatus,
              ...(text ? { text } : {}),
              ...(turnUsageOf(notification.params)
                ? { turnUsage: turnUsageOf(notification.params) }
                : {})
            })
          : event('stop', 'info', 'Codex turn completed', {
              status: terminalStatus,
              ...(turnUsageOf(notification.params)
                ? { turnUsage: turnUsageOf(notification.params) }
                : {})
            })
    })
  }

  if (method === 'thread/tokenUsage/updated') {
    const contextUsage = contextUsageOf(notification.params)
    const turnUsage = turnUsageOf(notification.params)
    return Object.freeze({
      kind: 'projected',
      threadId,
      ...(turnId ? { turnId } : {}),
      ...(contextUsage || turnUsage
        ? {
            event: event('system', 'info', 'Codex usage updated', {
              ...(contextUsage ? { contextUsage } : {}),
              ...(turnUsage ? { turnUsage } : {})
            })
          }
        : { event: event('system', 'info', 'Codex usage unavailable') })
    })
  }

  if (method === 'item/agentMessage/delta') {
    const text = textOf(notification.params, item)
    return Object.freeze({
      kind: 'projected',
      threadId,
      ...(turnId ? { turnId } : {}),
      event: event('message', 'info', 'Codex response', {
        role: 'assistant',
        status: 'in_progress',
        ...(itemIdOf(notification.params) ? { messageId: itemIdOf(notification.params) } : {}),
        ...(text ? { text } : {})
      })
    })
  }

  if (
    method === 'item/reasoning/summaryTextDelta' ||
    method === 'item/reasoning/summaryPartAdded'
  ) {
    const text = textOf(notification.params, item)
    return Object.freeze({
      kind: 'projected',
      threadId,
      ...(turnId ? { turnId } : {}),
      event: event('thought', 'info', 'Codex activity', {
        status: 'in_progress',
        ...(text ? { text } : {})
      })
    })
  }

  if (method === 'item/plan/delta') {
    return Object.freeze({
      kind: 'projected',
      threadId,
      ...(turnId ? { turnId } : {}),
      event: event('plan', 'info', 'Codex plan update', {
        status: 'in_progress',
        ...(textOf(notification.params, item) ? { text: textOf(notification.params, item) } : {})
      })
    })
  }

  if (method === 'error') {
    return Object.freeze({
      kind: 'projected',
      threadId,
      ...(turnId ? { turnId } : {}),
      event: event('error', 'error', 'Codex runtime error', {
        providerError: true,
        ...(errorTextOf(notification.params) ? { text: errorTextOf(notification.params) } : {})
      })
    })
  }

  if (method === 'item/started' || method === 'item/completed') {
    const itemType = stringAt(item, 'type')
    const itemId = itemIdOf(notification.params)
    if (!item || !itemType || !itemId) {
      return Object.freeze({ kind: 'malformed', reason: 'invalid-thread-item' })
    }
    const completed = method === 'item/completed'
    if (itemType === 'userMessage' || itemType === 'hookPrompt') {
      return Object.freeze({ kind: 'projected', threadId, ...(turnId ? { turnId } : {}) })
    }
    if (itemType === 'agentMessage') {
      const text = textOf(notification.params, item)
      return Object.freeze({
        kind: 'projected',
        threadId,
        ...(turnId ? { turnId } : {}),
        event: event('message', 'info', 'Codex response', {
          role: 'assistant',
          status: completed ? 'completed' : 'in_progress',
          messageId: itemId,
          ...(text ? { text } : {})
        })
      })
    }
    if (itemType === 'reasoning') {
      const text = textOf(notification.params, item)
      return Object.freeze({
        kind: 'projected',
        threadId,
        ...(turnId ? { turnId } : {}),
        event: event('thought', 'info', 'Codex activity', {
          status: completed ? 'completed' : 'in_progress',
          ...(text ? { text } : {})
        })
      })
    }
    if (itemType === 'plan') {
      const text = textOf(notification.params, item)
      return Object.freeze({
        kind: 'projected',
        threadId,
        ...(turnId ? { turnId } : {}),
        event: event('plan', 'info', 'Codex plan update', {
          status: completed ? 'completed' : 'in_progress',
          ...(text ? { text } : {})
        })
      })
    }
    if (
      itemType === 'enteredReviewMode' ||
      itemType === 'exitedReviewMode' ||
      itemType === 'contextCompaction'
    ) {
      return Object.freeze({
        kind: 'projected',
        threadId,
        ...(turnId ? { turnId } : {}),
        event: event('system', 'info', 'Codex runtime state changed', {
          status: completed ? 'completed' : 'in_progress'
        })
      })
    }
    const toolName =
      itemType === 'commandExecution'
        ? 'command execution'
        : itemType === 'fileChange'
          ? 'file change'
          : itemType === 'mcpToolCall'
            ? 'MCP tool'
            : itemType
    return Object.freeze({
      kind: 'projected',
      threadId,
      ...(turnId ? { turnId } : {}),
      event: event(
        'tool',
        completed ? 'info' : 'warning',
        titleOf(notification.params, item, toolName),
        {
          status: completed ? 'completed' : 'in_progress',
          providerToolName: toolName,
          toolCallId: itemId,
          ...(textOf(notification.params, item)
            ? { terminalOutput: textOf(notification.params, item) }
            : {})
        }
      )
    })
  }

  const completed = method.endsWith('/completed')
  const toolName = method.includes('commandExecution')
    ? 'command execution'
    : method.includes('fileChange')
      ? 'file change'
      : 'MCP tool'
  return Object.freeze({
    kind: 'projected',
    threadId,
    ...(turnId ? { turnId } : {}),
    event: event(
      'tool',
      completed ? 'info' : 'warning',
      titleOf(notification.params, item, toolName),
      {
        status: completed ? 'completed' : 'in_progress',
        providerToolName: toolName,
        toolCallId: itemIdOf(notification.params),
        ...(textOf(notification.params, item)
          ? { terminalOutput: textOf(notification.params, item) }
          : {})
      }
    )
  })
}
