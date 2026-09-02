import { test, type Page } from '@playwright/test';

const nav = (page: Page, name: string | RegExp) =>
  page.locator('.rail').getByRole('link', { name });

/**
 * Capturas para revisar el aspecto a mano.
 *
 * No afirma nada —de eso se encargan los flujos— pero mirar la pantalla de verdad es la única
 * forma de ver que un icono se ha quedado solo en su línea o que un botón desapareció. Las
 * imágenes van a `evidence/` y no se versionan: cambian en cada ejecución.
 */
test('capturas', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByLabel('Usuario').fill('braian');
  await page.getByLabel('Contraseña').fill('e2e-password-de-pruebas');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await nav(page, 'Sesiones').click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `evidence/ui-${testInfo.project.name}-sesiones-lista.png` });

  await page.getByRole('row', { name: /timeout del pool/i }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `evidence/ui-${testInfo.project.name}-sesiones.png` });

  await page.getByRole('button', { name: /^(Abrir|Ir al) workspace$/ }).click();
  // Un trabajo de verdad: sin eventos, la línea de tiempo no se puede mirar.
  await page.getByLabel('Qué quieres que haga el agente').fill('@@slow:4 revisa el pool');
  await page.getByRole('button', { name: 'Enviar' }).click();
  await page.getByText('Terminado').first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `evidence/ui-${testInfo.project.name}-workspace.png`, fullPage: false });

  // El detalle en crudo de un evento: lo que sustituye al volcado de JSON en la línea de tiempo.
  const card = page.locator('.event-card').first();
  if (await card.count()) {
    await card.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `evidence/ui-${testInfo.project.name}-evento.png`, fullPage: false });
    await page.keyboard.press('Escape');
  }

  await nav(page, /^Trabajo/).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `evidence/ui-${testInfo.project.name}-trabajo.png` });

  await nav(page, /^Salud/).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `evidence/ui-${testInfo.project.name}-salud.png`, fullPage: false });

  await nav(page, /^Inicio/).click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `evidence/ui-${testInfo.project.name}-inicio.png`, fullPage: false });
});
