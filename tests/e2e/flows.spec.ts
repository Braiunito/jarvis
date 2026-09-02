/**
 * Los cinco flujos críticos, tal y como los recorre una persona.
 *
 * Corren contra el stack completo con hosts falsos: login por el gateway, sesiones del índice,
 * runs que de verdad arrancan tmux y escriben su spool. Si algo de esto se rompe, el producto
 * está roto para quien lo usa, no sólo para un test unitario.
 */
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-password-de-pruebas';

/**
 * Los destinos del carril.
 *
 * Se busca dentro del carril y no en toda la página a propósito: «Sesiones» o «Trabajo» aparecen
 * también como atajos dentro de las pantallas, y un test que pincha el primero que encuentra deja
 * de probar la navegación para probar la suerte.
 */
const nav = (page: Page, name: string | RegExp) =>
  page.locator('.rail').getByRole('link', { name });

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Usuario').fill('braian');
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(nav(page, 'Sesiones')).toBeVisible();
}

/** Abre el workspace de una sesión concreta y devuelve su URL. */
async function openWorkspace(page: Page, title: string): Promise<string> {
  await nav(page, 'Sesiones').click();
  // La lista es una tabla: se compara entre sesiones, así que cada una es una fila.
  await page.getByRole('row', { name: new RegExp(title, 'i') }).click();
  await page.getByRole('button', { name: /^(Abrir|Ir al) workspace$/ }).click();
  await expect(page).toHaveURL(/\/w\//);
  return page.url();
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('flujo 1 · retomar trabajo: buscar, previsualizar y abrir', async ({ page }) => {
  await nav(page, 'Sesiones').click();
  await expect(page.getByRole('row', { name: /timeout del pool/i })).toBeVisible();

  // Buscar es una consulta: filtra la lista y no toca nada más.
  await page.getByLabel('Buscar sesiones').fill('certificado');
  await expect(page.getByRole('row', { name: /certificado caducado/i })).toBeVisible();
  await expect(page.getByRole('row', { name: /timeout del pool/i })).toHaveCount(0);

  await page.getByLabel('Buscar sesiones').fill('');
  await page.getByRole('row', { name: /timeout del pool/i }).click();
  await expect(page.getByText('el pool se queda sin conexiones')).toBeVisible();

  await page.getByRole('button', { name: /^(Abrir|Ir al) workspace$/ }).click();
  await expect(page).toHaveURL(/\/w\//);
  // El transcript remoto se ve, y dice de dónde salió.
  await page.getByRole('tab', { name: /Conversación/ }).click();
  await expect(page.getByText('escrito en la máquina').first()).toBeVisible();
});

test('flujo 2 · trabajo directo: destino visible antes de enviar, y resultado en vivo', async ({ page }) => {
  await openWorkspace(page, 'timeout del pool');

  // Lo que se ve antes de pulsar es exactamente lo que se va a ejecutar, y en un idioma que
  // dice qué puede hacer el agente, no cómo se llama la bandera de la CLI.
  await expect(page.getByText('claude · en bastion')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sólo lectura', pressed: true })).toBeVisible();

  await page.getByLabel('Qué quieres que haga el agente').fill('@@slow:3 revisa el pool');
  await page.getByRole('button', { name: 'Enviar' }).click();

  // El borrador se limpia sólo cuando el servidor confirmó el trabajo.
  await expect(page.getByLabel('Qué quieres que haga el agente')).toHaveValue('');
  await expect(page.getByText('Terminado').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('resultado').first()).toBeVisible();
});

test('flujo 3 · el borrador sobrevive a navegar y volver', async ({ page }) => {
  const url = await openWorkspace(page, 'pipeline de despliegue');
  await page.getByLabel('Qué quieres que haga el agente').fill('esto es un borrador a medio escribir');
  // El guardado es con retardo: se le da su momento antes de irse.
  await page.waitForTimeout(1200);

  await nav(page, /^Trabajo/).click();
  await expect(page).toHaveURL(/\/runs/);
  await page.goto(url);

  await expect(page.getByLabel('Qué quieres que haga el agente'))
    .toHaveValue('esto es un borrador a medio escribir');
});

test('flujo 4 · delegar un objetivo al Assistant', async ({ page }) => {
  await openWorkspace(page, 'timeout del pool');

  await page.getByLabel('Objetivo').fill('averigua por que el pool se queda sin conexiones');
  await page.getByRole('button', { name: 'Delegar objetivo' }).click();

  // El plan es una lista de pasos con estado, no una conversación. El título aparece también en
  // la síntesis final, así que se busca el del paso.
  await expect(page.getByText('Reunir contexto', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Resultado' })).toBeVisible({ timeout: 90_000 });
});

test('flujo 5 · diagnóstico: qué salto está roto y cómo se copia', async ({ page }) => {
  await nav(page, /^Salud/).click();

  await expect(page.getByText('ssh:bastion')).toBeVisible();
  // Un host caído deja su check en rojo y el resto de la aplicación en pie.
  await expect(page.getByText('ssh:deadhost')).toBeVisible();
  await expect(page.getByText(/No route to host/)).toBeVisible();
  await expect(page.getByText('database')).toBeVisible();

  await expect(page.getByRole('button', { name: 'Copiar diagnóstico' })).toBeVisible();
});

test('la paleta lleva a un contexto sin pasar por tres pantallas', async ({ page }) => {
  await openWorkspace(page, 'timeout del pool');
  await nav(page, 'Inicio').click();

  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Ir a' })).toBeVisible();

  await page.getByPlaceholder('Ir a un workspace').fill('timeout');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/w\//);

  // Y también lleva a una sección, escribiendo lo que uno recuerda.
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder('Ir a un workspace').fill('salud');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/health/);
});

test('la terminal se abre, adjunta y no se cierra al salir', async ({ page }) => {
  await nav(page, 'Terminal').click();
  await page.getByRole('button', { name: 'Conectar', exact: true }).click();

  await expect(page.getByText('conectada', { exact: true })).toBeVisible({ timeout: 30_000 });

  // Adjuntar de verdad se prueba escribiendo: si vuelve el eco, hay un TTY al otro lado. Mirar el
  // banner sólo funciona la primera vez —al reengancharse, tmux redibuja la pantalla actual, no
  // el historial—, y eso hacía que el test dependiera de quién llegó antes.
  await page.locator('.terminal-host').click();
  await page.keyboard.type('hola-jarvis');
  await expect(page.getByText(/hola-jarvis/).first()).toBeVisible({ timeout: 20_000 });

  // Salir de la pantalla no mata la sesión: al volver sigue en la lista.
  await nav(page, 'Inicio').click();
  await nav(page, 'Terminal').click();
  await expect(page.locator('.list-item').filter({ hasText: /jarvis-claude/ }).first())
    .toBeVisible({ timeout: 20_000 });
});

test('cerrar la terminal sí la mata, y lo dice antes de hacerlo', async ({ page }) => {
  await nav(page, 'Terminal').click();
  await page.getByRole('button', { name: /^(Conectar|Reconectar)$/ }).click();
  await expect(page.getByText('conectada', { exact: true })).toBeVisible({ timeout: 30_000 });

  // Destruir es explícito: nombra la sesión y la máquina antes de tocarlas.
  await page.getByRole('button', { name: 'Cerrar la terminal', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('No se puede deshacer')).toBeVisible();
  await expect(dialog.getByText(/bastion/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cerrar la terminal' }).click();

  // Y al volver ya no está.
  await expect(page.getByText('conectada', { exact: true })).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('.list-item').filter({ hasText: /jarvis-claude/ }))
    .toHaveCount(0, { timeout: 20_000 });
});
