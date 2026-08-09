import { describe, expect, it, vi } from 'vitest'

const spawnSync = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawnSync }))
vi.mock('electron', () => ({
  app: {
    getPath: () => '/Applications/Research Agent.app/Contents/MacOS/Research Agent',
    getVersion: () => '0.12.1',
    isPackaged: true
  },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openExternal: vi.fn(async () => {}), openPath: vi.fn(async () => '') }
}))
vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: () => {},
    autoDownload: true,
    autoInstallOnAppQuit: true
  }
}))

import { createUpdateStrategy } from './create-strategy'
import { DisabledUpdateStrategy } from './disabled-strategy'

describe('createUpdateStrategy for the private Research Agent build', () => {
  it.each(['darwin', 'win32', 'linux'] as const)(
    'disables update network access on %s',
    async (platform) => {
      const strategy = createUpdateStrategy(platform, {
        isPackaged: true,
        version: '0.12.1'
      })

      expect(strategy).toBeInstanceOf(DisabledUpdateStrategy)
      await expect(strategy.check()).resolves.toEqual({
        state: 'disabled',
        current: '0.12.1'
      })
      expect(spawnSync).not.toHaveBeenCalled()
    }
  )
})
