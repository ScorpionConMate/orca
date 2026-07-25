import { describe, expect, it } from 'vitest'
import {
  DeviceStreamOpcode,
  encodeDeviceStreamFrame,
  decodeDeviceStreamFrame,
  encodeDeviceStreamJson,
  decodeDeviceStreamJson,
  DEVICE_STREAM_HEADER_BYTES,
  DEVICE_STREAM_MAX_FRAME_BYTES
} from './device-stream-protocol'

describe('DeviceStreamProtocol', () => {
  it('round-trips Open frame with streamId in payload and header', () => {
    const payload = encodeDeviceStreamJson({ sessionId: 's1', deviceId: 'd1', transport: 'runtime-websocket', streamId: 42 })
    const bytes = encodeDeviceStreamFrame(DeviceStreamOpcode.Open, 0, 0, payload)
    const frame = decodeDeviceStreamFrame(bytes)!
    expect(frame.opcode).toBe(DeviceStreamOpcode.Open)
    expect(frame.streamId).toBe(0) // control stream

    const json = decodeDeviceStreamJson<{ sessionId: string; streamId: number }>(frame.payload)
    expect(json?.sessionId).toBe('s1')
    expect(json?.streamId).toBe(42)
  })

  it('round-trips Opened frame with streamId in payload', () => {
    const payload = encodeDeviceStreamJson({ sessionId: 's1', deviceId: 'd1', transport: 'runtime-websocket', streamId: 42 })
    const bytes = encodeDeviceStreamFrame(DeviceStreamOpcode.Opened, 42, 0, payload)
    const frame = decodeDeviceStreamFrame(bytes)!
    expect(frame.opcode).toBe(DeviceStreamOpcode.Opened)
    expect(frame.streamId).toBe(42)

    const json = decodeDeviceStreamJson<{ sessionId: string; streamId: number }>(frame.payload)
    expect(json?.sessionId).toBe('s1')
    expect(json?.streamId).toBe(42)
  })

  it('encodes and decodes all opcodes', () => {
    for (const opcode of Object.values(DeviceStreamOpcode).filter((v): v is DeviceStreamOpcode => typeof v === 'number')) {
      const bytes = encodeDeviceStreamFrame(opcode, 1, 0, new Uint8Array())
      const frame = decodeDeviceStreamFrame(bytes)
      expect(frame?.opcode).toBe(opcode)
    }
  })

  it('rejects frames with bad kind byte', () => {
    const bytes = new Uint8Array(DEVICE_STREAM_HEADER_BYTES)
    bytes[0] = 0xff // wrong kind
    expect(decodeDeviceStreamFrame(bytes)).toBeNull()
  })

  it('rejects frames with bad version byte', () => {
    const bytes = new Uint8Array(DEVICE_STREAM_HEADER_BYTES)
    bytes[0] = 0x64
    bytes[1] = 99 // wrong version
    expect(decodeDeviceStreamFrame(bytes)).toBeNull()
  })

  it('rejects truncated frames', () => {
    expect(decodeDeviceStreamFrame(new Uint8Array(DEVICE_STREAM_HEADER_BYTES - 1))).toBeNull()
  })

  it('rejects oversized payloads', () => {
    expect(() =>
      encodeDeviceStreamFrame(DeviceStreamOpcode.Frame, 1, 0, new Uint8Array(DEVICE_STREAM_MAX_FRAME_BYTES + 1))
    ).toThrow('device_stream_payload_too_large')
  })

  it('encodes seq as 64-bit LE', () => {
    const bytes = encodeDeviceStreamFrame(DeviceStreamOpcode.Frame, 1, 0xdeadbeefcafe, new Uint8Array())
    const frame = decodeDeviceStreamFrame(bytes)
    expect(frame?.seq).toBe(0xdeadbeefcafe)
  })
})
