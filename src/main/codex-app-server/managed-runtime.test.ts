import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtimeFixture = vi.hoisted(() => ({
  binary: '#!/bin/sh\necho codex-cli 0.147.0\n',
  binarySha256: '3049cd4c4b4030d3e5fb543429f9d366c4b72a03e213d0e35e59a832a8ba9e03'
}))

vi.mock('../settings/managed-codex', async (importActual) => {
  const actual = await importActual<typeof import('../settings/managed-codex')>()
  const platformKey = actual.resolveManagedCodexPlatform().key
  return {
    ...actual,
    CODEX_BINARY_SHA256: {
      ...actual.CODEX_BINARY_SHA256,
      [platformKey]: runtimeFixture.binarySha256
    }
  }
})

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
import { verifyManagedCodexAppServerRuntime } from './managed-runtime'
import { startCodexAppServer } from './start'

describe('managed Codex app-server runtime', () => {
  let dataRoot: string
  let binaryPath: string

  const writeRuntimeManifest = async (
    overrides: Partial<ManagedCodexRuntimeManifest> = {}
  ): Promise<void> => {
    const platformKey = resolveManagedCodexPlatform().key
    const manifest: ManagedCodexRuntimeManifest = {
      schemaVersion: 1,
      codexVersion: CODEX_VERSION,
      platformKey,
      codexPackageIntegrity: CODEX_INTEGRITIES[platformKey],
      binarySha256: CODEX_BINARY_SHA256[platformKey],
      ...overrides
    }
    await writeFile(managedCodexRuntimeManifest(dataRoot), `${JSON.stringify(manifest)}\n`)
  }

  beforeEach(async () => {
    dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'research-agent-codex-runtime-')))
    binaryPath = managedCodexBinary(dataRoot)
    await mkdir(dirname(binaryPath), { recursive: true })
    expect(createHash('sha256').update(runtimeFixture.binary).digest('hex')).toBe(
      runtimeFixture.binarySha256
    )
    await writeFile(binaryPath, runtimeFixture.binary)
    await chmod(binaryPath, 0o700)
    await writeRuntimeManifest()
  })

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true })
  })

  it('accepts only the app-managed binary after a live exact-version probe', async () => {
    const probe = vi.fn(async () => `codex-cli ${CODEX_VERSION}`)

    await expect(verifyManagedCodexAppServerRuntime(dataRoot, probe)).resolves.toBe(
      await realpath(binaryPath)
    )
    expect(probe).toHaveBeenCalledWith(await realpath(binaryPath))
  })

  it('rejects version drift before constructing an app-server transport', async () => {
    const transportFactory = vi.fn()
    const workspace = join(dataRoot, 'workspace')
    await mkdir(workspace)

    await expect(
      startCodexAppServer({
        applicationVersion: '0.1.0',
        dataRoot,
        authorizedRoots: [workspace],
        cwd: workspace,
        versionProbe: async () => 'codex-cli 0.146.0',
        transportFactory
      })
    ).rejects.toThrow(`expected ${CODEX_VERSION}`)
    expect(transportFactory).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a symlinked managed runtime root before probing the executable',
    async () => {
      const managedRoot = managedCodexRoot(dataRoot)
      const realRoot = join(dataRoot, 'codex-managed-real')
      await rename(managedRoot, realRoot)
      await symlink(realRoot, managedRoot, 'dir')
      const probe = vi.fn(async () => `codex-cli ${CODEX_VERSION}`)

      await expect(verifyManagedCodexAppServerRuntime(dataRoot, probe)).rejects.toThrow(
        'root is missing or symlinked'
      )
      expect(probe).not.toHaveBeenCalled()
    }
  )

  it('rejects a replaced binary before probing it', async () => {
    await writeFile(binaryPath, `${runtimeFixture.binary}# replaced\n`)
    const probe = vi.fn(async () => `codex-cli ${CODEX_VERSION}`)

    await expect(verifyManagedCodexAppServerRuntime(dataRoot, probe)).rejects.toThrow(
      'failed its integrity check'
    )
    expect(probe).not.toHaveBeenCalled()
  })

  it('does not let a rewritten co-located manifest authorize a replacement binary', async () => {
    const replacement = `${runtimeFixture.binary}# replacement\n`
    const replacementSha256 = createHash('sha256').update(replacement).digest('hex')
    await writeFile(binaryPath, replacement)
    await writeRuntimeManifest({ binarySha256: replacementSha256 })
    const probe = vi.fn(async () => `codex-cli ${CODEX_VERSION}`)

    await expect(verifyManagedCodexAppServerRuntime(dataRoot, probe)).rejects.toThrow(
      'manifest does not match this application'
    )
    expect(probe).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a managed-path symlink even when its target reports the pinned version',
    async () => {
      const outside = join(dataRoot, 'outside-codex')
      await writeFile(outside, '#!/bin/sh\necho codex-cli 0.147.0\n')
      await chmod(outside, 0o700)
      await rm(binaryPath)
      await symlink(outside, binaryPath)
      const probe = vi.fn(async () => `codex-cli ${CODEX_VERSION}`)

      await expect(verifyManagedCodexAppServerRuntime(dataRoot, probe)).rejects.toThrow(
        'not a managed file'
      )
      expect(probe).not.toHaveBeenCalled()
    }
  )
})
