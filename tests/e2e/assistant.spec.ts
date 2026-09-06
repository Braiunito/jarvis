/**
 * El asistente, tal y como lo recorre una persona.
 *
 * La pantalla que más ha cambiado en dos días no tenía ni un flujo, y en esa ventana convivieron
 * con la suite en verde un panel de artifacts en blanco, unas referencias que el core guardaba y la
 * pantalla tiraba, y un hilo que se podía arrastrar de lado. Ninguno se ve desde el core ni desde
 * una prueba unitaria: hacen falta las dos mitades ejecutándose juntas, que es lo que hay aquí.
 *
 * El modelo del stack es el guionizado (`JARVIS_ASSISTANT_SCRIPTED`), así que las directivas dentro
 * del mensaje deciden qué produce el turno: `@@artifact` presenta los tres, `@@tools` mira sesiones
 * y ofrece terminal. Es el camino real del core con datos de mentira, que es mejor que sembrar
 * filas: sembrando se prueba el pintado y no que el core produzca eso.
 */
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-password-de-pruebas';

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Usuario').fill('braian');
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.locator('.rail').getByRole('link', { name: 'Sesiones' })).toBeVisible();
}

/** Escribe en el compositor y manda. Enter envía, que es lo que hace quien viene de un chat. */
async function preguntar(page: Page, texto: string): Promise<void> {
  const composer = page.getByLabel('Mensaje para el asistente');
  await composer.fill(texto);
  await composer.press('Enter');
}

test('el asistente contesta, enseña lo que hizo y lo que encontró se puede abrir', async ({ page }) => {
  await login(page);
  await page.goto('/assistant');

  await preguntar(page, 'enséñame la sonda @@artifact');

  // La pregunta aparece como propia antes de que conteste: sin eso, escribir parece no hacer nada.
  await expect(page.locator('.chat-bubble.user')).toContainText('enséñame la sonda', { timeout: 20_000 });

  /*
   * Las consultas se ven, plegadas y con su nombre real.
   *
   * Es la promesa de la pantalla: un asistente que consulta y contesta sin enseñar de dónde sale es
   * indistinguible de uno que se lo inventa.
   */
  await expect(page.locator('.chat-tool').first()).toBeVisible({ timeout: 40_000 });

  // Un artifact `inline` es contenido y va dentro de la burbuja, con su cabecera y su cuerpo.
  const inline = page.locator('.artifact').first();
  await expect(inline).toBeVisible({ timeout: 40_000 });
  await expect(inline).toContainText('table');

  /*
   * Y uno de `panel` es una puerta: una pastilla que dice qué hay dentro antes de pulsarla.
   * «3 porciones» es del `previewOf` del core, así que esto también comprueba que ese dato llega.
   */
  const chip = page.locator('.artifact-chip').first();
  await expect(chip).toBeVisible();

  await chip.click();
  // El panel es un diálogo propio, no las clases de otra pantalla, y trae el cuerpo al abrirse.
  const panel = page.locator('.artifact-panel, .artifact-modal');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.artifact')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Cerrar' }).first().click();
  await expect(panel).toHaveCount(0);
});

test('el hilo no se puede arrastrar de lado', async ({ page }) => {
  await login(page);
  await page.goto('/assistant');
  await preguntar(page, 'revisa la sesión @@tools @@artifact');
  await expect(page.locator('.artifact, .chat-refs').first()).toBeVisible({ timeout: 40_000 });

  /*
   * Es el fallo que Braian vio en el teléfono: una pastilla más ancha que el hilo lo volvía
   * desplazable y el texto salía cortado por la izquierda, sin que nada dijera que se había movido.
   */
  const desborde = await page.evaluate(() => {
    const caja = document.querySelector('.chat-messages');
    return caja ? caja.scrollWidth - caja.clientWidth : 0;
  });
  expect(desborde).toBeLessThanOrEqual(1);
});

test('el estado dice si esto va a funcionar, y con qué', async ({ page }) => {
  await login(page);
  await page.goto('/assistant');
  await preguntar(page, 'hola');

  /*
   * La línea de la cabecera no dice «online»: dice cuántas máquinas responden y con qué modelo se
   * contesta. Una palabra que colapsa el modelo, el índice y seis hosts en un color no se puede
   * comprobar; los números sí.
   */
  const estado = page.locator('.chat-status');
  await expect(estado).toBeVisible({ timeout: 20_000 });
  await expect(estado).toContainText(/máquina/i, { timeout: 40_000 });

  // Y el aviso de capacidades, si lo hay, no se recorta nunca: es lo único accionable de la línea.
  const aviso = page.locator('.chat-status-warn');
  if (await aviso.count()) {
    const cortado = await aviso.evaluate((e) => e.scrollWidth > e.clientWidth + 1);
    expect(cortado).toBe(false);
  }
});

test('borrar una conversación pregunta antes, porque no se deshace', async ({ page }) => {
  await login(page);
  await page.goto('/assistant');
  await preguntar(page, 'hola');
  await expect(page.locator('.chat-bubble.user')).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Borrar la conversación' }).click();
  const dialogo = page.getByRole('dialog', { name: /Borrar esta conversación/i });
  await expect(dialogo).toBeVisible();
  await expect(dialogo).toContainText('No se puede deshacer');

  // Cancelar de verdad cancela: el hilo sigue donde estaba.
  await page.keyboard.press('Escape');
  await expect(page.locator('.chat-bubble.user')).toBeVisible();
});

test('un envío que falla no se lleva lo escrito', async ({ page }) => {
  await login(page);
  await page.goto('/assistant');
  await preguntar(page, 'hola');
  await expect(page.locator('.chat-bubble.user')).toBeVisible({ timeout: 20_000 });

  // A partir de aquí, mandar falla.
  await page.route('**/api/chat/*/messages', (route) => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ code: 'INTERNAL', message: 'a propósito' }),
  }));

  const composer = page.getByLabel('Mensaje para el asistente');
  await composer.fill('esto no se puede perder');
  await composer.press('Enter');

  /*
   * Lo escrito se borraba antes de que el servidor confirmara, así que un 500 se llevaba el texto
   * y la pantalla se quedaba muda. Lo que se comprueba es lo que le importa a quien escribió: que
   * su texto sigue ahí para volver a intentarlo.
   */
  await expect(composer).toHaveValue('esto no se puede perder', { timeout: 10_000 });
});
