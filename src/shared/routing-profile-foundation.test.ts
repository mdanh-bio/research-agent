import { describe, expect, it } from 'vitest'

import { WORK_CLASSES } from './model-routing'
import { ROUTING_PROFILE_FOUNDATION_DEFINITIONS } from './routing-profile-foundation'

describe('routing profile foundation', () => {
  it('publishes the complete shipped profile mappings without claiming activation', () => {
    expect(ROUTING_PROFILE_FOUNDATION_DEFINITIONS.map(({ name }) => name)).toEqual([
      'Research Max',
      'Balanced',
      'Economy'
    ])

    for (const profile of ROUTING_PROFILE_FOUNDATION_DEFINITIONS) {
      expect(Object.keys(profile.workClassTiers)).toEqual(WORK_CLASSES)
    }
  })
})
