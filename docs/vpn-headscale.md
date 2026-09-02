# VPN propia: Headscale en Vultr, clientes en zeus y en el móvil

Zeus está en una LAN cerrada y no tiene IP pública. Esta VPN existe para llegar a él desde
fuera —desde el móvil, sobre todo— sin abrir un puerto en el router de casa y sin depender de la
infraestructura de Tailscale Inc.

**Headscale** es la implementación libre del plano de control de Tailscale. Corre en el servidor
público (Vultr) y es quien reparte identidades y claves; el tráfico real entre nodos va cifrado
extremo a extremo por WireGuard y, siempre que el NAT lo permita, **no pasa por el servidor**.
Comprobado: zeus y Vultr se hablan en `direct`, sin relay.

## Estado

| Nodo | IP | Qué es |
|------|-----|--------|
| `vultr` | `100.64.0.1` | el propio servidor de control, también nodo |
| `s26-ultra-de-braian-1` | `100.64.0.3` | el móvil |
| `zeus` | `100.64.0.4` | el bastión, además **subnet router** de `192.168.1.0/24` |

Con zeus anunciando la LAN y esa ruta aprobada, desde el móvil se llega **tanto a zeus** (por
`100.64.0.4` o, con MagicDNS, `zeus.jarvis.internal`) **como al resto de la red de casa** por sus
IPs `192.168.1.x` de siempre.

| Pieza | Dónde |
|-------|-------|
| `headscale` v0.29.3 | Vultr (`64.176.6.157`), escucha en `127.0.0.1:8080` |
| nginx `vpn.bevrim.com` | Vultr, termina TLS y reenvía |
| `tailscale` 1.102.3 (paquete) | Vultr |
| `tailscale` (contenedor `tailscaled`) | zeus |
| app Tailscale | móvil |

El dominio es `vpn.bevrim.com`. Se eligió porque `bevrim.com` ya tenía **DNS wildcard** hacia
Vultr, así que no hizo falta tocar la zona: el subdominio resolvía solo. El certificado es de
Let's Encrypt vía el certbot que ya estaba en la máquina, y renueva con los demás.

## Cómo quedó configurado el servidor

`/etc/headscale/config.yaml` (la copia intacta del paquete está en `config.yaml.orig`):

| Clave | Valor | Por qué |
|-------|-------|---------|
| `server_url` | `https://vpn.bevrim.com` | es la URL que va en el certificado y la que teclea el cliente |
| `listen_addr` | `127.0.0.1:8080` | headscale nunca se expone directo; solo nginx habla con él |
| `trusted_proxies` | `127.0.0.1/32` | sin esto headscale registra la IP de nginx como la del cliente |
| `dns.base_domain` | `jarvis.internal` | MagicDNS. **Debe** diferir del dominio de `server_url`; `.internal` está reservado por ICANN para uso privado, así que no puede colisionar con un dominio real |
| `derp.server.enabled` | `false` | se usan los relays públicos de Tailscale (ver nota abajo) |

En nginx, `/etc/nginx/sites-available/vpn.bevrim.com.conf`. Dos detalles que no son opcionales:
las cabeceras `Upgrade`/`Connection` (el protocolo `ts2021` sube la conexión a websocket, y sin
ellas el cliente se cuelga al registrarse) y `proxy_read_timeout 3600s` con `proxy_buffering off`
(el plano de control mantiene long-polls abiertos; con los timeouts por defecto los nodos se caen
y reconectan cada minuto).

### Sobre los relays DERP

Un DERP solo entra en juego cuando dos nodos no consiguen hablarse directo. Está en los públicos
de Tailscale por dos razones: el VPS tiene 1 CPU y ~800 MB libres, y el relay embebido pediría
abrir puertos y gastar ancho de banda del mismo servidor que sirve los 17 sitios. **No compromete
la privacidad**: el relay reenvía paquetes ya cifrados extremo a extremo y no puede leerlos. En la
práctica apenas se usa: el `netcheck` da NAT abierto y las conexiones salen directas.

Si aun así se prefiere no depender de nada de Tailscale Inc., se activa con
`derp.server.enabled: true`, un `region_id` propio y UDP 3478 abierto.

