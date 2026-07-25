# Plan técnico detallado: Device Sessions y emuladores remotos para Orca

**Objetivo inmediato:** ejecutar un Android Emulator en un servidor Linux con `orca serve` y visualizar/controlar ese dispositivo desde Orca Desktop en Windows.  
**Objetivo arquitectónico:** unificar dispositivos locales, Remote Orca Server, SSH y proveedores externos detrás de una misma abstracción, sin degradar el camino local existente.  
**Fecha del análisis:** 24 de julio de 2026.

## 1. Resultado esperado

Al finalizar el primer conjunto de contribuciones, el usuario debería poder:

1. Abrir Orca Desktop en Windows.
2. Conectarse a un entorno servido por `orca serve` en Linux.
3. Seleccionar un AVD disponible en el servidor.
4. Iniciar o adjuntar el AVD desde Orca.
5. Ver el video H.264 dentro del panel Mobile Emulator de Orca.
6. Hacer tap, swipe, escribir, rotar, instalar APK, lanzar apps y consultar logs.
7. Desconectarse y reconectarse sin dejar procesos, forwards ni buffers huérfanos.
8. Usar la misma UI cuando el emulador sea local; la ubicación debe ser transparente.

La primera entrega no necesita resolver iOS remoto, SSH ni nubes de dispositivos. Sí debe dejar contratos claros para agregarlos después.

## 2. Hipótesis técnica

La feature es viable porque las piezas difíciles ya existen:

- Android SDK/AVD y control por ADB.
- Captura H.264 mediante scrcpy.
- Decodificación con WebCodecs en el renderer.
- Métodos RPC para el plano de control.
- WebSocket autenticado para Remote Orca Server.
- Protocolo binario multiplexado, ACKs y recuperación usados por terminales remotas.

El trabajo principal es desacoplar el stream del `BrowserWindow` local y convertirlo en una sesión de dispositivo transportable.

## 3. Arquitectura actual y limitación

### 3.1 Flujo local actual

```text
AVD -> scrcpy -> AndroidEmulatorBackend -> scrcpyVideoRegistry
    -> emulator:videoStream* IPC -> BrowserWindow -> VideoDecoder/canvas
```

### 3.2 Limitación

El handler de video es IPC local y valida que el consumidor sea un `BrowserWindow`. Cuando el AVD vive en el servidor y la UI vive en Windows, no hay un `BrowserWindow` local en el servidor que represente al controlador. Los frames nunca entran al transporte remoto.

### 3.3 Decisión estructural

No agregar un "modo remoto" paralelo. Introducir una abstracción común:

```text
DeviceSession
  + DeviceProvider
  + DeviceCapabilities
  + DeviceMediaSource
  + DeviceControlSurface
  + DeviceTransport
```

Local y remoto serán dos implementaciones de `DeviceTransport`.

## 4. Componentes propuestos

### 4.1 DeviceProvider

Responsable de inventario y ciclo de vida.

```ts
interface DeviceProvider {
  readonly kind: string
  listDevices(): Promise<DeviceDescriptor[]>
  acquire(deviceId: string, options?: AcquireOptions): Promise<DeviceSessionHost>
  release(sessionId: string): Promise<void>
}
```

Implementaciones futuras:

- `AndroidSdkDeviceProvider`
- `IosSimulatorDeviceProvider`
- `GenymotionDeviceProvider`
- `SauceLabsDeviceProvider`
- `BrowserStackDeviceProvider`
- `AwsDeviceFarmProvider`
- `FirebaseTestLabProvider` como proveedor batch, no interactivo

### 4.2 DeviceSessionHost

Vive en la máquina que posee el dispositivo y los helpers.

Responsabilidades:

- identidad estable de sesión;
- ownership de procesos;
- capabilities;
- media source;
- control commands;
- cleanup idempotente;
- métricas y estado.

### 4.3 DeviceMediaSource

Publica metadatos y frames sin conocer Electron, WebSocket ni SSH.

