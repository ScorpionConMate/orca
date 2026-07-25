// Structured device-streaming telemetry events (Phase 4).
// Thin wrapper over the project's track() that fills common fields.
// Never logs frame bytes, codec config bytes, or session tokens.
import { track } from '../../telemetry/client'

function monotonicNow(): number { return Date.now() }

type DeviceEventBase = {
  sessionId: string
  deviceId: string
}

export function trackDeviceSessionCreated(base: DeviceEventBase): void {
  const ts = monotonicNow()
  track('device_session_created', { session_id: base.sessionId, device_id: base.deviceId, transport: 'runtime-websocket', provider: 'android-sdk', ts })
}

export function trackDeviceSessionReleased(base: DeviceEventBase): void {
  const ts = monotonicNow()
  track('device_session_released', { session_id: base.sessionId, device_id: base.deviceId, transport: 'runtime-websocket', provider: 'android-sdk', ts })
}

type DeviceStreamEventBase = DeviceEventBase & { streamId: number }

export function trackDeviceStreamOpened(base: DeviceStreamEventBase): void {
  const ts = monotonicNow()
  track('device_stream_opened', { session_id: base.sessionId, device_id: base.deviceId, stream_id: base.streamId, transport: 'runtime-websocket', provider: 'android-sdk', ts })
}

export function trackDeviceStreamClosed(base: DeviceStreamEventBase & { reason?: string }): void {
  const ts = monotonicNow()
  track('device_stream_closed', { session_id: base.sessionId, device_id: base.deviceId, stream_id: base.streamId, transport: 'runtime-websocket', provider: 'android-sdk', ts, reason: base.reason })
}

export function trackDeviceStreamFrameDropped(base: DeviceStreamEventBase & { pendingBytesBefore: number }): void {
  const ts = monotonicNow()
  track('device_stream_frame_dropped', { session_id: base.sessionId, device_id: base.deviceId, stream_id: base.streamId, transport: 'runtime-websocket', provider: 'android-sdk', ts, pending_bytes_before: base.pendingBytesBefore })
}

export function trackDeviceStreamKeyframeRequested(base: DeviceStreamEventBase): void {
  const ts = monotonicNow()
  track('device_stream_keyframe_requested', { session_id: base.sessionId, device_id: base.deviceId, stream_id: base.streamId, transport: 'runtime-websocket', provider: 'android-sdk', ts })
}

export function trackDeviceStreamRecovered(base: DeviceStreamEventBase & { recoveryAttempts: number }): void {
  const ts = monotonicNow()
  track('device_stream_recovered', { session_id: base.sessionId, device_id: base.deviceId, stream_id: base.streamId, transport: 'runtime-websocket', provider: 'android-sdk', ts, recovery_attempts: base.recoveryAttempts })
}
