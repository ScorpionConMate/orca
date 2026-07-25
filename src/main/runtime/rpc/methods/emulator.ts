import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import path from 'node:path'
import { z } from 'zod'
import { registerDeviceSession, unregisterDeviceSession, getDeviceSession, listDeviceSessions } from '../device-session-host-stub'
import { getDeviceStreamServer, type DeviceStreamBinaryTransport } from '../device-stream-server'

// Minimal schemas for emulator commands (loose for initial testing; can be tightened like browser-schemas).
const WorktreeParam = z.object({ worktree: z.string().optional() }).partial()

const TapParams = z.object({
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  device: z.string().optional(), emulator: z.string().optional(), worktree: z.string().optional()
})

const GesturePoint = z.object({
  edge: z.number().int().min(0).max(4).optional(), type: z.enum(['begin', 'move', 'end']),
  x: z.number().min(0).max(1), y: z.number().min(0).max(1)
})

const GestureParams = z.object({
  points: z.array(GesturePoint).min(2).max(64),
  device: z.string().optional(), emulator: z.string().optional(), worktree: z.string().optional()
})

const TypeParams = z.object({
  text: z.string(), device: z.string().optional(), emulator: z.string().optional(), worktree: z.string().optional()
})

const ButtonParams = z.object({
  name: z.string(), device: z.string().optional(), emulator: z.string().optional(), worktree: z.string().optional()
})

const RotateOrientation = z.enum(['portrait', 'portrait_upside_down', 'landscape_left', 'landscape_right'])

const RotateParams = z.object({
  orientation: RotateOrientation,
  device: z.string().optional(), emulator: z.string().optional(), worktree: z.string().optional()
})

const ExecParams = z.object({
  command: z.string(), device: z.string().optional(), emulator: z.string().optional(), worktree: z.string().optional()
})

const InstallParams = z.object({
  path: z.string().refine((v) => path.isAbsolute(v), { message: 'path must be absolute' }),
  reinstall: z.boolean().optional(), device: z.string().optional(), emulator: z.string().optional(), worktree: z.string().optional()
})

const LaunchParams = z.object({
  package: z.string(), activity: z.string().optional(),
  device: z.string().optional(), emulator: z.string().optional(), worktree: z.string().optional()
})

const PermissionsParams = z.object({
  op: z.enum(['grant', 'revoke', 'reset']), package: z.string().optional(),
  permission: z.string().optional(), device: z.string().optional(),
  emulator: z.string().optional(), worktree: z.string().optional()
}).superRefine((value, ctx) => {
  if (value.op === 'reset') {
    if (value.package) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['package'], message: 'package is not allowed for reset' }) }
    if (value.permission) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['permission'], message: 'permission is not allowed for reset' }) }
    return
  }
  if (!value.package) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['package'], message: 'package is required for grant/revoke' }) }
  if (!value.permission) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['permission'], message: 'permission is required for grant/revoke' }) }
})

const AxParams = z.object({ device: z.string().optional(), emulator: z.string().optional(), worktree: z.string().optional() })
const LogcatParams = z.object({
  lines: z.number().int().positive().optional(), filters: z.array(z.string()).optional(),
  device: z.string().optional(), emulator: z.string().optional(), worktree: z.string().optional()
})
const AttachParams = z.object({ device: z.string().optional(), worktree: z.string().optional(), focus: z.boolean().optional() })
const KillParams = z.object({ device: z.string().optional(), emulator: z.string().optional(), worktree: z.string().optional() })
const ShutdownParams = KillParams.extend({ managedOnly: z.boolean().optional() })
const ListParams = WorktreeParam
const StreamOpenParams = z.object({ sessionId: z.string(), deviceId: z.string() })
const StreamCloseParams = z.object({ sessionId: z.string() })
const SessionGetParams = z.object({ sessionId: z.string() })

function sessionToDescriptor(host: { sessionId: string; provider: string; transport: string; platform: string; capabilities: unknown; video?: unknown }, deviceId: string) {
  return { sessionId: host.sessionId, provider: host.provider, transport: host.transport, deviceId, displayName: deviceId, platform: host.platform, capabilities: host.capabilities, video: host.video }
}

// Module-level feature flag — default off. Wired from the store at startup.
let _remoteDeviceStreamingEnabled = false
export function _setRemoteDeviceStreamingEnabled(enabled: boolean): void {
  _remoteDeviceStreamingEnabled = enabled
}

function requireDeviceStreamingEnabled(): void {
  if (!_remoteDeviceStreamingEnabled) {
    throw Object.assign(new Error('feature_disabled: Remote device streaming is disabled'), { code: 'feature_disabled' })
  }
}

