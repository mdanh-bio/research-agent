import { readFile } from 'node:fs/promises'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

import {
  validatePrivatePackageManifest,
  validatePrivateRootManifest
} from './validate-npm-release.mjs'

const validManifest = (): {
  name: string
  version: string
  private: boolean
  bin: Record<string, string>
} => ({
  name: '@mdanh-bio/research-agent',
  version: '0.1.0',
  private: true,
  bin: { 'research-agent': './cli.mjs' }
})

type WorkflowStep = {
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

type PrivatePackageWorkflow = {
  jobs?: { verify?: { steps?: WorkflowStep[] } }
}

describe('validatePrivatePackageManifest', () => {
  it('accepts the private Research Agent package metadata', () => {
    expect(validatePrivatePackageManifest(validManifest())).toEqual({
      name: '@mdanh-bio/research-agent',
      version: '0.1.0',
      private: true,
      binary: 'research-agent'
    })
  })

  it('rejects a publishable package or explicit public access', () => {
    expect(() => validatePrivatePackageManifest({ ...validManifest(), private: false })).toThrow(
      'must remain marked private'
    )
    expect(() =>
      validatePrivatePackageManifest({
        ...validManifest(),
        publishConfig: { access: 'public' }
      })
    ).toThrow('must not declare public npm access')
  })

  it('rejects an unexpected package name', () => {
    expect(() =>
      validatePrivatePackageManifest({ ...validManifest(), name: '@aipoch/open-science' })
    ).toThrow(
      'Expected private package name @mdanh-bio/research-agent, received @aipoch/open-science.'
    )
  })

  it.each([undefined, '', '  '])('rejects a missing package version (%s)', (version) => {
    expect(() => validatePrivatePackageManifest({ ...validManifest(), version })).toThrow(
      'The private package version is missing.'
    )
  })

  it('requires the Research Agent CLI binary', () => {
    expect(() => validatePrivatePackageManifest({ ...validManifest(), bin: {} })).toThrow(
      'must expose the research-agent binary'
    )
  })

  it('requires the application root to remain private too', () => {
    expect(() => validatePrivateRootManifest({ name: 'research-agent', private: false })).toThrow(
      'application root must remain marked private'
    )
    expect(() =>
      validatePrivateRootManifest({ name: 'research-agent', private: true })
    ).not.toThrow()
  })

  it('keeps the former publish workflow verification-only and credential-free', async () => {
    const [workflow, rootManifestSource] = await Promise.all([
      readFile('.github/workflows/publish-npm.yml', 'utf8'),
      readFile('package.json', 'utf8')
    ])
    const parsed = load(workflow) as PrivatePackageWorkflow
    const rootManifest = JSON.parse(rootManifestSource) as {
      scripts?: Record<string, string>
    }
    const steps = parsed.jobs?.verify?.steps ?? []
    const checkout = steps.find(({ name }) => name === 'Checkout')
    const packageContents = steps.find(({ name }) => name === 'Check package contents')
    const pack = steps.find(({ name }) => name === 'Build inspection tarball')

    expect(workflow).toContain('Verify private CLI package')
    expect(checkout).toMatchObject({
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: { 'persist-credentials': false }
    })
    expect(packageContents?.run).toBe('npm run check:cli-package')
    expect(rootManifest.scripts?.['check:cli-package']).toContain(
      'npm pack ./packages/open-science'
    )
    expect(rootManifest.scripts?.['check:cli-package']).toContain('--ignore-scripts')
    expect(pack?.run).toContain('npm pack ./packages/open-science')
    expect(pack?.run).toContain('--ignore-scripts')
    expect(workflow).not.toMatch(/\bnpm publish\b/)
    expect(workflow).not.toContain('id-token: write')
    expect(workflow).not.toContain('NPM_TOKEN')
    expect(workflow).not.toContain("'npm-v*'")
  })

  it('keeps inherited nightly packaging manual during the private baseline', async () => {
    const workflow = await readFile('.github/workflows/nightly.yml', 'utf8')

    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toMatch(/^\s*schedule:/m)
    expect(workflow).not.toContain('cron:')
  })
})
