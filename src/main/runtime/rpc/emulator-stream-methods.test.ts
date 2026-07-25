import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest, RpcSuccess } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { EMULATOR_METHODS, _setRemoteDeviceStreamingEnabled } from './methods/emulator'
import { unregisterDeviceSession, setSourceConstructor } from './device-session-host-stub'
import { registerDeviceStreamServer } from './device-stream-server'
import type { DeviceMediaSource, DeviceMediaEvent } from '../../../shared/device-session-types'

function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return { getRuntimeId: () => 'test-runtime', registerSubscriptionCleanup: vi.fn(), cleanupSubscription: vi.fn(), ...overrides } as OrcaRuntimeService
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('emulator stream RPC methods', () => {
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    _setRemoteDeviceStreamingEnabled(true)
    runtime = stubRuntime()
    registerDeviceStreamServer(runtime)
    setSourceConstructor(class MockSource implements DeviceMediaSource {
      subscribe(_listener: (event: DeviceMediaEvent) => void) { return () => {} }
    })
  })

  afterEach(() => { _setRemoteDeviceStreamingEnabled(false); unregisterDeviceSession('test-session') })

  it('emulator.stream.open registers a session and returns a descriptor', async () => {
    const dispatcher = new RpcDispatcher({ runtime, methods: EMULATOR_METHODS })
    const response = await dispatcher.dispatch(makeRequest('emulator.stream.open', { sessionId: 'test-session', deviceId: 'test-device' }))
    expect(response.ok).toBe(true)
    if (!response.ok) { return }
    const r = (response as RpcSuccess).result as Record<string, unknown>
    expect(r.sessionId).toBe('test-session')
    expect(r.provider).toBe('android-sdk')
    expect(r.transport).toBe('runtime-websocket')
    expect(r.platform).toBe('android')
    expect(r.capabilities).toBeDefined()
  })

  it('emulator.stream.close unregisters a session', async () => {
    const dispatcher = new RpcDispatcher({ runtime, methods: EMULATOR_METHODS })
    await dispatcher.dispatch(makeRequest('emulator.stream.open', { sessionId: 'test-session', deviceId: 'test-device' }))
    const response = await dispatcher.dispatch(makeRequest('emulator.stream.close', { sessionId: 'test-session' }))
    expect(response.ok).toBe(true)
    if (!response.ok) { return }
    const r = (response as RpcSuccess).result as Record<string, unknown>
    expect(r.ok).toBe(true)
    const listResp = await dispatcher.dispatch(makeRequest('emulator.session.list', {}))
    expect(listResp.ok).toBe(true)
    if (!listResp.ok) { return }
    const sessions = (listResp as RpcSuccess).result as Record<string, unknown>[]
    expect(sessions.find((s) => s.sessionId === 'test-session')).toBeUndefined()
  })

  it('emulator.session.list returns registered sessions', async () => {
    const dispatcher = new RpcDispatcher({ runtime, methods: EMULATOR_METHODS })
    await dispatcher.dispatch(makeRequest('emulator.stream.open', { sessionId: 'session-a', deviceId: 'device-a' }))
    await dispatcher.dispatch(makeRequest('emulator.stream.open', { sessionId: 'session-b', deviceId: 'device-b' }))
    const response = await dispatcher.dispatch(makeRequest('emulator.session.list', {}))
    expect(response.ok).toBe(true)
    if (!response.ok) { return }
    const sessions = (response as RpcSuccess).result as Record<string, unknown>[]
    expect(sessions.length).toBe(2)
    expect(sessions.find((s) => s.sessionId === 'session-a')).toBeDefined()
    expect(sessions.find((s) => s.sessionId === 'session-b')).toBeDefined()
    unregisterDeviceSession('session-a'); unregisterDeviceSession('session-b')
  })

  it('emulator.session.get returns a single session descriptor', async () => {
    const dispatcher = new RpcDispatcher({ runtime, methods: EMULATOR_METHODS })
    await dispatcher.dispatch(makeRequest('emulator.stream.open', { sessionId: 'test-session', deviceId: 'test-device' }))
    const response = await dispatcher.dispatch(makeRequest('emulator.session.get', { sessionId: 'test-session' }))
    expect(response.ok).toBe(true)
    if (!response.ok) { return }
    const r = (response as RpcSuccess).result as Record<string, unknown> | null
    expect(r).not.toBeNull()
    expect(r!.sessionId).toBe('test-session')
  })

  it('emulator.session.get returns null for unknown session', async () => {
    const dispatcher = new RpcDispatcher({ runtime, methods: EMULATOR_METHODS })
    const response = await dispatcher.dispatch(makeRequest('emulator.session.get', { sessionId: 'nonexistent' }))
    expect(response.ok).toBe(true)
    if (!response.ok) { return }
    expect((response as RpcSuccess).result).toBeNull()
  })

  it('emulator.session.list returns empty array when no sessions', async () => {
    const dispatcher = new RpcDispatcher({ runtime, methods: EMULATOR_METHODS })
    const response = await dispatcher.dispatch(makeRequest('emulator.session.list', {}))
    expect(response.ok).toBe(true)
    if (!response.ok) { return }
    expect((response as RpcSuccess).result).toEqual([])
  })
})