export const EMULATOR_METHODS: RpcAnyMethod[] = [
  defineMethod({ name: 'emulator.list', params: ListParams, handler: async (params, { runtime }) => runtime.emulatorList(params) }),
  defineMethod({ name: 'emulator.stream.open', params: StreamOpenParams, handler: async (params) => { requireDeviceStreamingEnabled(); return sessionToDescriptor(registerDeviceSession(params.sessionId, params.deviceId), params.deviceId) } }),
  defineMethod({ name: 'emulator.stream.close', params: StreamCloseParams, handler: async (params) => { requireDeviceStreamingEnabled(); unregisterDeviceSession(params.sessionId); return { ok: true } } }),
  defineMethod({
    name: 'emulator.session.list',
    params: z.object({}).partial(),
    handler: async (_params, { runtime }) => {
      requireDeviceStreamingEnabled()
      // Lazily register discovered Android AVDs as sessions so the renderer can pick one.
      // Why: the host stub is empty until a device is observed; syncing on list keeps v1 manual
      // testing working without a separate provider lifecycle. iOS sims are out of scope for v1.
      try {
        const devices = await runtime.emulatorListDevices({})
        for (const device of devices) {
          if (device.backend !== 'android' || !device.isAvailable) { continue }
          const sessionId = `android:${device.id}`
          if (!getDeviceSession(sessionId)) {
            registerDeviceSession(sessionId, device.id)
          }
        }
      } catch {
        // Backend unavailable (no SDK, adb down) -> return whatever is already registered.
      }
      return listDeviceSessions().map((h) => sessionToDescriptor(h, h.deviceId))
    }
  }),
  defineMethod({ name: 'emulator.session.get', params: SessionGetParams, handler: async (params) => { requireDeviceStreamingEnabled(); const h = getDeviceSession(params.sessionId); return h ? sessionToDescriptor(h, h.deviceId) : null } }),
  defineMethod({ name: 'emulator.attach', params: AttachParams, handler: async (params, { runtime }) => runtime.emulatorAttach(params) }),
  defineMethod({ name: 'emulator.tap', params: TapParams, handler: async (params, { runtime }) => runtime.emulatorTap(params) }),
  defineMethod({ name: 'emulator.gesture', params: GestureParams, handler: async (params, { runtime }) => runtime.emulatorGesture(params) }),
  defineMethod({ name: 'emulator.type', params: TypeParams, handler: async (params, { runtime }) => runtime.emulatorType(params) }),
  defineMethod({ name: 'emulator.button', params: ButtonParams, handler: async (params, { runtime }) => runtime.emulatorButton(params) }),
  defineMethod({ name: 'emulator.rotate', params: RotateParams, handler: async (params, { runtime }) => runtime.emulatorRotate(params) }),
  defineMethod({ name: 'emulator.exec', params: ExecParams, handler: async (params, { runtime }) => runtime.emulatorExec(params) }),
  defineMethod({ name: 'emulator.kill', params: KillParams, handler: async (params, { runtime }) => runtime.emulatorKill(params) }),
  defineMethod({ name: 'emulator.shutdown', params: ShutdownParams, handler: async (params, { runtime }) => runtime.emulatorShutdown(params) }),
  defineMethod({ name: 'emulator.listSimulators', params: z.object({ worktree: z.string().optional() }).partial(), handler: async (params, { runtime }) => runtime.emulatorListSimulators(params) }),
  defineMethod({ name: 'emulator.availability', params: z.object({ worktree: z.string().optional() }).partial(), handler: async (params, { runtime }) => runtime.emulatorAvailability(params) }),
  defineMethod({ name: 'emulator.listDevices', params: z.object({ worktree: z.string().optional() }).partial(), handler: async (params, { runtime }) => runtime.emulatorListDevices(params) }),
  defineMethod({ name: 'emulator.install', params: InstallParams, handler: async (params, { runtime }) => runtime.emulatorInstall(params) }),
  defineMethod({ name: 'emulator.launch', params: LaunchParams, handler: async (params, { runtime }) => runtime.emulatorLaunch(params) }),
  defineMethod({ name: 'emulator.permissions', params: PermissionsParams, handler: async (params, { runtime }) => runtime.emulatorPermissions(params) }),
  defineMethod({ name: 'emulator.ax', params: AxParams, handler: async (params, { runtime }) => runtime.emulatorAx(params) }),
  defineMethod({ name: 'emulator.logcat', params: LogcatParams, handler: async (params, { runtime }) => runtime.emulatorLogcat(params) }),
  defineMethod({ name: 'emulator.unregisterActive', params: z.object({ worktree: z.string().optional() }).partial(), handler: async (params, { runtime }) => runtime.emulatorUnregisterActive(params) }),
  defineStreamingMethod({
    name: 'emulator.stream.start', params: z.object({}).optional(),
    handler: async (_params, ctx, _emit) => {
      requireDeviceStreamingEnabled()
      const { runtime, connectionId, sendBinary, registerDeviceBinaryStreamHandler } = ctx
      if (!connectionId || !sendBinary || !registerDeviceBinaryStreamHandler) { throw new Error('binary_device_stream_required') }
      const server = getDeviceStreamServer(runtime)
      if (!server) { throw new Error('device_stream_server_unavailable') }
      let resolveMultiplex: () => void = () => {}
      const multiplexClosed = new Promise<void>((resolve) => { resolveMultiplex = resolve })
      const transport: DeviceStreamBinaryTransport = { sendBinary, registerBinaryStreamHandler: (sid, h) => registerDeviceBinaryStreamHandler(sid, h) }
      server.attach(connectionId, transport, resolveMultiplex)
      await multiplexClosed
    }
  })
]
