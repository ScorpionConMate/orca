# RFC: Transport-Agnostic Device Sessions and Remote Emulator Streaming

**Status:** Request for feedback  
**Related issue:** [#6701 — support browser & mobile emulator etc for SSH workspaces or Remote Orca Server](https://github.com/stablyai/orca/issues/6701)  
**Initial implementation target:** Android emulator running on a Linux Remote Orca Server, viewed and controlled from Orca Desktop on Windows  
**Long-term scope:** Local, Remote Orca Server, SSH, and external device providers

## Summary

I would like to contribute a transport-agnostic device-session architecture that preserves Orca's current local emulator experience while enabling the same emulator pane to consume a device hosted elsewhere.

The immediate use case is:

- Orca Desktop runs on Windows.
- `orca serve` runs on a Linux home server.
- An Android AVD and the Android SDK run on that Linux server.
- The user opens the remote workspace from Windows and sees/controls the server-owned emulator inside the normal Orca emulator pane.

This is not intended to be a separate "remote emulator mode." The proposal is to make locality an implementation detail. The renderer should consume a `DeviceSession` with capabilities and a media stream, regardless of whether the device is:

- local to the desktop process;
- hosted by a paired Remote Orca Server;
- reachable through an SSH workspace;
- or supplied by an external provider such as Genymotion, Sauce Labs, BrowserStack, or AWS Device Farm.

The first contribution would remain intentionally narrow: refactor the existing local path without behavioral change, then add Android streaming over the paired Remote Orca Server transport.

## Motivation

Orca already contains most of the pieces required for Android device support:

- Android SDK and AVD discovery;
- device lifecycle through `adb` and `emulator`;
- installation, launch, permissions, accessibility, and logcat operations;
- H.264 capture through scrcpy;
- renderer-side WebCodecs decoding;
- runtime RPC methods for emulator control;
- an authenticated paired WebSocket transport;
- and an existing multiplexed binary-stream implementation for remote terminals.

The remaining architectural mismatch is ownership of the video stream. The emulator and scrcpy stream are host-owned, but the current video bridge is Electron-window-owned. The video registry publishes frames to an IPC handler that requires a local `BrowserWindow`, so a controller connected to a Remote Orca Server can invoke control-plane methods but cannot subscribe to the server-owned media stream.

This also explains the broader issue reported in #6701: loopback-owned browser or simulator resources work on the execution host, but a remote renderer cannot consume them unless Orca proxies or multiplexes them through a transport owned by the remote runtime.

## Current architecture

The current Android flow is conceptually:

```text
Android AVD / adb device
        |
        v
scrcpy server + adb forwards
        |
        v
AndroidEmulatorBackend
        |
        v
scrcpyVideoRegistry
        |
        v
emulator:videoStream* Electron IPC
        |
        v
Local BrowserWindow renderer
        |
        v
VideoDecoder -> canvas
```

Control operations are already represented as runtime RPC methods, while video frames use local Electron IPC. This split is correct for a local desktop, but the data plane does not cross a Remote Orca Server connection.

## Goals

1. Preserve the existing local emulator behavior and performance.
2. Make local versus remote transport transparent to the emulator pane.
3. Stream Android H.264 video through Orca's authenticated remote-runtime connection without exposing ADB or scrcpy ports.
4. Reuse the existing emulator control RPC surface where practical.
5. Bound memory, frame queues, and subscriber counts.
6. Recover from dropped frames, reconnects, and renderer remounts.
7. Keep the architecture extensible to iOS Simulator, SSH-hosted devices, physical devices, and external providers.
8. Land the work as reviewable, independently tested PRs rather than one very large patch.

## Non-goals for the first implementation

- A public third-party plugin marketplace or arbitrary executable plugin system.
- Full iOS remote streaming in the first PR series.
- Camera, microphone, Bluetooth, NFC, or arbitrary sensor forwarding.
- Exposing raw ADB, scrcpy, or simulator-helper ports to the controller.
- Solving every external device-cloud provider before the host-owned Android path works.
- Replacing Appium or test-lab products.

## Design principles

### Local-first compatibility

The local implementation should use the same domain model as remote sessions, but may retain the most efficient local transport. A local session should not be forced through a network-style serialization layer merely for architectural purity.

### Separate device ownership from presentation

The host that owns the SDK, emulator process, ADB connection, credentials, and helper processes remains authoritative for device lifecycle. The controller owns presentation, decoding, and user input capture.

### Separate control plane from data plane

Control operations are small, ordered RPC calls. Video is a high-throughput binary stream with different flow-control requirements. They should share authentication and session identity, but not necessarily the same message representation.

### Capability-driven UI

The renderer should not infer behavior from `platform === android` alone. A session should advertise capabilities such as video, install, launch, accessibility, logcat, rotation, clipboard, camera injection, and provider-specific limitations.

### Provider-neutral core

The core abstraction should describe a device session, not scrcpy or a specific cloud vendor. Provider-specific APIs and credentials should remain behind adapters.

## Proposed domain model

The names below are illustrative and should follow maintainers' preferred conventions.

```ts
type DeviceProviderKind =
  | 'android-sdk'
  | 'ios-simulator'
  | 'genymotion'
  | 'browserstack'
  | 'sauce-labs'
  | 'aws-device-farm'
  | 'custom'

type DeviceTransportKind = 'local-ipc' | 'runtime-websocket' | 'ssh-relay' | 'external'

type DeviceVideoCodec = 'h264' | 'mjpeg'

type DeviceCapabilities = {
  video: boolean
  input: boolean
  install: boolean
  launch: boolean
  permissions: boolean
  accessibilityTree: boolean
  logs: boolean
  rotate: boolean
  clipboard: boolean
  screenshots: boolean
}

type DeviceSessionDescriptor = {
  sessionId: string
  provider: DeviceProviderKind
  transport: DeviceTransportKind
  deviceId: string
  displayName: string
  platform: 'android' | 'ios'
  capabilities: DeviceCapabilities
  video?: {
    codec: DeviceVideoCodec
    width?: number
    height?: number
  }
}
```

I suggest separating four responsibilities:

1. **Device provider** — discovery, acquisition, boot, shutdown, install, logs, and provider credentials.
2. **Device session** — stable identity and lifecycle for one active device attachment.
3. **Device media source** — publishes codec metadata and frames on the authoritative host.
4. **Device transport adapter** — connects the host-owned session to a consumer through local IPC, Remote Orca Server, SSH, or an external provider protocol.

## Proposed architecture

```text
                           Orca renderer
                                 |
                         DeviceSessionClient
                                 |
               +-----------------+-----------------+
               |                                   |
        Local transport                    Remote transport
        Electron IPC                       Paired runtime WS
               |                                   |
               +-----------------+-----------------+
                                 |
                         Host DeviceSession
                                 |
                +----------------+----------------+
                |                                 |
        DeviceProvider                    DeviceMediaSource
  lifecycle/control/capabilities       H.264 or MJPEG frames
                |                                 |
        Android SDK / iOS /              scrcpy / serve-sim /
        external provider API             provider media API
```

The renderer should receive the same session descriptor and stream events in both local and remote cases. Only the selected transport adapter changes.

## Control plane

Most existing methods can remain or evolve incrementally:

```text
emulator.listDevices
emulator.attach
emulator.detach
emulator.tap
emulator.gesture
emulator.type
emulator.button
emulator.rotate
emulator.install
emulator.launch
emulator.permissions
emulator.ax
emulator.logcat
emulator.shutdown
```

Potential additions:

```text
emulator.stream.open
emulator.stream.close
emulator.stream.requestKeyframe
emulator.session.get
emulator.session.subscribe
```

`emulator.attach` should return a serializable session descriptor instead of returning local-only stream URLs as the authoritative representation.

## Data plane

There are two viable directions:

### Option A: Add a device-specific binary protocol

Create a `device-stream-protocol.ts` parallel to `terminal-stream-protocol.ts`, with its own kind byte, version, opcodes, stream ID, sequence, and payload.

Advantages:

- low implementation coupling;
- easy to review independently;
- device-specific semantics remain explicit.

### Option B: Generalize the current terminal binary envelope

Extract a generic runtime binary multiplex envelope and make terminal and device streams protocol families on top of it.

Advantages:

- one common framing, flow-control, limits, and dispatch mechanism;
- better foundation for future browser, audio, file, or screen streams.

Risk:

- broader refactor and higher regression surface.

For an initial contribution, I would prefer Option A unless maintainers already intend to generalize the binary layer. The implementation can still reuse the terminal multiplexer patterns for ACKs, bounded buffering, reconnect handling, and sequence-gap recovery.

Illustrative device opcodes:

```text
Open
Opened
Metadata
CodecConfig
Frame
Ack
RequestKeyframe
Pause
Resume
Close
Error
```

The exact wire format should be agreed before implementation. Important properties are:

- a versioned envelope;
- a bounded maximum frame size;
- per-session stream IDs;
- monotonic sequence numbers;
- keyframe/config flags;
- explicit close/error events;
- and credit- or ACK-based backpressure.

## Backpressure and recovery

A remote video transport cannot behave like an unbounded event emitter.

Proposed rules:

1. Cap queued bytes and queued frames per stream.
2. Prefer dropping stale non-keyframes over increasing latency indefinitely.
3. On a sequence gap, discard dependent frames until codec configuration and a keyframe are available.
4. Allow the controller to request a fresh keyframe.
5. Pause or reduce the producer when the pane or window is hidden.
6. Use bounded replay only for codec metadata and the latest decodable GOP, not an unlimited history.
7. Release all subscriptions when the renderer, connection, or session closes.
8. Keep one producer session shareable by multiple authorized viewers where practical, but bound subscriber counts.

## Local behavior

Local mode remains a first-class path:

```text
Local DeviceSession -> LocalDeviceStreamTransport -> Electron IPC -> renderer
```

The initial refactor should preserve current observable behavior byte-for-byte where possible. The goal is to move local IPC behind a transport interface, not replace it with WebSocket loopback.

This also gives us a clean regression boundary: after the first PR, all current local emulator tests and manual validation should pass before any remote functionality is added.

## Remote Orca Server behavior

```text
Linux host running orca serve
    Android AVD
       -> AndroidEmulatorBackend
       -> DeviceMediaSource
       -> RuntimeDeviceStreamServer
       -> authenticated paired WebSocket
       -> RemoteDeviceStreamClient on Windows
       -> existing WebCodecs renderer path
```

Control commands remain runtime RPC calls. Video frames are multiplexed as binary messages on the paired socket, preserving the existing device token and E2EE boundary.

No additional public listener is required, and the user does not need to expose ports 5037, 5554/5555, scrcpy forwards, or helper HTTP ports.

## SSH-hosted devices

SSH should be treated as another transport/host boundary, not a separate device backend. Once the device-session and stream contracts are stable, an SSH adapter could:

- run the provider and media source on the SSH host;
- tunnel a framed Orca device stream through the existing SSH relay;
- and expose the same session descriptor to the renderer.

I would keep this outside the first Android Remote Orca Server series because the lifecycle and failure modes differ.

## External providers

A provider abstraction could eventually support cloud devices, but providers differ significantly.

### Strong candidate: Genymotion SaaS/PaaS

Genymotion exposes APIs to create/start/stop Android virtual devices, secure ADB connectivity, and device HTTP APIs. This maps relatively well to Orca's provider and control interfaces. It is the most natural candidate for a future fully integrated virtual-device provider.

### Possible session adapters: Sauce Labs, BrowserStack, AWS Device Farm

These products provide live interactive sessions and/or Appium endpoints on real or virtual devices. An Orca integration may initially be better represented as an externally hosted session with provider-specific controls and a launch/open action. Raw embeddable video access may not be exposed as a supported public API, so the adapter should not assume Orca can ingest the vendor's internal stream.

### Automation provider: Firebase Test Lab

Firebase Test Lab is optimized around test matrices, virtual and physical devices, and collected results. It is valuable for an Orca "run on device matrix" workflow, but it is not a direct substitute for an interactive emulator pane.

The core should therefore avoid requiring every provider to expose identical capabilities. A capability-driven model lets interactive and batch providers coexist without pretending they are equivalent.

## Security considerations

- Device media and controls must require the same paired-device authentication as other remote runtime operations.
- Do not expose ADB, emulator-console, scrcpy, or simulator-helper ports directly.
- Validate stream IDs against the authenticated connection and device scope.
- Apply authorization to every control and media subscription.
- Bound payload size, frame rate, buffered bytes, subscriber count, and session count.
- Avoid logging pairing credentials, provider API tokens, app content, frame payloads, or clipboard data.
- Ensure session cleanup revokes subscriptions and closes host-owned helpers.
- External provider credentials should use Orca's credential-storage conventions and never be forwarded to renderers unnecessarily.

## Observability

Suggested diagnostics:

- session ID, device ID, provider, transport, codec, dimensions;
- produced/sent/dropped/decoded frame counters;
- queued bytes and outstanding credit;
- keyframe requests and recovery count;
- reconnect reason and duration;
- producer and subscriber lifecycle events;
- scrubbed error categories rather than payload contents.

## Proposed PR sequence

### PR 1 — Local transport abstraction, no feature change

- Introduce session/media-source/transport interfaces.
- Move current `scrcpyVideoRegistry -> Electron IPC` wiring behind a local transport adapter.
- Preserve local Android behavior.
- Add contract and cleanup tests.

### PR 2 — Device binary protocol and host multiplexer

- Add versioned framing and opcodes.
- Implement bounded queues, ACK/credit flow control, and keyframe recovery primitives.
- Add parser, malformed-frame, overflow, and lifecycle tests.
- No renderer feature enabled yet.

### PR 3 — Remote Android stream client

- Add controller-side multiplexer.
- Route remote Android H.264 config/frames into the existing WebCodecs rendering path.
- Keep control commands on runtime RPC.
- Gate behind an experimental feature flag if preferred.

### PR 4 — Reconnect, visibility, and performance hardening

- Reconnect and session resubscription.
- Sequence-gap/keyframe recovery.
- Hidden-window pause behavior.
- Memory and throughput instrumentation.
- End-to-end tests and cross-platform manual evidence.

### Later PRs

- iOS Simulator media transport.
- SSH device sessions.
- external-provider SPI and first provider adapter.
- multi-viewer or multi-device UX improvements.

## Test strategy

### Unit tests

- protocol encode/decode and invalid frames;
- stream ID ownership;
- queue and payload limits;
- ACK/credit accounting;
- keyframe recovery after dropped frames;
- subscription cleanup;
- capability serialization;
- provider and transport routing.

### Integration tests

- fake H.264 source -> runtime socket -> remote client -> decoder adapter;
- disconnect and reconnect with an active session;
- renderer remount reuses a valid host stream;
- remote controls target the same device as the stream;
- multiple device streams remain isolated;
- unauthorized or stale stream IDs are rejected.

### Manual validation matrix

Primary:

- Linux server + Android AVD -> Windows Orca Desktop over LAN.
- Linux server + Android AVD -> Windows Orca Desktop over Tailscale.

Regression:

- Windows local Android emulator.
- Linux local Android emulator.
- macOS local Android emulator.
- macOS local iOS Simulator.

Additional where available:

- macOS Remote Orca Server -> Windows/macOS controller.
- bandwidth/latency simulation and reconnect tests.

## Open questions for maintainers

1. Is this direction aligned with the intended resolution of #6701?
2. Is someone already implementing the assigned issue, and would an Android-focused slice be useful?
3. Should the binary framing remain device-specific initially, or should it generalize the terminal multiplex envelope?
4. Should remote emulator streaming first target paired Remote Orca Server only, leaving SSH for a later series?
5. Is a feature flag expected for the first remote implementation?
6. Should the session abstraction live under `emulator/`, or is a broader `devices/` package preferred?
7. Are there existing plans for a supported external-provider/plugin API that this work should align with?

## Offer to contribute

I can implement and validate the first Android-focused slice across Linux, Windows, and macOS. My proposed starting point is the local no-behavior-change refactor, followed by a small protocol spike demonstrating a bounded H.264 stream over the paired runtime connection.

Before writing the larger changes, I would appreciate feedback on ownership, naming, protocol direction, and PR boundaries so I do not duplicate existing work.

## Source references reviewed

- `src/main/emulator/backends/android-emulator-backend.ts`
- `src/main/emulator/scrcpy-video-registry.ts`
- `src/main/ipc/emulator-video-stream.ts`
- `src/main/runtime/rpc/methods/emulator.ts`
- `src/main/runtime/runtime-rpc.ts`
- `src/shared/terminal-stream-protocol.ts`
- `src/renderer/src/runtime/remote-runtime-terminal-multiplexer.ts`
- `.github/CONTRIBUTING.md`
- Issue #6701 and its current comments
