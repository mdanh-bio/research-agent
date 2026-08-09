import { describe, expect, it } from 'vitest'

import { resolveMessageDelivery } from './message-delivery'

describe('resolveMessageDelivery', () => {
  it('continues normally when auto is used without an active turn', () => {
    expect(resolveMessageDelivery({ requested: 'auto', hasActiveTurn: false })).toMatchObject({
      resolved: 'continue',
      source: 'idle-default'
    })
  })

  it('honors explicit steering even without a classifier', () => {
    expect(resolveMessageDelivery({ requested: 'steer', hasActiveTurn: true })).toMatchObject({
      resolved: 'steer',
      source: 'explicit'
    })
  })

  it('uses a high-confidence recommendation without changing message content', () => {
    expect(
      resolveMessageDelivery({
        requested: 'auto',
        hasActiveTurn: true,
        recommendation: { mode: 'steer', confidence: 0.91 }
      })
    ).toMatchObject({ resolved: 'steer', source: 'router' })
  })

  it('defaults uncertain active-turn messages to a non-destructive side question', () => {
    expect(
      resolveMessageDelivery({
        requested: 'auto',
        hasActiveTurn: true,
        recommendation: { mode: 'stop-and-replace', confidence: 0.4 }
      })
    ).toMatchObject({ resolved: 'side-question', source: 'safe-default' })
  })

  it.each([
    { confidenceThreshold: -0.1 },
    { confidenceThreshold: 1.1 },
    { confidenceThreshold: null as never },
    { recommendation: { mode: 'stop-and-replace' as const, confidence: -0.1 } },
    { recommendation: { mode: 'stop-and-replace' as const, confidence: 1.1 } },
    { recommendation: { mode: 'stop-and-replace' as const, confidence: Number.NaN } }
  ])('fails safely for out-of-range router trust input %j', (untrusted) => {
    expect(
      resolveMessageDelivery({
        requested: 'auto',
        hasActiveTurn: true,
        recommendation: { mode: 'stop-and-replace', confidence: 1 },
        ...untrusted
      })
    ).toMatchObject({ resolved: 'side-question', source: 'safe-default' })
  })
})
