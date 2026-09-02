/**
 * Los cinco flujos críticos, tal y como los recorre una persona.
 *
 * Corren contra el stack completo con hosts falsos: login por el gateway, sesiones del índice,
 * runs que de verdad arrancan tmux y escriben su spool. Si algo de esto se rompe, el producto
 * está roto para quien lo usa, no sólo para un test unitario.
 */
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-password-de-pruebas';

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Usuario').fill('braian');
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('link', { name: 'Sesiones' })).toBeVisible();
}

/** Abre el workspace de una sesión concreta y devuelve su URL. */
async function openWorkspace(page: Page, title: string): Promise<string> {
  await page.getByRole('link', { name: 'Sesiones' }).click();
  await page.getByRole('button', { name: new RegExp(title, 'i') }).click();
  await page.getByRole('button', { name: /workspace/i }).click();
  await expect(page).toHaveURL(/\/w\//);
  return page.url();
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('flujo 1 · retomar trabajo: buscar, previsualizar y abrir', async ({ page }) => {
  await page.getByRole('link', { name: 'Sesiones' }).click();
  await expect(page.getByRole('button', { name: /timeout del pool/i })).toBeVisible();

  // Buscar es una consulta: filtra la lista y no toca nada más.
  await page.getByLabel('Buscar sesiones').fill('certificado');
  await expect(page.getByRole('button', { name: /certificado caducado/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /timeout del pool/i })).toHaveCount(0);

  await page.getByLabel('Buscar sesiones').fill('');
  await page.getByRole('button', { name: /timeout del pool/i }).click();
  await expect(page.getByText('el pool se queda sin conexiones')).toBeVisible();

  await page.getByRole('button', { name: /workspace/i }).click();
  await expect(page).toHaveURL(/\/w\//);
  // El transcript remoto se ve, y dice que es remoto.
  await expect(page.getByText('remote-transcript').first()).toBeVisible();
});

test('flujo 2 · trabajo directo: destino visible antes de enviar, y resultado en vivo', async ({ page }) => {
  await openWorkspace(page, 'timeout del pool');

  // Lo que se ve antes de pulsar es exactamente lo que se va a ejecutar.
  await expect(page.getByText('claude · en bastion')).toBeVisible();
  await expect(page.getByText('permiso: safe')).toBeVisible();

  await page.getByLabel('Prompt').fill('@@slow:3 revisa el pool');
  await page.getByRole('button', { name: 'Enviar' }).click();

  // El borrador se limpia sólo cuando el servidor confirmó el trabajo.
  await expect(page.getByLabel('Prompt')).toHaveValue('');
  await expect(page.getByText('completado').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('agent.result').first()).toBeVisible();
});

test('flujo 3 · el borrador sobrevive a navegar y volver', async ({ page }) => {
  const url = await openWorkspace(page, 'pipeline de despliegue');
  await page.getByLabel('Prompt').fill('esto es un borrador a medio escribir');
  // El guardado es con retardo: se le da su momento antes de irse.
  await page.waitForTimeout(1200);

  await page.getByRole('link', { name: 'Runs' }).click();
  await expect(page).toHaveURL(/\/runs/);
  await page.goto(url);

  await expect(page.getByLabel('Prompt')).toHaveValue('esto es un borrador a medio escribir');
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
  await page.getByRole('link', { name: 'Salud' }).click();

  await expect(page.getByText('ssh:bastion')).toBeVisible();
  // Un host caído deja su check en rojo y el resto de la aplicación en pie.
  await expect(page.getByText('ssh:deadhost')).toBeVisible();
  await expect(page.getByText(/No route to host/)).toBeVisible();
  await expect(page.getByText('database')).toBeVisible();

  await expect(page.getByRole('button', { name: 'Copiar diagnóstico' })).toBeVisible();
});

test('la terminal se abre, adjunta y no se cierra al salir', async ({ page }) => {
  await page.getByRole('link', { name: 'Terminal' }).click();
  await page.getByRole('button', { name: 'Conectar' }).click();

  await expect(page.getByText('conectada')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Claude Code \(falso\)/)).toBeVisible({ timeout: 30_000 });

  // Salir de la pantalla no mata la sesión: al volver sigue en la lista.
  await page.getByRole('link', { name: 'Inicio' }).click();
  await page.getByRole('link', { name: 'Terminal' }).click();
  await expect(page.getByText(/jarvis-claude/).first()).toBeVisible({ timeout: 20_000 });
});
