import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CodexAppServerClient } from './client'
import { CodexRuntimeGenerationOwner } from './codex-runtime'
import { InMemoryCodexRuntimeThreadLinkStore, type CodexRuntimeThreadLink } from './runtime-links'
import type { CodexAppServerTransport } from './types'

class FakeTransport implements CodexAppServerTransport {
  readonly writes: string[] = []
  private readonly lines = new Set<(line: string) => void>()
  private readonly closes = new Set<(error?: Error) => void>()

  write(message: string): void {
    this.writes.push(message)
  }

  onLine(listener: (line: string) => void): () => void {
    this.lines.add(listener)
    return () => this.lines.delete(listener)
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closes.add(listener)
    return () => this.closes.delete(listener)
  }

  async close(): Promise<void> {
    for (const listener of this.closes) listener()
  }

  receive(message: unknown): void {
    const line = typeof message === 'string' ? message : JSON.stringify(message)
    for (const listener of this.lines) listener(line)
  }
}

const parsedWrites = (transport: FakeTransport): Array<Record<string, unknown>> =>
  transport.writes.map((line) => JSON.parse(line) as Record<string, unknown>)

const threadResponse = (
  cwd: string,
  threadId: string,
  sandbox: 'readOnly' | 'workspaceWrite' = 'workspaceWrite',
  threadOverrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  thread: { id: threadId, ephemeral: false, forkedFromId: null, ...threadOverrides },
  model: 'model-1',
  modelProvider: 'provider-1',
  cwd,
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  sandbox:
    sandbox === 'readOnly'
      ? { type: 'readOnly', networkAccess: false }
      : {
          type: 'workspaceWrite',
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true
        }
})

const threadReadResponse = (
  cwd: string,
  threadId: string,
  turns: readonly Record<string, unknown>[],
  threadOverrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  thread: {
    id: threadId,
    ephemeral: false,
    forkedFromId: null,
    cwd,
    modelProvider: 'provider-1',
    turns,
    ...threadOverrides
  }
})

const terminalParams = (
  threadId: string,
  turnId: string,
  status: 'completed' | 'interrupted' | 'failed' = 'completed'
): Record<string, unknown> => ({
  threadId,
  turn: { id: turnId, status, items: [] }
})

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

