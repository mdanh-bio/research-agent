import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import type { SshOverrides } from '../../shared/compute'
import { normalizeComputeSshAlias } from '../../shared/compute'

export const CONTROL_MASTER_PERSIST_SECONDS = 8 * 60 * 60

export type ControlMasterConfig = {
  controlDirectory: string
  controlPath: string
  persistSeconds: number
  args: string[]
}

type ControlMasterConfigOptions = {
  controlDirectory?: string
  persistSeconds?: number
  mode?: 'auto' | 'yes'
  // Stable, non-secret description of the resolved endpoint/options. It is hashed and never placed
  // in the socket path. Callers should include user, host, port, identity path and proxy routing so
  // edits cannot accidentally reuse a master authenticated under an older configuration.
  connectionKey?: string
}

const defaultControlDirectory = (): string => join(homedir(), '.ssh', 'research-agent-control')

// Pure builder: it neither creates a socket/directory nor starts ssh. Hashing the alias keeps the
// Unix socket path short and prevents path separators or OpenSSH %-tokens from changing its scope.
export const buildControlMasterConfig = (
  alias: string,
  options: ControlMasterConfigOptions = {}
): ControlMasterConfig => {
  const normalizedAlias = normalizeComputeSshAlias(alias)
  const controlDirectory = options.controlDirectory ?? defaultControlDirectory()
  if (!isAbsolute(controlDirectory)) {
    throw new Error('ControlMaster controlDirectory must be an absolute path.')
  }
  const persistSeconds = options.persistSeconds ?? CONTROL_MASTER_PERSIST_SECONDS
  if (
    !Number.isInteger(persistSeconds) ||
    persistSeconds < 1 ||
    persistSeconds > 7 * 24 * 60 * 60
  ) {
    throw new Error('ControlPersist must be an integer between 1 second and 7 days.')
  }
  const socketKey = createHash('sha256')
    .update(normalizedAlias)
    .update('\0')
    .update(options.connectionKey ?? normalizedAlias)
    .digest('hex')
    .slice(0, 24)
  const controlPath = join(controlDirectory, `cm-${socketKey}`)
  return {
    controlDirectory,
    controlPath,
    persistSeconds,
    args: [
      '-o',
      `ControlMaster=${options.mode ?? 'auto'}`,
      '-o',
      `ControlPath=${controlPath}`,
      '-o',
      `ControlPersist=${persistSeconds}`
    ]
  }
}

export type InteractiveSshPromptKind =
  'password' | 'one_time_code' | 'key_passphrase' | 'host_key_confirmation' | 'unknown'

export type InteractiveSshPrompt = {
  sessionId: string
  promptId: string
  kind: InteractiveSshPromptKind
  message: string
  // Passwords, OTPs and passphrases must never be echoed, persisted, or included in logs/crashes.
  secret: boolean
}

export type InteractiveSshOpenRequest = {
  providerId: string
  sshAlias: string
  sshOverrides?: SshOverrides
  controlMaster: ControlMasterConfig
}

export type InteractiveSshSession = {
  sessionId: string
  providerId: string
  state: 'opening' | 'awaiting_prompt' | 'ready' | 'closed' | 'failed'
}

// PTY-capable boundary for a future main-process implementation. This file intentionally provides
// no implementation and makes no connection. Prompt answers are single-use values: implementations
// must write them directly to the live PTY and immediately release their in-memory reference.
export interface InteractiveSshBroker {
  open(request: InteractiveSshOpenRequest): Promise<InteractiveSshSession>
  answerPrompt(sessionId: string, promptId: string, answer: string): Promise<void>
  close(sessionId: string): Promise<void>
  onPrompt(listener: (prompt: InteractiveSshPrompt) => void): () => void
}
