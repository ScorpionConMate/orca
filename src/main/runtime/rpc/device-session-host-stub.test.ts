import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { registerDeviceSession, unregisterDeviceSession, getDeviceSession, listDeviceSessions, incrementSubscriberCount, decrementSubscriberCount, setSourceConstructor } from './device-session-host-stub'
import type { DeviceMediaEvent, DeviceMediaSource } from '../../../shared/device-session-types'

// Why: track the last telemetry call so we can inspect payloads
let lastTrackCall: { name: string; props: Record<string, unknown> } | null = null

vi.mock('./device-telemetry', () => ({
  trackDeviceSessionCreated: (base: Record<string, unknown>) => { lastTrackCall = { name: 'device_session_created', props: { ...base } } },
  trackDeviceSessionReleased: (base: Record<string, unknown>) => { lastTrackCall = { name: 'device_session_released', props: { ...base } } },
  trackDeviceStreamOpened: vi.fn(),
  trackDeviceStreamClosed: vi.fn(),
  trackDeviceStreamFrameDropped: vi.fn(),
  trackDeviceStreamKeyframeRequested: vi.fn(),
}))

/** Fake source with a spyable setPaused. */
function makeFakeSourceCtor(): { Ctor: new (deviceId: string) => DeviceMediaSource; setPaused: ReturnType<typeof vi.fn> } {
  const setPaused = vi.fn()
  const Ctor = class implements DeviceMediaSource {
    setPaused = setPaused
    subscribe(_l: (e: DeviceMediaEvent) => void) { return () => {} }
  }
  return { Ctor, setPaused }
}

describe('DeviceSessionHostStub', () => {
  beforeEach(() => {
    lastTrackCall = null
    const { Ctor } = makeFakeSourceCtor()
    setSourceConstructor(Ctor)
  })

  afterEach(() => {
    for (const s of listDeviceSessions()) {
      unregisterDeviceSession(s.sessionId)
    }
  })

  // ── Finding #3: device_id in released event ────────────────────────────
  it('uses deviceId (not sessionId) in the released telemetry event', () => {
    registerDeviceSession('s1', 'd1')
    lastTrackCall = null // clear the create event
    unregisterDeviceSession('s1')
    expect(lastTrackCall).not.toBeNull()
    expect(lastTrackCall!.name).toBe('device_session_released')
    expect(lastTrackCall!.props.sessionId).toBe('s1')
    expect(lastTrackCall!.props.deviceId).toBe('d1')
  })

  // ── Finding #2: subscriber counting produces correct pause/resume ──────
  it('calls setPaused(false) on first subscriber and setPaused(true) when last leaves', () => {
    const { Ctor } = makeFakeSourceCtor()
    setSourceConstructor(Ctor)

    registerDeviceSession('sub-scenario-1', 'sub-dev-1')
    incrementSubscriberCount('sub-scenario-1')
    // Why: the media source was cached on the host; we can read it after the fact
    const host = getDeviceSession('sub-scenario-1')!
    expect(host.mediaSource?.setPaused).toHaveBeenCalledWith(false)

    decrementSubscriberCount('sub-scenario-1')
    expect(host.mediaSource?.setPaused).toHaveBeenCalledWith(true)
  })

  it('does NOT toggle setPaused when going from N to N+1 (not the first subscriber)', () => {
    const { Ctor, setPaused } = makeFakeSourceCtor()
    setSourceConstructor(Ctor)

    registerDeviceSession('multi-scenario', 'multi-dev')
    // 0→1 fires setPaused(false)
    incrementSubscriberCount('multi-scenario')
    const host = getDeviceSession('multi-scenario')!
    const spy = vi.spyOn(host.mediaSource!, 'setPaused' as never)
    setPaused.mockClear()

    // 1→2 should NOT fire
    incrementSubscriberCount('multi-scenario')
    expect(spy).not.toHaveBeenCalled()

    // 2→1 should NOT fire
    decrementSubscriberCount('multi-scenario')
    expect(spy).not.toHaveBeenCalled()

    // 1→0 fires setPaused(true)
    decrementSubscriberCount('multi-scenario')
    expect(spy).toHaveBeenCalledWith(true)
  })
})
