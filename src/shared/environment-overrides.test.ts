import { describe, expect, it } from 'vitest'

import {
  LEGACY_OPEN_SCIENCE_ENV_OPT_IN,
  allowsLegacyOpenScienceEnvironment,
  readResearchAgentEnvironment
} from './environment-overrides'

describe('Research Agent environment overrides', () => {
  it('ignores legacy Open Science variables by default', () => {
    expect(
      readResearchAgentEnvironment(
        { OPEN_SCIENCE_STORAGE_ROOT: '/legacy' },
        'RESEARCH_AGENT_STORAGE_ROOT',
        'OPEN_SCIENCE_STORAGE_ROOT'
      )
    ).toBeUndefined()
  })

  it('accepts a legacy variable only through the exact compatibility opt-in', () => {
    const environment = {
      [LEGACY_OPEN_SCIENCE_ENV_OPT_IN]: '1',
      OPEN_SCIENCE_STORAGE_ROOT: '/legacy'
    }

    expect(allowsLegacyOpenScienceEnvironment(environment)).toBe(true)
    expect(
      readResearchAgentEnvironment(
        environment,
        'RESEARCH_AGENT_STORAGE_ROOT',
        'OPEN_SCIENCE_STORAGE_ROOT'
      )
    ).toBe('/legacy')
  })

  it('always prefers the Research Agent variable', () => {
    expect(
      readResearchAgentEnvironment(
        {
          [LEGACY_OPEN_SCIENCE_ENV_OPT_IN]: '1',
          RESEARCH_AGENT_STORAGE_ROOT: '/current',
          OPEN_SCIENCE_STORAGE_ROOT: '/legacy'
        },
        'RESEARCH_AGENT_STORAGE_ROOT',
        'OPEN_SCIENCE_STORAGE_ROOT'
      )
    ).toBe('/current')
  })
})