```ts
type DeviceMediaEvent =
  | { type: 'metadata'; codec: 'h264' | 'mjpeg'; width: number; height: number }
  | { type: 'config'; bytes: Uint8Array }
  | { type: 'frame'; seq: number; pts: bigint; keyFrame: boolean; bytes: Uint8Array }
  | { type: 'error'; code: string; message: string }
  | { type: 'closed'; reason?: string }

interface DeviceMediaSource {
  subscribe(listener: (event: DeviceMediaEvent) => void): () => void
  requestKeyframe?(): void
  setPaused?(paused: boolean): void
}
```

`AndroidEmulatorBackend` adaptaría `scrcpyVideoRegistry` a este contrato.

### 4.4 DeviceTransport

Conecta un `DeviceMediaSource` con un consumidor.

```ts
interface DeviceTransport {
  open(session: DeviceSessionDescriptor): Promise<DeviceStreamHandle>
}
```

Implementaciones:

- `LocalIpcDeviceTransport`
- `RuntimeWebSocketDeviceTransport`
- `SshRelayDeviceTransport`
- `ExternalProviderDeviceTransport`

### 4.5 DeviceSessionClient

Vive del lado del controlador y expone una API uniforme al renderer.

El hook actual de video debería depender de este cliente, no directamente de `ipcRenderer`.

## 5. Protocolo remoto

### 5.1 Plano de control

Mantener JSON RPC para:

- attach/detach;
- tap/gesture/type;
- botones y rotación;
- instalación/lanzamiento;
- permisos;
- accessibility tree;
- logcat;
- shutdown.

Agregar solo los métodos necesarios para la vida del stream:

```text
emulator.stream.open
emulator.stream.close
emulator.stream.requestKeyframe
emulator.stream.pause
emulator.stream.resume
```

### 5.2 Plano de datos

Usar frames binarios sobre el WebSocket autenticado existente.

Opciones:

- protocolo específico `device-stream-protocol.ts`;
- o extracción de un envelope multiplexado genérico.

Recomendación inicial: protocolo específico para reducir el alcance del primer PR. Reutilizar patrones de terminales, no necesariamente sus tipos.

### 5.3 Envelope sugerido

No fijar el formato definitivo sin feedback. Un spike puede usar:

```text
byte 0      kind
byte 1      version
byte 2      opcode
byte 3      flags
bytes 4-7   streamId uint32 LE
bytes 8-15  seq uint64 LE
bytes 16-23 pts uint64 LE
bytes 24..  payload
```

Flags posibles:

- keyframe;
- codec config;
- discontinuity;
- end-of-stream.

### 5.4 Backpressure

Requisitos obligatorios:

- límite de bytes por stream;
- límite de frames pendientes;
- ACK/créditos;
- descarte de frames obsoletos antes de aumentar latencia;
- recuperación por keyframe tras gaps;
- pausa cuando panel/ventana no es visible;
- cleanup al cerrar socket;
- no retener más que codec config + GOP decodificable más reciente.

## 6. Plan por fases y PRs

## Fase 0 — Coordinación y baseline

### Tareas

1. Comentar la propuesta en #6701.
2. Confirmar qué está implementando la persona asignada.
3. Acordar nombres, ownership y estrategia de protocolo.
4. Crear una rama de investigación, no un PR gigante.
5. Reproducir y documentar el estado actual.

### Baseline que debe guardarse

- video local Android funcionando;
- attach/tap/type/install/logcat funcionando;
- Remote Orca Server controla el host pero no muestra video;
- uso de CPU/RAM con panel visible y oculto;
- serial del AVD, codec, resolución y FPS;
- logs de cleanup al cerrar panel y aplicación.

### Entregables

- comentario RFC;
- capturas o video de reproducción;
- notas de arquitectura;
- tabla de pruebas inicial.

### Criterio de salida

Mantenedores confirman que no se duplica trabajo y aceptan el primer slice.

## Fase 1 — Refactor local sin cambio funcional

### Objetivo

Desacoplar el video Android de Electron IPC manteniendo la UX local intacta.

### Cambios probables

- crear tipos compartidos de `DeviceSessionDescriptor` y capabilities;
- adaptar `scrcpyVideoRegistry` a `DeviceMediaSource`;
- introducir `LocalIpcDeviceTransport`;
- hacer que `emulator-video-stream.ts` consuma la interfaz, no el registry concreto;
- mantener `use-emulator-video-stream.ts` sin cambios grandes o colocar una fachada estable.

