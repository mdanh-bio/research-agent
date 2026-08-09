import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

type WorkflowStep = {
  'continue-on-error'?: boolean
  env?: Record<string, string>
  id?: string
  if?: string
  name?: string
  run?: string
  'timeout-minutes'?: number
  uses?: string
  with?: Record<string, unknown>
}

type WorkflowJob = {
  'continue-on-error'?: boolean
  env?: Record<string, string>
  if?: string
  needs?: string | string[]
  permissions?: Record<string, string>
  'runs-on'?: string
  steps?: WorkflowStep[]
  strategy?: { matrix?: Record<string, unknown> }
  'timeout-minutes'?: number
  uses?: string
  with?: Record<string, unknown>
}

type Workflow = {
  jobs: Record<string, WorkflowJob>
  permissions?: Record<string, string>
  on?: {
    push?: { branches?: string[]; tags?: string[] }
    workflow_call?: unknown
    workflow_dispatch?: unknown
  }
}

const readWorkflow = (name: string): Workflow =>
  load(readFileSync(join(process.cwd(), '.github', 'workflows', name), 'utf8')) as Workflow

const readWorkflowText = (name: string): string =>
  readFileSync(join(process.cwd(), '.github', 'workflows', name), 'utf8')

const findStep = (job: WorkflowJob, name: string): WorkflowStep => {
  const step = job.steps?.find((candidate) => candidate.name === name)
  if (!step) throw new Error(`Missing workflow step: ${name}`)
  return step
}

