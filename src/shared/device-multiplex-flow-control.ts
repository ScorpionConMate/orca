// Flow-control constants for the device binary stream multiplex.
// Mirrors terminal-multiplex-flow-control.ts with the same numeric values.

export const DEVICE_STREAM_CHUNK_BYTES = 48 * 1024
export const DEVICE_OUTPUT_BATCH_MAX_BYTES = 64 * 1024
export const DEVICE_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES = 512 * 1024
export const DEVICE_MULTIPLEX_ACK_STREAM_MAX_WINDOW_BYTES = 2 * 1024 * 1024
export const DEVICE_MULTIPLEX_ACK_TOTAL_INITIAL_WINDOW_BYTES = 2 * 1024 * 1024
export const DEVICE_MULTIPLEX_ACK_TOTAL_MAX_WINDOW_BYTES = 8 * 1024 * 1024
export const DEVICE_MULTIPLEX_PENDING_MAX_BYTES = 256 * 1024
export const DEVICE_MULTIPLEX_ACK_BATCH_BYTES = 192 * 1024
export const DEVICE_MULTIPLEX_ACK_FLUSH_MS = 4
export const DEVICE_MULTIPLEX_MAX_STREAMS_PER_CONNECTION = 32

// Recovery-loop bounds (Phase 4)
export const DEVICE_RECOVERY_TIMEOUT_MS = 2_000
export const DEVICE_RECOVERY_MAX_ATTEMPTS = 3

// Multi-viewer bounds
export const DEVICE_SESSION_MAX_SUBSCRIBERS = 4

// Reconnect bounds
export const DEVICE_RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000] as const
export const DEVICE_RECONNECT_MAX_ATTEMPTS = 3
