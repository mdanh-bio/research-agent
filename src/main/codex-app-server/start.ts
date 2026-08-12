import { chmod, mkdir } from 'node:fs/promises'

import { codexStorageDir, codexSubscriptionStorageDir } from '../agent-framework/codex'
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
    provider?: CodexAppServerProviderHandoff
    versionProbe?: CodexVersionProbe
    transportFactory?: (options: CodexAppServerProcessOptions) => CodexAppServerTransport
  }>

export type CodexAppServerProviderHandoff = Readonly<
  | {
      kind: 'subscription'
      model?: string
    }
  | {
      kind: 'api-key'
      model?: string
      baseUrl: string
      apiKey: string
    }
>

// The app-server and every command it starts inherit this environment. Keep the ambient surface
// deliberately small: one explicitly selected provider credential is added below while its
// credential-free provider registration is passed as fixed allowlisted `-c` overrides. Explicit
// `options.env` values can override only these process-bootstrapping keys and therefore cannot
// reintroduce tokens, SSH agents, proxy routing, or a second Codex configuration root.
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

const validateProviderHandoff = (
  provider: CodexAppServerProviderHandoff | undefined
): CodexAppServerProviderHandoff | undefined => {
  if (provider === undefined) return undefined
  if (provider.kind === 'subscription') {
    if (provider.model !== undefined && (!provider.model.trim() || provider.model.length > 256)) {
      throw new Error('Codex subscription model is invalid.')
    }
    return provider
  }
  if (provider.kind !== 'api-key') throw new Error('Codex provider handoff kind is invalid.')
  if (
    typeof provider.baseUrl !== 'string' ||
    !provider.baseUrl.trim() ||
    provider.baseUrl.length > 2_048
  ) {
    throw new Error('Codex provider base URL is invalid.')
  }
  let parsed: URL
  try {
    parsed = new URL(provider.baseUrl)
  } catch {
    throw new Error('Codex provider base URL is invalid.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Codex provider base URL must use HTTP or HTTPS.')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Codex provider base URL must not contain credentials or query data.')
  }
  if (
    typeof provider.apiKey !== 'string' ||
    !provider.apiKey.trim() ||
    provider.apiKey.length > 16_384
  ) {
    throw new Error('Codex provider credential is invalid.')
  }
  if (provider.model !== undefined && (!provider.model.trim() || provider.model.length > 256)) {
    throw new Error('Codex provider model is invalid.')
  }
  return provider
}

const tomlString = (value: string): string => JSON.stringify(value)

const normalizeResponsesBaseUrl = (value: string): string => {
  const normalized = value
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/responses$/i, '')
  const parsed = new URL(normalized)
  return parsed.pathname === '' || parsed.pathname === '/' ? `${normalized}/v1` : normalized
}

const providerConfigOverrides = (
  provider: CodexAppServerProviderHandoff | undefined
): readonly string[] => {
  if (!provider) return []
  if (provider.kind === 'subscription') {
    return provider.model ? [`model=${tomlString(provider.model)}`] : []
  }
  return [
    ...(provider.model ? [`model=${tomlString(provider.model)}`] : []),
    'model_provider="open-science"',
    'model_providers.open-science.name="Research Agent"',
    'model_providers.open-science.wire_api="responses"',
    `model_providers.open-science.base_url=${tomlString(normalizeResponsesBaseUrl(provider.baseUrl))}`,
    'model_providers.open-science.env_key="OPENAI_API_KEY"',
    // One approved direct-runtime turn maps to exactly one upstream request. Automatic HTTP or
    // dropped-stream retries would be additional model calls outside that single-use approval.
    'model_providers.open-science.request_max_retries=0',
    'model_providers.open-science.stream_max_retries=0'
  ]
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
  const provider = validateProviderHandoff(options.provider)
  const codexHome =
    provider?.kind === 'subscription'
      ? codexSubscriptionStorageDir(options.dataRoot)
      : codexStorageDir(options.dataRoot)
  await mkdir(codexHome, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(codexHome, 0o700)
  const inheritedEnvironment = allowlistedProcessEnvironment(process.env, options.env)
  const providerEnvironment =
    provider?.kind === 'api-key'
      ? {
          // This is an explicit main-process handoff for one app-server generation. It is never
          // accepted from ambient process.env/options.env and is not written to CODEX_CONFIG.
          OPENAI_API_KEY: provider.apiKey
        }
      : undefined
  const processOptions: CodexAppServerProcessOptions = {
    executablePath,
    cwd,
    env: {
      ...inheritedEnvironment,
      HOME: codexHome,
      ...(process.platform === 'win32' ? { USERPROFILE: codexHome } : {}),
      CODEX_HOME: codexHome,
      ...providerEnvironment
    },
    configOverrides: providerConfigOverrides(provider),
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
