# Changelog

Todas las entradas describen **qué cambió para quien usa esto**, no qué ficheros se tocaron.

## [0.1.0] — en curso · migración desde LiteChat

### Añadido

- **Contratos congelados** (M0): 91 pruebas doradas que fijan lo que la migración promete
  conservar — entrecomillado SSH, allowlist de hosts, estrategias A/B, los tres adaptadores de CLI
  y el protocolo del spool remoto. Corren sin red, sin Docker y sin bastión.
- **Gateway** (M1): passkeys con el mismo formato de `users.json` v1 que el stack anterior, así que
  una credencial ya enrolada entra sin volver a registrarse. Cadena de pasos configurable,
  revocación de sesión en el servidor y la escotilla de HTTP plano, apagada por defecto y ruidosa
  cuando está encendida.
- **Core** (M2/M3): workspaces con identidad estable, borradores con compare-and-swap, y runs
  durables. Un run vive en una tmux del host con su spool, no en la conexión SSH del core: se
  puede reiniciar el core a mitad de una ejecución sin perderla ni duplicarla.
- **SSE reanudable**: `Last-Event-ID` reconstruye exactamente desde un `seq` conocido. Desconectar
  no toca el run.
- **Terminal viva** (M4): attach a tmux por WebSocket con TTY real, teclas de móvil y detach limpio
  al cerrar. Salir no mata la sesión.
- **Assistant durable** (M4): un objetivo se convierte en pasos que viven en SQLite. El modelo
  propone y el core ejecuta, así que un plan sobrevive a un reinicio. Las aprobaciones son de un
  solo uso, caducan y su digest las ata a la acción concreta que se autorizó.
- **Importación desde LiteChat** (M5): idempotente por instalación y conversación, con procedencia
  visible. Un export que traiga claves de proveedor se rechaza entero en vez de limpiarse por
  detrás.
- **Backup y restore** verificados: `VACUUM INTO` para la base, checksums en el manifiesto e
  `integrity_check` al restaurar.
- **Consola** (web): React sin stores globales. El destino y el permiso se ven antes de enviar, el
  borrador sobrevive a navegar y a fallar, y lo que escribió el agente remoto nunca se confunde con
  lo que hizo Jarvis.

### Corregido durante la migración

Fallos reales encontrados al probar contra tmux y procesos de verdad, no al leer el código:

- una línea de salida más grande que el trozo de lectura dejaba el run **bloqueado para siempre**;
  ahora la lectura crece hasta un tope y, si se supera, se anota y se sigue;
- una cancelación no se confirmaba nunca si al wrapper lo mataban antes de publicar su estado;
  ahora una tmux ausente cuenta como «parado», que es lo que de verdad significa;
- cerrar el socket de la terminal se llevaba por delante la sesión tmux; ahora se pide un detach
  limpio antes de soltar el ssh;
- el gateway consumía el cuerpo de las peticiones antes de reenviarlas y el core se quedaba
  esperando bytes que nadie iba a mandar;
- un fallo anterior al primer evento (un `cwd` que no existe, un binario que falta) se reportaba
  como «salió con código 2»; ahora el core adjunta la cola de `stderr` y dice qué pasó.

### Decidido

Siete ADR: límite de privilegio entre gateway y core, SQLite en un nodo con umbrales medidos para
PostgreSQL, runner remoto con tmux y spool, un transporte por necesidad, identidad de sesión y
workspace, compatibilidad de passkeys sin re-enrolamiento, y política de retención y redacción.

### Aplazado a propósito

Marketplace de mods, ejecución de JS/Python desde el contenido, filesystem virtual en el
navegador, proveedores de chat genéricos y modo cliente-only. No vuelven por nostalgia: cada uno
tendría que declarar entidad, destino, permiso, estados de fallo y comportamiento móvil.