describe('CodexRuntimeGenerationOwner', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  const createOwner = async (
    options: {
      links?: InMemoryCodexRuntimeThreadLinkStore
      linksFactory?: (root: string) => InMemoryCodexRuntimeThreadLinkStore
      onApprovalRequest?: NonNullable<
        ConstructorParameters<typeof CodexRuntimeGenerationOwner>[0]['onApprovalRequest']
      >
      onApprovalSettled?: NonNullable<
        ConstructorParameters<typeof CodexRuntimeGenerationOwner>[0]['onApprovalSettled']
      >
      releaseCredentialLease?: NonNullable<
        ConstructorParameters<typeof CodexRuntimeGenerationOwner>[0]['releaseCredentialLease']
      >
    } = {}
  ): Promise<{
    owner: CodexRuntimeGenerationOwner
    transport: FakeTransport
    links: InMemoryCodexRuntimeThreadLinkStore
  }> => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'research-agent-codex-runtime-owner-')))
    const transport = new FakeTransport()
    const links =
      options.linksFactory?.(root) ?? options.links ?? new InMemoryCodexRuntimeThreadLinkStore()
    const owner = new CodexRuntimeGenerationOwner({
      applicationVersion: '0.1.0',
      dataRoot: root,
      authorizedRoots: [root],
      defaultCwd: root,
      workspaceWriteRoots: [root],
      links,
      onApprovalRequest: options.onApprovalRequest,
      onApprovalSettled: options.onApprovalSettled,
      releaseCredentialLease: options.releaseCredentialLease,
      startClient: async ({ ownedThreadIds }) => {
        const client = new CodexAppServerClient(transport, {
          authorizedRoots: [root as string],
          defaultCwd: root as string,
          workspaceWriteRoots: [root as string],
          ownedThreadIds
        })
        const initialize = client.initialize({
          name: 'research_agent',
          title: 'Research Agent',
          version: '0.1.0'
        })
        transport.receive({ id: 0, result: { platformOs: 'macos' } })
        await initialize
        return client
      }
    })
    return { owner, transport, links }
  }

  it('owns a root thread, projects a complete turn, and keeps exact link state', async () => {
    const { owner, transport, links } = await createOwner()
    const events: unknown[] = []
    owner.onEvent((event) => events.push(event))

    const session = owner.start({
      appSessionId: 'session-1',
      agentRunId: 'run-1',
      cwd: root as string,
      model: 'model-1',
      modelProvider: 'provider-1',
      sandbox: 'workspace-write',
      ephemeral: false
    })
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'thread/start', id: 1 })
    )
    transport.receive({
      id: 1,
      result: threadResponse(root as string, 'thread-1')
    })
    await expect(session).resolves.toMatchObject({
      appSessionId: 'session-1',
      runtimeThreadId: 'thread-1',
      status: 'idle',
      model: 'model-1',
      modelProvider: 'provider-1'
    })

    const turn = owner.startTurn({
      appSessionId: 'session-1',
      input: [{ kind: 'text', text: 'Analyze cohort A.' }],
      clientUserMessageId: 'message-1'
    })
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'turn/start', id: 2 })
    )
    transport.receive({ id: 2, result: { turn: { id: 'turn-1' } } })
    await expect(turn).resolves.toMatchObject({ runtimeTurnId: 'turn-1' })

    transport.receive({
      method: 'turn/started',
      params: { threadId: 'thread-1', turnId: 'turn-1' }
    })
    transport.receive({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        delta: 'Cohort A is stable.'
      }
    })
    transport.receive({
      method: 'turn/completed',
      params: terminalParams('thread-1', 'turn-1')
    })

    const read = owner.readState('session-1')
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'thread/read', id: 3 })
    )
    transport.receive({
      id: 3,
      result: threadReadResponse(root as string, 'thread-1', [
        { id: 'turn-1', status: 'completed' }
      ])
    })
    await expect(read).resolves.toMatchObject({
      status: 'idle',
      lastTerminalTurnId: 'turn-1'
    })
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runtimeThreadId: 'thread-1',
          event: expect.objectContaining({ kind: 'message' })
        }),
        expect.objectContaining({ terminal: true, runtimeTurnId: 'turn-1' })
      ])
    )
    await expect(links.listActive()).resolves.toHaveLength(1)
    await owner.close()
    await expect(links.listActive()).resolves.toEqual([])
  })

  it('keeps an interrupted turn active until matching terminal confirmation', async () => {
    const { owner, transport, links } = await createOwner()
    const session = owner.start({
      appSessionId: 'session-1',
      agentRunId: 'run-1',
      cwd: root as string,
      sandbox: 'workspace-write',
      ephemeral: false
    })
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'thread/start', id: 1 })
    )
    transport.receive({ id: 1, result: threadResponse(root as string, 'thread-1') })
    await session
    const turn = owner.startTurn({
      appSessionId: 'session-1',
      input: [{ kind: 'text', text: 'Keep working.' }]
    })
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'turn/start', id: 2 })
    )
    transport.receive({ id: 2, result: { turn: { id: 'turn-1' } } })
    await turn

    const cancel = owner.cancel('session-1', 'turn-1')
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'turn/interrupt', id: 3 })
    )
    transport.receive({ id: 3, result: {} })
    await cancel
    await expect(links.listActive()).resolves.toHaveLength(1)

    const stillActive = owner.readState('session-1')
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'thread/read', id: 4 })
    )
    transport.receive({
      id: 4,
      result: threadReadResponse(root as string, 'thread-1', [])
    })
    await expect(stillActive).resolves.toMatchObject({
      status: 'cancelling',
      activeTurnId: 'turn-1'
    })

    transport.receive({
      method: 'turn/completed',
      params: terminalParams('thread-1', 'turn-1', 'interrupted')
    })
    await owner.close()
  })

  it('reads ephemeral thread metadata without requesting unsupported turn history', async () => {
    const { owner, transport } = await createOwner()
    const session = owner.start({
      appSessionId: 'session-ephemeral',
      agentRunId: 'run-ephemeral',
      cwd: root as string,
      model: 'model-1',
      modelProvider: 'provider-1',
      sandbox: 'read-only',
      ephemeral: true
    })
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'thread/start', id: 1 })
    )
    transport.receive({
      id: 1,
      result: threadResponse(root as string, 'thread-ephemeral', 'readOnly', { ephemeral: true })
    })
    await session

    const read = owner.readState('session-ephemeral')
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toEqual({
        method: 'thread/read',
        id: 2,
        params: { threadId: 'thread-ephemeral', includeTurns: false }
      })
    )
    transport.receive({
      id: 2,
      result: threadReadResponse(root as string, 'thread-ephemeral', [], { ephemeral: true })
    })
    await expect(read).resolves.toMatchObject({ status: 'idle', ephemeral: true })
    await owner.close()
  })

  it('bridges exact approvals and declines requests for foreign threads', async () => {
    const approvals: string[] = []
    const settlements: Array<[string, string]> = []
    const { owner, transport } = await createOwner({
      onApprovalRequest: ({ projection }) => {
        approvals.push(projection.requestId)
        return 'accept'
      },
      onApprovalSettled: (requestId, state) => settlements.push([requestId, state])
    })
    const session = owner.start({
      appSessionId: 'session-1',
      agentRunId: 'run-1',
      cwd: root as string,
      sandbox: 'workspace-write',
      ephemeral: false
    })
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'thread/start', id: 1 })
    )
    transport.receive({ id: 1, result: threadResponse(root as string, 'thread-1') })
    await session
    const turn = owner.startTurn({
      appSessionId: 'session-1',
      input: [{ kind: 'text', text: 'Approval-bound work.' }]
    })
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'turn/start', id: 2 })
    )
    transport.receive({ id: 2, result: { turn: { id: 'turn-1' } } })
    await turn

    transport.receive({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        itemId: 'item-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 1,
        command: 'python analysis.py'
      }
    })
    await vi.waitFor(() => expect(approvals).toEqual(['approval-1']))
    expect(parsedWrites(transport).at(-1)).toEqual({
      id: 'approval-1',
      result: { decision: 'accept' }
    })
    expect(settlements).toEqual([['approval-1', 'resolved']])

    transport.receive({
      id: 'approval-foreign',
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'item-2', threadId: 'foreign-thread', turnId: 'turn-2', startedAtMs: 1 }
    })
    expect(parsedWrites(transport).at(-1)).toEqual({
      id: 'approval-foreign',
      result: { decision: 'decline' }
    })

    transport.receive({
      id: 'approval-stale',
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'item-stale', threadId: 'thread-1', turnId: 'turn-old', startedAtMs: 1 }
    })
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ id: 'approval-stale' })
    )
    expect(parsedWrites(transport).at(-1)).toEqual({
      id: 'approval-stale',
      result: { decision: 'decline' }
    })
    expect(approvals).toEqual(['approval-1'])
    expect(settlements).toEqual([
      ['approval-1', 'resolved'],
      ['approval-stale', 'rejected']
    ])
    transport.receive({
      method: 'turn/completed',
      params: terminalParams('thread-1', 'turn-1')
    })
    await owner.close()
  })

  it('settles close when terminal completion races the interrupt response', async () => {
    const { owner, transport, links } = await createOwner()
    const session = owner.start({
      appSessionId: 'session-1',
      agentRunId: 'run-1',
      cwd: root as string,
      sandbox: 'workspace-write',
      ephemeral: false
    })
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'thread/start', id: 1 })
    )
    transport.receive({ id: 1, result: threadResponse(root as string, 'thread-1') })
    await session
    const turn = owner.startTurn({
      appSessionId: 'session-1',
      input: [{ kind: 'text', text: 'Finish during cancellation.' }]
    })
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'turn/start', id: 2 })
    )
    transport.receive({ id: 2, result: { turn: { id: 'turn-1' } } })
    await turn

    const closing = owner.closeSession('session-1')
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'turn/interrupt', id: 3 })
    )
    transport.receive({
      method: 'turn/completed',
      params: terminalParams('thread-1', 'turn-1')
    })
    transport.receive({ id: 3, result: {} })

    await expect(closing).resolves.toBeUndefined()
    await expect(links.listActive()).resolves.toEqual([])
    await owner.close()
  })

  it('closes persisted links, rejects pending operations, and settles approvals when the process exits', async () => {
    const approvalStates: Array<[string, string]> = []
    const releaseCredentialLease = vi.fn()
    let resolveApproval: (() => void) | undefined
    const { owner, transport, links } = await createOwner({
      onApprovalRequest: () =>
        new Promise<'accept'>((resolve) => {
          resolveApproval = () => resolve('accept')
        }),
      onApprovalSettled: (requestId, state) => approvalStates.push([requestId, state]),
      releaseCredentialLease
    })
    const session = owner.start({
      appSessionId: 'session-1',
      agentRunId: 'run-1',
      cwd: root as string,
      sandbox: 'workspace-write',
      ephemeral: false
    })
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'thread/start', id: 1 })
    )
    transport.receive({ id: 1, result: threadResponse(root as string, 'thread-1') })
    await session

    const turn = owner.startTurn({
      appSessionId: 'session-1',
      input: [{ kind: 'text', text: 'Pending work.' }]
    })
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'turn/start', id: 2 })
    )
    transport.receive({ id: 2, result: { turn: { id: 'turn-1' } } })
    await turn
    transport.receive({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        itemId: 'item-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 1,
        command: 'python analysis.py'
      }
    })
    await vi.waitFor(() => expect(resolveApproval).toBeTypeOf('function'))

    const pendingRead = owner.readState('session-1')
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'thread/read', id: 3 })
    )

    await transport.close()
    await expect(pendingRead).rejects.toThrow('transport closed')
    await vi.waitFor(() => expect(links.listActive()).resolves.toEqual([]))
    expect(approvalStates).toEqual([['approval-1', 'cancelled']])
    await vi.waitFor(() => expect(releaseCredentialLease).toHaveBeenCalledOnce())
    resolveApproval?.()
    await owner.close()
  })

  it('serializes generation startup so concurrent sessions share one app-server process', async () => {
    const { owner, transport } = await createOwner()
    const first = owner.start({
      appSessionId: 'session-1',
      agentRunId: 'run-1',
      cwd: root as string,
      sandbox: 'workspace-write',
      ephemeral: false
    })
    const second = owner.start({
      appSessionId: 'session-1',
      agentRunId: 'run-2',
      cwd: root as string,
      sandbox: 'workspace-write',
      ephemeral: false
    })
    const secondRejected = second.then(
      () => {
        throw new Error('Expected concurrent duplicate Session start to be rejected.')
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain('already owned')
      }
    )
    await vi.waitFor(() =>
      expect(
        parsedWrites(transport).filter((message) => message.method === 'thread/start')
      ).toHaveLength(1)
    )
    transport.receive({ id: 1, result: threadResponse(root as string, 'thread-1') })
    await expect(first).resolves.toMatchObject({ appSessionId: 'session-1' })
    await secondRejected
    await owner.close()
  })

  it('fails closed when a terminal notification names a different or already completed turn', async () => {
    const { owner, transport } = await createOwner()
    const session = owner.start({
      appSessionId: 'session-1',
      agentRunId: 'run-1',
      cwd: root as string,
      sandbox: 'workspace-write',
      ephemeral: false
    })
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'thread/start', id: 1 })
    )
    transport.receive({ id: 1, result: threadResponse(root as string, 'thread-1') })
    await session
    const turn = owner.startTurn({
      appSessionId: 'session-1',
      input: [{ kind: 'text', text: 'Complete once.' }]
    })
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'turn/start', id: 2 })
    )
    transport.receive({ id: 2, result: { turn: { id: 'turn-1' } } })
    await turn
    transport.receive({
      method: 'turn/completed',
      params: terminalParams('thread-1', 'turn-1')
    })
    transport.receive({
      method: 'turn/completed',
      params: terminalParams('thread-1', 'turn-1')
    })
    await vi.waitFor(() => expect(owner.readState('session-1')).rejects.toThrow('unavailable'))
    await owner.close()
  })

  it('fails closed on notifications for an unowned thread', async () => {
    const { owner, transport } = await createOwner()
    const session = owner.start({
      appSessionId: 'session-1',
      agentRunId: 'run-1',
      cwd: root as string,
      sandbox: 'workspace-write',
      ephemeral: false
    })
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'thread/start', id: 1 })
    )
    transport.receive({ id: 1, result: threadResponse(root as string, 'thread-1') })
    await session

    transport.receive({
      method: 'item/agentMessage/delta',
      params: { threadId: 'foreign-thread', turnId: 'turn-foreign', delta: 'leak' }
    })
    await expect(owner.readState('session-1')).rejects.toThrow('unavailable')
    await owner.close()
  })

  it('forks only through the typed native capability and persists exact parent provenance', async () => {
    const { owner, transport, links } = await createOwner()
    const session = owner.start({
      appSessionId: 'session-1',
      agentRunId: 'run-1',
      cwd: root as string,
      sandbox: 'workspace-write',
      ephemeral: false
    })
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'thread/start', id: 1 })
    )
    transport.receive({ id: 1, result: threadResponse(root as string, 'thread-1') })
    await session

    const fork = owner.capabilities.nativeFork?.({
      parentAppSessionId: 'session-1',
      appSessionId: 'session-2',
      agentRunId: 'run-2',
      cwd: root as string,
      sandbox: 'read-only',
      ephemeral: false
    })
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'thread/fork', id: 2 })
    )
    transport.receive({
      id: 2,
      result: threadResponse(root as string, 'thread-2', 'readOnly', {
        ephemeral: true,
        forkedFromId: 'thread-1'
      })
    })
    await expect(fork).resolves.toMatchObject({
      appSessionId: 'session-2',
      runtimeThreadId: 'thread-2',
      parentRuntimeThreadId: 'thread-1',
      ephemeral: true,
      sandbox: 'read-only'
    })
    await expect(links.listActive()).resolves.toHaveLength(2)
    await owner.close()
  })

  it('rejects a resumed thread whose fork provenance drifts', async () => {
    const { owner, transport } = await createOwner({
      linksFactory: (authorizedCwd) =>
        new InMemoryCodexRuntimeThreadLinkStore({
          links: [link({ parentRuntimeThreadId: 'parent-1', authorizedCwd })]
        })
    })
    const resume = owner.resume({
      appSessionId: 'session-1',
      agentRunId: 'run-1',
      runtimeThreadId: 'thread-1',
      cwd: root as string,
      sandbox: 'read-only',
      model: 'model-1',
      modelProvider: 'provider-1',
      ephemeral: false,
      parentRuntimeThreadId: 'parent-1'
    })
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'thread/resume', id: 1 })
    )
    transport.receive({
      id: 1,
      result: threadResponse(root as string, 'thread-1', 'readOnly', {
        forkedFromId: 'foreign-parent'
      })
    })
    await expect(resume).rejects.toThrow('fork provenance')
    await owner.close()
  })

  it('rejects a resumed thread whose effective model drifts from the selected target', async () => {
    const { owner, transport } = await createOwner({
      linksFactory: (authorizedCwd) =>
        new InMemoryCodexRuntimeThreadLinkStore({
          links: [link({ authorizedCwd })]
        })
    })
    const resume = owner.resume({
      appSessionId: 'session-1',
      agentRunId: 'run-1',
      runtimeThreadId: 'thread-1',
      cwd: root as string,
      sandbox: 'read-only',
      model: 'model-1',
      modelProvider: 'provider-1',
      ephemeral: false
    })
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toMatchObject({ method: 'thread/resume', id: 1 })
    )
    transport.receive({
      id: 1,
      result: {
        ...threadResponse(root as string, 'thread-1', 'readOnly'),
        model: 'different-model'
      }
    })
    await expect(resume).rejects.toThrow('requested model')
    await owner.close()
  })

  it('rejects resume-policy drift before issuing thread/resume', async () => {
    const { owner, transport } = await createOwner({
      linksFactory: (authorizedCwd) =>
        new InMemoryCodexRuntimeThreadLinkStore({ links: [link({ authorizedCwd })] })
    })

    await expect(
      owner.resume({
        appSessionId: 'session-1',
        agentRunId: 'run-1',
        runtimeThreadId: 'thread-1',
        cwd: root as string,
        sandbox: 'workspace-write',
        model: 'model-1',
        modelProvider: 'provider-1',
        ephemeral: false
      })
    ).rejects.toThrow('sandbox differs from the durable link')
    expect(parsedWrites(transport).some((message) => message.method === 'thread/resume')).toBe(
      false
    )
    await owner.close()
  })
})