### Archivos candidatos

```text
src/main/emulator/device-session/*
src/main/emulator/device-media-source.ts
src/main/emulator/android/android-device-media-source.ts
src/main/ipc/emulator-video-stream.ts
src/main/emulator/scrcpy-video-registry.ts
src/shared/device-session-types.ts
src/renderer/src/components/emulator-pane/use-emulator-video-stream.ts
```

### Tests

- el adapter reenvía metadata/config/frame en orden;
- unsubscribe libera listener;
- cerrar renderer limpia suscripciones;
- remount reutiliza sesión válida;
- el camino local mantiene capabilities y codec;
- no hay buffers sin límite.

### Criterio de aceptación

Todos los tests actuales pasan; validación manual local en Windows, Linux y macOS; cero cambio visual esperado.

## Fase 2 — Protocolo binario y servidor de streams

### Objetivo

Crear el contrato transportable sin habilitar todavía la UI remota.

### Cambios probables

```text
src/shared/device-stream-protocol.ts
src/main/runtime/rpc/device-stream-server.ts
src/main/runtime/runtime-rpc.ts
src/main/runtime/rpc/mobile-socket-wiring.ts (solo si corresponde)
```

### Funciones

- encode/decode;
- stream ID allocation;
- ownership por conexión autenticada;
- Open/Close/Ack/RequestKeyframe;
- queue bounds;
- métricas;
- cleanup.

### Tests imprescindibles

- round-trip de todos los opcodes;
- payload corto, máximo y excedido;
- versión/kind/opcode inválidos;
- stream ID ajeno;
- cierre de socket;
- productor demasiado rápido;
- ACK duplicado o fuera de rango;
- frame drop y espera de keyframe;
- múltiples streams aislados.

### Criterio de aceptación

Un test de integración puede enviar frames sintéticos desde el host y recibirlos en un cliente de prueba sin memoria creciente.

## Fase 3 — Cliente remoto y Android end-to-end

### Objetivo

Mostrar el AVD Linux en Orca Windows.

### Cambios probables

```text
src/renderer/src/runtime/remote-runtime-device-multiplexer.ts
src/renderer/src/runtime/runtime-device-stream.ts
src/renderer/src/components/emulator-pane/device-stream-client.ts
src/renderer/src/components/emulator-pane/use-emulator-video-stream.ts
src/main/runtime/rpc/methods/emulator.ts
src/main/runtime/orca-runtime-emulator.ts
```

### Flujo

1. Renderer solicita attach.
2. Host inicia/reutiliza AVD y scrcpy.
3. RPC devuelve `DeviceSessionDescriptor`.
4. Cliente abre el stream binario.
5. Host envía metadata/config/keyframe.
6. Renderer configura `VideoDecoder`.
7. Frames siguientes se dibujan al canvas.
8. Controles siguen por RPC.

### Feature flag

Agregar flag experimental si lo solicitan:

```text
remoteDeviceStreamingEnabled
```

Fallback: mostrar un mensaje explícito en lugar de "Stream disconnected".

### Criterio de aceptación

Linux server -> Windows client funciona por LAN y Tailscale sin puertos adicionales.

## Fase 4 — Robustez, reconexión y rendimiento

### Casos

- pérdida temporal del WebSocket;
- cambio de red LAN/Tailscale;
- suspensión de Windows;
- renderer reload;
- panel oculto;
- AVD reiniciado;
- scrcpy caído;
- codec config perdido;
- dos sesiones/dispositivos simultáneos;
- dos viewers autorizados.

### Comportamiento esperado

- estado visible: connecting/streaming/recovering/disconnected;
- reconnect con backoff;
- nueva suscripción o reattach según autoridad;
- solicitud de keyframe;
- no reproducir frames dependientes tras gap;
- cleanup idempotente;
- límites de memoria constantes.

### Métricas

- FPS producido, enviado y decodificado;
- frames descartados;
- bytes en cola;
- RTT de ACK;
- latencia aproximada captura-presentación;
- keyframe requests;
- reconnect count;
- CPU y RAM de host/controlador.

