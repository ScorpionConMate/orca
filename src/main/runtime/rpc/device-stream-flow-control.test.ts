import { describe, expect, it } from 'vitest'
import {
  DEVICE_STREAM_CHUNK_BYTES, DEVICE_OUTPUT_BATCH_MAX_BYTES,
  DEVICE_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES,
  DEVICE_MULTIPLEX_ACK_STREAM_MAX_WINDOW_BYTES,
  DEVICE_MULTIPLEX_ACK_TOTAL_INITIAL_WINDOW_BYTES,
  DEVICE_MULTIPLEX_ACK_TOTAL_MAX_WINDOW_BYTES,
  DEVICE_MULTIPLEX_PENDING_MAX_BYTES,
  DEVICE_MULTIPLEX_ACK_BATCH_BYTES,
  DEVICE_MULTIPLEX_ACK_FLUSH_MS,
  DEVICE_MULTIPLEX_MAX_STREAMS_PER_CONNECTION
} from '../../../shared/device-multiplex-flow-control'

describe('device-multiplex-flow-control constants', () => {
  it('chunk size is 48 KiB', () => { expect(DEVICE_STREAM_CHUNK_BYTES).toBe(48 * 1024) })
  it('batch max is 64 KiB', () => { expect(DEVICE_OUTPUT_BATCH_MAX_BYTES).toBe(64 * 1024) })
  it('initial ack stream window is 512 KiB', () => { expect(DEVICE_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES).toBe(512 * 1024) })
  it('max ack stream window is 2 MiB', () => { expect(DEVICE_MULTIPLEX_ACK_STREAM_MAX_WINDOW_BYTES).toBe(2 * 1024 * 1024) })
  it('initial total window is 2 MiB', () => { expect(DEVICE_MULTIPLEX_ACK_TOTAL_INITIAL_WINDOW_BYTES).toBe(2 * 1024 * 1024) })
  it('max total window is 8 MiB', () => { expect(DEVICE_MULTIPLEX_ACK_TOTAL_MAX_WINDOW_BYTES).toBe(8 * 1024 * 1024) })
  it('pending max is 256 KiB', () => { expect(DEVICE_MULTIPLEX_PENDING_MAX_BYTES).toBe(256 * 1024) })
  it('ack batch is 192 KiB', () => { expect(DEVICE_MULTIPLEX_ACK_BATCH_BYTES).toBe(192 * 1024) })
  it('ack flush interval is 4 ms', () => { expect(DEVICE_MULTIPLEX_ACK_FLUSH_MS).toBe(4) })
  it('max streams per connection is 32', () => { expect(DEVICE_MULTIPLEX_MAX_STREAMS_PER_CONNECTION).toBe(32) })

  it('stream window grows from initial to max', () => {
    expect(DEVICE_MULTIPLEX_ACK_STREAM_MAX_WINDOW_BYTES).toBeGreaterThan(DEVICE_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES)
  })

  it('total window grows from initial to max', () => {
    expect(DEVICE_MULTIPLEX_ACK_TOTAL_MAX_WINDOW_BYTES).toBeGreaterThan(DEVICE_MULTIPLEX_ACK_TOTAL_INITIAL_WINDOW_BYTES)
  })

  it('window values are internally consistent', () => {
    expect(DEVICE_MULTIPLEX_ACK_TOTAL_MAX_WINDOW_BYTES).toBeGreaterThan(0)
  })
})
