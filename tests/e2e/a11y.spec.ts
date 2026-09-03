/**
 * Accesibilidad y móvil, comprobados en la aplicación de verdad.
 *
 * No es una auditoría completa —eso no lo da ninguna herramienta— pero sí cubre lo que se rompe
 * solo al editar pantallas: contraste por debajo de AA, un botón sin nombre, un icono suelto sin
 * texto, una región mal etiquetada. Corre contra el mismo stack que los flujos, así que mide la
 * página real y no un render de prueba.
 *
 * Lo que axe no puede ver va en los tests de abajo: que el foco se vea, que el orden de
 * tabulación empiece por el atajo al contenido, y que en un dedo los objetivos midan 44 px.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-password-de-pruebas';

const nav = (page: Page, name: string | RegExp) =>
  page.locator('.rail').getByRole('link', { name });

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Usuario').fill('braian');
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(nav(page, 'Sesiones')).toBeVisible();
}

/**
 * Un fallo se cuenta con el sitio donde está.
 *
 * «color-contrast» a secas no se arregla: hay que saber qué elemento y con qué colores, y eso lo
 * trae axe en el nodo. Sin esto, cada fallo cuesta una sesión de depuración.
 */
export function describeViolations(
  violations: Array<{ id: string; nodes: Array<{ target: unknown[]; failureSummary?: string }> }>,
): string[] {
  return violations.flatMap((violation) => violation.nodes.map((node) => [
    violation.id,
    node.target.join(' '),
    (node.failureSummary ?? '').split('\n').slice(1).join(' ').slice(0, 220),
  ].filter(Boolean).join(' · ')));
}

/** Las reglas que se exigen: WCAG 2.1 A y AA, que es el nivel al que se comprometió el producto. */
const analyze = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    // El lienzo de xterm es un widget de terceros con su propio árbol accesible; auditarlo aquí
    // sólo produce ruido que no podemos arreglar desde este lado.
    .exclude('.terminal-host')
    .analyze();

test('la pantalla de entrada no tiene fallos de accesibilidad', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Usuario')).toBeVisible();
  const results = await analyze(page);
  expect(describeViolations(results.violations)).toEqual([]);
});

for (const screen of [
  { name: 'Inicio', go: (page: Page) => nav(page, 'Inicio').click() },
  { name: 'Sesiones', go: (page: Page) => nav(page, 'Sesiones').click() },
  { name: 'Trabajo', go: (page: Page) => nav(page, /^Trabajo/).click() },
  { name: 'Terminal', go: (page: Page) => nav(page, 'Terminal').click() },
  { name: 'Salud', go: (page: Page) => nav(page, /^Salud/).click() },
]) {
  test(`${screen.name} no tiene fallos de accesibilidad`, async ({ page }) => {
    await login(page);
    await screen.go(page);
    await page.waitForTimeout(1200);
    const results = await analyze(page);
    expect(describeViolations(results.violations)).toEqual([]);
  });
}

test('el workspace no tiene fallos de accesibilidad, con las cuatro pestañas', async ({ page }) => {
  await login(page);
  await nav(page, 'Sesiones').click();
  await page.getByRole('row', { name: /timeout del pool/i }).click();
  await page.getByRole('button', { name: /^(Abrir|Ir al) workspace$/ }).click();
  await expect(page).toHaveURL(/\/w\//);

  for (const tab of ['Actividad', 'Conversación', 'Archivos y contexto', 'Configuración']) {
    await page.getByRole('tab', { name: new RegExp(tab) }).click();
    await page.waitForTimeout(500);
    const results = await analyze(page);
    expect(describeViolations(results.violations).map((line) => `${tab} · ${line}`)).toEqual([]);
  }
});

test('el primer tabulador lleva al contenido, y el foco se ve', async ({ page }) => {
  await login(page);

  // El atajo es el primer elemento del orden: con cinco destinos delante, llegar al contenido
  // costaba una docena de saltos en cada pantalla.
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Saltar al contenido' });
  await expect(skip).toBeFocused();

  const outline = await skip.evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: style.outlineWidth, style: style.outlineStyle, transform: style.transform };
  });
  expect(outline.style).not.toBe('none');
  expect(parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
  // Y al enfocarse deja de estar escondido fuera de la pantalla.
  expect(outline.transform === 'none' || outline.transform === 'matrix(1, 0, 0, 1, 0, 0)').toBe(true);

  await skip.press('Enter');
  await expect(page.locator('main#contenido')).toBeFocused();
});

