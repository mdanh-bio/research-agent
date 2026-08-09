import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'

let storageRoot: string | undefined
let disconnect: (() => Promise<void>) | undefined

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

describe('model routing persistence schema', () => {
  it('round-trips policy, run, attempt, and thread metadata without a message-content column', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'research-agent-routing-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await ensureProjectSchema(client)
    await ensureProjectSchema(client)

    await client.routingPolicySnapshot.create({
      data: {
        id: 'policy-snapshot-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        workClass: 'analysis',
        policyId: 'research_max.analysis',
        policyVersion: '1',
        policySource: 'shipped_default',
        policyJson: '{"id":"research_max.analysis"}',
        policyHash: 'sha256:policy'
      }
    })
    await client.agentRun.create({
      data: {
        id: 'run-1',
        policySnapshotId: 'policy-snapshot-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        promptMessageId: 'message-in-session-json',
        role: 'analyst',
        workClass: 'analysis',
        runtime: 'codex',
        status: 'running'
      }
    })
    await client.modelAttempt.create({
      data: {
        id: 'attempt-1',
        agentRunId: 'run-1',
        sequence: 0,
        trigger: 'initial',
        backend: 'codex',
        providerId: 'provider-1',
        model: 'model-1',
        reasoningEffort: 'high',
        targetDataBoundary: 'approved_cloud',
        requestHash: 'sha256:request'
      }
    })
    await client.runtimeThreadLink.create({
      data: {
        id: 'thread-link-1',
        agentRunId: 'run-1',
        appSessionId: 'session-1',
        backend: 'codex',
        runtimeThreadId: 'codex-thread-1',
        ephemeral: false
      }
    })

    await expect(
      client.agentRun.findUniqueOrThrow({
        where: { id: 'run-1' },
        include: { modelAttempts: true, runtimeThreadLinks: true, policySnapshot: true }
      })
    ).resolves.toMatchObject({
      promptMessageId: 'message-in-session-json',
      policySnapshot: { policyId: 'research_max.analysis' },
      modelAttempts: [{ requestHash: 'sha256:request', sideEffectsStarted: false }],
      runtimeThreadLinks: [{ runtimeThreadId: 'codex-thread-1' }]
    })

    const tables = ['RoutingPolicySnapshot', 'AgentRun', 'ModelAttempt', 'RuntimeThreadLink']
    for (const table of tables) {
      const columns = await client.$queryRawUnsafe<Array<{ name: string }>>(
        `PRAGMA table_info("${table}")`
      )
      expect(columns.map(({ name }) => name)).not.toContain('messageContent')
    }
  })
})
