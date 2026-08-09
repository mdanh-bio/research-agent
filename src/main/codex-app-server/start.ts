import { chmod, mkdir } from 'node:fs/promises'

import { codexStorageDir } from '../agent-framework/codex'
import { CodexAppServerClient } from './client'
import { verifyManagedCodexAppServerRuntime, type CodexVersionProbe } from './managed-runtime'
import { CodexPathAuthority } from './path-authority'
import {
  CodexAppServerProcessTransport,
  type CodexAppServerProcessOptions
} from './process-transport'
import type { CodexAppServerTransport } from './types'

export type StartCodexAppServerOptions = Omit<
  CodexAppServerProcessOptions,
  'executablePath' | 'cwd'
> &
  Readonly<{
    applicationVersion: string
    dataRoot: string
    authorizedRoots: readonly string[]
    cwd: string
    workspaceWriteRoots?: readonly string[]
    ownedThreadIds?: readonly string[]
    versionProbe?: CodexVersionProbe
    transportFactory?: (options: CodexAppServerProcessOptions) => CodexAppServerTransport
  }>

// The app-server and every command it starts inherit this environment. Keep the ambient surface
// deliberately small: provider credentials are materialized through the app-owned Codex profile,
// not copied from the desktop process. Explicit `options.env` values can override only these
// process-bootstrapping keys and therefore cannot reintroduce tokens, SSH agents, proxy routing, or
// a second Codex configuration root.
const CODEX_PROCESS_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'COLORTERM',
  'SHELL',
  'USER',
  'LOGNAME',
  'USERNAME',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'NO_COLOR',
  'FORCE_COLOR'
] as const)

const allowlistedProcessEnvironment = (
  ...sources: readonly (NodeJS.ProcessEnv | undefined)[]
): NodeJS.ProcessEnv => {
  const result: NodeJS.ProcessEnv = {}
  for (const source of sources) {
    if (!source) continue
    for (const key of CODEX_PROCESS_ENV_ALLOWLIST) {
      const value = source[key]
      if (typeof value === 'string') result[key] = value
    }
  }
  return result
}

export const startCodexAppServer = async (
  options: StartCodexAppServerOptions
): Promise<CodexAppServerClient> => {
  const pathAuthority = new CodexPathAuthority({
    authorizedRoots: options.authorizedRoots,
    workspaceWriteRoots: options.workspaceWriteRoots
  })
  const cwd = pathAuthority.resolveAuthorizedDirectory(options.cwd, 'Codex app-server cwd')
  const executablePath = await verifyManagedCodexAppServerRuntime(
    options.dataRoot,
    options.versionProbe
  )
  const codexHome = codexStorageDir(options.dataRoot)
  await mkdir(codexHome, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(codexHome, 0o700)
  const inheritedEnvironment = allowlistedProcessEnvironment(process.env, options.env)
  const processOptions: CodexAppServerProcessOptions = {
    executablePath,
    cwd,
    env: {
      ...inheritedEnvironment,
      HOME: codexHome,
      ...(process.platform === 'win32' ? { USERPROFILE: codexHome } : {}),
      CODEX_HOME: codexHome
    },
    onStderr: options.onStderr,
    spawnProcess: options.spawnProcess
  }
  const transport = (
    options.transportFactory ?? ((input) => new CodexAppServerProcessTransport(input))
  )(processOptions)
  let client: CodexAppServerClient | undefined
  try {
    client = new CodexAppServerClient(transport, {
      authorizedRoots: options.authorizedRoots,
      defaultCwd: cwd,
      workspaceWriteRoots: options.workspaceWriteRoots,
      ownedThreadIds: options.ownedThreadIds
    })
    await client.initialize({
      name: 'research_agent',
      title: 'Research Agent',
      version: options.applicationVersion
    })
    return client
  } catch (error) {
    if (client) await client.close().catch(() => undefined)
    else await transport.close().catch(() => undefined)
    throw error
  }
}
