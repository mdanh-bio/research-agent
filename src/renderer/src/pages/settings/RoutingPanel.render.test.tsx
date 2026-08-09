// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RoutingPanel } from './RoutingPanel'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('RoutingPanel', () => {
  it('shows exact shipped mappings as a read-only, inactive foundation', () => {
    act(() => root.render(<RoutingPanel />))

    expect(
      container.querySelector('[data-routing-status]')?.getAttribute('data-routing-status')
    ).toBe('foundation_not_active')
    expect(container.textContent).toContain('Foundation / not active')
    expect(container.textContent).toContain(
      'No routing policy is persisted or applied to a runtime'
    )
    expect(container.textContent).toContain('Research Max')
    expect(container.textContent).toContain('Balanced')
    expect(container.textContent).toContain('Economy')

    const planRow = Array.from(container.querySelectorAll('tbody tr')).find(
      (row) => row.querySelector('th')?.textContent === 'Plan'
    )
    expect(
      Array.from(planRow?.querySelectorAll('td') ?? []).map((cell) => cell.textContent)
    ).toEqual(['Strong', 'Strong', 'Medium'])
    expect(container.querySelectorAll('tbody tr')).toHaveLength(11)
    expect(container.querySelector('button, input, select')).toBeNull()
  })
})
