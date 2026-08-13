import { describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import type { MessageDeliveryAdmissionResult } from '../../shared/message-delivery'
import { MessageDeliveryBackendRouter } from './message-delivery-router'

const session = (
  agentFrameworkId: PersistedChatSession['agentFrameworkId']
): PersistedChatSession =>
  ({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Delivery router',
    cwd: '/workspace',
    status: 'running',
    ...(agentFrameworkId ? { agentFrameworkId } : {}),
    messages: [],
    createdAt: 1,
    updatedAt: 1
  }) as PersistedChatSession

const accepted = (sessionId: string): MessageDeliveryAdmissionResult => ({
  status: 'accepted',
  sessionId
})

const sideQuestion = { ask: vi.fn() }

const request = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  sessionId: 'session-1',
  content: 'continue with the bounded task',
  requested: 'steer',
  ...extra
})

describe('MessageDeliveryBackendRouter', () => {
  it('selects the main-owned OpenCode or Codex owner without accepting renderer authority', async () => {
    const openCode = vi.fn(async () => accepted('session-1'))
    const codex = vi.fn(async () => accepted('session-1'))
    let current: 'codex' | 'opencode' | undefined = 'opencode'
    const router = new MessageDeliveryBackendRouter({
      sessions: {
        projectIdForSession: async () => 'project-1',
        loadSession: async () => session('opencode')
      },
      resolveBackend: () => current,
      openCode: { deliver: openCode },
      codex: { deliver: codex },
      sideQuestion
    })

    await expect(router.deliver(request())).resolves.toEqual({
      kind: 'delivery',
      ...accepted('session-1')
    })
    expect(openCode).toHaveBeenCalledOnce()
    expect(codex).not.toHaveBeenCalled()

    current = 'codex'
    await expect(router.deliver(request())).resolves.toEqual({
      kind: 'delivery',
      ...accepted('session-1')
    })
    expect(codex).toHaveBeenCalledOnce()
  })

  it('uses persisted OpenCode identity when the live runtime is detached', async () => {
    const openCode = vi.fn(async () => accepted('session-1'))
    const codex = vi.fn(async () => accepted('session-1'))
    const router = new MessageDeliveryBackendRouter({
      sessions: {
        projectIdForSession: async () => 'project-1',
        loadSession: async () => session('opencode')
      },
      resolveBackend: (loaded) => (loaded.agentFrameworkId === 'opencode' ? 'opencode' : undefined),
      openCode: { deliver: openCode },
      codex: { deliver: codex },
      sideQuestion
    })

    await expect(router.deliver(request())).resolves.toMatchObject({ status: 'accepted' })
    expect(openCode).toHaveBeenCalledOnce()
    expect(codex).not.toHaveBeenCalled()
  })

  it('blocks unsupported or unavailable backends and rejects forged authority fields', async () => {
    const openCode = vi.fn(async () => accepted('session-1'))
    const codex = vi.fn(async () => accepted('session-1'))
    const router = new MessageDeliveryBackendRouter({
      sessions: {
        projectIdForSession: async () => 'project-1',
        loadSession: async () => session('claude-code')
      },
      resolveBackend: () => undefined,
      openCode: { deliver: openCode },
      codex: { deliver: codex },
      sideQuestion
    })

    await expect(router.deliver(request())).resolves.toMatchObject({
      status: 'blocked',
      safeErrorCode: 'backend_unavailable'
    })
    await expect(router.deliver(request({ runtimeTurnId: 'forged-turn' }))).rejects.toThrow(
      /unsupported authority fields/i
    )
    expect(openCode).not.toHaveBeenCalled()
    expect(codex).not.toHaveBeenCalled()
  })
})