## Usuarios

Un usuario de headscale es un espacio de nombres: agrupa nodos y es a quien la política concede
permisos.

> **Cuidado: sin política, headscale permite todo entre todos.** No hay ningún aislamiento
> implícito por usuario — dar de alta a alguien le abre la red entera. Se comprobó enrolando un
> nodo de `ana`: veía los cuatro nodos, alcanzaba zeus y leía su Netdata, que no pide
> autenticación. Por eso hay una política; está más abajo.

```bash
# en Vultr, como root
headscale users create ana          # alta
headscale users list                # ver IDs; el ID es lo que piden los demás comandos
headscale users rename ana anabel
headscale users destroy ana         # baja (borra también sus nodos)
```

Dados de alta hasta ahora: `braian` (ID 1) y `ana` (ID 2).

### Meter un dispositivo de ese usuario

Dos caminos. **Con clave de enrolado**, cuando se puede pasar por línea de comandos:

```bash
# en Vultr: generar la clave (--expiration corta, y sin --reusable si es un solo aparato)
headscale preauthkeys create --user 2 --expiration 1h
```

```bash
# en el aparato
tailscale up --login-server https://vpn.bevrim.com --authkey <la-clave>
```

**Desde una app que no acepta clave** (el móvil es el caso): la app muestra una pantalla de
*Node registration* con un identificador `hskey-authreq-…`. Ese identificador **no es la clave de
enrolado**: es el número de la petición, y caduca en minutos. Se aprueba desde Vultr:

```bash
headscale auth register --auth-id hskey-authreq-XXXX --user ana
```

> El `--user USERNAME` que aparece en esa pantalla es un **hueco a rellenar**, no un valor. Hay que
> poner el nombre real, en minúsculas, tal y como sale en `headscale users list`. Con cualquier
> otra cosa responde `user not found` — que es el mensaje correcto, pero no lo parece.

Y ojo: cada vez que se refresca esa pantalla se genera un `auth-id` nuevo. Si se aprueban dos, se
acaba con **dos nodos** para el mismo aparato; el sobrante se borra con `headscale nodes delete -i <ID>`.

## Los clientes

### zeus

Va como **contenedor**, no como paquete del sistema, por una razón concreta: el usuario `zeus`
tiene Docker pero su `sudo` pide contraseña, así que `apt install` no era una opción. Encaja
además con cómo está montada esa máquina, donde todo el stack ya es Docker.

Y va **dentro del compose**, en `docker-compose.vpn.yml`, no lanzado a mano. La diferencia importa:
`restart: unless-stopped` revive un contenedor que se cayó o que estaba corriendo al apagar la
máquina, pero **no puede recrear uno que ya no existe**. Eso sólo lo hace `docker compose up -d`,
que es lo que ejecuta el unit de systemd al arrancar. Lanzada a mano, la VPN habría sobrevivido a
todos los reinicios hasta el día de un `prune`, y entonces habría fallado en silencio.

En el `.env`:

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.lan.yml:docker-compose.vpn.yml