/**
 * El foco se recorre con el tabulador, no llamando a `focus()`.
 *
 * `:focus-visible` depende de **cómo** llegaste al elemento: enfocarlo desde JavaScript no cuenta
 * como interacción de teclado y el navegador no pinta el anillo. Un test que use `element.focus()`
 * mide otra cosa y falla siempre; este recorre la portada como lo haría una persona sin ratón.
 */
test('recorrer la portada con el tabulador enseña siempre dónde estás', async ({ page }) => {
  await login(page);
  await nav(page, 'Inicio').click();
  await page.waitForTimeout(600);
  await page.locator('main#contenido').click();

  const sinAnillo: string[] = [];
  const recorrido: string[] = [];

  for (let step = 0; step < 28; step += 1) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body) return null;
      const style = getComputedStyle(element);
      return {
        label: (element.getAttribute('aria-label') || element.textContent || element.tagName)
          .trim().slice(0, 40),
        ring: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2,
        shadow: style.boxShadow !== 'none',
      };
    });
    if (!focused) break;
    recorrido.push(focused.label);
    if (!focused.ring && !focused.shadow) sinAnillo.push(focused.label);
  }

  expect(recorrido.length).toBeGreaterThan(8);
  expect(sinAnillo).toEqual([]);
});

test('en un dedo, los objetivos táctiles miden 44 px', async ({ page, isMobile }, testInfo) => {
  test.skip(testInfo.project.name !== 'movil', 'sólo aplica al proyecto con pantalla de teléfono');
  void isMobile;
  await login(page);

  for (const screen of ['Inicio', 'Sesiones', 'Terminal'] as const) {
    await nav(page, screen).click();
    await page.waitForTimeout(800);

    const small = await page.evaluate(() => {
      const targets = [...document.querySelectorAll<HTMLElement>(
        '.rail a, .btn, .tabs button, .topbar-search, .select, .input',
      )].filter((element) => element.offsetParent !== null);
      return targets
        .map((element) => ({
          label: element.textContent?.trim().slice(0, 30) || element.className,
          height: Math.round(element.getBoundingClientRect().height),
        }))
        // Medio píxel de holgura: los bordes redondeados y el subpíxel dan 43.98.
        .filter((target) => target.height < 43.5);
    });
    expect(small, `objetivos pequeños en ${screen}`).toEqual([]);
  }
});

test('con el teclado virtual abierto, la terminal y sus teclas siguen a la vista', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'movil', 'el teclado virtual sólo existe en el teléfono');
  await login(page);
  await nav(page, 'Terminal').click();
  await page.getByRole('button', { name: 'Conectar', exact: true }).click();
  await expect(page.getByText('conectada', { exact: true })).toBeVisible({ timeout: 30_000 });

  /*
   * Playwright no abre un teclado de verdad, así que se simula lo único que la aplicación mira:
   * `visualViewport` encoge y avisa. Es lo que hace un teléfono, y comprobar la reacción vale más
   * que no comprobar nada por no tener el teclado.
   */
  await page.evaluate(() => {
    const viewport = window.visualViewport as unknown as {
      height: number;
      dispatchEvent: (event: Event) => boolean;
    };
    Object.defineProperty(viewport, 'height', { value: 420, configurable: true });
    viewport.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(300);

  // Las teclas que un teléfono no tiene siguen alcanzables dentro de lo visible.
  const esc = page.getByRole('button', { name: 'Esc', exact: true });
  const box = await esc.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(420);

  // Y la terminal encoge en vez de empujarlas fuera: deja sitio para las teclas dentro de lo
  // visible, en vez de quedarse con el alto de la ventana entera.
  const height = await page.locator('.terminal-host').evaluate(
    (element) => element.getBoundingClientRect().height);
  expect(height).toBeLessThanOrEqual(420 - 100);
  expect(height).toBeGreaterThan(100);
});

