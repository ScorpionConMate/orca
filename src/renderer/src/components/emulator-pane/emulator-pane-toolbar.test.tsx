// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmulatorPaneToolbar } from './emulator-pane-toolbar'
import type { DeviceStreamClientState } from './device-stream-client'
import { TooltipProvider } from '@/components/ui/tooltip'

let container: HTMLDivElement
let root: Root

function renderToolbar(state: DeviceStreamClientState | null) {
  act(() => {
    root.render(
      <TooltipProvider>
        <EmulatorPaneToolbar
          displayName="Test Device"
          isLive={state === 'streaming'}
          loading={false}
          devices={[]}
          selectedUdid={null}
          onSelectDevice={vi.fn()}
          onAttach={vi.fn()}
          onShutdown={vi.fn()}
          onHome={vi.fn()}
          onRotate={vi.fn()}
          remoteStreamState={state}
        />
      </TooltipProvider>
    )
  })
}

describe('EmulatorPaneToolbar remote status badges', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
    vi.restoreAllMocks()
  })

  function getBadgeText(): string | null {
    const badgeEl = container.querySelector('[data-slot="badge"]')
    return badgeEl?.textContent ?? null
  }

  function hasSpinner(): boolean {
    return container.querySelector('[class*="animate-spin"]') !== null
  }

  it('shows connecting badge with spinner', () => {
    renderToolbar('connecting')
    expect(getBadgeText()).toContain('Connecting')
    expect(hasSpinner()).toBe(true)
  })

  it('shows streaming badge with Live text', () => {
    renderToolbar('streaming')
    expect(getBadgeText()).toContain('Live')
  })

  it('shows recovering badge with spinner', () => {
    renderToolbar('recovering')
    expect(getBadgeText()).toContain('Recovering')
    expect(hasSpinner()).toBe(true)
  })

  it('shows disconnected badge with Disconnected text', () => {
    renderToolbar('disconnected')
    expect(getBadgeText()).toContain('Disconnected')
  })

  it('shows disconnected badge for fallback state', () => {
    renderToolbar('fallback')
    expect(getBadgeText()).toContain('Disconnected')
  })

  it('shows Shutdown button only when streaming or recovering', () => {
    renderToolbar('connecting')
    const shutdownIcon = container.querySelector('[class*="lucide-power"]')
    expect(shutdownIcon).toBeNull()
  })
})
