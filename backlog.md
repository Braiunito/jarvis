# Backlog · Jarvis

Estado: abierto · creado 2026-09-02

Este backlog es lo que viene **después** de terminar la migración técnica (M0–M5 + empaquetado y
evidencias, ver [`docs/migration/`](./docs/migration/)). El orden de arriba abajo es el orden de
ejecución previsto: **se arranca por UX-01**.

Convención: `[ ]` pendiente · `[-]` en curso · `[x]` hecho (con fecha, ficheros y comprobación).

---

## Bloque UX · repensar la consola (prioridad 1)

Encargo del 2026-09-02: repensar UI/UX, revisar qué librerías merece la pena incluir, mejorar los
textos, reordenar los accesos alrededor de flujos de trabajo reales, y asegurar que Assistant y
título automático existen.

### UX-01 · Vocabulario del producto, en español y sin jerga heredada

`safe` / `auto` / `yolo` son nombres de la CLI, no del producto. La etiqueta que ve una persona
tiene que decir qué puede hacer el agente, no cómo se llama la bandera por dentro.

| Interno (no cambia) | Lo que se muestra | Frase de ayuda |
|---|---|---|
| `safe` | **Sólo lectura** | Puede mirar y proponer. No cambia nada. |
| `auto` | **Puede editar** | Escribe ficheros en el destino, sin sandbox de red. |
| `yolo` | **Sin restricciones** | Ejecuta cualquier cosa en la máquina. Pide confirmación aparte. |

- El valor interno (`permissionProfile`) **no** se renombra: es contrato con las CLIs y con la
  auditoría, y renombrarlo rompería fixtures y el histórico.
- La traducción vive en un solo sitio del front, junto al resto de etiquetas.
- Repasar en la misma pasada: `run` → «trabajo» / «ejecución» donde sea texto corrido, `workspace`
  se queda (es el objeto del dominio), `stale` → «último dato conocido, de hace X», `failed` →
  «falló», `timed_out` → «se agotó el tiempo».
- Todo mensaje de error debe decir **qué pasó, dónde y qué hacer ahora**; el código técnico va en
  segundo plano, para copiar.

### UX-02 · Elegir librerías de interfaz (decisión con ADR)

Hoy el front es React + CSS propio, sin dependencias de UI. Funciona, pero hay piezas que no
merece la pena escribir a mano: menús accesibles, diálogos con foco atrapado, paleta de comandos,
listas largas virtualizadas y avisos.

Candidatas a evaluar, con el criterio de **no reintroducir una plataforma genérica** (fue la causa
de la migración) y de que cada una resuelva un problema concreto:

| Necesidad | Candidata | Por qué / riesgo |
|---|---|---|
| primitivas accesibles (menú, diálogo, tabs, tooltip) | Base UI o Radix Primitives | headless, sin estilos impuestos; riesgo: peso y otra API que aprender |
| sistema de estilos | Tailwind v4 (o seguir con CSS propio + tokens) | el equipo ya lo conoce; riesgo: clases largas en JSX y otra cadena de build |
| componentes ya compuestos | shadcn/ui | se copia el código al repo, no es dependencia; riesgo: arrastra Tailwind + Radix |
| paleta de comandos | cmdk | resuelve el quick switcher de UX-04 |
| listas largas | @tanstack/react-virtual | el explorador puede tener miles de sesiones |
| iconos | lucide-react | consistencia; sólo si se importa por icono, no el paquete entero |
| avisos | sonner, o un componente propio de 40 líneas | evaluar si compensa la dependencia |
| formularios | ninguna | los formularios de esta consola son de 2–3 campos |

Entregable: ADR-008 con la decisión, el presupuesto de bundle (hoy 155 KiB gzip; techo 400 KiB) y
la lista de lo que **no** se adopta y por qué.

### UX-03 · Assistant: que exista de verdad en la interfaz

El core ya tiene planes, pasos, aprobaciones y despertar durable (M4). Falta la parte que se ve:

- un modo «objetivo» en el composer, junto a «Direct», que crea un plan en vez de un run suelto;
- ver el plan como lista de pasos con su estado, no como un chat;
- una aprobación es una tarjeta con acción, destino, permiso y caducidad, con dos botones;
- la síntesis final enlaza a los runs y a la evidencia, sin copiar buffers enteros;
- notificación in-app cuando un plan pasa a `waiting_approval` o termina.

### UX-04 · Reordenar los accesos por flujo, no por entidad

Hoy la navegación es una lista de secciones (Inicio, Sesiones, Runs, Terminal, Salud). Los flujos
reales son otros:

1. **retomar** — buscar, previsualizar, abrir, continuar;
2. **delegar** — describir objetivo, confirmar alcance, observar;
3. **vigilar** — qué está corriendo, qué pide algo de mí;
4. **intervenir** — entrar a la terminal, parar, reintentar;
5. **diagnosticar** — qué salto está roto y cómo se copia.

Trabajo concreto:
- paleta de comandos (Ctrl/Cmd+K) que salte a workspace, host, run o acción sin usar el ratón;
- «continuar donde estaba» como primera acción de la portada;
- la terminal se abre desde el workspace con el host y la sesión ya elegidos, no como sección
  suelta donde hay que rellenar dos selectores;
- Run Center accesible desde cualquier pantalla con un indicador de cuántos piden atención;
- móvil: barra inferior con las cuatro acciones reales, no el menú de escritorio encogido.

### UX-05 · Título automático del workspace

Un workspace se llama hoy como el título que trae el índice, o como su id, que no dice nada.

- generar un título corto a partir del primer prompt y del primer resultado;
- hacerlo en el core con el modelo pequeño configurado (`JARVIS_TITLE_*`), nunca en el navegador;
- **un título escrito por una persona siempre gana** y no se vuelve a tocar (regresión conocida
  del stack viejo: el título automático pisaba el que el usuario había puesto);
- si no hay modelo configurado, se cae a las primeras palabras del prompt: sin modelo no se queda
  sin nombre.

### UX-06 · Estados vacíos, de carga y de error con oficio

- cada pantalla vacía explica qué hacer, no sólo que está vacía;
- los esqueletos de carga tienen la forma del contenido que viene;
- un error ofrece siempre la siguiente acción (reintentar, abrir salud, copiar diagnóstico);
- `aria-live` anuncia transiciones de estado, no cada token que llega.

### UX-07 · Repaso de accesibilidad y móvil

- foco visible y orden de tabulación en las cinco pantallas;
- objetivos táctiles de 44 px de verdad, comprobados en 390×844;
- contraste AA en ambos temas;
- la terminal móvil con teclas Esc/Tab/flechas/Ctrl+C ya está: falta probarla con teclado virtual
  abierto, que es cuando el layout se rompe.

---

## Bloque técnico · pendiente tras la migración

### TEC-01 · Transporte nativo de OpenCode
Hoy OpenCode va por `opencode run` como los demás. Su servidor HTTP/SSE daría sesiones vivas.

### TEC-02 · Recetas y runbooks tipados
Sólo cuando haya datos de qué se repite de verdad. No inventar un motor de workflows antes.

### TEC-03 · Compactación de eventos antiguos
La política está en ADR-007; falta el trabajo periódico que la aplica.

### TEC-04 · Migración del almacén de autenticación
`users.json` → SQLite y/o SimpleWebAuthn. Es una misión aparte con verificador dual y rollback
propio (ADR-006), no un ticket suelto.

### TEC-05 · Segunda opinión
Mandar el mismo objetivo a dos proveedores y comparar. Vuelve sólo como acción explícita.
