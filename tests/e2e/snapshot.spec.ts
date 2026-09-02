import { test } from '@playwright/test';

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
  await page.getByRole('link', { name: 'Sesiones' }).click();
  await page.getByRole('button', { name: /timeout del pool/i }).click();
  await page.getByRole('button', { name: /^(Abrir|Ir al) workspace$/ }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `evidence/ui-${testInfo.project.name}-workspace.png`, fullPage: false });

  await page.getByRole('link', { name: /Salud/ }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `evidence/ui-${testInfo.project.name}-salud.png`, fullPage: false });

  await page.getByRole('link', { name: /Inicio/ }).click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `evidence/ui-${testInfo.project.name}-inicio.png`, fullPage: false });
});
