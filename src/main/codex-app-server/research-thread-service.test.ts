import { describe, expect, it, vi } from 'vitest'

import type { CodexAppServerClient } from './client'
import {
  CodexResearchThreadService,
  type ResearchThreadLink,
  type ResearchThreadLinkStore
} from './research-thread-service'

const createClient = (): CodexAppServerClient =>
  ({
    startThread: vi.fn(),
    forkThread: vi.fn(),
    startTurn: vi.fn(),
    steerTurn: vi.fn(),
    interruptTurn: vi.fn()
  }) as unknown as CodexAppServerClient

describe('CodexResearchThreadService', () => {
  it('creates a read-only ephemeral side fork without interrupting its parent', async () => {
    const client = createClient()
    vi.mocked(client.forkThread).mockResolvedValue({ thread: { id: 'side-thread' } })
    vi.mocked(client.startTurn).mockResolvedValue({ turn: { id: 'side-turn' } })
    const saved: ResearchThreadLink[] = []
    const links: ResearchThreadLinkStore = { save: async (link) => void saved.push(link) }
    const service = new CodexResearchThreadService(client, links)

    await expect(
      service.askSideQuestion({
        applicationSessionId: 'session-1',
        parentThreadId: 'parent-thread',
        text: 'Why did the analysis choose this normalization?'
      })
    ).resolves.toEqual({ threadId: 'side-thread', turnId: 'side-turn' })

    expect(client.forkThread).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'parent-thread',
        ephemeral: true,
        sandbox: 'read-only'
      })
    )
    expect(client.interruptTurn).not.toHaveBeenCalled()
    expect(saved).toEqual([
      {
        applicationSessionId: 'session-1',
        runtime: 'codex',
        threadId: 'side-thread',
        parentThreadId: 'parent-thread',
        relationship: 'side-question',
        ephemeral: true
      }
    ])
  })

  it('steers the exact active turn and preserves message bytes', async () => {
    const client = createClient()
    vi.mocked(client.steerTurn).mockResolvedValue({ turnId: 'turn-1' })
    const service = new CodexResearchThreadService(client, { save: async () => undefined })

    await expect(
      service.steer({
        threadId: 'thread-1',
        turnId: 'turn-1',
        text: 'Use cohort B instead.'
      })
    ).resolves.toBe('turn-1')
    expect(client.steerTurn).toHaveBeenCalledWith({
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'Use cohort B instead.', text_elements: [] }]
    })
  })

  it('interrupts before starting a replacement turn', async () => {
    const client = createClient()
    vi.mocked(client.interruptTurn).mockResolvedValue({})
    vi.mocked(client.startTurn).mockResolvedValue({ turn: { id: 'turn-2' } })
    const service = new CodexResearchThreadService(client, { save: async () => undefined })

    await expect(
      service.stopAndReplace({ threadId: 'thread-1', turnId: 'turn-1', text: 'Start over.' })
    ).resolves.toBe('turn-2')
    expect(client.interruptTurn).toHaveBeenCalledWith({
      threadId: 'thread-1',
      turnId: 'turn-1'
    })
    expect(client.startTurn).toHaveBeenCalledWith({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Start over.', text_elements: [] }]
    })
  })
})
