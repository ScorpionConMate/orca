import { describe, expect, it } from 'vitest'
import {
  DeviceStreamOpcode,
  encodeDeviceStreamFrame,
  decodeDeviceStreamFrame,
  encodeDeviceStreamJson,
  decodeDeviceStreamJson,
  encodeDeviceStreamHybridPayload,
  decodeDeviceStreamHybridPayload,
  DEVICE_STREAM_HEADER_BYTES,
  DEVICE_STREAM_MAX_FRAME_BYTES
} from '../../../shared/device-stream-protocol'

describe('device-stream-protocol', () => {
  it('round-trips every opcode with JSON payload', () => {
    const testCases: { opcode: DeviceStreamOpcode; payload: unknown }[] = [
      { opcode: DeviceStreamOpcode.Open, payload: { sessionId: 's1', deviceId: 'd1', transport: 'runtime-websocket' } },
      { opcode: DeviceStreamOpcode.Opened, payload: { sessionId: 's1', deviceId: 'd1', transport: 'runtime-websocket', capabilities: { video: true, input: false, install: false, launch: false, permissions: false, accessibilityTree: false, logs: false, rotate: false, clipboard: false, screenshots: false } } },
      { opcode: DeviceStreamOpcode.Metadata, payload: { codec: 'h264', width: 1080, height: 1920 } },
      { opcode: DeviceStreamOpcode.Ack, payload: { bytes: 1024 } },
      { opcode: DeviceStreamOpcode.RequestKeyframe, payload: {} },
      { opcode: DeviceStreamOpcode.Pause, payload: {} },
      { opcode: DeviceStreamOpcode.Resume, payload: {} },
      { opcode: DeviceStreamOpcode.Error, payload: { code: 'test_error', message: 'test' } },
      { opcode: DeviceStreamOpcode.Close, payload: { reason: 'done' } }
    ]
    for (const { opcode, payload } of testCases) {
      const data = encodeDeviceStreamJson(payload)
      const frame = encodeDeviceStreamFrame(opcode, 1, 0, data)
      expect(frame.length).toBe(DEVICE_STREAM_HEADER_BYTES + data.length)
      const decoded = decodeDeviceStreamFrame(frame)
      expect(decoded).not.toBeNull()
      expect(decoded!.opcode).toBe(opcode)
      expect(decoded!.streamId).toBe(1)
      expect(decoded!.seq).toBe(0)
      const parsed = decodeDeviceStreamJson<typeof payload>(decoded!.payload)
      expect(parsed).toEqual(payload)
    }
  })

  it('round-trips CodecConfig with binary bytes', () => {
    const configBytes = new Uint8Array([0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e, 0x99]).buffer
    const payload = encodeDeviceStreamHybridPayload({ pts: '1234567890' }, configBytes)
    const frame = encodeDeviceStreamFrame(DeviceStreamOpcode.CodecConfig, 1, 0, payload)
    expect(frame.length).toBe(DEVICE_STREAM_HEADER_BYTES + payload.length)
    const decoded = decodeDeviceStreamFrame(frame)
    expect(decoded).not.toBeNull()
    expect(decoded!.opcode).toBe(DeviceStreamOpcode.CodecConfig)
    const { metadata, bytes } = decodeDeviceStreamHybridPayload(decoded!.payload)
    expect(metadata).not.toBeNull()
    expect(metadata!.pts).toBe('1234567890')
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array(configBytes))
  })

  it('round-trips Frame with keyframe and binary data', () => {
    const frameData = new Uint8Array(1024).fill(0xac) // simulated H.264 NAL
    const payload = encodeDeviceStreamHybridPayload({ pts: '9876543210', keyFrame: true, seq: 42 }, frameData.buffer)
    const frame = encodeDeviceStreamFrame(DeviceStreamOpcode.Frame, 2, 42, payload)
    const decoded = decodeDeviceStreamFrame(frame)
    expect(decoded).not.toBeNull()
    expect(decoded!.opcode).toBe(DeviceStreamOpcode.Frame)
    expect(decoded!.streamId).toBe(2)
    expect(decoded!.seq).toBe(42)
    const { metadata, bytes } = decodeDeviceStreamHybridPayload(decoded!.payload)
    expect(metadata).not.toBeNull()
    expect(metadata!.pts).toBe('9876543210')
    expect(metadata!.keyFrame).toBe(true)
    expect(metadata!.seq).toBe(42)
    expect(new Uint8Array(bytes)).toEqual(frameData)
  })

  it('seq preserves large values (u64)', () => {
    const payload = encodeDeviceStreamJson({})
    const frame = encodeDeviceStreamFrame(DeviceStreamOpcode.Metadata, 0, 0xdeadbeef0123, payload)
    const decoded = decodeDeviceStreamFrame(frame)
    expect(decoded!.seq).toBe(0xdeadbeef0123)
  })

  it('rejects wrong kind byte', () => {
    const frame = encodeDeviceStreamFrame(DeviceStreamOpcode.Metadata, 0, 0, new Uint8Array())
    frame[0] = 0x74 // terminal kind
    expect(decodeDeviceStreamFrame(frame)).toBeNull()
  })

  it('rejects wrong version', () => {
    const frame = encodeDeviceStreamFrame(DeviceStreamOpcode.Metadata, 0, 0, new Uint8Array())
    frame[1] = 99
    expect(decodeDeviceStreamFrame(frame)).toBeNull()
  })

  it('rejects unknown opcode', () => {
    const frame = encodeDeviceStreamFrame(DeviceStreamOpcode.Metadata, 0, 0, new Uint8Array())
    frame[2] = 255
    expect(decodeDeviceStreamFrame(frame)).toBeNull()
  })

  it('returns null for truncated header', () => {
    expect(decodeDeviceStreamFrame(new Uint8Array(DEVICE_STREAM_HEADER_BYTES - 1))).toBeNull()
  })

  it('throws on oversized payload', () => {
    const oversized = new Uint8Array(DEVICE_STREAM_MAX_FRAME_BYTES + 1)
    expect(() => encodeDeviceStreamFrame(DeviceStreamOpcode.Frame, 0, 0, oversized)).toThrow('device_stream_payload_too_large')
  })

  it('round-trips empty payload', () => {
    const frame = encodeDeviceStreamFrame(DeviceStreamOpcode.RequestKeyframe, 0, 0, new Uint8Array())
    const decoded = decodeDeviceStreamFrame(frame)
    expect(decoded!.opcode).toBe(DeviceStreamOpcode.RequestKeyframe)
    expect(decoded!.payload.byteLength).toBe(0)
  })

  it('decodeDeviceStreamHybridPayload handles truncated input gracefully', () => {
    const { metadata, bytes } = decodeDeviceStreamHybridPayload(new Uint8Array([0, 0, 0, 5, 0x68, 0x65]))
    expect(metadata).toBeNull() // truncated JSON (missing close brace)
    expect(bytes.byteLength).toBe(2)
  })

  it('decodeDeviceStreamHybridPayload handles empty input', () => {
    const { metadata, bytes } = decodeDeviceStreamHybridPayload(new Uint8Array(0))
    expect(metadata).toBeNull()
    expect(bytes.byteLength).toBe(0)
  })
})
