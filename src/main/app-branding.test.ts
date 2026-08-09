import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const projectRoot = resolve(__dirname, '../..')
const displayName = 'Research Agent'
const appId = 'bio.mdanh.research-agent'

describe('app display branding', () => {
  it('uses the Research Agent display name in shell and workspace surfaces', () => {
    const mainSource = readFileSync(resolve(projectRoot, 'src/main/index.ts'), 'utf8')
    const windowsSource = readFileSync(resolve(projectRoot, 'src/main/windows.ts'), 'utf8')
    const rendererHtmlSource = readFileSync(resolve(projectRoot, 'src/renderer/index.html'), 'utf8')
    const builderSource = readFileSync(resolve(projectRoot, 'electron-builder.yml'), 'utf8')
    const packageSource = readFileSync(resolve(projectRoot, 'package.json'), 'utf8')
    // The product name now anchors the home screen brand (the workspace sidebar shows the project).
    const homePageSource = readFileSync(
      resolve(projectRoot, 'src/renderer/src/pages/home/HomePage.tsx'),
      'utf8'
    )

    expect(mainSource).toContain(`const APP_NAME = '${displayName}'`)
    expect(windowsSource).toContain(`title: '${displayName}'`)
    expect(rendererHtmlSource).toContain(`<title>${displayName}</title>`)
    expect(builderSource).toContain(`productName: ${displayName}`)
    expect(builderSource).toContain(`CFBundleName: ${displayName}`)
    expect(builderSource).toContain(`CFBundleDisplayName: ${displayName}`)
    expect(packageSource).toContain(`"productName": "${displayName}"`)
    expect(homePageSource).toContain('{APP.name}')
  })

  it('uses the private app identifier for packaged and window integration metadata', () => {
    const mainSource = readFileSync(resolve(projectRoot, 'src/main/index.ts'), 'utf8')
    const builderSource = readFileSync(resolve(projectRoot, 'electron-builder.yml'), 'utf8')

    expect(mainSource).toContain(`const APP_USER_MODEL_ID = '${appId}'`)
    expect(builderSource).toContain(`appId: ${appId}`)
  })

  it('isolates private data roots and disables the public updater', () => {
    const repositorySource = readFileSync(
      resolve(projectRoot, 'src/main/session-persistence/repository.ts'),
      'utf8'
    )
    const storageSource = readFileSync(resolve(projectRoot, 'src/main/storage-root.ts'), 'utf8')
    const appConfigSource = readFileSync(resolve(projectRoot, 'src/shared/app-config.ts'), 'utf8')
    const builderSource = readFileSync(resolve(projectRoot, 'electron-builder.yml'), 'utf8')

    expect(repositorySource).toContain("PROD_SESSION_DIR_NAME = '.research-agent'")
    expect(repositorySource).toContain("DEV_SESSION_DIR_NAME = '.research-agent-project'")
    expect(storageSource).toContain("app.isPackaged ? 'ResearchAgent' : 'ResearchAgent-DEV'")
    expect(appConfigSource).toContain('enabled: false')
    expect(builderSource).not.toContain('https://statics.aipoch.com/open-science/app/stable')
  })

  it('uses the fork name in representative user-visible copy surfaces', () => {
    const surfaces = [
      'packages/open-science/cli.mjs',
      'src/main/remote-access/pairing-page.ts',
      'src/renderer/src/pages/onboarding/AgentStep.tsx',
      'src/renderer/src/pages/settings/ComputeAddForm.tsx',
      'src/renderer/src/pages/settings/ComputePanel.tsx',
      'src/renderer/src/pages/settings/ProviderForm.tsx',
      'src/renderer/src/pages/settings/ProviderList.tsx',
      'src/renderer/src/pages/settings/provider-key-security.ts',
      'src/renderer/src/pages/settings/RemoteControlPanel.tsx',
      'src/renderer/src/stores/settings-store.ts'
    ].map((path) => readFileSync(resolve(projectRoot, path), 'utf8'))

    for (const source of surfaces) {
      expect(source).toContain(displayName)
      expect(source).not.toContain('Open Science')
    }
  })

  it('opens tall enough to show the complete first-run environment summary', () => {
    const windowsSource = readFileSync(resolve(projectRoot, 'src/main/windows.ts'), 'utf8')

    expect(windowsSource).toContain('height: 960')
    expect(windowsSource).toContain('minHeight: 720')
  })

  it('awaits Electron readiness inside the startup promise chain', () => {
    const mainSource = readFileSync(resolve(projectRoot, 'src/main/index.ts'), 'utf8')

    expect(mainSource).toContain('await app.whenReady()')
    expect(mainSource).not.toContain('app.whenReady().then')
  })
})
