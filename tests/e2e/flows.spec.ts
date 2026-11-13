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
 * Se busca dentro del carril y no en toda la página a propósito: «Sesiones» aparece también como
 * miga dentro de las pantallas, y un test que pincha el primero que encuentra deja de probar la
 * navegación para probar la suerte.
 */
const nav = (page: Page, name: string | RegExp) =>
  page.locator('.rail').getByRole('link', { name });

/** El escudo de arriba: la única puerta a Salud. */
const shield = (page: Page) => page.locator('.topbar').getByRole('link', { name: /^Salud/ });

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Usuario').fill('braian');
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(nav(page, 'Sesiones')).toBeVisible();
}

/** El grupo de una carpeta, por su nombre corto. */
const group = (page: Page, folder: string) =>
  page.locator('.group-head').filter({ has: page.locator('.group-title', { hasText: new RegExp(`^${folder}`) }) });

/**
 * Abre una sesión concreta y devuelve su URL.
 *
 * Tres pasos, que son los de la pantalla: el grupo de su carpeta, la sesión, «Abrir». Se busca el
 * grupo que contiene la sesión en vez de nombrar la carpeta, para que el test no dependa de dónde
 * se ejecutó cada sesión de prueba.
 */
async function openWorkspace(page: Page, title: string): Promise<string> {
  await nav(page, 'Sesiones').click();
  await page.getByLabel('Buscar sesiones').fill(title);
  await page.locator('.group-head').first().click();
  await page.locator('.session-head', { hasText: new RegExp(title, 'i') }).click();
  await page.getByRole('button', { name: 'Abrir', exact: true }).click();
  await expect(page).toHaveURL(/\/w\//);
  return page.url();
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('flujo 1 · retomar trabajo: carpeta, sesión y abrir', async ({ page }) => {
  // La portada son las sesiones, agrupadas por la carpeta donde se ejecutaron: el nombre corto,
  // no la ruta, y las de la misma carpeta juntas aunque sean de máquinas distintas.
  await expect(group(page, 'app')).toBeVisible();
  await expect(group(page, 'app')).toContainText('3 sesiones');
  await expect(page.getByText('/tmp/jarvis-demo/app')).toHaveCount(0);

  // Buscar es una consulta: filtra y no toca nada más.
  await page.getByLabel('Buscar sesiones').fill('certificado');
  await expect(group(page, 'edge')).toBeVisible();
  await expect(group(page, 'app')).toHaveCount(0);

  // Y basta el principio de una palabra, como se teclea: en la conversación…
  await page.getByLabel('Buscar sesiones').fill('certif');
  await expect(group(page, 'edge')).toBeVisible();
  await expect(group(page, 'app')).toHaveCount(0);
  // …y en la máquina, que el índice ni siquiera tiene en el texto que busca.
  await page.getByLabel('Buscar sesiones').fill('serv');
  await expect(group(page, 'edge')).toBeVisible();
  await expect(group(page, 'deploy')).toHaveCount(0);
  await page.getByLabel('Buscar sesiones').fill('');

  // Abrir el grupo enseña sus sesiones, la más reciente primero, y las rutas completas.
  await group(page, 'app').click();
  await expect(page.locator('.session-head').first()).toContainText('timeout del pool');
  await expect(page.getByText('/srv/app')).toBeVisible();

  // Y pulsar una sesión enseña su ruta, de qué iba y qué se puede hacer.
  await page.locator('.session-head', { hasText: 'timeout del pool' }).click();
  await expect(page.getByText('el pool se queda sin conexiones')).toBeVisible();
  await page.getByRole('button', { name: 'Abrir', exact: true }).click();
  await expect(page).toHaveURL(/\/w\//);

  // El hilo: los turnos anteriores plegados en «lo que pediste → lo que contestó»; el último,
  // abierto. Desplegar uno enseña el turno entero.
  // Con la suite pasando dos veces —escritorio y móvil— el hilo crece; si el primero quedó entre
  // los anteriores, se piden.
  // `count()` antes que `isEnabled()`: éste espera a que el botón exista, y si no hay nada
  // anterior no va a existir nunca.
  const anteriores = page.locator('.thread-more');
  await expect(page.locator('.turn').first()).toBeVisible();
  if (await anteriores.count() && await anteriores.isEnabled()) await anteriores.click();
  const primero = page.locator('.turn').first();
  await expect(primero).toContainText('La API devuelve 502');
  await expect(primero).toContainText('el pool llega a 20 conexiones');
  await expect(primero.locator('.turn-head')).toHaveAttribute('aria-expanded', 'false');

  // La última respuesta se copia sin abrir el turno, y entera: el Markdown tal cual.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await primero.getByRole('button', { name: 'Copiar la última respuesta' }).click();
  await expect(primero.getByRole('button', { name: 'Copiar la última respuesta' })).toHaveAttribute('title', 'Copiado');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('el pool llega a 20 conexiones');

  await primero.locator('.turn-head').click();
  await expect(primero.locator('.message.assistant')).toContainText('el pool llega a 20 conexiones');
  // Abierto, cada respuesta lleva el suyo, y el de la tarjeta plegada se va.
  await expect(primero.locator('.message.assistant').getByRole('button', { name: 'Copiar la respuesta' })).toBeVisible();
  await expect(primero.getByRole('button', { name: 'Copiar la última respuesta' })).toHaveCount(0);

  // La miga vuelve al grupo abierto, no a la portada en frío.
  await page.locator('.crumb').getByRole('link', { name: 'Sesiones' }).click();
  await expect(page.locator('.session-head', { hasText: 'timeout del pool' })).toBeVisible();
});

test('flujo 2 · trabajo directo: destino visible antes de enviar, y resultado en vivo', async ({ page }) => {
  await openWorkspace(page, 'timeout del pool');

  // Lo que se ve antes de pulsar es exactamente lo que se va a ejecutar, y en un idioma que
  // dice qué puede hacer el agente, no cómo se llama la bandera de la CLI.
  await expect(page.getByText('claude · en bastion')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sólo lectura', pressed: true })).toBeVisible();

  // Con qué modelo trabajó la sesión, dicho para leerlo; el identificador exacto, al pasar por encima.
  await expect(page.locator('.ws-meta')).toContainText('Opus 5');

  // Y con cuál se manda esto: sin elegir, el de la máquina; elegido, llega a la CLI.
  await page.getByLabel('Modelo', { exact: true }).selectOption('sonnet');
  const sent = page.waitForRequest((request) => request.url().endsWith('/api/runs') && request.method() === 'POST');
  await page.getByLabel('Qué quieres que haga el agente').fill('@@slow:3 revisa el pool');
  await page.getByRole('button', { name: 'Enviar' }).click();
  expect((await sent).postDataJSON()).toMatchObject({ model: 'sonnet' });

  // El borrador se limpia sólo cuando el servidor confirmó el trabajo.
  await expect(page.getByLabel('Qué quieres que haga el agente')).toHaveValue('');
  // El trabajo es el último turno del hilo, y viene abierto: se ve en vivo sin pulsar nada.
  const turno = page.locator('.turn').last();
  await expect(turno.locator('.turn-head')).toContainText('revisa el pool');
  await expect(turno.getByText('Terminado').first()).toBeVisible({ timeout: 60_000 });
  await expect(turno.getByText('resultado').first()).toBeVisible();
  // El agente arrancó con el modelo elegido: lo dice él mismo en su primer evento. Y el
  // compositor se queda con él para el siguiente, que es lo normal en una misma conversación.
  await expect(turno.getByRole('button', { name: /el agente arrancó.*modelo: sonnet/ })).toBeVisible();
  await expect(page.getByLabel('Modelo', { exact: true })).toHaveValue('sonnet');
  // Las respuestas del trabajo se copian igual que las del transcript.
  await expect(turno.getByRole('button', { name: 'Copiar la respuesta' }).first()).toBeVisible();

  /*
   * Lo repetido se agrupa; lo distinto no.
   *
   * La línea de tiempo junta eventos idénticos seguidos —un agente que razona emite el mismo
   * cada pocos segundos— pero tres respuestas distintas son tres cosas que el agente dijo, y
   * fundirlas escondería información. El agente falso manda «paso 1/3», «paso 2/3» y «paso 3/3».
   */
  for (const paso of ['paso 1/3', 'paso 2/3', 'paso 3/3']) {
    await expect(page.getByText(paso, { exact: true })).toHaveCount(1);
  }
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

test('flujo 4 · diagnóstico: qué salto está roto y cómo se copia', async ({ page }) => {
  // Salud no está en el carril: se entra por el escudo, que ya avisa de que algo va mal.
  await expect(nav(page, /Salud/)).toHaveCount(0);
  await expect(shield(page)).toHaveClass(/danger|warn/);
  await shield(page).click();
  await expect(page).toHaveURL(/\/health/);
  await expect(shield(page)).toHaveAttribute('aria-current', 'page');

  // Un host caído deja su check en rojo, a la vista, y el resto de la aplicación en pie.
  await expect(page.getByText('ssh:deadhost')).toBeVisible();
  await expect(page.getByText(/No route to host/).first()).toBeVisible();

  // Lo que va bien está plegado, contado, y a un clic.
  await expect(page.getByText('ssh:bastion')).toHaveCount(0);
  await page.getByRole('button', { name: /^Ver las \d+ que van bien$/ }).click();
  await expect(page.getByText('ssh:bastion')).toBeVisible();
  await expect(page.getByText('database', { exact: true })).toBeVisible();

  await expect(page.getByRole('button', { name: 'Copiar diagnóstico' })).toBeVisible();
});

test('el asistente ya no está: ni en el carril ni en su ruta', async ({ page }) => {
  await expect(page.locator('.rail').getByRole('link')).toHaveCount(3);
  await expect(nav(page, /Asistente/)).toHaveCount(0);
  // Un enlace viejo a /assistant cae en la portada, no en una pantalla en blanco.
  await page.goto('/assistant');
  await expect(page.getByLabel('Buscar sesiones')).toBeVisible();
});

test('la paleta lleva a un contexto sin pasar por tres pantallas', async ({ page }) => {
  await openWorkspace(page, 'timeout del pool');
  await nav(page, /^Trabajo/).click();

  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Ir a' })).toBeVisible();

  await page.getByPlaceholder('Ir a una sesión').fill('timeout');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/w\//);

  // Y también lleva a una sección, escribiendo lo que uno recuerda.
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder('Ir a una sesión').fill('trabajo');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/runs/);
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
  await nav(page, 'Sesiones').click();
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

/**
 * Estrenar una sesión, que es lo que antes obligaba a ir a la máquina.
 *
 * Se prueba el camino sin prompt a propósito: crea el workspace vacío y deja escribir la primera
 * tarea en el compositor, como en cualquier otro. Es el que más se parece al resto del producto y
 * el que deja el estado raro —una sesión que existe aquí y todavía no en la máquina—, que es justo
 * lo que la pantalla tiene que saber contar.
 */
test('empezar una sesión desde cero', async ({ page }) => {
  await nav(page, 'Sesiones').click();
  await page.getByRole('button', { name: 'Empezar una sesión' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Un trabajo')).toBeVisible();
  await dialog.getByLabel('Máquina', { exact: true }).selectOption('bastion');
  await dialog.getByLabel('Agente', { exact: true }).selectOption('claude');
  await dialog.getByRole('button', { name: 'Crear el workspace' }).click();

  await expect(page).toHaveURL(/\/w\//);
  // La sesión existe aquí y todavía no al otro lado: la pantalla lo dice en vez de enseñar un
  // historial vacío como si se hubiera perdido.
  await expect(page.getByText('sin estrenar')).toBeVisible();
  await expect(page.getByLabel('Qué quieres que haga el agente')).toBeVisible();
});

/**
 * Las máquinas se pueden elegir aunque el sondeo tarde.
 *
 * El sondeo abre un SSH a cada máquina y contesta cuando ha terminado la última: con una caída,
 * eso son los 20 s del timeout. El diálogo sacaba la lista de esa respuesta, así que durante todo
 * ese rato el desplegable estaba vacío y al tocarlo no salía nada (pasó en producción con bevrim
 * apagada, en el móvil y en el escritorio). Aquí se retiene el sondeo para siempre: la lista tiene
 * que salir igual, de lo que ya se sabe, y sin deshabilitar nada que no se haya comprobado.
 */
test('las máquinas salen en el desplegable aunque el sondeo no conteste', async ({ page }) => {
  const isProbe = (url: URL): boolean => url.pathname === '/api/hosts' && url.searchParams.get('probe') === '1';
  let probesHeld = 0;
  await page.route(isProbe, () => { probesHeld += 1; });
  // El diálogo vive montado desde que se entra y el sondeo de `login` ya contestó: se recarga
  // para que la aplicación arranque con él retenido.
  await page.reload();

  await nav(page, 'Sesiones').click();
  await page.getByRole('button', { name: 'Empezar una sesión' }).click();
  const machine = page.getByRole('dialog').getByLabel('Máquina', { exact: true });

  await expect(machine.locator('option')).not.toHaveCount(0, { timeout: 3_000 });
  await expect(machine).toHaveValue('bastion');
  await expect(machine.locator('option:disabled')).toHaveCount(0);
  expect(probesHeld).toBeGreaterThan(0);
});

/**
 * La cadena de autenticación se recorre, no se supone.
 *
 * Con una política de dos factores el primer paso **no** emite cookie: responde
 * `{authenticated: false, next, pending}`. La pantalla llamaba a `onAuthenticated()` igualmente, la
 * aplicación se creía dentro y `/auth/me` la echaba sin explicar nada; con `totp` no se podía
 * entrar en absoluto.
 *
 * Se prueba interceptando las respuestas del gateway en vez de levantar un despliegue con otra
 * política: lo que hay que comprobar es que la pantalla obedece lo que le dicen —qué paso toca y
 * que devuelve el token pendiente—, y eso no depende de quién genere esas respuestas.
 */
test('con dos factores, la pantalla pide el segundo y lleva el token pendiente', async ({ page }) => {
  await page.route('**/auth/config', (route) => route.fulfill({
    json: {
      rpId: 'localhost', rpName: 'Jarvis', steps: ['password', 'totp'],
      discoverableLogin: true, userVerification: 'required', insecureLogin: false,
    },
  }));
  await page.route('**/auth/password/verify', (route) => route.fulfill({
    json: { authenticated: false, next: 'totp', pending: 'token-de-prueba' },
  }));

  let meChecks = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/auth/me')) meChecks += 1;
  });

  let sentPending: string | null = null;
  await page.route('**/auth/totp/verify', async (route) => {
    sentPending = (route.request().postDataJSON() as { pending?: string }).pending ?? null;
    await route.fulfill({ json: { authenticated: true, user: { username: 'braian', displayName: 'Braian' } } });
  });

  // El `beforeEach` ya entró con la política real: se sale para recorrer la cadena desde cero.
  await page.context().clearCookies();
  await page.goto('/');
  await page.getByLabel('Usuario').fill('braian');
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();

  // El segundo paso aparece, y no se ha dado por buena la sesión.
  await expect(page.getByLabel('Código de la aplicación')).toBeVisible();
  await expect(page.getByText('No tengo el teléfono')).toBeVisible();

  await page.getByLabel('Código de la aplicación').fill('123456');
  await page.getByRole('button', { name: 'Confirmar' }).click();

  /*
   * Lo que se comprueba es la cadena, no la cookie.
   *
   * Una respuesta fingida no puede emitir sesión, así que al terminar la aplicación vuelve a
   * preguntar `/auth/me`, el gateway de verdad dice que no, y la pantalla empieza otra vez. Esa
   * segunda pregunta **es** la prueba: significa que se dio por autenticada al final de la cadena
   * y no en el primer paso, que era el fallo.
   */
  await expect.poll(() => meChecks).toBeGreaterThan(1);
  expect(sentPending).toBe('token-de-prueba');
});

/**
 * Adjuntar un fichero, que la pantalla prometía sin poder cumplirlo.
 *
 * La pantalla decía «los ficheros que le subiste» y en toda la consola no había un solo
 * `input` de fichero. Se prueba el camino entero —subir, verlo, mandarlo con el trabajo— porque el
 * fallo era justamente que no existía ninguno de los tres pasos.
 */
test('adjuntar un fichero y mandarlo con el trabajo', async ({ page }) => {
  await openWorkspace(page, 'pipeline de despliegue');

  await page.getByLabel('Adjuntar ficheros').setInputFiles({
    name: 'notas.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('el pool se queda sin conexiones a las 3am'),
  });

  // Aparece como lo que va a ir con el próximo envío, y se puede dejar fuera. Se comprueba por el
  // fichero y no por el contador: el workspace es el mismo en las dos pasadas de la suite, así que
  // el número de adjuntos depende de quién llegó antes.
  await expect(page.getByText(/notas\.txt/).first()).toBeVisible({ timeout: 20_000 });

  const quitar = page.getByRole('button', { name: 'Quitar notas.txt' }).first();
  await quitar.click();
  await expect(page.getByRole('button', { name: 'Incluir notas.txt' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Incluir notas.txt' }).first().click();

  // Y queda en los detalles de la sesión, que es donde se mira lo que el agente puede ver.
  await page.getByRole('button', { name: 'Detalles' }).click();
  await expect(page.locator('.ws-details').getByText('notas.txt').first()).toBeVisible();
});

/**
 * Lo que no es ASCII, y lo que no es texto.
 *
 * Una sola eñe rompía la subida con un 400 que hablaba de longitudes: el cuerpo llegaba decodificado
 * a cadena y contar caracteres no es contar bytes. Se prueban los dos casos que lo destapan —acentos
 * y binario— porque los tests que había sólo mandaban ASCII puro, que era justo lo único que pasaba.
 */
test('se pueden adjuntar acentos y binarios, no sólo ASCII', async ({ page }) => {
  await openWorkspace(page, 'certificado caducado');

  await page.getByLabel('Adjuntar ficheros').setInputFiles([
    {
      name: 'añoración.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('el año pasado ya pasó; ñ, á, ü', 'utf8'),
    },
    {
      // Un PNG de 1×1 de verdad, para que sea binario y no texto disfrazado.
      name: 'punto.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    },
  ]);

  await expect(page.getByText(/añoración\.txt/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/punto\.png/).first()).toBeVisible({ timeout: 20_000 });
});