## Fase 5 — iOS remoto

Reutilizar `DeviceSession` y `DeviceTransport`, adaptando MJPEG/serve-sim.

El objetivo es eliminar URLs loopback como fuente autoritativa. El helper sigue local al host, pero Orca consume y retransmite el stream dentro de su frontera autenticada.

## Fase 6 — SSH

Agregar `SshRelayDeviceTransport` después de estabilizar Remote Orca Server.

Preguntas específicas:

- dónde corre el media source;
- cómo se multiplexa sobre SSH;
- reanudación tras reconnect;
- forwarding y cleanup;
- límites con SSH latency;
- compatibilidad con hosts sin GUI.

## Fase 7 — SPI de proveedores externos

No crear un sistema de plugins arbitrarios en el primer proyecto. Definir primero una interfaz interna estable y adapters incorporados.

Un SPI público podría evaluarse después, con aislamiento, versionado y permisos.

## 7. Proveedores externos

## 7.1 Genymotion SaaS/PaaS — mejor candidato para una integración profunda

Características relevantes:

- dispositivos Android virtuales en la nube;
- API HTTP para crear, iniciar y detener instancias;
- ADB seguro mediante `gmsaas`;
- APIs para controlar el dispositivo y widgets;
- acceso web interactivo.

Encaje propuesto:

```text
GenymotionDeviceProvider
  -> API: inventory/acquire/release
  -> ADB: install/control/logcat
  -> media: evaluar stream soportado o sesión web externa
```

Primer alcance prudente:

- listar recetas/instancias;
- iniciar/detener;
- conectar ADB;
- instalar/lanzar;
- abrir sesión externa si no existe API pública de video embebible.

## 7.2 Sauce Labs — real y virtual, live y automatizado

Sauce Labs soporta sesiones live en dispositivos reales y virtuales y automatización. Puede mapearse a capabilities, pero hay que verificar qué API pública permite controlar o embeber una sesión interactiva.

Adaptación inicial:

- provider para inventario/reserva;
- upload de app;
- Appium endpoint;
- acción "Open provider session";
- integración nativa del video solo si existe un contrato público soportado.

## 7.3 BrowserStack App Live — dispositivos reales interactivos

BrowserStack App Live ofrece interacción manual sobre dispositivos Android/iOS reales y local testing. Sus dispositivos de App Live son reales, no emuladores.

Adaptación razonable:

- upload/build selection;
- creación de sesión;
- enlace o ventana externa;
- Appium/App Automate para automatización;
- no asumir acceso al stream interno del proveedor.

## 7.4 AWS Device Farm — acceso remoto y Appium

AWS Device Farm permite sesiones interactivas web sobre dispositivos físicos y ofrece endpoints Appium.

Encaje:

- reservar dispositivo;
- iniciar sesión;
- upload APK/IPA;
- exponer Appium al agente;
- abrir sesión remota del proveedor.

Limitación a considerar: disponibilidad regional y modelo de slots.

## 7.5 Firebase Test Lab — proveedor batch

Test Lab ejecuta matrices en dispositivos físicos y virtuales y devuelve resultados. No debe modelarse como una sesión interactiva continua.

Encaje en Orca:

```text
Build APK -> elegir matriz -> ejecutar -> mostrar resultados, videos, logs y fallos
```

Su capability sería `batchTesting`, no `interactiveVideo`.

## 7.6 Modelo de capabilities para proveedores

```ts
type ProviderCapabilities = {
  interactiveVideo: boolean
  interactiveInput: boolean
  appiumEndpoint: boolean
  adbEndpoint: boolean
  install: boolean
  logs: boolean
  screenshots: boolean
  networkShaping: boolean
  geolocation: boolean
  batchTesting: boolean
  persistentDevice: boolean
}
```

Esto evita forzar a Test Lab a comportarse como scrcpy o asumir que BrowserStack expone su protocolo de streaming.

## 8. Matriz de pruebas

