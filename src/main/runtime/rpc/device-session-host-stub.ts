// Phase 2 stub: in-memory session host registry. Replaced by real DeviceProvider in Phase 3.
// Phase 4: subscriber counting, pause/resume on zero subscribers, bounded subscriber count.
import type { DeviceMediaSource, DeviceCapabilities } from '../../../shared/device-session-types'
import { DEVICE_SESSION_MAX_SUBSCRIBERS } from '../../../shared/device-multiplex-flow-control'
import { trackDeviceSessionCreated, trackDeviceSessionReleased } from './device-telemetry'

export type DeviceSessionHost = {
  sessionId: string
  deviceId: string
  provider: 'android-sdk'
  transport: 'runtime-websocket'
  platform: 'android'
  capabilities: DeviceCapabilities
  video?: { codec: 'h264' | 'mjpeg'; width?: number; height?: number }
  createMediaSource(): DeviceMediaSource
  /** Phase 4: subscriber refcount. Incremented on Open, decremented on Close. */
  subscriberCount: number
  /** Phase 4: cached media source so setPaused targets the real producer. */
  mediaSource: DeviceMediaSource | null
}

export type MediaSourceCtor = new (deviceId: string) => DeviceMediaSource

const DEFAULT_CAPABILITIES: DeviceCapabilities = {
  video: true, input: true, install: true, launch: true, permissions: true,
  accessibilityTree: false, logs: true, rotate: true, clipboard: true, screenshots: true
}

function createHost(deviceId: string, sessionId: string, ctor: MediaSourceCtor): DeviceSessionHost {
  let ms: DeviceMediaSource | null = null
  return {
    sessionId, deviceId, provider: 'android-sdk', transport: 'runtime-websocket', platform: 'android',
    capabilities: DEFAULT_CAPABILITIES, subscriberCount: 0, mediaSource: null,
    createMediaSource: () => { if (!ms) { ms = new ctor(deviceId) }; return ms }
  }
}

const sessions = new Map<string, DeviceSessionHost>()
let sourceCtor: MediaSourceCtor | null = null

export function setSourceConstructor(ctor: MediaSourceCtor): void { sourceCtor = ctor }

function getCtor(): MediaSourceCtor {
  if (!sourceCtor) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      sourceCtor = require('../../emulator/device-session/android-device-media-source').AndroidDeviceMediaSource as MediaSourceCtor
    } catch {
      throw new Error('DeviceMediaSource constructor not set. Call setSourceConstructor() before using session host.')
    }
  }
  return sourceCtor
}

export function registerDeviceSession(sessionId: string, deviceId: string): DeviceSessionHost {
  let host = sessions.get(sessionId)
  if (!host) {
    host = createHost(deviceId, sessionId, getCtor())
    sessions.set(sessionId, host)
    trackDeviceSessionCreated({ sessionId, deviceId })
  }
  return host
}

export function unregisterDeviceSession(sessionId: string): void {
  const host = sessions.get(sessionId)
  if (host) {
    trackDeviceSessionReleased({ sessionId, deviceId: host.deviceId })
  }
  sessions.delete(sessionId)
}

export function getDeviceSession(sessionId: string): DeviceSessionHost | undefined { return sessions.get(sessionId) }

export function listDeviceSessions(): DeviceSessionHost[] { return Array.from(sessions.values()) }

/** Phase 4: increment subscriber refcount. Returns false if the session is at capacity. */
export function incrementSubscriberCount(sessionId: string): boolean {
  const host = sessions.get(sessionId)
  if (!host) { return false }
  if (host.subscriberCount >= DEVICE_SESSION_MAX_SUBSCRIBERS) { return false }
  if (host.subscriberCount === 0) {
    // Why: cache the media source so setPaused targets the real producer, not a throwaway instance
    if (!host.mediaSource) { host.mediaSource = host.createMediaSource() }
    host.mediaSource.setPaused?.(false)
  }
  host.subscriberCount++
  return true
}

/** Phase 4: decrement subscriber refcount. Pauses producer when count reaches 0. */
export function decrementSubscriberCount(sessionId: string): void {
  const host = sessions.get(sessionId)
  if (!host || host.subscriberCount <= 0) { return }
  host.subscriberCount--
  if (host.subscriberCount === 0) {
    host.mediaSource?.setPaused?.(true)
  }
}
