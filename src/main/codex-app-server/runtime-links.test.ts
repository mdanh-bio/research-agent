import type { PrismaClient } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'

import {
  InMemoryCodexRuntimeThreadLinkStore,
  PrismaCodexRuntimeThreadLinkStore,
  type CodexRuntimeThreadLink
} from './runtime-links'

const link = (overrides: Partial<CodexRuntimeThreadLink> = {}): CodexRuntimeThreadLink => ({
  id: 'link-1',
  agentRunId: 'run-1',
  appSessionId: 'session-1',
  backend: 'codex',
  runtimeThreadId: 'thread-1',
  ephemeral: false,
  runtimeOwner: 'codex_app_server',
  authorizedCwd: '/workspace',
  sandbox: 'read-only',
  model: 'model-1',
  modelProvider: 'provider-1',
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  createdAt: 1,
  ...overrides
})

describe('InMemoryCodexRuntimeThreadLinkStore', () => {
  it('round-trips only validated active links and closes them idempotently', async () => {
    const store = new InMemoryCodexRuntimeThreadLinkStore()
    await store.save(link())

    await expect(store.listActive()).resolves.toEqual([link()])
    await store.close('thread-1', 2)
    await store.close('thread-1', 3)
    await expect(store.listActive()).resolves.toEqual([])
  })

  it('rejects duplicate active Session or thread ownership', async () => {
    const store = new InMemoryCodexRuntimeThreadLinkStore()
    await store.save(link())
    await expect(store.save(link({ id: 'link-2', runtimeThreadId: 'thread-2' }))).rejects.toThrow(
      'Duplicate active Codex runtime Session'
    )
    await expect(store.save(link({ id: 'link-3', appSessionId: 'session-3' }))).rejects.toThrow(
      'Duplicate active Codex runtime thread'
    )
  })

  it('filters legacy ACP rows and persists the complete direct-runtime resume authority', async () => {
    const findMany = vi.fn(async () => [])
    const create = vi.fn(async () => undefined)
    const delegate = { findMany, create } as unknown as PrismaClient['runtimeThreadLink']
    const store = new PrismaCodexRuntimeThreadLinkStore(async () => delegate)

    await expect(store.listActive()).resolves.toEqual([])
    expect(findMany).toHaveBeenCalledWith({
      where: { backend: 'codex', runtimeOwner: 'codex_app_server', closedAt: null },
      orderBy: { createdAt: 'asc' }
    })
    await store.save(link())
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        runtimeOwner: 'codex_app_server',
        authorizedCwd: '/workspace',
        sandbox: 'read-only',
        model: 'model-1',
        modelProvider: 'provider-1',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user'
      })
    })
  })
})
