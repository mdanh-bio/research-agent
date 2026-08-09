import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  artifactVersion,
  assertPackagedResources,
  findAppBundle,
  findArtifact,
  packagedLaunchArguments,
  parseArguments,
  parsePackagedAppEndpoint
} from './macos-package-smoke.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('macOS package smoke', () => {
  it('selects one DMG and ZIP and derives their shared version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'research-agent-macos-artifacts-'))
    roots.push(root)
    const dmg = join(root, 'research-agent-0.12.0-mac-arm64.dmg')
    const zip = join(root, 'research-agent-0.12.0-mac-arm64.zip')
    await Promise.all([
      writeFile(dmg, ''),
      writeFile(zip, ''),
      writeFile(join(root, 'latest.yml'), '')
    ])

    await expect(findArtifact(root, 'dmg')).resolves.toBe(dmg)
    await expect(findArtifact(root, 'zip')).resolves.toBe(zip)
    expect(artifactVersion(dmg)).toBe('0.12.0')
    expect(artifactVersion(zip)).toBe('0.12.0')
  })

  it('rejects ambiguous artifacts and stale app-bundle branding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'research-agent-macos-ambiguous-'))
    roots.push(root)
    await Promise.all([
      writeFile(join(root, 'one.dmg'), ''),
      writeFile(join(root, 'two.dmg'), ''),
      mkdir(join(root, 'One.app')),
      mkdir(join(root, 'Two.app'))
    ])

    await expect(findArtifact(root, 'dmg')).rejects.toThrow(/found 2/)
    await expect(findAppBundle(root)).rejects.toThrow(/found 2/)
    await rm(join(root, 'Two.app'), { recursive: true })
    await expect(findAppBundle(root)).rejects.toThrow(/Research Agent\.app/)
  })

  it('parses isolated artifact and Gatekeeper options', () => {
    expect(parseArguments(['--artifact-dir', 'dist', '--gatekeeper'])).toEqual({
      artifactDirectory: resolve('dist'),
      gatekeeper: true
    })
    expect(() => parseArguments([])).toThrow(/Usage/)
  })

  it('extracts the authenticated packaged service endpoint', () => {
    expect(
      parsePackagedAppEndpoint('Research Agent Web: http://127.0.0.1:3210/?token=abc_123')
    ).toEqual({ endpoint: 'http://127.0.0.1:3210', auth: 'token=abc_123' })
    expect(parsePackagedAppEndpoint('not ready')).toBeUndefined()
  })

  it('isolates Electron state without replacing the macOS home directory', () => {
    expect(packagedLaunchArguments('/tmp/research-agent-profile')).toEqual([
      '--user-data-dir=/tmp/research-agent-profile',
      '--open-science-headless',
      '--serve=0'
    ])
  })

  it('requires the adaptive icon catalog and its legacy ICNS fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'research-agent-macos-app-'))
    roots.push(root)
    const appBundle = join(root, 'Research Agent.app')
    const executableDirectory = join(appBundle, 'Contents', 'MacOS')
    const resources = join(appBundle, 'Contents', 'Resources')
    await Promise.all([
      mkdir(executableDirectory, { recursive: true }),
      mkdir(resources, { recursive: true })
    ])
    await Promise.all([
      writeFile(join(executableDirectory, 'Research Agent'), ''),
      writeFile(join(resources, 'app.asar'), ''),
      writeFile(join(resources, 'micromamba'), ''),
      writeFile(join(resources, 'Assets.car'), ''),
      writeFile(join(resources, 'icon.icns'), '')
    ])

    await expect(findAppBundle(root)).resolves.toBe(appBundle)
    await expect(assertPackagedResources(appBundle)).resolves.toEqual({
      executable: join(executableDirectory, 'Research Agent'),
      micromamba: join(resources, 'micromamba')
    })

    await rm(join(resources, 'Assets.car'))
    await expect(assertPackagedResources(appBundle)).rejects.toThrow()
  })
})
