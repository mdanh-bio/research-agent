// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WORK_CLASSES } from '../../../../shared/model-routing'
import type { EffectiveRouteView } from '../../../../shared/routing-settings'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { RoutingPanel } from './RoutingPanel'

let container: HTMLDivElement
let root: Root

const effectiveRoutes = Object.fromEntries(
  WORK_CLASSES.map((workClass) => [
    workClass,
    {
      workClass,
      source: 'shipped_default',
      target: {
        id: `configured:opencode:provider-1:${workClass}`,
        backend: 'opencode',
        providerId: 'provider-1',
        model: workClass === 'plan' ? 'model-strong' : 'model-medium',
        reasoningEffort: workClass === 'plan' ? 'high' : 'medium',
        capabilities: ['text', 'tool_use', 'reasoning', 'long_context'],
        dataBoundary: 'approved_cloud',
        contextWindow: 200_000
      },
      alternateCount: 1
    } satisfies EffectiveRouteView
  ])
)

beforeEach(() => {
  useSettingsStore.setState(createInitialSettingsState())
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('RoutingPanel', () => {
  it('shows an explicit default-off selector and accurate local-export state', () => {
    act(() => root.render(<RoutingPanel />))

    expect(
      container.querySelector('[data-routing-status]')?.getAttribute('data-routing-status')
    ).toBe('off')
    expect(container.textContent).toContain('Current sessions use Model and Agent settings')
    expect(
      container.querySelector<HTMLSelectElement>('[aria-label="Routing profile"]')?.value
    ).toBe('off')
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="External telemetry"]')
    ).toMatchObject({
      checked: false,
      disabled: true
    })
  })

  it('persists an explicit profile choice through the settings store', () => {
    const setRoutingProfile = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ setRoutingProfile })
    act(() => root.render(<RoutingPanel />))

    const select = container.querySelector<HTMLSelectElement>('[aria-label="Routing profile"]')!
    act(() => {
      select.value = 'research_max'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(setRoutingProfile).toHaveBeenCalledWith('research_max')
  })

  it('renders concrete active routes without exposing provider credentials', () => {
    useSettingsStore.setState({
      providers: [
        {
          id: 'provider-1',
          type: 'official',
          name: 'Configured provider',
          models: ['model-strong', 'model-medium'],
          supportsImageInput: false,
          hasKey: true,
          needsKey: false,
          maskedKey: 'sk-…cret'
        }
      ],
      routing: {
        profile: 'research_max',
        telemetryEnabled: false,
        status: 'active',
        effectiveRoutes
      }
    })
    act(() => root.render(<RoutingPanel />))

    expect(
      container.querySelector('[data-routing-status]')?.getAttribute('data-routing-status')
    ).toBe('active')
    expect(container.textContent).toContain('Configured provider / model-strong')
    expect(container.textContent).toContain('shipped default')
    expect(container.textContent).not.toContain('sk-…cret')
    expect(container.querySelectorAll('[aria-label="Effective routes"] tbody tr')).toHaveLength(11)
  })
})