JARVIS_VPN_LOGIN_SERVER=https://vpn.bevrim.com
JARVIS_VPN_HOSTNAME=zeus
JARVIS_VPN_ROUTES=192.168.1.0/24
# JARVIS_VPN_AUTHKEY sólo hace falta la primera vez; después el volumen guarda la identidad
```

```bash
docker compose up -d tailscale
docker exec tailscaled tailscale status
```

El volumen `tailscale-state` se declara **external** a propósito: guarda la identidad del nodo, así
que recrear el servicio la reutiliza en vez de enrolar un nodo duplicado. Si alguna vez hay que
crearlo de cero: `docker volume create tailscale-state`.

- **`TS_ACCEPT_DNS=false` no se quita.** La configuración del servidor tiene
  `override_local_dns: true`, así que sin eso tailscaled reescribe el `resolv.conf` del bastión y
  deja a Docker y al stack de Jarvis sin resolución.
- **`TS_ROUTES`** es lo que convierte a zeus en la puerta a toda la LAN.

El estado vive en el volumen `tailscale-state`, así que el contenedor se puede recrear sin volver
a registrar el nodo.

### Hacer visible `192.168.1.100` (y el resto de la LAN)

Que zeus **anuncie** la ruta no basta: hacen falta tres cosas, y las tres se comprobaron.

**1. Reenvío de paquetes en zeus.** Un subnet router reenvía tráfico que no va dirigido a él, y el
kernel lo descarta si esto está a cero. En zeus ya estaba a `1`, así que no hubo que tocarlo:

```bash
cat /proc/sys/net/ipv4/ip_forward      # tiene que decir 1
# si dijera 0:  echo 'net.ipv4.ip_forward=1' | sudo tee /etc/sysctl.d/99-tailscale.conf && sudo sysctl -p
```

**2. Aprobar la ruta en el servidor.** Headscale **no** acepta sola una ruta anunciada, y hace bien:
un nodo comprometido podría reclamar rutas ajenas. Hay que decirlo a mano:

```bash
headscale nodes list-routes
#  ID | Hostname | Approved | Available      | Serving (Primary)
#  4  | zeus     |          | 192.168.1.0/24 |                     <- anunciada, sin aprobar

headscale nodes approve-routes -i 4 -r 192.168.1.0/24

headscale nodes list-routes
#  4  | zeus     | 192.168.1.0/24 | 192.168.1.0/24 | 192.168.1.0/24 <- ya la sirve
```

Las tres columnas tienen que estar rellenas. `Available` es lo que el nodo ofrece, `Approved` lo
que el administrador consintió, y `Serving` lo que de verdad se está anunciando al resto.

**3. Que el cliente acepte rutas.** Cada nodo decide si quiere usarlas; por defecto **no**:

- **móvil (Android)**: ajustes de la app → *Use Tailscale subnets*
- **Linux**: `tailscale set --accept-routes`

Comprobación de que el camino existe, hecha desde Vultr, que no tiene nada que ver con esa LAN:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.1.100:8080/   # 401: el gateway, vivo
```

> **El subnet router hace SNAT.** El tráfico que entra por esa ruta sale de zeus con **su** IP de
> LAN, no con la `100.64.0.x` de origen. Para la máquina de destino la conexión parece venir de
> `192.168.1.100`, lo cual es cómodo (no hay que añadir rutas de vuelta en los demás equipos) pero
> conviene saberlo: **cualquier control de acceso por IP de origen no distingue a un cliente de la
> VPN de la propia zeus**. Se desactiva con `--snat-subnet-routes=false`, a cambio de tener que
> enseñar a los demás equipos de la LAN cómo volver a `100.64.0.0/10`.

### El móvil

App **Tailscale** (Play Store / App Store) y, **antes de iniciar sesión**, apuntarla al servidor
propio:

- **Android**: en la pantalla de login, menú `⋮` → *Use an alternate server* → `https://vpn.bevrim.com`
- **iOS**: Ajustes del sistema → Tailscale → *Alternate Coordination Server* → la misma URL

Luego aparece la pantalla de *Node registration*, que se aprueba como se explica arriba.

## Política de acceso

En `/etc/headscale/acl.hujson`, referenciada desde `policy.path` del `config.yaml`. Sin ella,
cualquier nodo de la VPN alcanza cualquier otro.

La idea es al revés de lo habitual: **el bastión es un servicio compartido y todo el mundo en la
VPN debe alcanzarlo**. Lo que se acota es el resto.

| Origen | Puede llegar a |
|--------|----------------|
| cualquiera | **zeus**, entero |
| `braian@` | sus propios dispositivos, y **toda la LAN** `192.168.1.0/24` |
| `ana@` | sus propios dispositivos |

Así, un invitado en la VPN llega al bastión pero no a la impresora, al router ni al móvil de otro.

```bash
headscale policy check --file /etc/headscale/acl.hujson   # validar ANTES de recargar
headscale policy get                                       # ver la activa
systemctl restart headscale
```

Comprobado con un nodo de prueba de `ana`: llegaba a zeus, y el router de casa daba 100 % de
pérdida. **Los filtros se aplican en el nodo de destino**, así que un cambio tarda en notarse lo
que tarde cada nodo en recoger el mapa nuevo — un aparato que estaba pasando puede seguir pasando
un rato. No es que la regla no se haya aplicado.

