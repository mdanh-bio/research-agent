import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

type Step = {
  'continue-on-error'?: boolean
  env?: Record<string, string>
  if?: string
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

type Job = {
  'continue-on-error'?: boolean
  env?: Record<string, string>
  if?: string
  needs?: string | string[]
  permissions?: Record<string, string>
  'runs-on'?: string
  secrets?: unknown
  steps?: Step[]
  strategy?: { matrix?: { shard?: number[] } }
  uses?: string
  with?: Record<string, unknown>
}

type Workflow = {
  concurrency?: { 'cancel-in-progress'?: boolean; group?: string }
  jobs: Record<string, Job>
  on?: Record<string, unknown>
  permissions?: Record<string, string>
}

const workflow = (name: string): Workflow =>
  load(readFileSync(join(process.cwd(), '.github/workflows', name), 'utf8')) as Workflow

const workflowText = (name: string): string =>
  readFileSync(join(process.cwd(), '.github/workflows', name), 'utf8')

const step = (job: Job, name: string): Step => {
  const result = job.steps?.find((candidate) => candidate.name === name)
  if (!result) throw new Error(`Missing step: ${name}`)
  return result
}

describe('release and scheduled workflow topology', () => {
  it('runs three serial Windows full-suite shards', () => {
    const job = workflow('windows-full-test.yml').jobs.windows_full_test
    const test = step(job, 'Test complete suite shard')

    expect(job.strategy?.matrix?.shard).toEqual([1, 2, 3])
    expect(test.run).toContain('--shard=${{ matrix.shard }}/3')
    expect(test.run).toContain('--maxWorkers=1')
  })

  it('runs reusable verification beside native builds while private callers remain fail closed', () => {
    const build = workflow('build.yml').jobs.build
    const nightly = workflow('nightly.yml')
    const release = workflow('release.yml')

    expect(build.needs).toBe('setup')
    expect(build.if).toBe("${{ needs.setup.result == 'success' }}")
    expect(nightly.jobs.prepare.needs).toEqual(['plan', 'build'])
    expect(Object.keys(release.jobs)).toEqual(['build'])
    expect(release.jobs.build).toMatchObject({
      uses: './.github/workflows/build.yml',
      with: { mac_only: true }
    })
    expect(release.jobs.build.secrets).toBeUndefined()
  })

  it('keeps private Nightly manual and prepares diagnostics without write access', () => {
    const nightly = workflow('nightly.yml')
    const schedule = nightly.on?.schedule as Array<{ cron: string }>
    const prepare = nightly.jobs.prepare

    expect(nightly.on).not.toHaveProperty('push')
    expect(schedule).toBeUndefined()
    expect(nightly.on).toHaveProperty('workflow_dispatch')
    expect(nightly.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(nightly.concurrency).toEqual({
      group: 'nightly-build',
      'cancel-in-progress': true
    })
    expect(nightly.jobs.build).toMatchObject({
      needs: 'plan',
      if: "needs.plan.outputs.should_build == 'true'",
      uses: './.github/workflows/build.yml',
      with: { nightly: true }
    })
    expect(nightly.jobs.build.secrets).toBeUndefined()
    expect(step(nightly.jobs.plan, 'Compare main with the rolling nightly tag').run).toContain(
      'repos/$GITHUB_REPOSITORY/commits/nightly'
    )
    expect(nightly.jobs).not.toHaveProperty('publish-dry-run')
    expect(prepare).toMatchObject({
      needs: ['plan', 'build'],
      if: "needs.build.result == 'success'",
      'runs-on': 'ubuntu-latest'
    })
    expect(step(prepare, 'Aggregate release certification evidence').run).toContain(
      '--expected-sha "$GITHUB_SHA"'
    )
    expect(step(prepare, 'Generate checksums').run).toContain('sha256sum')
    expect(step(prepare, 'Upload prepared nightly metadata').with).toMatchObject({
      name: 'nightly-ready',
      'retention-days': 1,
      'if-no-files-found': 'error'
    })
  })

  it('verifies selected nightly artifacts without a publication trigger or write scope', () => {
    const verifyWorkflow = workflow('nightly-publish.yml')
    const verify = verifyWorkflow.jobs.verify
    const download = step(verify, 'Download prepared nightly artifacts')

    expect(verifyWorkflow.on).toEqual({
      workflow_dispatch: {
        inputs: {
          source_run_id: {
            description: 'Successful Nightly workflow run ID to verify',
            required: true,
            type: 'string'
          }
        }
      }
    })
    expect(verifyWorkflow.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(verifyWorkflow.concurrency).toEqual({
      group: 'nightly-artifact-verification-${{ inputs.source_run_id }}',
      'cancel-in-progress': true
    })
    expect(Object.keys(verifyWorkflow.jobs)).toEqual(['verify'])
    expect(download.with).toMatchObject({
      'github-token': '${{ github.token }}',
      'run-id': '${{ inputs.source_run_id }}',
      'merge-multiple': true
    })
    const checksum = step(verify, 'Verify prepared nightly metadata and checksums')
    expect(checksum.run).toContain('test -s artifacts/RELEASE-CERTIFICATION.json')
    expect(checksum.run).toContain('sha256sum --check SHA256SUMS.txt')
    expect(verify.steps?.some(({ uses }) => uses?.startsWith('actions/checkout@'))).toBe(false)
  })

  it('keeps every inherited publication workflow manual, read-only, and credential-free', () => {
    for (const name of [
      'release.yml',
      'nightly.yml',
      'nightly-publish.yml',
      'mirror-to-website.yml',
      'stage-runtime-bundle.yml',
      'notarize-dryrun.yml',
      'notarize-mac.yml'
    ]) {
      const candidate = workflow(name)
      const text = workflowText(name)
      const permissionSets = [candidate.permissions]
        .concat(Object.values(candidate.jobs).map((job) => job.permissions))
        .filter((permissions): permissions is Record<string, string> => permissions !== undefined)

      for (const permissions of permissionSets) {
        expect(Object.values(permissions), name).not.toContain('write')
      }
      expect(text, name).not.toMatch(/softprops\/action-gh-release/i)
      expect(text, name).not.toMatch(/actions\/attest-build-provenance/i)
      expect(text, name).not.toMatch(/\bgh\s+release\s+(?:create|delete|upload)\b/i)
      expect(text, name).not.toMatch(/\baws\s+s3(?:api)?\b/i)
      expect(text, name).not.toMatch(/S3_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|BUCKET)/)
      expect(text, name).not.toMatch(/event_type=windows-upgrade-smoke/)
      expect(text, name).not.toMatch(/notarytool\s+submit/)
    }
  })

  it('retains Apple-Silicon runtime staging only as a one-day verification artifact', () => {
    const runtime = workflow('stage-runtime-bundle.yml')
    const verify = runtime.jobs.verify

    expect(runtime.on).toHaveProperty('workflow_dispatch')
    expect(runtime.permissions).toEqual({ contents: 'read' })
    expect(verify['runs-on']).toBe('macos-14')
    expect(step(verify, 'Fetch pinned Apple-Silicon micromamba').run).toContain(
      'fetch-micromamba.mjs osx-arm64'
    )
    expect(step(verify, 'Stage default environments').env).toEqual({
      OS_STAGE_PLATFORM: 'osx-arm64'
    })
    expect(step(verify, 'Retain verification bundle').with).toMatchObject({
      'retention-days': 1,
      'if-no-files-found': 'error'
    })
  })

  it('runs Windows upgrade smoke independently against published release assets', () => {
    const smokeWorkflow = workflow('windows-upgrade-smoke.yml')
    const smoke = smokeWorkflow.jobs['windows-upgrade-smoke']
    const dispatch = smokeWorkflow.on?.repository_dispatch as { types: string[] }

    expect(dispatch.types).toEqual(['windows-upgrade-smoke'])
    expect(smokeWorkflow.on).toHaveProperty('workflow_dispatch')
    expect(smokeWorkflow.concurrency?.['cancel-in-progress']).toBe(false)
    expect(smoke['continue-on-error']).toBeUndefined()
    expect(step(smoke, 'Download current Windows installer').run).toContain(
      'gh release download $env:CURRENT_TAG'
    )
    expect(step(smoke, 'Upload Windows update-drill evidence').if).toBe('always()')
    expect(step(smoke, 'Report Windows update-drill outcome').run).toBe('exit 1')
  })

  it('pins third-party actions in every changed workflow', () => {
    for (const name of [
      'build.yml',
      'nightly.yml',
      'nightly-publish.yml',
      'release.yml',
      'mirror-to-website.yml',
      'stage-runtime-bundle.yml',
      'notarize-dryrun.yml',
      'notarize-mac.yml',
      'windows-full-test.yml',
      'windows-upgrade-smoke.yml'
    ]) {
      for (const job of Object.values(workflow(name).jobs)) {
        for (const candidate of job.steps ?? []) {
          if (!candidate.uses || candidate.uses.startsWith('./')) continue
          expect(candidate.uses, `${name}: ${candidate.name}`).toMatch(/^[^@]+@[0-9a-f]{40}$/)
        }
      }
    }
  })
})
