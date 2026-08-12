import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CODEX_APP_SERVER_REQUEST_TIMEOUT_MS,
  MAX_CODEX_APP_SERVER_JSONL_BYTES,
  MAX_CODEX_APP_SERVER_NOTIFICATION_BYTES,
  CodexAppServerClient,
  CodexAppServerRpcError
} from './client'
import { CODEX_APP_SERVER_OPTOUT_NOTIFICATION_METHODS } from './notification-projector'
import type { CodexAppServerTransport } from './types'

class FakeTransport implements CodexAppServerTransport {
  readonly writes: string[] = []
  closeCalls = 0
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
    this.closeCalls += 1
    for (const listener of this.closes) listener()
  }

  receive(message: unknown): void {
    const line = typeof message === 'string' ? message : JSON.stringify(message)
    for (const listener of this.lines) listener(line)
  }

  terminate(error?: Error): void {
    for (const listener of this.closes) listener(error)
  }
}

const parsedWrites = (transport: FakeTransport): unknown[] =>
  transport.writes.map((line) => JSON.parse(line))

const threadResponse = (
  cwd: string,
  threadId: string,
  sandbox: 'readOnly' | 'workspaceWrite' = 'readOnly',
  overrides: Readonly<Record<string, unknown>> = {},
  threadOverrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> => ({
  thread: { id: threadId, ephemeral: false, forkedFromId: null, ...threadOverrides },
  model: 'test-model',
  modelProvider: 'test-provider',
  cwd,
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  sandbox:
    sandbox === 'readOnly'
      ? { type: sandbox, networkAccess: false }
      : {
          type: sandbox,
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true
        },
  ...overrides
})

const adapterOwnedConfig = {
  'sandbox_workspace_write.writable_roots': [],
  'sandbox_workspace_write.network_access': false,
  'sandbox_workspace_write.exclude_tmpdir_env_var': true,
  'sandbox_workspace_write.exclude_slash_tmp': true
}

const initialize = async (
  client: CodexAppServerClient,
  transport: FakeTransport
): Promise<void> => {
  const pending = client.initialize({
    name: 'research_agent',
    title: 'Research Agent',
    version: '0.1.0'
  })
  transport.receive({ id: 0, result: { userAgent: 'codex-test' } })
  await pending
}

describe('CodexAppServerClient', () => {
  let authorizedRoot: string
  let outsideRoot: string

  beforeEach(async () => {
    authorizedRoot = await realpath(await mkdtemp(join(tmpdir(), 'research-agent-codex-root-')))
    outsideRoot = await realpath(await mkdtemp(join(tmpdir(), 'research-agent-codex-outside-')))
  })

  afterEach(async () => {
    await Promise.all([
      rm(authorizedRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true })
    ])
  })

  const clientFor = (
    transport: CodexAppServerTransport,
    options: Partial<ConstructorParameters<typeof CodexAppServerClient>[1]> = {}
  ): CodexAppServerClient =>
    new CodexAppServerClient(transport, {
      authorizedRoots: [authorizedRoot],
      defaultCwd: authorizedRoot,
      ownedThreadIds: ['thread-1'],
      ...options
    })

  it('performs the required initialize then initialized handshake', async () => {
    const transport = new FakeTransport()
    const client = clientFor(transport)

    const pending = client.initialize({
      name: 'research_agent',
      title: 'Research Agent',
      version: '0.1.0'
    })
    expect(parsedWrites(transport)).toEqual([
      {
        method: 'initialize',
        id: 0,
        params: {
          clientInfo: {
            name: 'research_agent',
            title: 'Research Agent',
            version: '0.1.0'
          },
          capabilities: {
            experimentalApi: false,
            optOutNotificationMethods: CODEX_APP_SERVER_OPTOUT_NOTIFICATION_METHODS
          }
        }
      }
    ])

    transport.receive({ id: 0, result: { platformOs: 'macos' } })
    await expect(pending).resolves.toEqual({ platformOs: 'macos' })
    expect(parsedWrites(transport).at(-1)).toEqual({ method: 'initialized' })
    expect(client.isInitialized()).toBe(true)
  })

  it('rejects application methods before initialization', async () => {
    const client = clientFor(new FakeTransport())
    await expect(client.listThreads()).rejects.toThrow('requires initialization')
  })

  it('does not expose generic request, notification, or wire-write escape hatches', () => {
    const client = clientFor(new FakeTransport())
    const surface = client as unknown as Record<string, unknown>
    const prototypeMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(client))

    expect(surface.request).toBeUndefined()
    expect(surface.notify).toBeUndefined()
    expect(surface.onRequest).toBeUndefined()
    expect(surface.respond).toBeUndefined()
    expect(surface.respondError).toBeUndefined()
    expect(prototypeMethods).not.toEqual(
      expect.arrayContaining([
        'request',
        'notify',
        'onRequest',
        'respond',
        'respondError',
        'sendRequest',
        'sendNotification',
        'write'
      ])
    )
  })

  it('always initializes on the stable API even when an untyped caller supplies capabilities', async () => {
    const transport = new FakeTransport()
    const client = clientFor(transport)
    const pending = Reflect.apply(client.initialize, client, [
      { name: 'research_agent', title: 'Research Agent', version: '0.1.0' },
      { experimentalApi: true }
    ]) as Promise<unknown>

    expect(parsedWrites(transport)).toEqual([
      {
        method: 'initialize',
        id: 0,
        params: {
          clientInfo: {
            name: 'research_agent',
            title: 'Research Agent',
            version: '0.1.0'
          },
          capabilities: {
            experimentalApi: false,
            optOutNotificationMethods: CODEX_APP_SERVER_OPTOUT_NOTIFICATION_METHODS
          }
        }
      }
    ])
    transport.receive({ id: 0, result: {} })
    await pending
  })

  it('rejects full-access, arbitrary config, and turn-level policy overrides before writing', async () => {
    const transport = new FakeTransport()
    const client = clientFor(transport)
    await initialize(client, transport)
    const writesBefore = transport.writes.length

    expect(() =>
      Reflect.apply(client.startThread, client, [{ sandbox: 'danger-full-access' }])
    ).toThrow('full access is forbidden')
    expect(() =>
      Reflect.apply(client.startThread, client, [
        { config: { sandbox_mode: 'danger-full-access' } }
      ])
    ).toThrow('parameter config is not permitted')
    expect(() => Reflect.apply(client.startThread, client, [{ approvalPolicy: 'never' }])).toThrow(
      'parameter approvalPolicy is not permitted'
    )
    expect(() =>
      Reflect.apply(client.resumeThread, client, [
        'thread-1',
        { config: { experimental_process_api: true } }
      ])
    ).toThrow('parameter config is not permitted')
    expect(() =>
      Reflect.apply(client.resumeThread, client, ['thread-1', { sandbox: 'danger-full-access' }])
    ).toThrow('full access is forbidden')
    expect(() =>
      Reflect.apply(client.forkThread, client, [
        { threadId: 'thread-1', config: { experimental_process_api: true } }
      ])
    ).toThrow('parameter config is not permitted')
    expect(() =>
      Reflect.apply(client.startTurn, client, [
        {
          threadId: 'thread-1',
          input: [{ type: 'text', text: 'run it' }],
          sandboxPolicy: { type: 'dangerFullAccess' }
        }
      ])
    ).toThrow('parameter sandboxPolicy is not permitted')
    expect(() =>
      Reflect.apply(client.startTurn, client, [
        {
          threadId: 'thread-1',
          input: [{ type: 'text', text: 'run it' }],
          approvalPolicy: 'never'
        }
      ])
    ).toThrow('parameter approvalPolicy is not permitted')

    expect(transport.writes).toHaveLength(writesBefore)
  })

  it('pins safe sandbox and user approval defaults for start, resume, and fork', async () => {
    const transport = new FakeTransport()
    const client = clientFor(transport, {
      authorizedRoots: [authorizedRoot],
      workspaceWriteRoots: [authorizedRoot]
    })
    await initialize(client, transport)

    const start = client.startThread({ sandbox: 'workspace-write' })
    transport.receive({
      id: 1,
      result: threadResponse(authorizedRoot, 'thread-1', 'workspaceWrite')
    })
    await start
    const resume = client.resumeThread('thread-1')
    transport.receive({ id: 2, result: threadResponse(authorizedRoot, 'thread-1') })
    await resume
    const fork = client.forkThread({ threadId: 'thread-1', ephemeral: true })
    transport.receive({
      id: 3,
      result: threadResponse(
        authorizedRoot,
        'thread-2',
        'readOnly',
        {},
        {
          ephemeral: true,
          forkedFromId: 'thread-1'
        }
      )
    })
    await fork

    expect(parsedWrites(transport).slice(-3)).toEqual([
      {
        method: 'thread/start',
        id: 1,
        params: {
          cwd: authorizedRoot,
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          sandbox: 'workspace-write',
          config: adapterOwnedConfig
        }
      },
      {
        method: 'thread/resume',
        id: 2,
        params: {
          threadId: 'thread-1',
          cwd: authorizedRoot,
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          sandbox: 'read-only',
          config: adapterOwnedConfig
        }
      },
      {
        method: 'thread/fork',
        id: 3,
        params: {
          threadId: 'thread-1',
          ephemeral: true,
          cwd: authorizedRoot,
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          sandbox: 'read-only',
          config: adapterOwnedConfig
        }
      }
    ])
  })

  it('uses the approved default cwd and rejects outside or turn-overridden cwd values', async () => {
    const transport = new FakeTransport()
    const client = clientFor(transport, {
      authorizedRoots: [authorizedRoot],
      workspaceWriteRoots: [authorizedRoot]
    })
    await initialize(client, transport)
    const writesBefore = transport.writes.length

    expect(() => client.startThread({ cwd: outsideRoot, sandbox: 'workspace-write' })).toThrow(
      'authorized roots'
    )
    expect(() =>
      Reflect.apply(client.startTurn, client, [
        { threadId: 'thread-1', input: [], cwd: outsideRoot }
      ])
    ).toThrow('parameter cwd is not permitted')
    expect(transport.writes).toHaveLength(writesBefore)
  })

  it('fails closed when the server does not apply the requested thread trust boundary', async () => {
    const scenarios: Array<{
      request: Parameters<CodexAppServerClient['startThread']>[0]
      overrides: Readonly<Record<string, unknown>>
      expectedError: string
    }> = [
      {
        request: {},
        overrides: { approvalPolicy: 'never' },
        expectedError: 'approval policy'
      },
      {
        request: {},
        overrides: { approvalsReviewer: 'auto_review' },
        expectedError: 'route approvals to the user'
      },
      {
        request: {},
        overrides: { sandbox: { type: 'dangerFullAccess' } },
        expectedError: 'read-only sandbox'
      },
      {
        request: {},
        overrides: { sandbox: { type: 'readOnly', networkAccess: true } },
        expectedError: 'network access'
      },
      {
        request: {},
        overrides: { cwd: outsideRoot },
        expectedError: 'outside application-authorized roots'
      },
      {
        request: { model: 'expected-model' },
        overrides: { model: 'substituted-model' },
        expectedError: 'requested model'
      },
      {
        request: { modelProvider: 'expected-provider' },
        overrides: { modelProvider: 'substituted-provider' },
        expectedError: 'requested model provider'
      }
    ]

    for (const scenario of scenarios) {
      const transport = new FakeTransport()
      const client = clientFor(transport)
      await initialize(client, transport)
      const pending = client.startThread(scenario.request)
      transport.receive({
        id: 1,
        result: threadResponse(authorizedRoot, 'unsafe-thread', 'readOnly', scenario.overrides)
      })

      await expect(pending).rejects.toThrow(scenario.expectedError)
      expect(client.isInitialized()).toBe(false)
      expect(() => client.startThread()).toThrow('closed')
    }
  })

  it('fails closed when thread persistence or fork provenance drifts', async () => {
    const scenarios: Array<{
      request: (client: CodexAppServerClient) => Promise<unknown>
      result: Readonly<Record<string, unknown>>
      expectedError: string
    }> = [
      {
        request: (client) => client.startThread({ ephemeral: true }),
        result: threadResponse(authorizedRoot, 'ephemeral-thread'),
        expectedError: 'requested persistence mode'
      },
      {
        request: (client) => client.startThread(),
        result: threadResponse(authorizedRoot, 'malformed-thread', 'readOnly', {
          thread: { id: 'malformed-thread', forkedFromId: null }
        }),
        expectedError: 'ephemeral flag is invalid'
      },
      {
        request: (client) => client.forkThread({ threadId: 'thread-1', ephemeral: true }),
        result: threadResponse(
          authorizedRoot,
          'wrong-child',
          'readOnly',
          {},
          {
            ephemeral: true,
            forkedFromId: 'foreign-parent'
          }
        ),
        expectedError: 'incorrect fork provenance'
      }
    ]

    for (const scenario of scenarios) {
      const transport = new FakeTransport()
      const client = clientFor(transport)
      await initialize(client, transport)
      const pending = scenario.request(client)
      transport.receive({ id: 1, result: scenario.result })

      await expect(pending).rejects.toThrow(scenario.expectedError)
      expect(client.isInitialized()).toBe(false)
    }
  })

  it('requires the complete adapter-owned effective sandbox policy', async () => {
    const scenarios: Array<{
      sandbox: 'read-only' | 'workspace-write'
      effective: Readonly<Record<string, unknown>>
      expectedError: string
    }> = [
      {
        sandbox: 'read-only',
        effective: { type: 'readOnly' },
        expectedError: 'effective network access must be false'
      },
      {
        sandbox: 'workspace-write',
        effective: {
          type: 'workspaceWrite',
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true
        },
        expectedError: 'writable roots must be an array'
      },
      {
        sandbox: 'workspace-write',
        effective: {
          type: 'workspaceWrite',
          writableRoots: [authorizedRoot],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true
        },
        expectedError: 'unapproved additional writable roots'
      },
      {
        sandbox: 'workspace-write',
        effective: {
          type: 'workspaceWrite',
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: true
        },
        expectedError: 'unapproved temporary writable roots'
      }
    ]

    for (const scenario of scenarios) {
      const transport = new FakeTransport()
      const client = clientFor(transport, { workspaceWriteRoots: [authorizedRoot] })
      await initialize(client, transport)
      const pending = client.startThread({ sandbox: scenario.sandbox })
      transport.receive({
        id: 1,
        result: threadResponse(authorizedRoot, 'unsafe-thread', 'readOnly', {
          sandbox: scenario.effective
        })
      })

      await expect(pending).rejects.toThrow(scenario.expectedError)
      expect(client.isInitialized()).toBe(false)
    }
  })

  it('filters discovery and rejects every outbound operation for foreign threads', async () => {
    const transport = new FakeTransport()
    const client = clientFor(transport)
    await initialize(client, transport)

    const listing = client.listThreads<{ data: Array<{ id: string }>; nextCursor: string }>()
    transport.receive({
      id: 1,
      result: {
        data: [{ id: 'thread-1' }, { id: 'foreign-thread' }, { malformed: true }],
        nextCursor: 'next'
      }
    })
    await expect(listing).resolves.toEqual({ data: [{ id: 'thread-1' }], nextCursor: 'next' })
    const writesBefore = transport.writes.length

    expect(() => client.resumeThread('foreign-thread')).toThrow('not linked')
    expect(() => client.readThread('foreign-thread')).toThrow('not linked')
    expect(() => client.forkThread({ threadId: 'foreign-thread' })).toThrow('not linked')
    expect(() =>
      client.startTurn({
        threadId: 'foreign-thread',
        input: [{ type: 'text', text: 'inspect data' }]
      })
    ).toThrow('not linked')
    expect(() =>
      client.steerTurn({
        threadId: 'foreign-thread',
        expectedTurnId: 'turn-1',
        input: [{ type: 'text', text: 'change course' }]
      })
    ).toThrow('not linked')
    expect(() => client.interruptTurn({ threadId: 'foreign-thread', turnId: 'turn-1' })).toThrow(
      'not linked'
    )
    expect(transport.writes).toHaveLength(writesBefore)
  })

  it('canonicalizes every local input path and rejects local URL bypasses', async () => {
    const paths = {
      image: join(authorizedRoot, 'inputs', 'figure.png'),
      audio: join(authorizedRoot, 'inputs', 'notes.wav'),
      skill: join(authorizedRoot, 'skills', 'biology', 'SKILL.md'),
      mention: join(authorizedRoot, 'inputs', 'cohort.csv')
    }
    for (const [path, contents] of [
      [paths.image, 'png'],
      [paths.audio, 'wav'],
      [paths.skill, '# Biology'],
      [paths.mention, 'sample,value']
    ] as const) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, contents)
    }
    const transport = new FakeTransport()
    const client = clientFor(transport)
    await initialize(client, transport)

    const pending = client.startTurn({
      threadId: 'thread-1',
      input: [
        { type: 'localImage', path: paths.image, detail: 'high' },
        { type: 'localAudio', path: paths.audio },
        { type: 'skill', name: 'biology', path: paths.skill },
        { type: 'mention', name: 'cohort.csv', path: paths.mention }
      ]
    })
    transport.receive({ id: 1, result: { turn: { id: 'turn-1' } } })
    await pending
    expect(parsedWrites(transport).at(-1)).toEqual({
      method: 'turn/start',
      id: 1,
      params: {
        threadId: 'thread-1',
        input: [
          { type: 'localImage', path: await realpath(paths.image), detail: 'high' },
          { type: 'localAudio', path: await realpath(paths.audio) },
          { type: 'skill', name: 'biology', path: await realpath(paths.skill) },
          { type: 'mention', name: 'cohort.csv', path: await realpath(paths.mention) }
        ]
      }
    })

    const writesBefore = transport.writes.length
    expect(() =>
      client.startTurn({
        threadId: 'thread-1',
        input: [{ type: 'image', url: 'file:///etc/passwd' }]
      })
    ).toThrow('must use HTTPS, HTTP, or an inline data URL')
    expect(transport.writes).toHaveLength(writesBefore)
  })

  it.skipIf(process.platform === 'win32')(
    'rejects cwd and local-input paths that escape through symlinks',
    async () => {
      const outsideFile = join(outsideRoot, 'private.png')
      const inputLink = join(authorizedRoot, 'linked.png')
      const directoryLink = join(authorizedRoot, 'linked-directory')
      await writeFile(outsideFile, 'private')
      await symlink(outsideFile, inputLink)
      await symlink(outsideRoot, directoryLink)
      const transport = new FakeTransport()
      const client = clientFor(transport, {
        authorizedRoots: [authorizedRoot],
        workspaceWriteRoots: [authorizedRoot]
      })
      await initialize(client, transport)
      const writesBefore = transport.writes.length

      expect(() =>
        client.startTurn({
          threadId: 'thread-1',
          input: [{ type: 'localImage', path: inputLink }]
        })
      ).toThrow('outside application-authorized roots')
      expect(() => client.startThread({ cwd: directoryLink, sandbox: 'workspace-write' })).toThrow(
        'outside application-authorized roots'
      )
      expect(transport.writes).toHaveLength(writesBefore)
    }
  )

  it('declines unattended or invalid approvals and denies unknown server requests', async () => {
    const transport = new FakeTransport()
    const client = clientFor(transport)
    await initialize(client, transport)

    transport.receive({
      id: 'unattended',
      method: 'item/fileChange/requestApproval',
      params: { itemId: 'item-1', threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 1 }
    })
    expect(parsedWrites(transport).at(-1)).toEqual({
      id: 'unattended',
      result: { decision: 'decline' }
    })

    transport.receive({
      id: 'invalid',
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'item-2', threadId: 'thread-1' }
    })
    expect(parsedWrites(transport).at(-1)).toMatchObject({
      id: 'invalid',
      error: { code: -32602 }
    })

    transport.receive({ id: 'unknown', method: 'thread/shellCommand', params: {} })
    expect(parsedWrites(transport).at(-1)).toEqual({
      id: 'unknown',
      error: {
        code: -32601,
        message: 'Research Agent denies unsupported app-server requests.'
      }
    })
  })

  it('declines session-scoped file grant requests without consulting the approval handler', async () => {
    const transport = new FakeTransport()
    const client = clientFor(transport)
    await initialize(client, transport)
    const handler = vi.fn(() => 'accept' as const)
    client.setApprovalHandler(handler)

    transport.receive({
      id: 'grant-root',
      method: 'item/fileChange/requestApproval',
      params: {
        itemId: 'item-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 1,
        grantRoot: outsideRoot
      }
    })

    expect(handler).not.toHaveBeenCalled()
    expect(parsedWrites(transport).at(-1)).toEqual({
      id: 'grant-root',
      result: { decision: 'decline' }
    })
  })

  it('declines approvals that are not linked to an owned Research Agent thread', async () => {
    const transport = new FakeTransport()
    const client = clientFor(transport)
    await initialize(client, transport)
    const handler = vi.fn(() => 'accept' as const)
    client.setApprovalHandler(handler)

    transport.receive({
      id: 'foreign-thread',
      method: 'item/commandExecution/requestApproval',
      params: {
        itemId: 'item-1',
        threadId: 'foreign-thread',
        turnId: 'turn-1',
        startedAtMs: 1,
        command: 'touch foreign.txt'
      }
    })

    expect(handler).not.toHaveBeenCalled()
    expect(parsedWrites(transport).at(-1)).toEqual({
      id: 'foreign-thread',
      result: { decision: 'decline' }
    })
  })

  it('fails closed when an untyped approval handler returns a session-wide decision', async () => {
    const transport = new FakeTransport()
    const client = clientFor(transport)
    await initialize(client, transport)
    client.setApprovalHandler((() => 'acceptForSession') as never)

    transport.receive({
      id: 'approval-1',
      method: 'item/fileChange/requestApproval',
      params: { itemId: 'item-1', threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 1 }
    })
    await vi.waitFor(() =>
      expect(parsedWrites(transport).at(-1)).toEqual({
        id: 'approval-1',
        result: { decision: 'decline' }
      })
    )
  })

  it('does not send a late approval after app-server clears the pending request', async () => {
    const transport = new FakeTransport()
    const client = clientFor(transport)
    await initialize(client, transport)
    let resolveDecision: ((decision: 'accept') => void) | undefined
    client.setApprovalHandler(
      () =>
        new Promise<'accept'>((resolve) => {
          resolveDecision = resolve
        })
    )
    const writesBefore = transport.writes.length

    transport.receive({
      id: 'approval-1',
      method: 'item/fileChange/requestApproval',
      params: { itemId: 'item-1', threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 1 }
    })
    await vi.waitFor(() => expect(resolveDecision).toBeTypeOf('function'))
    transport.receive({
      method: 'serverRequest/resolved',
      params: { threadId: 'thread-1', requestId: 'approval-1' }
    })
    resolveDecision?.('accept')
    await new Promise((resolve) => setImmediate(resolve))

    expect(transport.writes).toHaveLength(writesBefore)
  })

  it('sends stable thread, steer, fork, and interrupt wire shapes', async () => {
    const transport = new FakeTransport()
    const client = clientFor(transport)
    await initialize(client, transport)

    const fork = client.forkThread({ threadId: 'thread-1', ephemeral: true })
    transport.receive({
      id: 1,
      result: threadResponse(
        authorizedRoot,
        'thread-2',
        'readOnly',
        {},
        {
          ephemeral: true,
          forkedFromId: 'thread-1'
        }
      )
    })
    await fork

    const steer = client.steerTurn({
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'Use the corrected dataset.' }]
    })
    transport.receive({ id: 2, result: { turnId: 'turn-1' } })
    await steer

    const interrupt = client.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' })
    transport.receive({ id: 3, result: {} })
    await interrupt

    expect(parsedWrites(transport).slice(-3)).toEqual([
      {
        method: 'thread/fork',
        id: 1,
        params: {
          threadId: 'thread-1',
          ephemeral: true,
          cwd: authorizedRoot,
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          sandbox: 'read-only',
          config: adapterOwnedConfig
        }
      },
      {
        method: 'turn/steer',
        id: 2,
        params: {
          threadId: 'thread-1',
          expectedTurnId: 'turn-1',
          input: [{ type: 'text', text: 'Use the corrected dataset.' }]
        }
      },
      {
        method: 'turn/interrupt',
        id: 3,
        params: { threadId: 'thread-1', turnId: 'turn-1' }
      }
    ])
  })

  it('routes notifications and approvals through separate typed interfaces', async () => {
    const transport = new FakeTransport()
    const client = clientFor(transport)
    await initialize(client, transport)
    const notifications: unknown[] = []
    const requests: unknown[] = []
    client.onNotification((notification) => notifications.push(notification))
    client.setApprovalHandler((request) => {
      requests.push(request)
      return 'accept'
    })

    transport.receive({ method: 'turn/completed', params: { threadId: 'thread-1' } })
    transport.receive({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        itemId: 'item-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 1,
        command: 'python analysis.py',
        cwd: authorizedRoot
      }
    })
    await vi.waitFor(() => expect(requests).toHaveLength(1))

    expect(notifications).toEqual([{ method: 'turn/completed', params: { threadId: 'thread-1' } }])
    expect(requests).toEqual([
      {
        kind: 'command-execution',
        requestId: 'approval-1',
        itemId: 'item-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 1,
        command: 'python analysis.py',
        cwd: authorizedRoot
      }
    ])
    expect(parsedWrites(transport).at(-1)).toEqual({
      id: 'approval-1',
      result: { decision: 'accept' }
    })
  })

  it('returns typed RPC errors and rejects pending work when transport closes', async () => {
    const transport = new FakeTransport()
    const client = clientFor(transport, { ownedThreadIds: ['thread-1', 'missing'] })
    await initialize(client, transport)

    const failed = client.readThread('missing')
    transport.receive({ id: 1, error: { code: -32_001, message: 'missing thread' } })
    await expect(failed).rejects.toMatchObject({
      code: -32_001,
      message: 'missing thread'
    } satisfies Partial<CodexAppServerRpcError>)

    const pending = client.listThreads()
    transport.terminate(new Error('process exited'))
    await expect(pending).rejects.toThrow('process exited')
    await client.close()
    expect(transport.closeCalls).toBe(1)
  })

  it('redacts structured RPC error data while retaining the stable code and message', async () => {
    const transport = new FakeTransport()
    const client = clientFor(transport)
    await initialize(client, transport)

    const failed = client.listThreads()
    transport.receive({
      id: 1,
      error: {
        code: -32_001,
        message: 'provider request failed api_key=secret-token',
        data: { apiKey: 'secret-token' }
      }
    })

    await expect(failed).rejects.toMatchObject({
      code: -32_001,
      message: 'provider request failed api_key=[redacted]',
      data: undefined
    } satisfies Partial<CodexAppServerRpcError>)
  })

  it('fails closed on unknown responses and oversized protocol payloads', async () => {
    const scenarios = [
      {
        message: JSON.stringify({ id: 999, result: {} }),
        expected: 'unknown Codex app-server request id'
      },
      {
        message: 'x'.repeat(MAX_CODEX_APP_SERVER_JSONL_BYTES + 1),
        expected: 'JSONL message exceeds the size limit'
      },
      {
        message: JSON.stringify({
          method: 'turn/started',
          params: {
            threadId: 'thread-1',
            text: 'x'.repeat(MAX_CODEX_APP_SERVER_NOTIFICATION_BYTES)
          }
        }),
        expected: 'notification exceeds the size limit'
      }
    ]

    for (const scenario of scenarios) {
      const transport = new FakeTransport()
      const client = clientFor(transport)
      await initialize(client, transport)
      const errors: string[] = []
      client.onProtocolError((error) => errors.push(error.message))
      const pending = client.listThreads()
      transport.receive(scenario.message)
      await expect(pending).rejects.toThrow(scenario.expected)
      expect(errors).toEqual([expect.stringContaining(scenario.expected)])
      expect(client.isInitialized()).toBe(false)
    }
  })

  it('bounds pending requests and fails a timed-out request closed', async () => {
    const transport = new FakeTransport()
    const timers: Array<() => void> = []
    const client = clientFor(transport, {
      maxPendingRequests: 1,
      requestTimeoutMs: CODEX_APP_SERVER_REQUEST_TIMEOUT_MS,
      setTimer: (fn) => {
        timers.push(fn)
        return timers.length as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: vi.fn()
    })
    await initialize(client, transport)
    const pending = client.listThreads()
    await expect(client.listThreads()).rejects.toThrow('pending-request limit')
    timers.at(-1)?.()
    await expect(pending).rejects.toThrow('request thread/list timed out')
    expect(client.isInitialized()).toBe(false)
  })

  it('surfaces malformed server output without logging or throwing it through request state', async () => {
    const transport = new FakeTransport()
    const client = clientFor(transport)
    const errors: string[] = []
    client.onProtocolError((error) => errors.push(error.message))

    transport.receive('{not json')
    expect(errors).toEqual(['Invalid JSON from Codex app-server.'])
  })
})
