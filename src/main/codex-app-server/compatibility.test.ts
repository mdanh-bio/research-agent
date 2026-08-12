import { describe, expect, it, vi } from 'vitest'

import type { AgentRuntimePort, AgentRuntimeSessionState } from '../agent-runtime'
import { CodexCompatibilityOwner } from './compatibility'

const state: AgentRuntimeSessionState = {
  appSessionId: 'session-1',
  backend: 'codex',
  runtimeThreadId: 'new-thread',
  ephemeral: false,
  cwd: '/workspace',
  sandbox: 'workspace-write',
  status: 'idle',
  updatedAt: 2
}

describe('CodexCompatibilityOwner', () => {
  it('requires idle legacy ACP state and creates an explicit reset segment', async () => {
    const start = vi.fn(async () => state)
    const audit = vi.fn()
    const owner = new CodexCompatibilityOwner({ start } as Pick<AgentRuntimePort, 'start'>, {
      idFactory: () => 'segment-2',
      now: () => 2,
      recordLegacyIdentity: audit
    })

    await expect(
      owner.migrate({
        appSessionId: 'session-1',
        agentRunId: 'run-2',
        agentFrameId: 'frame-1',
        cwd: '/workspace',
        sandbox: 'workspace-write',
        providerIdentity: 'legacy-codex-acp',
        activeTurnId: 'turn-1',
        completedHistory: []
      })
    ).rejects.toThrow('must be idle')

    const migrated = await owner.migrate({
      appSessionId: 'session-1',
      agentRunId: 'run-2',
      agentFrameId: 'frame-1',
      cwd: '/workspace',
      sandbox: 'workspace-write',
      model: 'model-1',
      providerIdentity: 'legacy-codex-acp',
      providerSessionId: 'legacy-provider-session',
      completedHistory: [
        { role: 'user', text: 'Analyze cohort A.', completed: true },
        { role: 'assistant', text: 'Cohort A is stable.', completed: true }
      ]
    })

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ appSessionId: 'session-1', agentRunId: 'run-2' })
    )
    expect(migrated).toMatchObject({
      contextReset: true,
      oldProviderIdentity: 'legacy-codex-acp',
      newRuntimeThreadId: 'new-thread',
      runtimeSegment: {
        id: 'segment-2',
        frameworkId: 'codex',
        agentFrameId: 'frame-1'
      },
      historyEntryCount: 2,
      historyTruncated: false
    })
    expect(migrated.historyPreamble).toContain('do not claim the old provider session was resumed')
    expect(audit).toHaveBeenCalledWith({
      appSessionId: 'session-1',
      providerIdentity: 'legacy-codex-acp',
      providerSessionId: 'legacy-provider-session',
      runtimeSegmentId: 'segment-2'
    })
  })
})
