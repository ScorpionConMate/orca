import { useMemo } from 'react'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { useAppStore } from '@/store'
import {
  resolveEmulatorProvider,
  type ResolvedEmulatorProvider
} from './emulator-provider-resolver'

export function resolvedProviderToTarget(provider: ResolvedEmulatorProvider): RuntimeClientTarget {
  return provider.kind === 'remote'
    ? { kind: 'environment', environmentId: provider.runtimeEnvironmentId }
    : { kind: 'local' }
}

export function useResolvedEmulatorProvider(): ResolvedEmulatorProvider {
  const settings = useAppStore((s) => s.settings)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  return useMemo(
    () =>
      resolveEmulatorProvider(
        settings?.mobileEmulatorProvider ?? null,
        settings?.activeRuntimeEnvironmentId?.trim() ?? null,
        runtimeEnvironments
      ),
    [settings?.mobileEmulatorProvider, settings?.activeRuntimeEnvironmentId, runtimeEnvironments]
  )
}
