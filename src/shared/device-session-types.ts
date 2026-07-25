// Shared types for transport-agnostic device session architecture.
// Phase 1: types only — no runtime imports from main or renderer.

export type DeviceProviderKind =
  | 'android-sdk'
  | 'ios-simulator'
  | 'genymotion'
  | 'browserstack'
  | 'sauce-labs'
  | 'aws-device-farm'
  | 'custom'

export type DeviceTransportKind =
  | 'local-ipc'
  | 'runtime-websocket'
  | 'ssh-relay'
  | 'external'

export type DeviceVideoCodec = 'h264' | 'mjpeg'

export type DeviceCapabilities = {
  video: boolean
  input: boolean
  install: boolean
  launch: boolean
  permissions: boolean
  accessibilityTree: boolean
  logs: boolean
  rotate: boolean
  clipboard: boolean
  screenshots: boolean
}

export type DeviceSessionDescriptor = {
  sessionId: string
  provider: DeviceProviderKind
  transport: DeviceTransportKind
  deviceId: string
  displayName: string
  platform: 'android' | 'ios'
  capabilities: DeviceCapabilities
  video?: { codec: DeviceVideoCodec; width?: number; height?: number }
}

// Discriminated union mirroring the scrcpy registry event surface, extended
// with seq for ordering and bigint pts for transport-agnostic timestamps.
export type DeviceMediaEvent =
  | { type: 'metadata'; codec: DeviceVideoCodec; width: number; height: number }
  | { type: 'config'; pts: bigint; bytes: ArrayBuffer }
  | { type: 'frame'; seq: number; pts: bigint; keyFrame: boolean; bytes: ArrayBuffer }
  | { type: 'error'; code: string; message: string }
  | { type: 'closed'; reason?: string }

export type DeviceMediaSource = {
  subscribe(listener: (event: DeviceMediaEvent) => void): () => void
  // Not available on every adapter (scrcpy registry lacks keyframe/pause control).
  requestKeyframe?(): void
  setPaused?(paused: boolean): void
}

export type DeviceTransport = {
  open(session: DeviceSessionDescriptor): Promise<DeviceStreamHandle>
}

export type DeviceStreamHandle = {
  close(): void
  readonly streamId: string
}