/**
 * Los estados que las pruebas no llegan a producir.
 *
 * El distintivo de cuota tiene cuatro estados y el stack falso sólo produce uno: axe nunca ve el
 * rojo de «te queda poca cuota», que es justo el que hay que poder leer antes de mandar trabajo.
 * En vez de fabricar la cuota gastada —que obliga a tocar el agente falso—, se mide el CSS que
 * los pinta: se inserta un distintivo de cada tono en una tarjeta de verdad y se calcula el
 * contraste con la misma fórmula que usa axe.
 *
 * Cubre además todos los sitios donde aparece un distintivo, no sólo la cuota.
 */
const TONES = ['ok', 'warn', 'danger', 'running', 'neutral', 'accent'];

async function badgeContrast(page: Page): Promise<Array<{ tone: string; ratio: number }>> {
  return page.evaluate((tones) => {
    const channel = (value: number): number => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    /*
     * `color-mix()` se computa como `color(srgb r g b)`, con componentes de 0 a 1, no como
     * `rgb()` de 0 a 255. Leerlo como si fuera rgb da un negro casi puro y contrastes inventados:
     * es el error que hacía fallar esta comprobación con colores que sí cumplen.
     */
    const parse = (color: string): [number, number, number, number] => {
      const parts = color.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1];
      const scale = color.startsWith('color(') ? 255 : 1;
      return [
        (parts[0] ?? 0) * scale,
        (parts[1] ?? 0) * scale,
        (parts[2] ?? 0) * scale,
        parts[3] ?? 1,
      ];
    };
    const luminance = ([r, g, b]: number[]): number =>
      0.2126 * channel(r ?? 0) + 0.7152 * channel(g ?? 0) + 0.0722 * channel(b ?? 0);
    const over = (top: number[], bottom: number[]): number[] => {
      const alpha = top[3] ?? 1;
      return [0, 1, 2].map((i) => (top[i] ?? 0) * alpha + (bottom[i] ?? 0) * (1 - alpha));
    };

    const host = document.querySelector('.card') ?? document.body;
    const page = parse(getComputedStyle(document.body).backgroundColor);
    const results: Array<{ tone: string; ratio: number }> = [];

    for (const tone of tones) {
      const badge = document.createElement('span');
      badge.className = `badge ${tone}`;
      badge.textContent = 'prueba';
      host.appendChild(badge);
      const style = getComputedStyle(badge);
      const background = over(parse(style.backgroundColor), page);
      const foreground = over(parse(style.color), background);
      const light = luminance(foreground);
      const dark = luminance(background);
      const [hi, lo] = light > dark ? [light, dark] : [dark, light];
      results.push({ tone, ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100 });
      badge.remove();
    }
    return results;
  }, TONES);
}

test('los distintivos de estado cumplen AA en tema claro, incluidos los que no se ven aquí', async ({ page }) => {
  await login(page);
  const ratios = await badgeContrast(page);
  expect(ratios.filter((tone) => tone.ratio < 4.5)).toEqual([]);
});

