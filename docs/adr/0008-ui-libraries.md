# ADR-008 · Qué librerías de interfaz entran, y cuáles no

Fecha: 2026-09-02 · Estado: aceptado

## Contexto

La consola es hoy React con CSS propio y cero dependencias de interfaz. Eso no fue pereza: la
migración desde LiteChat se hizo precisamente para salir de una plataforma genérica de módulos,
stores y extensiones que costaba más que lo que resolvía. Meter un framework de componentes por
inercia sería repetir el error con otro nombre.

Pero hay piezas que escribir a mano sale caro y sale mal: un menú accesible con foco atrapado y
navegación por teclado, una paleta de comandos, listas de miles de sesiones que no maten el
navegador. Ahí una dependencia buena vale su peso.

El presupuesto es el del ADR-007: **400 KiB gzip**. Hoy vamos por 156.

## Estado del terreno (comprobado el 2026-09-02)

| Paquete | Versión | Última publicación |
|---|---|---|
| `@radix-ui/react-dialog` | 1.1.23 | 2026-07-31 |
| `@base-ui-components/react` | 1.0.0-rc.0 | 2026-07-15 |
| `cmdk` | 1.1.1 | 2025-08-27 |
| `@tanstack/react-virtual` | 3.14.10 | 2026-08-18 |
| `lucide-react` | 1.39.0 | 2026-09-01 |
| `sonner` | 2.0.8 | 2026-08-09 |
| `tailwindcss` | 4.3.3 | 2026-08-31 |

Base UI viene de gente que hizo Radix y Floating UI, y `shadcn/ui` lo usa por defecto en proyectos
nuevos desde julio de 2026. Radix sigue mantenido tras la compra por WorkOS, con menos ritmo.

## Decisión

Entran, y sólo cuando llegue el ticket que las necesita:

| Necesidad | Elección | Por qué ésa |
|---|---|---|
| primitivas accesibles (diálogo, menú, popover, tabs) | **Radix Primitives**, por componente | estable, publicado hace semanas, y se instala uno a uno: `react-dialog` son ~15 KiB, no un framework |
| paleta de comandos (UX-04) | **cmdk** | resuelve filtrado, teclado y accesibilidad de una lista de comandos; escribirlo bien cuesta más que 6 KiB |
| listas largas (explorador de sesiones) | **@tanstack/react-virtual** | mismo autor que la capa de datos que ya usamos, sin estilos impuestos |
| iconos | **lucide-react**, importados uno a uno | ISC, 6.144 iconos publicados y el bundler sólo se lleva los que se usan |

No entran:

- **Base UI**: mejor apuesta a futuro, pero su 1.0 sigue publicándose como `rc` en npm. Esta
  consola gobierna máquinas; el sitio para estrenar no es su capa de diálogos. Se revisa cuando el
  paquete publique estable.
- **Tailwind**: el CSS actual son 9 KiB con tokens, tema claro y oscuro, y objetivos táctiles. Su
  problema no es el que Tailwind resuelve, y traería otra cadena de build.
- **shadcn/ui**: arrastra Tailwind y Radix a la vez, y su valor —copiar componentes al repo— es
  justo lo que ya tenemos.
- **sonner**: los avisos que necesitamos son tres estados en una esquina. Componente propio.
- **Librerías de formularios**: los formularios de esto tienen dos o tres campos.
- **Cualquier «mega framework» de componentes**: fue la causa de la migración.

## Reglas

1. Una dependencia entra **con el ticket que la usa**, no «para prepararnos».
2. Se importa por componente, nunca el paquete entero.
3. Cada alta anota en el PR cuánto sube el bundle. Si al acabar el bloque UX pasamos de 400 KiB
   gzip, algo se queda fuera.
4. Lo que se adopte no dicta el aspecto: los tokens, el tema y los tamaños táctiles siguen siendo
   nuestros. Las primitivas ponen el comportamiento accesible, no el diseño.

## Altas efectuadas

| Fecha | Paquete | Versión | Coste en bundle | Ticket |
|---|---|---|---|---|
| 2026-09-02 | `cmdk` | 1.1.1 | 156 → 176 KiB gzip | UX-04, paleta de comandos |
| 2026-09-02 | `lucide-react` | 1.39.0 | 176 → 180 KiB gzip (≈40 iconos) | iconografía |
| 2026-09-02 | `@radix-ui/react-dialog` | 1.1.23 | 191 → 194 KiB gzip (con el visor) | UX-08, detalle de un evento |
| 2026-09-02 | `react-json-view-lite` | 2.5.0 | incluido en la línea anterior | UX-08, JSON plegable |

El coste de los iconos es de 4 KiB para cuarenta siluetas porque se importan por nombre y el
paquete es ESM: sólo viaja lo que se usa. Importar `import * as icons` costaría el paquete entero,
así que no se hace.

**Por qué esas dos y no las de siempre.** Para el modal se descartó SweetAlert2: pesa unas diez
veces más, es imperativo —se llama, no se declara— y trae su propia paleta, que habría que pelear
token a token. Radix Dialog ya estaba aprobado por componente en esta misma decisión, pesa poco y
trae lo que cuesta hacer bien a mano: foco atrapado, `Escape`, `aria-modal` y devolver el foco al
salir.

Para el JSON se miraron `react-json-view` (sin mantenimiento, pide React 17), su fork de Microlink
(mismo problema con menos ojos encima) y `@textea/json-viewer` (arrastra emotion). Se eligió
`react-json-view-lite`: MIT, 7 KiB, compatible con React 19 y —lo que decidió— permite pasarle las
clases del producto, así que el árbol viste con nuestros tokens en vez de traer su tema. No se
importa su `index.css`.

Dónde se usan y por qué ahí, en `apps/web/src/ui/icons.tsx`: la regla es que un icono acompaña al
texto y nunca lo sustituye, salvo en la barra estrecha del móvil, donde el botón lleva su etiqueta
accesible. Los estados —de trabajo, de plan, de salud— llevan icono **además** de color, para que
distinguir «terminado» de «falló» no dependa de ver bien el verde y el rojo.

## Consecuencias

Se gana comportamiento accesible probado en las cuatro o cinco piezas donde hacerlo a mano sale
mal, y se sigue sin poder «configurar la aplicación» desde una librería. El coste es revisar
`@base-ui-components/react` cuando publique estable, y aceptar que hasta entonces convivimos con
la opción menos moderna y más asentada.

## Fuentes

- [Radix vs Base UI, ShadcnDeck](https://www.shadcndeck.com/blog/radix-vs-base-ui)
- [Top headless UI libraries for React in 2026, GreatFrontEnd](https://www.greatfrontend.com/blog/top-headless-ui-libraries-for-react-in-2026)
- [Headless UI alternatives, LogRocket](https://blog.logrocket.com/headless-ui-alternatives/)
- Versiones y fechas: `npm view <paquete> version time.modified`, 2026-09-02.
