// Client-side DeviceMediaSource that decodes binary frames from the device
// stream multiplexer and replays cached Metadata + CodecConfig + last keyframe
// on subscribe (Phase 2 Finding 2 remediation).
import type {
  DeviceMediaEvent,
  DeviceMediaSource,
  DeviceSessionDescriptor
} from '../../../shared/device-session-types'
import {
  DeviceStreamOpcode,
  decodeDeviceStreamHybridPayload,
  decodeDeviceStreamJson,
  encodeDeviceStreamFrame
} from '../../../shared/device-stream-protocol'

type DeviceStreamBinaryPump = {
  sendBinary: (bytes: Uint8Array) => boolean
  registerStreamHandler: (
    streamId: number,
    handler: (frame: { opcode: DeviceStreamOpcode; seq: number; payload: Uint8Array }) => void
  ) => () => void
}

export class RemoteDeviceMediaSource implements DeviceMediaSource {
  private readonly streamId: number
  private pump: DeviceStreamBinaryPump
  private listener: ((event: DeviceMediaEvent) => void) | null = null
  private subscribed = false

  // Replay cache (Phase 2 Finding 2)
  private lastMetadata: DeviceMediaEvent & { type: 'metadata' } | null = null
  private lastCodecConfig: DeviceMediaEvent & { type: 'config' } | null = null
  private lastKeyFrame: DeviceMediaEvent & { type: 'frame' } | null = null

  constructor(
    _descriptor: DeviceSessionDescriptor,
    pump: DeviceStreamBinaryPump,
    streamId: number
  ) {
    this.streamId = streamId
    this.pump = pump
  }

  subscribe(listener: (event: DeviceMediaEvent) => void): () => void {
    this.listener = listener

    // Replay cached events in order (Finding 2)
    if (this.lastMetadata) {
      listener(this.lastMetadata)
    }
    if (this.lastCodecConfig) {
      listener(this.lastCodecConfig)
    }
    if (this.lastKeyFrame) {
      listener(this.lastKeyFrame)
    }

    if (!this.subscribed) {
      this.subscribed = true
      this.pump.registerStreamHandler(
        this.streamId,
        (frame) => this.handleFrame(frame)
      )
    }

    return () => {
      this.listener = null
      // Do not unregister — the multiplexer owns stream handler lifecycle
    }
  }

  requestKeyframe(): void {
    const frame = encodeDeviceStreamFrame(
      DeviceStreamOpcode.RequestKeyframe,
      this.streamId,
      0,
      new Uint8Array()
    )
    this.pump.sendBinary(frame)
  }

  setPaused(paused: boolean): void {
    const opcode = paused ? DeviceStreamOpcode.Pause : DeviceStreamOpcode.Resume
    const frame = encodeDeviceStreamFrame(opcode, this.streamId, 0, new Uint8Array())
    this.pump.sendBinary(frame)
  }

  private handleFrame(raw: {
    opcode: DeviceStreamOpcode
    seq: number
    payload: Uint8Array
  }): void {
    if (!this.listener) { return }

    const listener = this.listener

    switch (raw.opcode) {
      case DeviceStreamOpcode.Metadata: {
        const json = decodeDeviceStreamJson<{
          codec?: unknown
          width?: unknown
          height?: unknown
        }>(raw.payload)
        if (json && typeof json.codec === 'string' && typeof json.width === 'number' && typeof json.height === 'number') {
          const event: DeviceMediaEvent & { type: 'metadata' } = {
            type: 'metadata',
            codec: json.codec as 'h264' | 'mjpeg',
            width: json.width,
            height: json.height
          }
          this.lastMetadata = event
          listener(event)
        }
        break
      }
      case DeviceStreamOpcode.CodecConfig: {
        const hy = decodeDeviceStreamHybridPayload(raw.payload)
        // Finding 7: pts is serialized as a string; parse back to bigint
        const pts =
          hy.metadata && typeof hy.metadata.pts === 'string'
            ? BigInt(hy.metadata.pts)
            : BigInt(0)
        const event: DeviceMediaEvent & { type: 'config' } = {
          type: 'config',
          pts,
          bytes: hy.bytes.slice(0)
        }
        this.lastCodecConfig = event
        listener(event)
        break
      }
      case DeviceStreamOpcode.Frame: {
        const hy = decodeDeviceStreamHybridPayload(raw.payload)
        // Finding 7: pts string → bigint
        const pts =
          hy.metadata && typeof hy.metadata.pts === 'string'
            ? BigInt(hy.metadata.pts)
            : BigInt(0)
        const keyFrame =
          hy.metadata && typeof hy.metadata.keyFrame === 'boolean'
            ? hy.metadata.keyFrame
            : false
        const event: DeviceMediaEvent & { type: 'frame' } = {
          type: 'frame',
          seq: raw.seq,
          pts,
          keyFrame,
          bytes: hy.bytes.slice(0)
        }
        if (keyFrame) {
          this.lastKeyFrame = event
        }
        listener(event)
        break
      }
      // Client never receives Open/Opened on a per-stream handler
      case DeviceStreamOpcode.Open:
      case DeviceStreamOpcode.Opened:
      case DeviceStreamOpcode.Ack:
      case DeviceStreamOpcode.Pause:
      case DeviceStreamOpcode.Resume:
      case DeviceStreamOpcode.RequestKeyframe: {
        // Finding 8: jsonLen === 0 means metadata: null, bytes present but
        // irrelevant for these opcodes — no event to emit to the listener.
        break
      }
      case DeviceStreamOpcode.Close: {
        const closeMsg = decodeDeviceStreamJson<{ reason?: unknown }>(raw.payload)
        listener({ type: 'closed', reason: closeMsg && typeof closeMsg.reason === 'string' ? closeMsg.reason : 'server_close' })
        break
      }
      case DeviceStreamOpcode.Error: {
        const err = decodeDeviceStreamJson<{ code?: unknown; message?: unknown }>(raw.payload)
        listener({
          type: 'error',
          code: err && typeof err.code === 'string' ? err.code : 'unknown',
          message: err && typeof err.message === 'string' ? err.message : 'Device stream error'
        })
        break
      }
    }
  }

  // Internal: called by the multiplexer when the binary channel closes
  handleTransportClose(): void {
    if (this.listener) {
      this.listener({ type: 'closed', reason: 'transport_closed' })
    }
  }

  // Phase 4: re-register pump and handler after transport reconnect
  rebindHandler(pump: DeviceStreamBinaryPump): void {
    this.pump = pump
    if (this.subscribed) {
      pump.registerStreamHandler(
        this.streamId,
        (frame) => this.handleFrame(frame)
      )
    }
  }
}
