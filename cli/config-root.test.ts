import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { TOKEN_FILE as APP_TOKEN_FILE } from '../src/main/web-service/auth'
import { WEB_SERVICE_STATE_FILE } from '../src/main/web-service/state-file'
import { DEV_CONFIG_DIR, STATE_FILE, TOKEN_FILE, resolveConfigRoot } from './config-root.mjs'

// The CLI (a standalone .mjs, separate module system) can't import the app's TypeScript constants at
// runtime, so it re-declares the state/token filenames. This guard fails loudly if the app renames one
// side without the other, which would otherwise silently break `open-science status/stop/url`.
describe('CLI config-root constants stay in lockstep with the app', () => {
  it('uses the same state and token filenames as the web service', () => {
    expect(STATE_FILE).toBe(WEB_SERVICE_STATE_FILE)
    expect(TOKEN_FILE).toBe(APP_TOKEN_FILE)
  })

  it('prefers Research Agent config and storage overrides', () => {
    expect(
      resolveConfigRoot({
        env: {
          RESEARCH_AGENT_CONFIG_ROOT: '/research-agent/config',
          RESEARCH_AGENT_STORAGE_ROOT: '/research-agent/storage'
        }
      })
    ).toBe('/research-agent/config')
    expect(
      resolveConfigRoot({ env: { RESEARCH_AGENT_STORAGE_ROOT: '/research-agent/storage' } })
    ).toBe('/research-agent/storage')
  })

  it('ignores legacy config and storage overrides by default', () => {
    expect(
      resolveConfigRoot({
        env: {
          OPEN_SCIENCE_CONFIG_ROOT: '/legacy/config',
          OPEN_SCIENCE_STORAGE_ROOT: '/legacy/storage'
        }
      })
    ).toBe(join(homedir(), DEV_CONFIG_DIR))
  })

  it('accepts legacy overrides only through the compatibility opt-in', () => {
    expect(
      resolveConfigRoot({
        env: {
          RESEARCH_AGENT_ALLOW_LEGACY_OPEN_SCIENCE_ENV: '1',
          OPEN_SCIENCE_CONFIG_ROOT: '/legacy/config'
        }
      })
    ).toBe('/legacy/config')
  })

  it('keeps Research Agent precedence when compatibility is enabled', () => {
    expect(
      resolveConfigRoot({
        env: {
          RESEARCH_AGENT_ALLOW_LEGACY_OPEN_SCIENCE_ENV: '1',
          RESEARCH_AGENT_CONFIG_ROOT: '/research-agent/config',
          OPEN_SCIENCE_CONFIG_ROOT: '/legacy/config'
        }
      })
    ).toBe('/research-agent/config')
  })
})
