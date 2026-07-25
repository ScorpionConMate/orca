import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

// Mock electron before importing the module under test.
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => ({}) }
}))

// Mock the scrcpy registry so tests don't need a real device.
import { scrcpyVideoRegistry } from '../scrcpy-video-registry'

vi.mock('../scrcpy-video-registry', () => ({
  scrcpyVideoRegistry: {
    subscribe: vi.fn(() => () => {}),
    register: vi.fn(),
    pushMeta: vi.fn(),
    pushFrame: vi.fn(),
    stop: vi.fn(),
    has: vi.fn()
  }
}))

vi.mock('../emulator-probe', () => ({ emulatorProbe: () => {} }))

import { connect, disconnect } from './local-ipc-device-transport'

// Lightweight fake WebContents for testing the transport's IPC surface.
type FakeOwner = EventEmitter & {
  isDestroyed: () => boolean
  send: (...args: unknown[]) => void
}

function makeFakeOwner(): FakeOwner {
  const owner = new EventEmitter() as FakeOwner
  owner.isDestroyed = () => false
  owner.send = vi.fn()
  return owner
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('localIpcDeviceTransport', () => {
  it('connects a stream and registers a subscription', () => {
    const subscribe = vi.mocked(scrcpyVideoRegistry.subscribe)
    subscribe.mockReturnValue(() => {})

    const owner = makeFakeOwner() as unknown as WebContents
    const streamId = connect(owner, 'emulator-5554', 'test-stream-1')

    expect(streamId).toBe('test-stream-1')
    // Subscription is deferred (setTimeout 0), so subscribe hasn't fired yet.
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('disconnect releases the subscription', () => {
    vi.useFakeTimers()
    const unsubscribe = vi.fn()
    vi.mocked(scrcpyVideoRegistry.subscribe).mockReturnValue(unsubscribe)

    const owner = makeFakeOwner() as unknown as WebContents
    const streamId = connect(owner, 'emulator-5554', 'test-stream-2')
    // Flush deferred subscription so the real unsubscribe is assigned.
    vi.advanceTimersByTime(0)
    disconnect(streamId, owner)

    expect(unsubscribe).toHaveBeenCalled()
  })

  it('rejects connect with a duplicate streamId from a different owner', () => {
    vi.useFakeTimers()
    vi.mocked(scrcpyVideoRegistry.subscribe).mockReturnValue(() => {})

    const owner1 = makeFakeOwner() as unknown as WebContents
    const owner2 = makeFakeOwner() as unknown as WebContents
    connect(owner1, 'dev1', 'dup-stream')

    expect(() => connect(owner2, 'dev2', 'dup-stream')).toThrow(
      'already in use by another renderer'
    )
  })

  it('replaces an existing subscription on reconnect from the same owner', () => {
    vi.useFakeTimers()
    const unsubscribe = vi.fn()
    vi.mocked(scrcpyVideoRegistry.subscribe).mockReturnValue(unsubscribe)

    const owner = makeFakeOwner() as unknown as WebContents
    connect(owner, 'dev1', 'reconnect-stream')
    // Flush deferred subscription so the first connect's subscription is live.
    vi.advanceTimersByTime(0)

    // Reconnect with same owner — must unsubscribe the old subscription.
    connect(owner, 'dev2', 'reconnect-stream')

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('cleans up via owner destroyed event', () => {
    vi.useFakeTimers()
    const unsubscribe = vi.fn()
    vi.mocked(scrcpyVideoRegistry.subscribe).mockReturnValue(unsubscribe)

    const fakeOwner = makeFakeOwner()
    const owner = fakeOwner as unknown as WebContents
    connect(owner, 'emulator-5554', 'destroyed-stream')
    // Flush deferred subscription so the subscription is live.
    vi.advanceTimersByTime(0)
    expect(fakeOwner.listenerCount('destroyed')).toBe(1)

    fakeOwner.emit('destroyed')
    expect(fakeOwner.listenerCount('destroyed')).toBe(0)
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('does not accumulate destroyed listeners across show/hide cycles', () => {
    vi.useFakeTimers()
    vi.mocked(scrcpyVideoRegistry.subscribe).mockReturnValue(() => {})

    const fakeOwner = makeFakeOwner()
    const owner = fakeOwner as unknown as WebContents
    for (let i = 0; i < 15; i++) {
      const streamId = connect(owner, 'emulator-5554', `cycle-${i}`)
      expect(fakeOwner.listenerCount('destroyed')).toBe(1)
      disconnect(streamId, owner)
      expect(fakeOwner.listenerCount('destroyed')).toBe(0)
    }
  })

  it('forwardEvent sends meta IPC with correct shape', () => {
    vi.useFakeTimers()
    const fakeOwner = makeFakeOwner()
    const owner = fakeOwner as unknown as WebContents
    const streamId = connect(owner, 'emulator-5554', 'ipc-meta-stream')
    vi.advanceTimersByTime(0)

    const subscribeCb = vi.mocked(scrcpyVideoRegistry.subscribe).mock.calls[0]?.[1]
    if (subscribeCb) {
      subscribeCb({ type: 'meta', meta: { codecId: 'h264', width: 1920, height: 1080 } })
    }

    expect(fakeOwner.send).toHaveBeenCalledWith('emulator:videoStreamMeta', {
      streamId,
      deviceId: 'emulator-5554',
      meta: { codecId: 'h264', width: 1920, height: 1080 }
    })
  })

  it('forwardEvent sends frame IPC with correct shape', () => {
    vi.useFakeTimers()
    const fakeOwner = makeFakeOwner()
    const owner = fakeOwner as unknown as WebContents
    const streamId = connect(owner, 'emulator-5554', 'ipc-frame-stream')
    vi.advanceTimersByTime(0)

    const subscribeCb = vi.mocked(scrcpyVideoRegistry.subscribe).mock.calls[0]?.[1]
    if (subscribeCb) {
      subscribeCb({
        type: 'frame',
        frame: { config: false, keyFrame: true, pts: '100', bytes: new ArrayBuffer(4) }
      })
    }

    expect(fakeOwner.send).toHaveBeenCalledWith('emulator:videoStreamFrame', {
      streamId,
      deviceId: 'emulator-5554',
      config: false,
      keyFrame: true,
      pts: '100',
      bytes: expect.any(ArrayBuffer)
    })
  })

  it('forwardEvent sends config frame IPC with correct shape', () => {
    vi.useFakeTimers()
    const fakeOwner = makeFakeOwner()
    const owner = fakeOwner as unknown as WebContents
    const streamId = connect(owner, 'emulator-5554', 'ipc-config-stream')
    vi.advanceTimersByTime(0)

    const subscribeCb = vi.mocked(scrcpyVideoRegistry.subscribe).mock.calls[0]?.[1]
    if (subscribeCb) {
      subscribeCb({
        type: 'frame',
        frame: { config: true, keyFrame: false, pts: '12345', bytes: new ArrayBuffer(8) }
      })
    }

    expect(fakeOwner.send).toHaveBeenCalledWith('emulator:videoStreamFrame', {
      streamId,
      deviceId: 'emulator-5554',
      config: true,
      keyFrame: false,
      pts: '12345',
      bytes: expect.any(ArrayBuffer)
    })
  })
})
