import type {
  DeviceMediaEvent,
  DeviceMediaSource
} from '../../../shared/device-session-types'
import {
  scrcpyVideoRegistry,
  type ScrcpyVideoEvent
} from '../scrcpy-video-registry'

// Wraps the scrcpy pub/sub registry as a DeviceMediaSource, translating its
// meta/frame events into the transport-agnostic DeviceMediaEvent union.
export class AndroidDeviceMediaSource implements DeviceMediaSource {
  private readonly deviceId: string
  private frameSeq = 0

  constructor(deviceId: string) {
    this.deviceId = deviceId
  }

  subscribe(listener: (event: DeviceMediaEvent) => void): () => void {
    const rawSubscriber = (raw: ScrcpyVideoEvent): void => {
      if (raw.type === 'meta') {
        listener({
          type: 'metadata',
          codec: codecFromId(raw.meta.codecId),
          width: raw.meta.width,
          height: raw.meta.height
        })
      } else if (raw.type === 'frame') {
        if (raw.frame.config) {
          listener({ type: 'config', pts: BigInt(raw.frame.pts), bytes: raw.frame.bytes })
        } else {
          listener({
            type: 'frame',
            seq: this.frameSeq++,
            pts: BigInt(raw.frame.pts),
            keyFrame: raw.frame.keyFrame,
            bytes: raw.frame.bytes
          })
        }
      }
    }

    const unsubscribe = scrcpyVideoRegistry.subscribe(this.deviceId, rawSubscriber)
    return unsubscribe
  }
}

// Map scrcpy codecId to DeviceVideoCodec. scrcpy uses "h264"/"h265" tags;
// the MJPEG path is separate in Orca, so h265 falls back to h264 for now.
function codecFromId(codecId: string): 'h264' | 'mjpeg' {
  if (codecId.startsWith('h264') || codecId.startsWith('avc')) {
    return 'h264'
  }
  if (codecId.startsWith('mjpeg') || codecId.startsWith('jpg')) {
    return 'mjpeg'
  }
  // Default to h264 — scrcpy almost always uses H.264 for Android.
  return 'h264'
}
