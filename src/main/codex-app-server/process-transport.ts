import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

import { terminateProcessTree } from '../process-tree'
import type { CodexAppServerTransport } from './types'

export type CodexAppServerProcessOptions = Readonly<{
  executablePath: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  onStderr?: (text: string) => void
  configOverrides?: readonly string[]
  spawnProcess?: typeof spawn
}>

export const CODEX_APP_SERVER_PROCESS_ARGS = Object.freeze(['app-server'] as const)

const PROCESS_GROUP_TERM_GRACE_MS = 3_000
const PROCESS_GROUP_KILL_GRACE_MS = 1_000
const PROCESS_GROUP_POLL_MS = 25
const CODEX_APP_SERVER_CONFIG_OVERRIDE_KEYS = new Set([
  'model',
  'model_provider',
  'model_providers.open-science.name',
  'model_providers.open-science.wire_api',
  'model_providers.open-science.base_url',
  'model_providers.open-science.env_key',
  'model_providers.open-science.request_max_retries',
  'model_providers.open-science.stream_max_retries'
])

const configOverrideArgs = (overrides: readonly string[] | undefined): string[] => {
  const args: string[] = []
  for (const override of overrides ?? []) {
    if (
      typeof override !== 'string' ||
      !override.trim() ||
      override.length > 4_096 ||
      override.includes('\u0000') ||
      override.includes('\r') ||
      override.includes('\n')
    ) {
      throw new Error('Codex app-server config override is invalid.')
    }
    const separator = override.indexOf('=')
    const key = separator < 0 ? '' : override.slice(0, separator)
    if (!CODEX_APP_SERVER_CONFIG_OVERRIDE_KEYS.has(key)) {
      throw new Error('Codex app-server config override is not allowlisted.')
    }
    args.push('-c', override)
  }
  return args
}

const isProcessGroupAlive = (processGroupId: number): boolean => {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const signalProcessGroup = (processGroupId: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-processGroupId, signal)
  } catch {
    // The complete process group may already be gone.
  }
}

const waitForProcessGroupExit = async (
  processGroupId: number,
  timeoutMs: number
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (isProcessGroupAlive(processGroupId)) {
    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => setTimeout(resolve, PROCESS_GROUP_POLL_MS))
  }
  return true
}

// A detached POSIX child is the leader of an app-owned process group. The normal process-tree walk
// catches descendants that create their own groups, while this second guard still reaches ordinary
// descendants after an unexpectedly exited parent has already been reparented by the kernel.
const terminatePosixProcessGroup = async (processGroupId: number | undefined): Promise<boolean> => {
  if (process.platform === 'win32' || processGroupId === undefined) return true
  if (!isProcessGroupAlive(processGroupId)) return true

  signalProcessGroup(processGroupId, 'SIGTERM')
  if (await waitForProcessGroupExit(processGroupId, PROCESS_GROUP_TERM_GRACE_MS)) return true

  signalProcessGroup(processGroupId, 'SIGKILL')
  return waitForProcessGroupExit(processGroupId, PROCESS_GROUP_KILL_GRACE_MS)
}

export class CodexAppServerProcessTransport implements CodexAppServerTransport {
  private readonly process: ChildProcessWithoutNullStreams
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly closeListeners = new Set<(error?: Error) => void>()
  private readonly reader: ReturnType<typeof createInterface>
  private readonly posixProcessGroupId: number | undefined
  private closed = false
  private closeNotified = false
  private closePromise: Promise<void> | undefined

  constructor(options: CodexAppServerProcessOptions) {
    const spawnProcess = options.spawnProcess ?? spawn
    this.process = spawnProcess(
      options.executablePath,
      [...CODEX_APP_SERVER_PROCESS_ARGS, ...configOverrideArgs(options.configOverrides)],
      {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32'
      }
    )
    this.posixProcessGroupId = process.platform === 'win32' ? undefined : this.process.pid
    this.reader = createInterface({ input: this.process.stdout, crlfDelay: Infinity })
    this.reader.on('line', (line) => {
      for (const listener of this.lineListeners) listener(line)
    })
    this.process.stderr.setEncoding('utf8')
    this.process.stderr.on('data', (chunk: string) => options.onStderr?.(chunk))
    this.process.once('error', (error) => this.handleUnexpectedClose(error))
    this.process.once('exit', (code, signal) => {
      if (this.closed) return
      const suffix = signal ? `signal ${signal}` : `code ${String(code)}`
      this.handleUnexpectedClose(new Error(`Codex app-server exited with ${suffix}.`))
    })
  }

  write(message: string): void {
    if (this.closed || this.process.stdin.destroyed) {
      throw new Error('Codex app-server process transport is closed.')
    }
    this.process.stdin.write(message)
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener)
    return () => this.lineListeners.delete(listener)
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    return this.startTermination()
  }

  private startTermination(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.reader.close()

    // Start whole-tree discovery before closing stdin can let the app-server exit and orphan a
    // descendant. A detached POSIX process group is checked afterwards so an unexpected parent exit
    // cannot hide already-reparented descendants from the PID tree walk.
    const treeTermination = terminateProcessTree(this.process)
    this.closePromise = (async () => {
      let treeReaped = false
      let treeError: unknown
      try {
        treeReaped = (await treeTermination).reaped
      } catch (error) {
        treeError = error
      }
      const groupReaped = await terminatePosixProcessGroup(this.posixProcessGroupId)
      if (treeError || !treeReaped || !groupReaped) {
        throw new Error('Codex app-server process tree did not terminate cleanly.')
      }
    })()
    if (!this.process.stdin.destroyed && !this.process.stdin.writableEnded) {
      this.process.stdin.end()
    }
    return this.closePromise
  }

  private handleUnexpectedClose(error: Error): void {
    if (this.closed) return
    const termination = this.startTermination()
    void termination.then(
      () => this.notifyClose(error),
      () =>
        this.notifyClose(
          new Error(`${error.message} Codex app-server process tree did not terminate cleanly.`)
        )
    )
  }

  private notifyClose(error?: Error): void {
    if (this.closeNotified) return
    this.closeNotified = true
    for (const listener of this.closeListeners) listener(error)
    this.closeListeners.clear()
  }
}