| Host del dispositivo | Controlador | Transporte | Dispositivo | Resultado esperado |
|---|---|---|---|---|
| Linux | Windows | Local LAN | Android AVD | video/control completos |
| Linux | Windows | Tailscale | Android AVD | video/control completos |
| Linux | Linux | local | Android AVD | sin regresión |
| Windows | Windows | local | Android AVD | sin regresión |
| macOS | macOS | local | Android AVD | sin regresión |
| macOS | macOS | local | iOS Simulator | sin regresión |
| macOS | Windows/macOS | Remote Server | iOS Simulator | fase posterior |
| SSH Linux | Windows/macOS | SSH | Android AVD | fase posterior |

Pruebas de red:

- RTT 20/80/200 ms;
- packet loss 0/1/3%;
- ancho de banda limitado;
- cambio de interfaz;
- socket cortado durante frame/config/keyframe;
- reconexión después de suspensión.

## 9. Objetivos de rendimiento provisorios

Estos valores deben discutirse, no presentarse como contrato definitivo:

- resolución inicial máxima: 1280 en el lado mayor, alineada con el backend actual;
- objetivo interactivo: 30 FPS estables en LAN;
- modo opcional 60 FPS si host/red/decoder lo permiten;
- cola máxima: pequeña y basada en bytes, no segundos de video;
- no crecimiento de RAM durante una sesión de 30 minutos;
- recuperación visual tras gap/reconnect: siguiente keyframe, idealmente menos de 2 segundos;
- panel oculto: productor pausado o significativamente reducido;
- controles: priorizar comandos sobre video congestionado.

## 10. Seguridad y threat model

### Activos

- contenido visual del dispositivo;
- inputs y clipboard;
- APK/IPA;
- credenciales de pairing;
- tokens de proveedores;
- ADB/root access;
- logs de aplicación.

### Amenazas

- suscripción a stream ajeno;
- replay de stream ID;
- payload gigante;
- queue exhaustion;
- fuga de tokens al renderer/logs;
- control después de revocación;
- exposición accidental de ADB;
- sesión de proveedor abandonada y facturando.

### Controles

- asociación stream-conexión-dispositivo;
- E2EE y auth existentes;
- límites estrictos;
- validación de opcodes/versiones;
- cleanup en `finally` y socket close;
- credenciales solo en main/host;
- redacción de logs;
- timeouts y lease de sesiones externas;
- feature flag y permisos explícitos.

## 11. Estrategia de observabilidad

Agregar eventos estructurados, sin payloads sensibles:

```text
device.session.created
device.stream.opened
device.stream.frame_dropped
device.stream.keyframe_requested
device.stream.recovered
device.stream.closed
device.session.released
```

Campos:

- provider/transport/platform;
- codec/dimensiones;
- reason code;
- counters y queue bytes;
- tiempos monotónicos;
- nunca frame bytes, texto tipeado, clipboard ni tokens.

## 12. Estrategia de desarrollo local

### Preparación

```bash
git clone https://github.com/stablyai/orca.git
cd orca
pnpm install
pnpm dev
```

Crear ramas pequeñas:

```text
feat/device-session-contracts
feat/local-device-stream-transport
feat/runtime-device-stream-protocol
feat/remote-android-device-stream
fix/remote-device-stream-recovery
```

### Regla práctica

Cada PR debe poder explicarse así:

- qué contrato agrega;
- qué comportamiento visible cambia;
- qué no cambia;
- cómo se probó local/remoto/SSH;
- qué límites de memoria y seguridad se agregaron;
- cómo se revierte o deshabilita.

## 13. Checklist antes de cada PR

- [ ] Issue/maintainer alignment confirmado.
- [ ] Un solo tema por PR.
- [ ] Tests que fallan sin el cambio.
- [ ] `pnpm lint`.
- [ ] `pnpm typecheck`.
- [ ] `pnpm test`.
- [ ] `pnpm build`.
- [ ] Validación en plataformas afectadas.
- [ ] Screenshots/video si cambia UI.
- [ ] Nota explícita sobre local, Remote Server y SSH.
- [ ] Riesgo de performance evaluado.
- [ ] Riesgo de seguridad evaluado.
- [ ] Cleanup verificado.
- [ ] Sin bump de versión.
- [ ] X handle en la descripción, según CONTRIBUTING.

