# Seguridad

Lo que este documento describe no son buenas intenciones: son las líneas que, si se cruzan,
convierten esta consola en un servicio de ejecución remota arbitraria.

## Lo que se protege

Una persona autenticada puede ejecutar agentes en máquinas reales, con permisos que van desde
«sólo mirar» hasta «cualquier cosa». Eso hace que el valor a proteger no sea un dato: es la
**capacidad de actuar**.

## Autenticación

- **No hay registro público.** Una cuenta existe porque alguien ejecutó `jarvis-users add` en la
  máquina. Ese paso por terminal es el ancla de confianza del sistema entero.
- **Passkey con verificación de usuario obligatoria** (`residentKey: required`,
  `userVerification: required`): huella, cara o PIN en cada entrada.
- **Enrolar exige un código de un solo uso** emitido por terminal, con caducidad, guardado sólo
  como hash.
- **La cadena de pasos es configurable** (`passkey`, `password+passkey`, `+totp`). Añadir un factor
  es añadir un paso, nunca reescribir el flujo.
- En cada aserción se comprueba **todo**: challenge de un solo uso, `origin`, hash del `rp.id`,
  flags UP y UV, y `signCount` —si retrocede, la credencial puede estar clonada—.
- El `user.id` es un **UUID opaco en bytes**. Nunca el nombre ni el correo: algunos autenticadores
  lo guardan para siempre.

## El límite de privilegio

| | gateway | core |
|---|---|---|
| expuesto a la red pública | sí, tras Caddy | no |
| clave SSH de la flota | **no** | sí, de sólo lectura |
| allowlist de hosts | no | sí |
| cookie de sesión | sí | **no la ve nunca** |
| puede ejecutar agentes | no | sí |

El gateway firma una identidad interna corta y la manda en `X-Jarvis-Identity`, con un secreto
distinto del de sesión. Sin esa firma, el core responde 401 aunque la petición venga de dentro de
la red de Docker.

## Ejecución remota

1. **Todo comando remoto se arma con `shellQuote`.** Ni un prompt, ni un path, ni un id de sesión
   se interpola crudo en una cadena de shell. Los tests lo comprueban pasando cada caso hostil por
   un `sh` de verdad y exigiendo los bytes originales de vuelta.
2. **Siempre hay allowlist de hosts.** Una lista vacía se rechaza, no se lee como «cualquier
   cosa»: sin ella, un nombre como `-oProxyCommand=…` lo lee `ssh` como opción y ejecuta código
   local.
3. **El perfil de permiso nunca se eleva solo.** `safe` es el punto de partida y `yolo` está
   apagado salvo que el operador lo encienda a propósito.
4. **El bastión es un host SSH más.** No hay una rama «local» que ejecute sin pasar por el mismo
   camino auditado.
5. **Los ids son opacos.** Un id de run acaba siendo un nombre de directorio y de sesión tmux; se
   valida contra un alfabeto cerrado antes de tocar nada.
6. **Sólo se destruyen sesiones tmux con el prefijo de Jarvis.** Lo demás no es nuestro.

## Adjuntos

El path lo genera Jarvis; el nombre que puso la persona es una etiqueta y nada más. Directorio
`0700`, fichero `0600`, escritura a `.part` y renombrado atómico, cuota reservada **antes** de
leer un byte del cuerpo, y un solo uso: reclamarlo dos veces es un conflicto, no un descuido.

## Aprobaciones

Una aprobación registra qué acción, sobre qué destino, con qué permiso y hasta cuándo. El digest
cubre todo eso: cambiar cualquier parte la invalida. Es de un solo uso —se consume en la misma
transacción que el efecto— y una caducada no ejecuta aunque llegue tarde un «sí».

## Qué no se registra nunca

Prompts completos, salida del agente, cookies, tokens, claves de API, material de passkey o TOTP,
contenido de adjuntos y paths privados que no hagan falta para diagnosticar. La auditoría guarda
**el destino y el permiso**, más el tamaño del prompt; nunca su texto. «Copiar diagnóstico» produce
versiones, estados por salto e identificadores, y nada más.

## La escotilla de HTTP plano — REVISAR EN CADA DESPLIEGUE

`JARVIS_INSECURE_LOGIN=true` permite entrar con usuario y contraseña sobre HTTP sin cifrar.

Existe porque **las passkeys son imposibles sin HTTPS**: fuera de un contexto seguro el navegador
no expone `navigator.credentials` en absoluto, así que una política `passkey` deja fuera a todo el
mundo en un despliegue que aún no tiene certificado.

Es temporal y está construida para que no se olvide encendida:

- apagada por defecto;
- restringida a redes privadas (`JARVIS_INSECURE_LOGIN_LAN_ONLY`, por defecto `true`); desde una IP
  pública devuelve 403 y lo audita;
- el gateway lo avisa en recuadro al arrancar;
- la pantalla de entrada muestra un aviso permanente y la barra superior lleva un distintivo;
- las entradas se auditan como `login.success.insecure`, distinguibles al revisar el registro.

Cuando haya TLS: `JARVIS_INSECURE_LOGIN=false`, enrolar passkeys y quitar las contraseñas con
`jarvis-users clear-password`.

La alternativa mientras tanto es un túnel, que es lo que convierte `localhost` en origen válido:

```bash
ssh -L 8080:127.0.0.1:8080 usuario@bastion   # y abrir http://localhost:8080 con JARVIS_RP_ID=localhost
```

## Lo que nunca se commitea

`.env` y variantes · `secrets/` · `users.json` · `session.key` · `internal.key` · ficheros `.pem`
o claves privadas pegadas dentro de cualquier fichero.

## Superficie que se dejó fuera a propósito

Del producto anterior no se trae: marketplace de mods, ejecución de JS/Python desde el contenido,
filesystem virtual en el navegador, sincronización de claves de proveedores ni un modo cliente-only.
No es nostalgia de funciones: cada una de ellas amplía lo que puede hacer alguien que consiga una
sesión.
