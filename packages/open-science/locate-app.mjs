/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { access, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readResearchAgentEnvironment } from './environment-overrides.mjs'

const cliDir = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(cliDir, '../..')
const require = createRequire(import.meta.url)

const exists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const isCurrentCli = async (candidate) => {
  if (!process.argv[1]) return false
  try {
    return (await realpath(candidate)) === (await realpath(process.argv[1]))
  } catch {
    return false
  }
}

const executableOnPath = async (name, env = process.env) => {
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd'] : ['']
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = join(directory, `${name}${suffix}`)
      if (await exists(candidate)) return candidate
    }
  }
  return undefined
}

const defaultInstalledCandidates = (env = process.env) => {
  if (process.platform === 'win32') {
    return [
      env.LOCALAPPDATA &&
        join(env.LOCALAPPDATA, 'Programs', 'Research Agent', 'Research Agent.exe'),
      env.PROGRAMFILES && join(env.PROGRAMFILES, 'Research Agent', 'Research Agent.exe')
    ].filter(Boolean)
  }
  if (process.platform === 'darwin') {
    const app = 'Research Agent.app/Contents/MacOS/Research Agent'
    return [join('/Applications', app), env.HOME && join(env.HOME, 'Applications', app)].filter(
      Boolean
    )
  }
  return ['/usr/bin/research-agent', '/usr/local/bin/research-agent']
}

const locateDevelopmentApp = async () => {
  const mainEntry = join(repositoryRoot, 'out', 'main', 'index.js')
  const webEntry = join(repositoryRoot, 'out', 'web', 'index.html')
  const electronModule = join(repositoryRoot, 'node_modules', 'electron')
  if (!(await exists(mainEntry)) || !(await exists(webEntry)) || !(await exists(electronModule))) {
    return undefined
  }
  const electronPath = require(electronModule)
  if (!(await exists(electronPath))) return undefined
  return {
    command: electronPath,
    args: [repositoryRoot],
    packaged: false,
    repositoryRoot
  }
}

export const locateApp = async ({ appPath, env = process.env } = {}) => {
  const explicit =
    appPath ?? readResearchAgentEnvironment(env, 'RESEARCH_AGENT_APP_PATH', 'OPEN_SCIENCE_APP_PATH')
  if (explicit) {
    const command = resolve(explicit)
    if (!(await exists(command))) throw new Error(`Research Agent executable not found: ${command}`)
    return { command, args: [], packaged: true, repositoryRoot }
  }

  const development = await locateDevelopmentApp()
  if (development) return development

  for (const candidate of defaultInstalledCandidates(env)) {
    if ((await exists(candidate)) && !(await isCurrentCli(candidate))) {
      return { command: candidate, args: [], packaged: true, repositoryRoot }
    }
  }

  if (process.platform === 'linux') {
    const command = await executableOnPath('research-agent', env)
    if (command && !(await isCurrentCli(command))) {
      return { command, args: [], packaged: true, repositoryRoot }
    }
  }

  // When run from a packaged build's resources dir there is no package.json next to the CLI, so fall
  // back to the product name rather than letting the read mask the real "could not locate" message.
  let productName = 'Research Agent'
  try {
    productName =
      JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')).productName ??
      productName
  } catch {
    // No package.json alongside the CLI (packaged): keep the default product name.
  }
  throw new Error(
    `Could not locate ${productName}. Run "npm run build" in the repository, install the app, or pass --app-path.`
  )
}

export { repositoryRoot }
