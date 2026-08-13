import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { codexStorageDir, codexSubscriptionStorageDir } from '../agent-framework/codex'
import { startCodexAppServer } from './start'
import type { CodexAppServerProcessOptions } from './process-transport'
import type { CodexAppServerTransport } from './types'

vi.mock('./managed-runtime', () => ({
  verifyManagedCodexAppServerRuntime: vi.fn(async (dataRoot: string) =>
    join(dataRoot, 'codex-managed', 'codex')
  )
}))

class HandshakeTransport implements CodexAppServerTransport {
  closed = false
  private readonly lines = new Set<(line: string) => void>()
  private readonly closes = new Set<(error?: Error) => void>()

  write(message: string): void {
    const request = JSON.parse(message) as { id?: number; method?: string }
    if (request.method === 'initialize' && request.id !== undefined) {
      queueMicrotask(() => {
        for (const listener of this.lines) {
          listener(JSON.stringify({ id: request.id, result: { platformOs: 'macos' } }))
        }
      })
    }
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
    if (this.closed) return
    this.closed = true
    for (const listener of this.closes) listener()
  }
}

describe('startCodexAppServer', () => {
  let dataRoot: string
  let workspace: string

  beforeEach(async () => {
    dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'research-agent-codex-start-')))
    workspace = join(dataRoot, 'workspace')
    await mkdir(workspace)
  })

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true })
  })

  it('uses an isolated home, exact cwd, and a minimal credential-free environment', async () => {
    let captured: CodexAppServerProcessOptions | undefined
    const transport = new HandshakeTransport()
    const client = await startCodexAppServer({
      applicationVersion: '0.1.0',
      dataRoot,
      authorizedRoots: [workspace],
      cwd: workspace,
      env: {
        PATH: '/explicit/bin',
        LANG: 'C.UTF-8',
        OPENAI_API_KEY: 'must-not-leak',
        CODEX_CONFIG: 'must-not-leak',
        DEFAULT_AUTH_REQUEST: 'must-not-leak',
        SSH_AUTH_SOCK: '/must/not/leak',
        AWS_SECRET_ACCESS_KEY: 'must-not-leak',
        GITHUB_TOKEN: 'must-not-leak',
        HTTPS_PROXY: 'http://must-not-leak.invalid'
      },
      transportFactory: (options) => {
        captured = options
        return transport
      }
    })

    const codexHome = codexStorageDir(dataRoot)
    expect(captured).toMatchObject({
      cwd: await realpath(workspace),
      env: expect.objectContaining({
        PATH: '/explicit/bin',
        LANG: 'C.UTF-8',
        HOME: codexHome,
        CODEX_HOME: codexHome
      })
    })
    expect(captured?.env).not.toHaveProperty('OPENAI_API_KEY')
    expect(captured?.env).not.toHaveProperty('CODEX_CONFIG')
    expect(captured?.env).not.toHaveProperty('DEFAULT_AUTH_REQUEST')
    expect(captured?.env).not.toHaveProperty('SSH_AUTH_SOCK')
    expect(captured?.env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    expect(captured?.env).not.toHaveProperty('GITHUB_TOKEN')
    expect(captured?.env).not.toHaveProperty('HTTPS_PROXY')
    await client.close()
  })

  it('hands an explicitly selected API credential to one generation without persisting it or inheriting it', async () => {
    let captured: CodexAppServerProcessOptions | undefined
    const transport = new HandshakeTransport()
    const client = await startCodexAppServer({
      applicationVersion: '0.1.0',
      dataRoot,
      authorizedRoots: [workspace],
      cwd: workspace,
      env: { OPENAI_API_KEY: 'ambient-secret', HTTPS_PROXY: 'ambient-proxy' },
      provider: {
        kind: 'api-key',
        baseUrl: 'https://gateway.example.test/v1',
        model: 'gateway-model',
        apiKey: 'generation-secret'
      },
      transportFactory: (options) => {
        captured = options
        return transport
      }
    })

    expect(captured?.cwd).toBe(await realpath(workspace))
    expect(captured?.env).toMatchObject({
      HOME: codexStorageDir(dataRoot),
      CODEX_HOME: codexStorageDir(dataRoot),
      OPENAI_API_KEY: 'generation-secret'
    })
    expect(captured?.env).not.toHaveProperty('HTTPS_PROXY', 'ambient-proxy')
    expect(captured?.env).not.toHaveProperty('CODEX_CONFIG')
    expect(captured?.configOverrides).toEqual([
      'model="gateway-model"',
      'model_provider="open-science"',
      'model_providers.open-science.name="Research Agent"',
      'model_providers.open-science.wire_api="responses"',
      'model_providers.open-science.base_url="https://gateway.example.test/v1"',
      'model_providers.open-science.env_key="OPENAI_API_KEY"',
      'model_providers.open-science.request_max_retries=0',
      'model_providers.open-science.stream_max_retries=0'
    ])
    expect(captured?.configOverrides?.join('\n')).not.toContain('generation-secret')
    await client.close()
  })

  it('uses the app-owned subscription home and never asks the direct runtime to use the global home', async () => {
    let captured: CodexAppServerProcessOptions | undefined
    const transport = new HandshakeTransport()
    const client = await startCodexAppServer({
      applicationVersion: '0.1.0',
      dataRoot,
      authorizedRoots: [workspace],
      cwd: workspace,
      provider: { kind: 'subscription', model: 'subscription-model' },
      transportFactory: (options) => {
        captured = options
        return transport
      }
    })

    expect(captured?.env).toMatchObject({
      HOME: codexSubscriptionStorageDir(dataRoot),
      CODEX_HOME: codexSubscriptionStorageDir(dataRoot)
    })
    expect(captured?.configOverrides).toEqual(['model="subscription-model"'])
    await client.close()
  })

  it('closes the process transport when client construction fails', async () => {
    const transport = new HandshakeTransport()

    await expect(
      startCodexAppServer({
        applicationVersion: '0.1.0',
        dataRoot,
        authorizedRoots: [workspace],
        cwd: workspace,
        ownedThreadIds: [''],
        transportFactory: () => transport
      })
    ).rejects.toThrow('must be a non-empty string')
    expect(transport.closed).toBe(true)
  })
})
