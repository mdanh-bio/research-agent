import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { constants } from 'node:fs'
import { access, lstat, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import {
  CODEX_BINARY_SHA256,
  CODEX_INTEGRITIES,
  CODEX_VERSION,
  managedCodexBinary,
  managedCodexRoot,
  managedCodexRuntimeManifest,
  resolveManagedCodexPlatform,
  type ManagedCodexRuntimeManifest
} from '../settings/managed-codex'

const execFileAsync = promisify(execFile)

export type CodexVersionProbe = (executablePath: string) => Promise<string>

const isInside = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate)
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  )
}

const defaultVersionProbe: CodexVersionProbe = async (executablePath) => {
  const { stdout, stderr } = await execFileAsync(executablePath, ['--version'], {
    encoding: 'utf8',
    // A version probe executes before the app-server's isolated environment is constructed. Do not
    // expose ambient provider, cloud, SSH, proxy, or developer credentials even to the pinned
    // executable; retain only platform bootstrap paths needed to launch it.
    env: {
      NO_BROWSER: '1',
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {})
    },
    timeout: 10_000,
    maxBuffer: 64 * 1024
  })
  return `${stdout}\n${stderr}`
}

const parseVersion = (output: string): string | undefined =>
  output.match(/(?:^|\s)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=\s|$)/)?.[1]

const binaryIdentity = async (path: string): Promise<string> => {
  const before = await stat(path)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  const after = await stat(path)
  if (
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error('Pinned Codex app-server executable changed during integrity verification.')
  }
  return hash.digest('hex')
}

const readRuntimeManifest = async (
  dataRoot: string,
  expectedPlatform: string,
  expectedPackageIntegrity: string,
  expectedBinarySha256: string
): Promise<ManagedCodexRuntimeManifest> => {
  const path = managedCodexRuntimeManifest(dataRoot)
  const metadata = await lstat(path).catch(() => undefined)
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Pinned Codex runtime integrity manifest is missing or invalid.')
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new Error('Pinned Codex runtime integrity manifest is unreadable.')
  }
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    (manifest as Partial<ManagedCodexRuntimeManifest>).schemaVersion !== 1 ||
    (manifest as Partial<ManagedCodexRuntimeManifest>).codexVersion !== CODEX_VERSION ||
    (manifest as Partial<ManagedCodexRuntimeManifest>).platformKey !== expectedPlatform ||
    (manifest as Partial<ManagedCodexRuntimeManifest>).codexPackageIntegrity !==
      expectedPackageIntegrity ||
    (manifest as Partial<ManagedCodexRuntimeManifest>).binarySha256 !== expectedBinarySha256
  ) {
    throw new Error('Pinned Codex runtime integrity manifest does not match this application.')
  }
  return manifest as ManagedCodexRuntimeManifest
}

// Resolves only the native binary installed in Research Agent's managed runtime, rejects final-path
// symlinks, and performs a live version probe immediately before app-server startup.
export const verifyManagedCodexAppServerRuntime = async (
  dataRoot: string,
  versionProbe: CodexVersionProbe = defaultVersionProbe
): Promise<string> => {
  const expectedPlatform = resolveManagedCodexPlatform().key
  const expectedPackageIntegrity = CODEX_INTEGRITIES[expectedPlatform]
  const expectedBinarySha256 = CODEX_BINARY_SHA256[expectedPlatform]
  if (!expectedPackageIntegrity || !expectedBinarySha256) {
    throw new Error(`No pinned Codex runtime identity for ${expectedPlatform}.`)
  }

  const expectedPath = resolve(managedCodexBinary(dataRoot))
  const expectedRoot = resolve(managedCodexRoot(dataRoot))
  const rootMetadata = await lstat(expectedRoot).catch(() => undefined)
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('Pinned Codex managed runtime root is missing or symlinked.')
  }
  const metadata = await lstat(expectedPath).catch(() => undefined)
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Pinned Codex app-server executable is missing or is not a managed file.')
  }
  await access(expectedPath, constants.X_OK)

  const [canonicalRoot, canonicalPath] = await Promise.all([
    realpath(expectedRoot),
    realpath(expectedPath)
  ])
  if (!isInside(canonicalRoot, canonicalPath) || !(await stat(canonicalPath)).isFile()) {
    throw new Error('Pinned Codex app-server executable escapes the managed runtime.')
  }

  // The manifest records what the SRI-verified installer published, but it is deliberately not a
  // trust anchor: it is writable beside the runtime. Both its source SRI and executable digest must
  // match code-owned release metadata before the executable is hashed independently.
  await readRuntimeManifest(
    dataRoot,
    expectedPlatform,
    expectedPackageIntegrity,
    expectedBinarySha256
  )
  if ((await binaryIdentity(canonicalPath)) !== expectedBinarySha256) {
    throw new Error('Pinned Codex app-server executable failed its integrity check.')
  }

  const versionOutput = await versionProbe(canonicalPath)
  const actualVersion = parseVersion(versionOutput)
  if (actualVersion !== CODEX_VERSION) {
    throw new Error(
      `Pinned Codex app-server version mismatch: expected ${CODEX_VERSION}, received ${actualVersion ?? 'unparseable output'}.`
    )
  }
  return canonicalPath
}