test.describe('tema oscuro', () => {
  test.use({ colorScheme: 'dark' });

  test('los distintivos de estado cumplen AA', async ({ page }) => {
    await login(page);
    const ratios = await badgeContrast(page);
    expect(ratios.filter((tone) => tone.ratio < 4.5)).toEqual([]);
  });

  test('la portada y el workspace no tienen fallos de accesibilidad', async ({ page }) => {
    await login(page);
    await page.waitForTimeout(1000);
    expect(describeViolations((await analyze(page)).violations)).toEqual([]);

    await nav(page, 'Sesiones').click();
    await page.getByRole('row', { name: /timeout del pool/i }).click();
    await page.getByRole('button', { name: /^(Abrir|Ir al) workspace$/ }).click();
    await expect(page).toHaveURL(/\/w\//);
    await page.waitForTimeout(800);
    expect(describeViolations((await analyze(page)).violations)).toEqual([]);
  });
});

/**
 * Una terminal en un teléfono cabe en muy poco, y lo que se fue por arriba no está en el
 * navegador.
 *
 * Estos dos tests cubren lo que se pidió mirando una sesión viva desde el móvil: poder darle toda
 * la pantalla, y poder subir a leer lo que acaba de pasar sin escribir nada dentro.
 */
async function conectarTerminal(page: Page): Promise<void> {
  await login(page);
  await nav(page, 'Terminal').click();
  await page.getByRole('button', { name: 'Conectar', exact: true }).click();
  await expect(page.getByText('conectada', { exact: true })).toBeVisible({ timeout: 30_000 });
}

test('la terminal se puede ver a pantalla completa, y se puede volver', async ({ page }) => {
  await conectarTerminal(page);

  const antes = await page.locator('.terminal-host').boundingBox();
  expect(antes).not.toBeNull();

  await page.getByRole('button', { name: 'Ver la terminal a pantalla completa' }).click();

  // El resto de la consola se aparta: si la cabecera sigue ahí, no es pantalla completa.
  await expect(page.locator('.topbar')).toBeHidden();
  await expect(page.locator('.terminal-setup')).toBeHidden();

  // Y la terminal ocupa lo que se ha liberado, que es el motivo de todo esto.
  const durante = await page.locator('.terminal-host').boundingBox();
  expect(durante).not.toBeNull();
  expect(durante!.height).toBeGreaterThan(antes!.height);

  const ventana = page.viewportSize();
  expect(durante!.height).toBeGreaterThan((ventana?.height ?? 0) * 0.6);

  /*
   * Y la rejilla se estira con él.
   *
   * Que el hueco crezca no basta: si xterm no se reajusta, el resultado es una terminal enorme
   * con el contenido apelotonado arriba y medio panel negro debajo —y tmux, al otro lado,
   * pintando todavía al tamaño viejo, con su barra de estado a media pantalla—. Eso es lo que se
   * vio en el primer despliegue, y esta comprobación es la que faltaba.
   */
  await expect.poll(async () => {
    const filas = await page.locator('.terminal-host .xterm-screen').evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    const hueco = await page.locator('.terminal-host').evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    return filas / hueco;
  }, { timeout: 10_000 }).toBeGreaterThan(0.85);

  // Salir tiene que estar siempre a la vista: nadie puede quedarse atrapado en este modo.
  const salir = page.getByRole('button', { name: 'Salir de pantalla completa' });
  await expect(salir).toBeVisible();
  const caja = await salir.boundingBox();
  expect(caja!.y).toBeGreaterThanOrEqual(0);
  expect(caja!.y + caja!.height).toBeLessThanOrEqual(ventana?.height ?? 0);

  await salir.click();
  await expect(page.locator('.topbar')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ver la terminal a pantalla completa' })).toBeVisible();

  // La sesión no se ha tocado por cambiar de vista.
  await expect(page.getByText('conectada', { exact: true })).toBeVisible();
});

test('se puede subir y bajar por el historial sin teclear dentro', async ({ page }) => {
  const enviados: string[] = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', (frame) => {
      if (typeof frame.payload === 'string') enviados.push(frame.payload);
    });
  });

  await conectarTerminal(page);

  /*
   * Se descarta lo que se envió al conectar.
   *
   * Un emulador de terminal **contesta** a lo que el programa remoto le pregunta: qué es
   * (`0;276;0c`, Device Attributes) y de qué color tiene el fondo y la tinta (`gb:ffff/…`). Esos
   * frames salen por el socket sin que nadie toque el teclado, así que contarlos como pulsaciones
   * haría fallar a un test que en realidad está comprobando otra cosa.
   */
  await page.waitForTimeout(500);
  enviados.length = 0;

  await page.getByRole('button', { name: 'Subir en el historial de la sesión' }).click();
  await page.getByRole('button', { name: 'Bajar en el historial de la sesión' }).click();
  await page.getByRole('button', { name: 'Volver al final de la sesión' }).click();
  await page.waitForTimeout(300);

  const controles = enviados.filter((payload) => payload.includes('"type":"scroll"'));
  expect(controles).toEqual([
    '{"type":"scroll","action":"up"}',
    '{"type":"scroll","action":"down"}',
    '{"type":"scroll","action":"end"}',
  ]);

  /*
   * Y lo importante: mirar no es teclear. Desde que se pulsan los botones no puede salir un solo
   * byte hacia el TTY, o el agente del otro lado se comería pulsaciones que nadie escribió.
   */
  const teclas = enviados.filter((payload) => !payload.startsWith('{'));
  expect(teclas).toEqual([]);

  await expect(page.getByText('conectada', { exact: true })).toBeVisible();
});
