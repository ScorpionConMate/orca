// React hook that subscribes to a remote device stream over the E2EE WebSocket
// and decodes H.264 frames via WebCodecs onto a canvas. Mirrors the WebCodecs
// decode path in use-emulator-video-stream.ts but sourced from a DeviceMediaSource.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeviceMediaEvent, DeviceSessionDescriptor } from '../../../../shared/device-session-types'
import { DEVICE_RECOVERY_TIMEOUT_MS, DEVICE_RECOVERY_MAX_ATTEMPTS } from '../../../../shared/device-multiplex-flow-control'
import { useAppStore } from '@/store'
import { getRemoteRuntimeDeviceMultiplexer } from '@/runtime/remote-runtime-device-multiplexer'
import { trackKeyframeRecoveryStarted, trackKeyframeRecoveryFailed, trackStreamRecovered } from '@/runtime/device-telemetry-client'

export type DeviceStreamClientState =
  | 'connecting'
  | 'streaming'
  | 'recovering'
  | 'disconnected'
  | 'fallback'

type StreamSize = { width: number; height: number }

const H264_CODEC = 'avc1.640028'

type UseDeviceStreamClientOptions = {
  sessionDescriptor: DeviceSessionDescriptor | null
  enabled: boolean
  onSize?: (size: StreamSize) => void
}

type UseDeviceStreamClientResult = {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  state: DeviceStreamClientState
  error: string | null
  retry: () => void
}

