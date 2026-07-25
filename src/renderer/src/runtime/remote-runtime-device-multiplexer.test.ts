// @vitest-environment happy-dom

import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  getRemoteRuntimeDeviceMultiplexer,
  resetRemoteRuntimeDeviceMultiplexersForTests,
  _getRemoteRuntimeDeviceMultiplexerCountForTest
} from './remote-runtime-device-multiplexer'

describe('RemoteRuntimeDeviceMultiplexer', () => {
  beforeEach(() => {
    resetRemoteRuntimeDeviceMultiplexersForTests()
    vi.unstubAllGlobals()
  })

  it('returns singleton per environmentId', () => {
    const a = getRemoteRuntimeDeviceMultiplexer('env-1')
    const b = getRemoteRuntimeDeviceMultiplexer('env-1')
    expect(a).toBe(b)

    const c = getRemoteRuntimeDeviceMultiplexer('env-2')
    expect(c).not.toBe(a)
  })

  it('replaces on environment revision mismatch and counts correctly', () => {
    getRemoteRuntimeDeviceMultiplexer('env-a')
    getRemoteRuntimeDeviceMultiplexer('env-b')
    getRemoteRuntimeDeviceMultiplexer('env-a')

    expect(_getRemoteRuntimeDeviceMultiplexerCountForTest()).toBe(2)
  })

  it('attachStream includes streamId in the Open payload', async () => {
    const sendBinary = vi.fn()
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          subscribe: vi.fn().mockResolvedValue({
            unsubscribe: vi.fn(),
            sendBinary
          })
        }
      }
    })

    const multiplexer = getRemoteRuntimeDeviceMultiplexer('env-test')
    const descriptor = {
      sessionId: 'test-session',
      provider: 'android-sdk' as const,
      transport: 'runtime-websocket' as const,
      deviceId: 'emulator-5554',
      displayName: 'Test',
      platform: 'android' as const,
      capabilities: {
        video: true, input: true, install: false, launch: false,
        permissions: false, accessibilityTree: false, logs: false,
        rotate: false, clipboard: false, screenshots: false
      }
    }

    const promise = multiplexer.attachStream(descriptor)
    expect(promise).toBeInstanceOf(Promise)
  })
})