## 14. Riesgos y mitigaciones

### Riesgo: refactor demasiado amplio

Mitigación: adapter local primero, sin cambiar el protocolo terminal ni la UI.

### Riesgo: latencia creciente

Mitigación: cola corta, frame dropping, ACKs y prioridad de controles.

### Riesgo: decoder queda fuera de sincronía

Mitigación: config+keyframe replay, requestKeyframe y discontinuity flag.

### Riesgo: múltiples viewers multiplican CPU

Mitigación: compartir productor; fan-out de frames con límites; pausar cuando no hay consumidores.

### Riesgo: proveedores externos no exponen video

Mitigación: capabilities; soportar sesiones externas/Appium sin prometer embedding.

### Riesgo: trabajo duplicado con issue asignado

Mitigación: RFC y coordinación antes del código; ofrecer un slice concreto.

## 15. Primer spike recomendado

Crear un prototipo descartable que:

1. genere frames H.264 sintéticos o use un archivo corto;
2. los publique desde una instancia de runtime de prueba;
3. los envíe por binary WebSocket con cola limitada;
4. los reciba en un cliente renderer de prueba;
5. mida bytes, drops y recuperación;
6. fuerce pérdida de frames;
7. solicite keyframe;
8. demuestre memoria estable.

No integrar todavía el AVD. Este spike valida el riesgo de transporte antes de tocar mucho código de emulador.

## 16. Segundo spike recomendado

Conectar `scrcpyVideoRegistry` al nuevo media source y mantener el renderer local.

Éxito:

- local sigue funcionando;
- el source no conoce Electron;
- el transport local es reemplazable;
- tests de cleanup y replay pasan.

## 17. Definición de terminado para Android Remote Server v1

- AVD descubierto e iniciado en Linux.
- Sesión aparece en el cliente Windows.
- H.264 visible en el panel nativo.
- Tap/swipe/type/buttons/rotate funcionales.
- install/launch/logcat funcionales.
- LAN y Tailscale probados.
- reconnect básico probado.
- panel oculto no sigue acumulando frames.
- no se exponen puertos extra.
- queues y payloads limitados.
- documentación y troubleshooting incluidos.
- regresión local validada en los tres sistemas.

## 18. Texto breve para iniciar la conversación en #6701

> I am interested in contributing an Android-focused slice of this issue. My use case is a Linux host running `orca serve` and an Android AVD, controlled from Orca Desktop on Windows. The Android backend, scrcpy H.264 source, renderer decoder, control RPCs, and remote binary transport patterns already exist; the missing piece appears to be that emulator video is currently delivered through local Electron IPC rather than the paired runtime transport.
>
> I would like to propose a transport-agnostic `DeviceSession` layer where local IPC and Remote Orca Server are transport implementations, so the existing local emulator path remains first-class. My suggested PR sequence is: (1) local no-behavior-change media-source/transport refactor, (2) bounded versioned binary device-stream protocol, (3) remote Android renderer client, and (4) reconnect/performance hardening.
>
> Before starting, is this aligned with the work already planned for this assigned issue? Would an Android Remote Orca Server slice be useful, and is there a preferred direction for reusing versus generalizing the terminal multiplex framing?

## 19. Referencias técnicas revisadas

Repositorio Orca:

- Issue `#6701`.
- `.github/CONTRIBUTING.md`.
- `src/main/emulator/backends/android-emulator-backend.ts`.
- `src/main/emulator/scrcpy-video-registry.ts`.
- `src/main/ipc/emulator-video-stream.ts`.
- `src/main/runtime/rpc/methods/emulator.ts`.
- `src/main/runtime/runtime-rpc.ts`.
- `src/shared/terminal-stream-protocol.ts`.
- `src/renderer/src/runtime/remote-runtime-terminal-multiplexer.ts`.

Proveedores:

- Genymotion SaaS/PaaS APIs y ADB.
- Sauce Labs Mobile App Testing y Live Testing.
- BrowserStack App Live.
- AWS Device Farm Remote Access.
- Firebase Test Lab.