export function useDeviceStreamClient({
  sessionDescriptor,
  enabled,
  onSize
}: UseDeviceStreamClientOptions): UseDeviceStreamClientResult {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<DeviceStreamClientState>(
    enabled && sessionDescriptor ? 'connecting' : 'fallback'
  )
  const [error, setError] = useState<string | null>(null)
  const [retryTrigger, setRetryTrigger] = useState(0)
  const onSizeRef = useRef(onSize)
  onSizeRef.current = onSize

  const retry = useCallback(() => {
    setRetryTrigger((c) => c + 1)
  }, [])

  useEffect(() => {
    if (!enabled || !sessionDescriptor) {
      setState('fallback')
      setError(null)
      return
    }

    const DecoderCtor = (
      globalThis as { VideoDecoder?: typeof VideoDecoder }
    ).VideoDecoder
    const ChunkCtor = (
      globalThis as { EncodedVideoChunk?: typeof EncodedVideoChunk }
    ).EncodedVideoChunk
    if (!DecoderCtor || !ChunkCtor) {
      setError('This build does not support WebCodecs H.264 decoding.')
      setState('disconnected')
      return
    }

    let disposed = false
    let configured = false
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (canvas) {
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
    }

    const environmentId =
      useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ?? null
    if (!environmentId) {
      setError('No active runtime environment.')
      setState('disconnected')
      return
    }

    setState('connecting')
    setError(null)

    let streamHandle: Awaited<
      ReturnType<ReturnType<typeof getRemoteRuntimeDeviceMultiplexer>['attachStream']>
    > | null = null

    // Phase 4: visibility pause observer
    const handleVisibilityChange = (): void => {
      if (disposed || !streamHandle) { return }
      if (document.visibilityState === 'hidden') {
        streamHandle.source.setPaused?.(true)
      } else {
        streamHandle.source.setPaused?.(false)
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    let firstFrameTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (!disposed) {
        setError('Remote device stream did not deliver a frame.')
        setState('disconnected')
        cleanup()
      }
    }, 10_000)

    const clearFirstFrameTimeout = (): void => {
      if (firstFrameTimeout) {
        clearTimeout(firstFrameTimeout)
        firstFrameTimeout = null
      }
    }

    // Phase 4: recovery loop state
    let recoveryAttempts = 0
    let recoveryTimeout: ReturnType<typeof setTimeout> | null = null

    function clearRecoveryTimeout(): void {
      if (recoveryTimeout) {
        clearTimeout(recoveryTimeout)
        recoveryTimeout = null
      }
    }

    function startRecoveryTimeout(): void {
      clearRecoveryTimeout()
      recoveryTimeout = setTimeout(() => {
        if (disposed) { return }
        recoveryAttempts++
        if (recoveryAttempts >= DEVICE_RECOVERY_MAX_ATTEMPTS) {
          clearRecoveryTimeout()
          trackKeyframeRecoveryFailed({
            sessionId: sessionDescriptor!.sessionId,
            deviceId: sessionDescriptor!.deviceId,
            streamId: streamHandle?.streamId ?? 0,
            attempts: recoveryAttempts
          })
          setError('Recovery failed. No keyframe received.')
          setState('disconnected')
          cleanup()
          return
        }
        // Request another keyframe
        streamHandle?.source.requestKeyframe?.()
        startRecoveryTimeout()
      }, DEVICE_RECOVERY_TIMEOUT_MS)
    }

    function cleanup(): void {
      if (disposed) { return }
      disposed = true
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      clearFirstFrameTimeout()
      clearRecoveryTimeout()
      streamHandle?.close()
      streamHandle = null
      if (decoder.state !== 'closed') {
        decoder.close()
      }
    }

    function fatal(message: string): void {
      if (disposed) { return }
      setError(message)
      setState('disconnected')
      cleanup()
    }

    // Why: mutable ref avoids stale-closure issues with state inside frame callback
    const recoveringRef = { current: false }

    const decoder = new DecoderCtor({
      output: (frame) => {
        if (!disposed && ctx && canvas) {
          clearFirstFrameTimeout()
          if (
            canvas.width !== frame.displayWidth ||
            canvas.height !== frame.displayHeight
          ) {
            canvas.width = frame.displayWidth
            canvas.height = frame.displayHeight
          }
          ctx.drawImage(frame, 0, 0)
        }
        frame.close()
      },
      error: (err) => fatal(err.message)
    })

    let expectedSeq: number | undefined

    const multiplexer = getRemoteRuntimeDeviceMultiplexer(environmentId)
    multiplexer
      .attachStream(sessionDescriptor)
      .then((handle) => {
        if (disposed) {
          handle.close()
          return
        }
        streamHandle = handle

        handle.source.subscribe((event: DeviceMediaEvent) => {
          if (disposed) { return }

          switch (event.type) {
            case 'metadata':
              onSizeRef.current?.({ width: event.width, height: event.height })
              break

            case 'config':
              if (!configured) {
                try {
                  decoder.configure({ codec: H264_CODEC, optimizeForLatency: true })
                } catch (err) {
                  fatal(
                    err instanceof Error ? err.message : 'Failed to configure the H.264 decoder.'
                  )
                  return
                }
                configured = true
              }
              break

            case 'frame': {
              if (!configured) { return }
              if (decoder.state === 'closed') { return }

              // Sequence gap detection → recovering
              if (
                expectedSeq !== undefined &&
                event.seq > expectedSeq + 1
              ) {
                recoveringRef.current = true
                setState('recovering')
                clearRecoveryTimeout()
                recoveryAttempts = 0
                trackKeyframeRecoveryStarted({
                  sessionId: sessionDescriptor!.sessionId,
                  deviceId: sessionDescriptor!.deviceId,
                  streamId: streamHandle?.streamId ?? 0
                })
                handle.source.requestKeyframe?.()
                startRecoveryTimeout()
              }
              expectedSeq = event.seq

              // Phase 4 Finding 2 fix: transition on ANY keyframe, not just when configBytes is non-null
              if (event.keyFrame) {
                if (recoveringRef.current) {
                  recoveringRef.current = false
                  clearRecoveryTimeout()
                  trackStreamRecovered({
                    sessionId: sessionDescriptor!.sessionId,
                    deviceId: sessionDescriptor!.deviceId,
                    streamId: streamHandle?.streamId ?? 0,
                    attemptCount: recoveryAttempts
                  })
                  recoveryAttempts = 0
                  setState('streaming')
                }
              }

              const chunkData = new Uint8Array(event.bytes)

              try {
                decoder.decode(
                  new ChunkCtor({
                    type: event.keyFrame ? 'key' : 'delta',
                    timestamp: Number(event.pts),
                    data: chunkData
                  })
                )
              } catch (err) {
                fatal(
                  err instanceof Error ? err.message : 'Failed to decode a remote device frame.'
                )
              }
              break
            }

            case 'closed':
              if (!disposed) {
                clearRecoveryTimeout()
                setState('disconnected')
                setError(event.reason ?? 'Device stream closed.')
              }
              break

            case 'error':
              if (!disposed) {
                clearRecoveryTimeout()
                setState('disconnected')
                setError(event.message)
              }
              break
          }
        })

        setState('streaming')
      })
      .catch((err: unknown) => {
        if (!disposed) {
          fatal(
            err instanceof Error ? err.message : 'Failed to attach remote device stream.'
          )
        }
      })

    return () => {
      cleanup()
    }
    // Why: retryTrigger is a counter bumped by retry() to re-run the effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionDescriptor, enabled, retryTrigger])

  return { canvasRef, state, error, retry }
}
