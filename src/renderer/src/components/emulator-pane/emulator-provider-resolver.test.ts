import { describe, expect, it } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { resolveEmulatorProvider } from './emulator-provider-resolver'

function makeRuntime(id: string, name: string, isRemote: boolean): PublicKnownRuntimeEnvironment {
  return {
    id,
    name,
    createdAt: 1000,
    updatedAt: 1000,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: isRemote
      ? [
          {
            id: 'ws-1',
            kind: 'websocket' as const,
            label: 'WebSocket',
            endpoint: 'wss://example.com/ws'
          }
        ]
      : [],
    preferredEndpointId: isRemote ? 'ws-1' : ''
  }
}

describe('resolveEmulatorProvider', () => {
  const remoteEnv = makeRuntime('env-1', 'Remote Linux', true)
  const localEnv = makeRuntime('env-2', 'Local Host', false)

  it('returns local:user when provider kind is local', () => {
    const result = resolveEmulatorProvider({ kind: 'local' }, null, [])
    expect(result).toEqual({ kind: 'local', reason: 'user' })
  })

  it('returns remote when provider kind is remote and runtime exists', () => {
    const result = resolveEmulatorProvider(
      { kind: 'remote', runtimeEnvironmentId: 'env-1' },
      null,
      [remoteEnv]
    )
    expect(result).toEqual({ kind: 'remote', runtimeEnvironmentId: 'env-1', runtimeName: 'Remote Linux' })
  })

  it('falls back to local when provider kind is remote with stale id', () => {
    const result = resolveEmulatorProvider(
      { kind: 'remote', runtimeEnvironmentId: 'env-stale' },
      null,
      [remoteEnv]
    )
    expect(result).toEqual({ kind: 'local', reason: 'fallback' })
  })

  it('returns local:follow for follow-runtime with no active runtime', () => {
    const result = resolveEmulatorProvider({ kind: 'follow-runtime' }, null, [])
    expect(result).toEqual({ kind: 'local', reason: 'follow' })
  })

  it('returns local:follow for follow-runtime with undefined provider', () => {
    const result = resolveEmulatorProvider(undefined, null, [])
    expect(result).toEqual({ kind: 'local', reason: 'follow' })
  })

  it('returns local:follow for follow-runtime with null provider', () => {
    const result = resolveEmulatorProvider(null, null, [])
    expect(result).toEqual({ kind: 'local', reason: 'follow' })
  })

  it('returns local:follow for follow-runtime with a local active runtime (no endpoints)', () => {
    const result = resolveEmulatorProvider({ kind: 'follow-runtime' }, 'env-2', [localEnv])
    expect(result).toEqual({ kind: 'local', reason: 'follow' })
  })

  it('returns remote for follow-runtime with a remote active runtime', () => {
    const result = resolveEmulatorProvider({ kind: 'follow-runtime' }, 'env-1', [remoteEnv])
    expect(result).toEqual({
      kind: 'remote',
      runtimeEnvironmentId: 'env-1',
      runtimeName: 'Remote Linux'
    })
  })

  it('returns local:follow for follow-runtime when active runtime id is unknown', () => {
    const result = resolveEmulatorProvider({ kind: 'follow-runtime' }, 'env-unknown', [remoteEnv])
    expect(result).toEqual({ kind: 'local', reason: 'follow' })
  })
})
