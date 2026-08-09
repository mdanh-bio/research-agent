import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { terminateProcessTreeMock } = vi.hoisted(() => ({
  terminateProcessTreeMock: vi.fn()
}))

vi.mock('../process-tree', () => ({ terminateProcessTree: terminateProcessTreeMock }))

import { CODEX_APP_SERVER_PROCESS_ARGS, CodexAppServerProcessTransport } from './process-transport'

const fakeProcess = (): ChildProcessWithoutNullStreams => {
  const process = new EventEmitter() as ChildProcessWithoutNullStreams
  Object.assign(process, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true)
  })
  return process
}

const deferred = <T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('CodexAppServerProcessTransport', () => {
  beforeEach(() => {
    terminateProcessTreeMock.mockReset()
    terminateProcessTreeMock.mockResolvedValue({ reaped: true })
  })

  it('spawns only the stable app-server command and ignores untyped CLI flag injection', async () => {
    const child = fakeProcess()
    const spawnProcess = vi.fn(() => child)
    const transport = new CodexAppServerProcessTransport({
      executablePath: '/managed/codex',
      spawnProcess: spawnProcess as never,
      ...({ args: ['--dangerously-bypass-approvals-and-sandbox'] } as object)
    })

    expect(CODEX_APP_SERVER_PROCESS_ARGS).toEqual(['app-server'])
    expect(spawnProcess).toHaveBeenCalledWith(
      '/managed/codex',
      ['app-server'],
      expect.objectContaining({
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32'
      })
    )
    await transport.close()
  })

  it('delegates descendant teardown to the shared escalating process-tree terminator', async () => {
    const child = fakeProcess()
    const transport = new CodexAppServerProcessTransport({
      executablePath: '/managed/codex',
      spawnProcess: vi.fn(() => child) as never
    })

    await transport.close()

    expect(terminateProcessTreeMock).toHaveBeenCalledOnce()
    expect(terminateProcessTreeMock).toHaveBeenCalledWith(child)
    expect(child.kill).not.toHaveBeenCalled()
    expect(child.stdin.writableEnded).toBe(true)
  })

  it('does not resolve close until the complete process-tree teardown settles', async () => {
    const teardown = deferred<{ reaped: boolean }>()
    terminateProcessTreeMock.mockReturnValueOnce(teardown.promise)
    const child = fakeProcess()
    const transport = new CodexAppServerProcessTransport({
      executablePath: '/managed/codex',
      spawnProcess: vi.fn(() => child) as never
    })
    let firstSettled = false
    let secondSettled = false

    const firstClose = transport.close().then(() => {
      firstSettled = true
    })
    const secondClose = transport.close().then(() => {
      secondSettled = true
    })
    await Promise.resolve()

    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)
    expect(terminateProcessTreeMock).toHaveBeenCalledOnce()

    teardown.resolve({ reaped: true })
    await Promise.all([firstClose, secondClose])

    expect(firstSettled).toBe(true)
    expect(secondSettled).toBe(true)
  })

  it('reports a process tree that remains alive after escalation', async () => {
    terminateProcessTreeMock.mockResolvedValueOnce({ reaped: false })
    const child = fakeProcess()
    const transport = new CodexAppServerProcessTransport({
      executablePath: '/managed/codex',
      spawnProcess: vi.fn(() => child) as never
    })

    await expect(transport.close()).rejects.toThrow('did not terminate cleanly')
  })

  it('awaits whole-tree teardown before reporting an unexpected process exit', async () => {
    const teardown = deferred<{ reaped: boolean }>()
    terminateProcessTreeMock.mockReturnValueOnce(teardown.promise)
    const child = fakeProcess()
    const transport = new CodexAppServerProcessTransport({
      executablePath: '/managed/codex',
      spawnProcess: vi.fn(() => child) as never
    })
    let notified = false
    const notification = new Promise<Error | undefined>((resolve) => {
      transport.onClose((error) => {
        notified = true
        resolve(error)
      })
    })

    child.emit('exit', 1, null)
    const close = transport.close()
    await Promise.resolve()

    expect(terminateProcessTreeMock).toHaveBeenCalledWith(child)
    expect(notified).toBe(false)
    teardown.resolve({ reaped: true })
    await close
    await expect(notification).resolves.toMatchObject({
      message: 'Codex app-server exited with code 1.'
    })
  })

  it.skipIf(process.platform === 'win32')(
    'reaps an inherited POSIX process group after the app-server parent exits first',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'research-agent-codex-process-group-'))
      const pidFile = join(root, 'grandchild.pid')
      let grandchildPid: number | undefined
      let transport: CodexAppServerProcessTransport | undefined
      try {
        const parentSource = [
          'const { spawn } = require("node:child_process");',
          'const { writeFileSync } = require("node:fs");',
          'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
          'writeFileSync(process.argv[1], String(child.pid));',
          'setTimeout(() => process.exit(23), 50);'
        ].join('\n')
        const spawnProcess = ((_executable: string, _args: readonly string[], options: object) =>
          spawn(process.execPath, ['-e', parentSource, pidFile], options)) as typeof spawn
        transport = new CodexAppServerProcessTransport({
          executablePath: '/managed/codex',
          spawnProcess
        })
        const notification = new Promise<Error | undefined>((resolve) => {
          transport?.onClose(resolve)
        })

        await vi.waitFor(async () => {
          const pid = Number.parseInt(await readFile(pidFile, 'utf8'), 10)
          expect(pid).toBeGreaterThan(0)
          grandchildPid = pid
        })
        await expect(notification).resolves.toMatchObject({
          message: 'Codex app-server exited with code 23.'
        })
        expect(grandchildPid).toBeDefined()
        expect(() => process.kill(grandchildPid as number, 0)).toThrow()
        await expect(transport.close()).resolves.toBeUndefined()
      } finally {
        if (grandchildPid !== undefined) {
          try {
            process.kill(grandchildPid, 'SIGKILL')
          } catch {
            // The process-group guard already reaped it.
          }
        }
        await transport?.close().catch(() => undefined)
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
