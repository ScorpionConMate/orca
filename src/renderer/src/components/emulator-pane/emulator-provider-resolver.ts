import type { MobileEmulatorProvider } from '../../../../shared/types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'

/** Resolved provider with the concrete runtime identity. */
export type ResolvedEmulatorProvider =
  | { kind: 'local'; reason: 'user' | 'fallback' | 'follow' }
  | { kind: 'remote'; runtimeEnvironmentId: string; runtimeName: string }

/**
 * Resolve the effective emulator provider for a session.
 *
 * - `local` via user override → `{ kind: 'local', reason: 'user' }`
 * - `remote` via user override → `{ kind: 'remote', … }` (fallback to local if stale id)
 * - `follow-runtime` → mirrors the active runtime environment (remote if it has a host)
 */
export function resolveEmulatorProvider(
  mobileEmulatorProvider: MobileEmulatorProvider | undefined | null,
  activeRuntimeEnvironmentId: string | null,
  savedRuntimeEnvironments: PublicKnownRuntimeEnvironment[]
): ResolvedEmulatorProvider {
  const provider = mobileEmulatorProvider ?? { kind: 'follow-runtime' }

  if (provider.kind === 'local') {
    return { kind: 'local', reason: 'user' }
  }

  if (provider.kind === 'remote') {
    const env = savedRuntimeEnvironments.find((e) => e.id === provider.runtimeEnvironmentId)
    if (env) {
      return { kind: 'remote', runtimeEnvironmentId: env.id, runtimeName: env.name }
    }
    // Stale id — fall back to local
    return { kind: 'local', reason: 'fallback' }
  }

  // follow-runtime (default)
  if (!activeRuntimeEnvironmentId) {
    return { kind: 'local', reason: 'follow' }
  }

  const activeEnv = savedRuntimeEnvironments.find((e) => e.id === activeRuntimeEnvironmentId)
  if (!activeEnv) {
    return { kind: 'local', reason: 'follow' }
  }

  // A remote runtime has at least one endpoint; a local runtime has none.
  // We consider any runtime with endpoints as remote.
  const isRemote = activeEnv.endpoints.length > 0
  if (isRemote) {
    return { kind: 'remote', runtimeEnvironmentId: activeEnv.id, runtimeName: activeEnv.name }
  }

  return { kind: 'local', reason: 'follow' }
}