> `zeus` se referencia en la política **por su IP** `100.64.0.4/32`. Es estable mientras el nodo
> exista; si alguna vez hay que re-registrarlo, esa línea es lo que hay que actualizar.

## Operación

```bash
# en Vultr, como root
headscale nodes list                 # quién está dentro y si está online
headscale nodes delete -i <ID>       # dar de baja un aparato
headscale nodes list-routes
headscale preauthkeys list           # claves de enrolado; `-o json` trae el id
headscale preauthkeys expire -i <ID> # revocar una (por id, no por el valor de la clave)
journalctl -u headscale -f
```

```bash
# en zeus
docker exec tailscaled tailscale status
docker logs --tail 50 tailscaled
```

Una clave de enrolado reutilizable es una credencial: quien la tenga puede meter un nodo en la red.
Conviene expirarla en cuanto los aparatos previstos estén dentro — **los nodos ya registrados no se
ven afectados**.

### Qué sobrevive a un reinicio, comprobado

No por lectura del `is-enabled`, sino reiniciando de verdad cada pieza y mirando que la red volvía:

| Pieza | Mecanismo | Probado |
|-------|-----------|---------|
| `headscale` (Vultr) | unit systemd `enabled` | reiniciado; nodos intactos, `/health` 200 |
| `tailscaled` (Vultr) | unit systemd `enabled` | reiniciado; vuelve como `100.64.0.1` |
| `nginx`, `docker` (Vultr) | `enabled` | — |
| `tailscaled` (zeus) | compose + `restart: unless-stopped` + unit `jarvis` | reiniciado **y borrado**; compose lo recreó conservando `100.64.0.4` y su ruta |
| certificado | tarea de certbot | `certbot renew --dry-run` en verde |

Lo que **no** se probó es un apagón real de las máquinas; lo verificado es la capa que lo cubre
(los servicios marcados `enabled`, y Docker también).

Que un nodo vuelva sin la clave de enrolado no es casualidad: la identidad vive en disco
(`/var/lib/headscale/` en el servidor, el volumen `tailscale-state` en zeus). Por eso la clave se
puede —y se debe— revocar en cuanto los aparatos están dentro.

### Qué expone el servidor a internet, comprobado desde fuera

| Ruta | Respuesta | Qué significa |
|------|-----------|---------------|
| `/api/v1/*` | **401** | la API de administración pide su propia clave |
| `/metrics`, `/debug/*` | **404** | sólo escuchan en `127.0.0.1:9090`; nginx no los publica |
| `/register/<auth-id>` | 200 (HTML) | **no registra nada** |
| `/health`, `/key`, `/windows`, `/apple` | 200 | informativos, los necesita el cliente |

Sobre `/register/`: es una plantilla **estática** que se limita a reimprimir el identificador que
lleva la URL, diciendo qué comando ejecutar en el servidor. Por eso responde 200 hasta con un
`auth-id` inventado. Escribir esa dirección en el navegador no da acceso a nadie: el alta la hace
`headscale auth register` en el servidor, o una clave de enrolado válida.

Lo que sí es una llave de verdad es una **clave de enrolado**: quien la tenga mete un nodo en la
red. Por eso se generan con caducidad corta y se expiran en cuanto el aparato está dentro.

**Copia de seguridad.** Todo el estado vive en `/var/lib/headscale/` (la base SQLite `db.sqlite`,
las claves privadas `noise_private.key` y la política `acl.hujson`). Perderlo obliga a re-registrar
todos los nodos:

```bash
systemctl stop headscale && tar czf ~/headscale-$(date +%F).tgz /var/lib/headscale /etc/headscale && systemctl start headscale
```

## Cómo deshacerlo

Es todo aditivo; nada de lo que había se modificó salvo el alta del vhost nuevo:

```bash
# en zeus
docker rm -f tailscaled && docker volume rm tailscale-state

# en Vultr
tailscale down && apt-get remove --purge tailscale
systemctl disable --now headscale && apt-get remove --purge headscale
rm -f /etc/nginx/sites-enabled/vpn.bevrim.com.conf && nginx -t && systemctl reload nginx
certbot delete --cert-name vpn.bevrim.com
rm -rf /var/lib/headscale
```

