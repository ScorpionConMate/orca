// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { usePluginPanelThemeRevision } from './use-plugin-panel-theme-revision'

let root: Root | null = null
let container: HTMLDivElement | null = null

function renderProbe(): { revisions: number[] } {
  const revisions: number[] = []
  function Probe(): null {
    revisions.push(usePluginPanelThemeRevision())
    return null
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<Probe />))
  return { revisions }
}

async function flushObserver(): Promise<void> {
  // MutationObserver delivers on a microtask; give React a chance to re-render.
  await act(async () => {
    await Promise.resolve()
  })
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  document.documentElement.className = ''
  document.documentElement.removeAttribute('style')
})

describe('usePluginPanelThemeRevision', () => {
  it('bumps when the root theme class changes', async () => {
    const { revisions } = renderProbe()
    const before = revisions.at(-1)

    document.documentElement.className = 'dark'
    await flushObserver()

    expect(revisions.at(-1)).toBeGreaterThan(before!)
  })

  it('bumps when root design tokens change', async () => {
    const { revisions } = renderProbe()
    const before = revisions.at(-1)

    document.documentElement.style.setProperty('--background', '#000')
    await flushObserver()

    expect(revisions.at(-1)).toBeGreaterThan(before!)
  })

  it('ignores mutations outside the document root', async () => {
    const { revisions } = renderProbe()
    const before = revisions.at(-1)

    container!.className = 'unrelated'
    await flushObserver()

    expect(revisions.at(-1)).toBe(before)
  })
})
