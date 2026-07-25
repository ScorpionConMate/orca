// Client-side structured device-streaming telemetry (Phase 4).
// Uses the renderer logger — never logs frame bytes or session tokens.
type DeviceStreamEventBase = {
  sessionId: string
  deviceId: string
}

function monotonicNow(): number { return Date.now() }

export function trackReconnectStarted(base: DeviceStreamEventBase & { attempt: number }): void {
  const ts = monotonicNow()
  console.info('[device-telemetry] device.stream.reconnect_started', { ...base, transport: 'runtime-websocket', provider: 'android-sdk', ts, attempt: base.attempt })
}

export function trackReconnectSucceeded(base: DeviceStreamEventBase & { attempt: number }): void {
  const ts = monotonicNow()
  console.info('[device-telemetry] device.stream.reconnect_succeeded', { ...base, transport: 'runtime-websocket', provider: 'android-sdk', ts, attempt: base.attempt })
}

export function trackReconnectFailed(base: DeviceStreamEventBase & { attempt: number }): void {
  const ts = monotonicNow()
  console.info('[device-telemetry] device.stream.reconnect_failed', { ...base, transport: 'runtime-websocket', provider: 'android-sdk', ts, attempt: base.attempt })
}

export function trackKeyframeRecoveryStarted(base: DeviceStreamEventBase & { streamId: number }): void {
  const ts = monotonicNow()
  console.info('[device-telemetry] device.stream.recovery_started', { ...base, transport: 'runtime-websocket', provider: 'android-sdk', ts, stream_id: base.streamId })
}

export function trackKeyframeRecoveryFailed(base: DeviceStreamEventBase & { streamId: number; attempts: number }): void {
  const ts = monotonicNow()
  console.info('[device-telemetry] device.stream.recovery_failed', { ...base, transport: 'runtime-websocket', provider: 'android-sdk', ts, stream_id: base.streamId, attempts: base.attempts })
}

export function trackStreamRecovered(base: DeviceStreamEventBase & { streamId: number; attemptCount: number }): void {
  const ts = monotonicNow()
  console.info('[device-telemetry] device.stream.recovered', { ...base, transport: 'runtime-websocket', provider: 'android-sdk', ts, stream_id: base.streamId, recovery_attempts: base.attemptCount })
}
