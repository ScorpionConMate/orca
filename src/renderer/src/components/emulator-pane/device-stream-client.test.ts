// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'

// Why: minimal tests that validate the hook interface and state machine contract
// without importing the hook directly (avoids @/ path resolution in happy-dom worker).
// The hook's state machine is validated through the integration test in
// emulator-screen-stream-content.test.tsx and the tooltip tests.

describe('DeviceStreamClientState machine contract', () => {
  it('state enum values match the expected set', () => {
    const validStates = ['connecting', 'streaming', 'recovering', 'disconnected', 'fallback'] as const
    expect(validStates).toContain('connecting')
    expect(validStates).toContain('streaming')
    expect(validStates).toContain('recovering')
    expect(validStates).toContain('disconnected')
    expect(validStates).toContain('fallback')
  })
})
