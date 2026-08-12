import { describe, expect, it } from 'vitest'

import {
  CODEX_APP_SERVER_NOTIFICATION_METHODS,
  CODEX_APP_SERVER_OPTOUT_NOTIFICATION_METHODS,
  projectCodexNotification
} from './notification-projector'

describe('projectCodexNotification', () => {
  it('projects bounded assistant deltas without retaining the provider envelope', () => {
    const projection = projectCodexNotification({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        delta: 'The normalized cohort is stable.'
      }
    })

    expect(projection).toMatchObject({
      kind: 'projected',
      threadId: 'thread-1',
      turnId: 'turn-1',
      event: {
        kind: 'message',
        role: 'assistant',
        text: 'The normalized cohort is stable.',
        messageId: 'item-1'
      }
    })
    expect(projection.event).not.toHaveProperty('raw')
  })

  it('projects pinned token usage and marks the exact completed turn terminal', () => {
    const usage = projectCodexNotification({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          last: {
            inputTokens: 12,
            cachedInputTokens: 3,
            cacheWriteInputTokens: 0,
            outputTokens: 5,
            reasoningOutputTokens: 0,
            totalTokens: 20
          },
          total: {
            inputTokens: 12,
            cachedInputTokens: 3,
            cacheWriteInputTokens: 0,
            outputTokens: 5,
            reasoningOutputTokens: 0,
            totalTokens: 20
          },
          modelContextWindow: 272000
        }
      }
    })
    const projection = projectCodexNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'completed',
          items: []
        }
      }
    })

    expect(projection).toMatchObject({
      kind: 'projected',
      threadId: 'thread-1',
      turnId: 'turn-1',
      terminal: true,
      event: { kind: 'stop', status: 'completed' }
    })
    expect(usage.event?.turnUsage).toEqual({
      inputTokens: 12,
      cacheTokens: 3,
      cachedReadTokens: 3,
      cachedWriteTokens: 0,
      outputTokens: 5
    })
    expect(usage.event?.contextUsage).toEqual({ used: 20, size: 272000 })
  })

  it('does not project unknown or malformed notifications', () => {
    expect(
      projectCodexNotification({ method: 'thread/shellCommand', params: { threadId: 'thread-1' } })
    ).toEqual({ kind: 'ignored', reason: 'unsupported-notification' })
    expect(projectCodexNotification({ method: 'turn/started', params: {} })).toEqual({
      kind: 'malformed',
      reason: 'missing-thread-id'
    })
    expect(
      projectCodexNotification({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', delta: 'unbound output' }
      })
    ).toEqual({ kind: 'malformed', reason: 'missing-turn-id' })
  })

  it('keeps the allowlist explicit and stable', () => {
    expect(CODEX_APP_SERVER_NOTIFICATION_METHODS).toEqual(
      expect.arrayContaining(['turn/started', 'turn/completed', 'item/agentMessage/delta', 'error'])
    )
    expect(CODEX_APP_SERVER_NOTIFICATION_METHODS).not.toContain('process/exec')
    expect(CODEX_APP_SERVER_OPTOUT_NOTIFICATION_METHODS).toContain('remoteControl/status/changed')
    expect(
      CODEX_APP_SERVER_NOTIFICATION_METHODS.some((method) =>
        CODEX_APP_SERVER_OPTOUT_NOTIFICATION_METHODS.includes(
          method as (typeof CODEX_APP_SERVER_OPTOUT_NOTIFICATION_METHODS)[number]
        )
      )
    ).toBe(false)
  })
})
