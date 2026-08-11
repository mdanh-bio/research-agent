import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8')
  },
  app: { getPath: () => '/tmp', getAppPath: () => '/tmp', isPackaged: false },
  net: { fetch: vi.fn() }
}))

const { SettingsRepository } = await import('./repository')
const { SettingsService } = await import('./service')

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'research-agent-routing-service-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('SettingsService transparent routing', () => {
  it('keeps the captured backend path unchanged while routing is off', async () => {
    const repository = new SettingsRepository(root)
    await repository.setAgentFramework('opencode')
    const service = new SettingsService({ repository, storageRoot: root })

    await expect(service.captureActiveAgentBackendRoute()).resolves.toEqual({
      kind: 'legacy',
      selection: { frameworkId: 'opencode' }
    })
    expect((await service.getSettingsView()).routing).toMatchObject({
      profile: 'off',
      status: 'off',
      telemetryEnabled: false
    })
  })

  it('persists an opt-in profile and resolves concrete configured targets', async () => {
    const repository = new SettingsRepository(root)
    await repository.upsertProvider({
      id: 'local-provider',
      type: 'custom',
      name: 'Local provider',
      apiEndpoints: ['openai'],
      baseUrl: 'http://127.0.0.1:8317/v1',
      model: 'model-a',
      contextWindow: 200_000,
      supportsImageInput: true
    })
    await repository.setActiveProvider('local-provider', 'model-a')
    await repository.setAgentFramework('opencode')
    const service = new SettingsService({ repository, storageRoot: root })

    const snapshot = await service.setRoutingProfile('balanced')
    const resolution = await service.resolveConfiguredRoute('analysis')

    expect(snapshot.routing).toMatchObject({ profile: 'balanced', status: 'active' })
    expect(resolution?.decision.target).toMatchObject({
      backend: 'opencode',
      providerId: 'local-provider',
      model: 'model-a',
      dataBoundary: 'any_configured'
    })
    expect(resolution?.decision.eligibleAlternates).toEqual([])
  })
})