## `JARVIS_INSECURE_LOGIN_LAN_ONLY` no está protegiendo nada

Encontrado al comprobar por qué el móvil **sí** podía entrar cuando yo esperaba que no. En el
registro de auditoría los logins salen así:

```json
{"event":"login.success.insecure","username":"ana","ip":"172.20.0.1","steps":["password"]}
```

`172.20.0.1` no es de nadie: es la puerta de la red bridge de Docker. En el despliegue LAN no hay
Caddy delante — el gateway publica el puerto él mismo (`0.0.0.0:8080->8080/tcp`) — y el
`docker-proxy` reescribe el origen de toda conexión entrante. El gateway ve **siempre** esa misma
IP, venga de la LAN, de la VPN o de internet.

Consecuencias, todas silenciosas:

- **`insecureLoginLanOnly` es un no-op.** `isPrivateAddress('172.20.0.1')` es cierto siempre, así
  que la puerta de contraseña sobre HTTP está abierta a cualquiera que alcance el puerto 8080. La
  variable dice que está restringida a redes privadas; el arranque también lo dice. Ninguno miente
  a propósito, pero el efecto es una protección que no existe.
- **El rate limit de login mete a todo el mundo en un cubo.** Todos los intentos comparten clave,
  así que unos pocos fallos ajenos bloquean el login a todos los demás.
- **La auditoría no permite rastrear nada:** todas las entradas registran la misma IP.

El código del gateway está bien escrito: usa `clientIp(req, config.trustProxy)`, que sí sabe leer
`X-Forwarded-For`. Lo que falta es la topología: `JARVIS_TRUST_PROXY` está en `false` y **no hay
proxy que ponga esa cabecera**. Activarlo sin más sería peor, porque entonces cualquier cliente
podría inventarse su propia IP de origen.

Arreglos posibles, de menos a más invasivo:

1. **Poner Caddy delante también en LAN** (es el diseño original) y `JARVIS_TRUST_PROXY=true`. Es
   la única opción en la que la cabecera la escribe alguien de confianza.
2. **`"userland-proxy": false`** en `/etc/docker/daemon.json`: Docker pasa a usar DNAT puro y el
   contenedor ve la IP real. Reinicia el demonio, o sea todos los contenedores.
3. **`network_mode: host`** para el gateway: ve la IP real, a cambio de dejar de estar aislado.

Y hay un detalle que hay que resolver **junto** con cualquiera de los tres: los clientes de la VPN
llegan con IPs `100.64.0.0/10`, que es el rango CGNAT del RFC 6598, y `isPrivateAddress()` no lo
contempla (`config.js:174`). En cuanto el gateway empiece a ver la IP de verdad, **el móvil dejará
de poder entrar** salvo que ese rango se añada a la lista. Merece su propia variable en vez de
ensancharse `isPrivateAddress`, que además gobierna la confianza en los proxies.

No lo toqué porque son tres caminos con consecuencias distintas y es una decisión de despliegue,
no un descuido que se arregle solo.

## Cosas que encontré de paso, y no toqué

Ninguna la causó este trabajo, y todas son decisiones tuyas:

- **Webmin (`miniserv.pl`) escucha en `0.0.0.0:10000`** de Vultr, abierto a internet, y el
  cortafuegos está desactivado (`ufw inactive`, iptables en `ACCEPT`). Es un panel de
  administración con acceso root expuesto al mundo. Ahora que hay VPN, lo natural es dejarlo
  escuchando solo en `100.64.0.1`.
- **Ubuntu 23.10 (mantic) está fuera de soporte** desde julio de 2024: no recibe parches de
  seguridad. En un servidor público con 17 sitios, es lo más urgente de la lista.
- **El disco de Vultr está al 84 %** (7,1 GB libres de 47 GB).
- **`work-api.online` devuelve HTTP 500**, y ya lo hacía antes de que yo entrara. Lo comprobé
  justo antes de instalar nada, precisamente para poder afirmarlo.