describe('post-merge Windows validation', () => {
  it('stages the pinned compatibility runner before packaging Windows builds', () => {
    const job = readWorkflow('build.yml').jobs.build
    const stage = findStep(job, 'Stage notebook runtime resources')

    expect(stage.run).toContain('micromamba-compat.exe')
    expect(stage.run).toContain('compatibility')
    expect(stage.run).toContain('matrix.subdir }}" = "win-64')
    expect(stage.run).toContain('"$compatibility_path" --version')
  })

  it('runs the complete Windows suite independently after changes land on main', () => {
    const build = readWorkflow('build.yml')
    const workflow = readWorkflow('windows-full-test.yml')
    const job = workflow.jobs.windows_full_test

    expect(build.jobs.windows_full_test).toBeUndefined()
    expect(workflow.on?.push).toMatchObject({ branches: ['main'] })
    expect(workflow.on).not.toHaveProperty('workflow_call')
    expect(job).toMatchObject({
      'runs-on': 'windows-latest'
    })
    expect(job['continue-on-error']).toBeUndefined()
    expect(job.strategy?.matrix?.shard).toEqual([1, 2, 3])
    expect(findStep(job, 'Test complete suite shard').run).toBe(
      'npm test -- --shard=${{ matrix.shard }}/3 --maxWorkers=1 --testTimeout=60000 --hookTimeout=60000'
    )
  })

  it('hard-gates every packaged Windows build on a fresh install/start/uninstall smoke', () => {
    const job = readWorkflow('build.yml').jobs.build
    const buildIndex = job.steps?.findIndex(({ name }) => name === 'Build & package') ?? -1
    const smokeIndex =
      job.steps?.findIndex(({ name }) => name === 'Smoke test Windows installer') ?? -1
    const uploadIndex = job.steps?.findIndex(({ name }) => name === 'Upload build artifacts') ?? -1
    const smoke = findStep(job, 'Smoke test Windows installer')

    expect(smoke.if).toBe("${{ matrix.platform == 'win' && !inputs.skip_verify }}")
    expect(smoke.run).toBe('node scripts/windows-installer-smoke.mjs --installer-dir dist')
    expect(smoke['timeout-minutes']).toBe(10)
    expect(buildIndex).toBeGreaterThan(-1)
    expect(smokeIndex).toBeGreaterThan(buildIndex)
    expect(uploadIndex).toBeGreaterThan(smokeIndex)
  })

  it('keeps Windows packaging unsigned until signing credentials are available', () => {
    const build = readWorkflow('build.yml')
    const job = build.jobs.build
    const names = job.steps?.map(({ name }) => name) ?? []
    const prepareMacSigning = findStep(job, 'Prepare macOS signing keychain')
    const packageStep = findStep(job, 'Build & package')
    const cleanupMacSigning = findStep(job, 'Clean up macOS signing keychain')

    expect(names).not.toContain('Require Windows signing credentials')
    expect(names).not.toContain('Verify Windows Authenticode signature')
    expect(prepareMacSigning).toMatchObject({
      id: 'mac_signing',
      if: "${{ matrix.platform == 'mac' && !inputs.nightly }}"
    })
    expect(prepareMacSigning.run).toContain('security create-keychain -p "$keychain_password"')
    expect(prepareMacSigning.run).toContain('security list-keychains -d user > "$keychain_list"')
    expect(prepareMacSigning.run).toContain(
      'security list-keychains -d user -s "$keychain" "${user_keychains[@]}"'
    )
    expect(prepareMacSigning.run).toContain('-P "${MAC_CSC_KEY_PASSWORD:-}"')
    expect(prepareMacSigning.run).toContain('-k "$keychain_password"')
    expect(prepareMacSigning.run).toContain("grep -q 'Developer ID Application:'")
    expect(packageStep.env).toEqual({
      CSC_KEYCHAIN: '${{ steps.mac_signing.outputs.keychain }}'
    })
    expect(packageStep.run).toContain(
      'if [ "${{ steps.mac_signing.outputs.enabled }}" = "true" ]; then'
    )
    expect(cleanupMacSigning).toMatchObject({
      if: "${{ always() && steps.mac_signing.outputs.keychain != '' }}",
      env: {
        MAC_SIGNING_CERTIFICATE: '${{ steps.mac_signing.outputs.certificate }}',
        MAC_SIGNING_KEYCHAIN: '${{ steps.mac_signing.outputs.keychain }}',
        MAC_SIGNING_KEYCHAIN_LIST: '${{ steps.mac_signing.outputs.keychain_list }}'
      }
    })
    expect(cleanupMacSigning.run).toContain(
      'security list-keychains -d user -s "${user_keychains[@]}"'
    )
    expect(cleanupMacSigning.run).toContain('security delete-keychain "$MAC_SIGNING_KEYCHAIN"')
    expect(cleanupMacSigning.run).toContain(
      'rm -f "$MAC_SIGNING_CERTIFICATE" "$MAC_SIGNING_KEYCHAIN_LIST"'
    )
    expect(packageStep.run).toContain('unsigned_args=(-c.dmg.sign=false)')
    expect(packageStep.run).not.toContain('publisherName')
  })

  it('runs one canonical packaged P0 and visual gate plus native package smoke on every target', () => {
    const setup = readWorkflow('build.yml').jobs.setup.steps?.find(({ id }) => id === 'set')
    const job = readWorkflow('build.yml').jobs.build
    const names = job.steps?.map(({ name }) => name) ?? []
    const packaged = findStep(job, 'Resolve packaged Electron executable')
    const p0 = findStep(job, 'Run P0 Electron certification')
    const visual = findStep(job, 'Run desktop visual regression')
    const macos = findStep(job, 'Smoke test macOS packages')
    const linux = findStep(job, 'Smoke test Linux packages')
    const evidence = findStep(job, 'Record platform certification evidence')
    const macVerification = readWorkflow('notarize-mac.yml').jobs.verify
    const notarizeDryRun = readWorkflow('notarize-dryrun.yml').jobs.verify
    const finalMacos = findStep(macVerification, 'Verify package structure and local signature')

    expect(setup.run).toContain('"name":"macos-arm64","os":"macos-26"')
    expect(setup.run).toContain('"name":"macos-x64","os":"macos-26-intel"')
    expect(job.env?.MACOSX_DEPLOYMENT_TARGET).toBe(
      "${{ matrix.platform == 'mac' && '12.0' || '' }}"
    )
    expect(packaged.id).toBe('packaged_app')
    expect(packaged.run).toContain('Research Agent.app/Contents/MacOS/Research Agent')
    expect(packaged.run).toContain('win-unpacked/research-agent.exe')
    expect(packaged.run).toContain('linux-unpacked/research-agent')
    expect(linux.run).toContain('apt-get remove --yes research-agent')
    expect(linux.run).toContain('--installed-executable /usr/bin/research-agent')
    expect(p0.env?.RESEARCH_AGENT_E2E_EXECUTABLE).toBe(
      '${{ steps.packaged_app.outputs.executable }}'
    )
    expect(visual.env?.RESEARCH_AGENT_E2E_EXECUTABLE).toBe(
      '${{ steps.packaged_app.outputs.executable }}'
    )
    expect(p0.if).toContain("matrix.name == 'macos-arm64'")
    expect(visual.if).toContain("matrix.name == 'macos-arm64'")
    expect(p0.run).toBe('npm run test:e2e:p0')
    expect(visual.run).toBe('npm run test:e2e:visual')
    expect(macos.if).toBe("${{ matrix.platform == 'mac' && !inputs.skip_verify }}")
    expect(macos.run).toBe('node scripts/macos-package-smoke.mjs --artifact-dir dist')
    expect(linux.run).toContain('scripts/linux-package-smoke.mjs')
    expect(evidence.run).toContain('package_smoke=passed')
    expect(evidence.run).toContain('electron_p0=not-applicable')
    expect(evidence.run).toContain('visual_regression=not-applicable')
    expect(evidence.run).toContain('--electron-p0 "$electron_p0"')
    expect(evidence.run).toContain('--visual-regression "$visual_regression"')
    expect(finalMacos.run).toBe('node scripts/macos-package-smoke.mjs --artifact-dir mac')
    expect(macVerification['runs-on']).toBe('${{ matrix.os }}')
    expect(macVerification.strategy?.matrix).toEqual({
      include: [
        { arch: 'arm64', os: 'macos-15' },
        { arch: 'x64', os: 'macos-15-intel' }
      ]
    })
    expect(notarizeDryRun.uses).toBe('./.github/workflows/notarize-mac.yml')
    expect(notarizeDryRun).not.toHaveProperty('secrets')
    expect(names.indexOf('Record platform certification evidence')).toBeGreaterThan(
      names.indexOf('Smoke test macOS packages')
    )
    expect(names.indexOf('Record platform certification evidence')).toBeGreaterThan(
      names.indexOf('Smoke test Linux packages')
    )
    expect(names.indexOf('Upload build artifacts')).toBeGreaterThan(
      names.indexOf('Record platform certification evidence')
    )
    expect(findStep(macVerification, 'Retain verified Mac artifacts').with).toMatchObject({
      'retention-days': 1,
      'if-no-files-found': 'error'
    })
  })

  it('uploads built packages before enforcing collected certification outcomes', () => {
    const job = readWorkflow('build.yml').jobs.build
    const names = job.steps?.map(({ name }) => name) ?? []
    const packaged = findStep(job, 'Build & package')
    const p0 = findStep(job, 'Run P0 Electron certification')
    const visual = findStep(job, 'Run desktop visual regression')
    const macos = findStep(job, 'Smoke test macOS packages')
    const windows = findStep(job, 'Smoke test Windows installer')
    const linux = findStep(job, 'Smoke test Linux packages')
    const evidence = findStep(job, 'Record platform certification evidence')
    const upload = findStep(job, 'Upload build artifacts')
    const enforce = findStep(job, 'Enforce platform certification')

    expect(packaged.id).toBe('package')
    for (const step of [p0, visual, macos, windows, linux]) {
      expect(step.id).toBeDefined()
      expect(step['continue-on-error']).toBe(true)
    }
    expect(evidence.if).toContain("steps.p0.outcome == 'success'")
    expect(evidence.if).toContain("steps.visual.outcome == 'success'")
    expect(evidence.if).toContain("matrix.name != 'macos-arm64'")
    expect(evidence.if).toContain("steps.p0.outcome == 'skipped'")
    expect(evidence.if).toContain("steps.visual.outcome == 'skipped'")
    expect(upload.if).toBe("${{ always() && steps.package.outcome == 'success' }}")
    expect(enforce.if).toBe('${{ !inputs.skip_verify && always() }}')
    expect(enforce.env).toMatchObject({
      MATRIX_NAME: '${{ matrix.name }}',
      P0_OUTCOME: '${{ steps.p0.outcome }}',
      VISUAL_OUTCOME: '${{ steps.visual.outcome }}'
    })
    expect(enforce.run).toContain('if [[ "$MATRIX_NAME" == "macos-arm64" ]]')
    expect(enforce.run).toContain('exit "$failed"')
    expect(names.indexOf('Upload build artifacts')).toBeLessThan(
      names.indexOf('Enforce platform certification')
    )
  })

  it('builds every platform without repeating the verified typecheck', () => {
    const workflow = readWorkflow('build.yml')
    const verifyTypecheck = findStep(workflow.jobs.verify, 'Typecheck')
    const build = findStep(workflow.jobs.build, 'Build & package')
    const commands = build.run?.split('\n').map((line) => line.trim()) ?? []

    expect(verifyTypecheck.run).toBe('npm run typecheck')
    expect(commands).toContain('npm run build:e2e')
    expect(commands).toContain('npm run build:web')
    expect(commands).not.toContain('npm run build')
    expect(commands.some((command) => command.startsWith('npm run typecheck'))).toBe(false)
  })

  it('keeps Windows update diagnostics independent from the private Mac verification workflow', () => {
    const release = readWorkflow('release.yml')
    const upgrade = readWorkflow('windows-upgrade-smoke.yml').jobs['windows-upgrade-smoke']

    expect(upgrade['runs-on']).toBe('windows-latest')
    expect(upgrade.needs).toBeUndefined()
    expect(upgrade['continue-on-error']).toBeUndefined()
    expect(upgrade['timeout-minutes']).toBe(40)
    expect(findStep(upgrade, 'Setup Node')).toMatchObject({
      uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      with: { 'node-version': 22 }
    })
    expect(findStep(upgrade, 'Install dependencies').run).toBe(
      'npm ci --ignore-scripts --no-audit --no-fund'
    )
    const current = findStep(upgrade, 'Download current Windows installer')
    expect(current.run).toContain('gh release download $env:CURRENT_TAG')
    expect(current.run).toContain("--pattern 'latest.yml'")
    const previous = findStep(upgrade, 'Download previous stable Windows installer')
    expect(previous.run).toContain('gh release download')
    expect(previous.run).toContain('*-win-x64-setup.exe.blockmap')
    expect(previous.run).not.toContain('Get-AuthenticodeSignature')
    expect(previous.run).toContain("$_.tagName -like 'v*'")
    expect(previous.run).toContain('$_.tagName -ne $env:CURRENT_TAG')
    expect(findStep(upgrade, 'Certify Windows electron-updater differential update')).toMatchObject(
      {
        id: 'updater',
        if: "steps.previous.outputs.available == 'true'",
        'continue-on-error': true,
        run: expect.stringContaining('windows-updater-certification.log')
      }
    )
    expect(
      findStep(upgrade, 'Drill Windows silent upgrade, process lock, rollback, and restart').run
    ).toContain('--previous-installer-dir previous')
    expect(
      findStep(upgrade, 'Drill Windows silent upgrade, process lock, rollback, and restart')
    ).toMatchObject({ id: 'installer', 'continue-on-error': true })
    expect(release.jobs['windows-full-test']).toBeUndefined()
    expect(release.jobs['windows-upgrade-smoke']).toBeUndefined()
    expect(Object.keys(release.jobs)).toEqual(['build'])
    expect(release.jobs.build.with).toEqual({ mac_only: true })
    expect(findStep(upgrade, 'Record Windows update-drill evidence').run).toContain(
      'write-windows-update'
    )
    expect(findStep(upgrade, 'Record Windows update-drill evidence').run).toContain(
      '--updater-observation'
    )
    expect(findStep(upgrade, 'Record Windows update-drill evidence').run).toContain(
      "elseif ($passed) { 'passed' } else { 'failed' }"
    )
    expect(findStep(upgrade, 'Upload Windows update-drill evidence')).toMatchObject({
      if: 'always()',
      with: expect.objectContaining({
        path: expect.stringContaining('windows-*-certification.log')
      })
    })
    expect(findStep(upgrade, 'Report Windows update-drill outcome').run).toBe('exit 1')
    expect(readWorkflowText('release.yml')).not.toContain('event_type=windows-upgrade-smoke')
    expect(readWorkflowText('release.yml')).not.toContain('softprops/action-gh-release')
  })

  it('keeps private release verification manual, Mac-only, read-only, and secret-free', () => {
    const release = readWorkflow('release.yml')

    expect(release.on).toEqual({ workflow_dispatch: null })
    expect(release.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(release.jobs)).toEqual(['build'])
    expect(release.jobs.build).toMatchObject({
      uses: './.github/workflows/build.yml',
      with: { mac_only: true }
    })
    expect(release.jobs.build).not.toHaveProperty('secrets')
    expect(readWorkflowText('release.yml')).not.toMatch(/push:\s*\n\s*tags:/)
    expect(readWorkflowText('release.yml')).not.toContain('contents: write')
  })

  it('runs website mirror transform tests locally without cloud credentials', () => {
    const workflow = readWorkflow('mirror-to-website.yml')
    const verify = workflow.jobs.verify

    expect(workflow.on).toEqual({ workflow_dispatch: null })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(findStep(verify, 'Install dependencies without package scripts').run).toBe(
      'npm ci --ignore-scripts --no-audit --no-fund'
    )
    expect(findStep(verify, 'Test manifest and feed transforms').run).toContain(
      'scripts/generate-version-manifest.test.ts'
    )
    expect(findStep(verify, 'Test manifest and feed transforms').run).toContain(
      'scripts/inject-feed-notes.test.ts'
    )
    const text = readWorkflowText('mirror-to-website.yml')
    expect(text).not.toMatch(/S3_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|BUCKET)/)
    expect(text).not.toMatch(/\baws\s+s3(?:api)?\b/i)
    expect(text).not.toMatch(/\bgh\s+release\b/i)
  })

  it('pins external actions in every changed release workflow', () => {
    for (const workflowName of [
      'release.yml',
      'mirror-to-website.yml',
      'stage-runtime-bundle.yml',
      'nightly-publish.yml',
      'notarize-dryrun.yml',
      'notarize-mac.yml',
      'windows-upgrade-smoke.yml'
    ]) {
      const workflow = readWorkflow(workflowName)
      const references = Object.values(workflow.jobs).flatMap((job) =>
        (job.steps ?? []).flatMap(({ uses }) => (uses?.startsWith('./') || !uses ? [] : [uses]))
      )

      expect(references.every((reference) => /@[0-9a-f]{40}$/i.test(reference))).toBe(true)
    }
  })
})
