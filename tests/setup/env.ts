/**
 * Cada fichero de test corre con su propio directorio de datos y su propia raíz de ssh falso.
 *
 * Se hace aquí y no dentro del test porque la configuración se resuelve al importar los módulos,
 * y un import se evalúa antes que cualquier línea del cuerpo del test.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'jarvis-test-'));

process.env['JARVIS_DATA_DIR'] = join(dir, 'data');
process.env['JARVIS_RP_ID'] = 'localhost';
process.env['JARVIS_ORIGINS'] = 'http://localhost:8080';
process.env['JARVIS_INSECURE_COOKIES'] = 'true';
process.env['JARVIS_STATIC_DIR'] = join(dir, 'static');
process.env['JARVIS_CORE_DB'] = join(dir, 'core.db');
process.env['JARVIS_SPOOL_ROOT'] = join(dir, 'spool');
process.env['JARVIS_FAKE_SSH_ROOT'] = join(dir, 'fake-ssh');
process.env['JARVIS_ATTACHMENT_ROOT'] = join(dir, 'attachments');
// El secreto con el que el gateway firma la identidad interna: se fija aquí porque la
// configuración se resuelve al importar, y para entonces el cuerpo del test aún no ha corrido.
process.env['JARVIS_INTERNAL_SECRET'] = 'jarvis-test-internal-secret';
/*
 * A dónde cree el gateway que está el core.
 *
 * Por defecto es `core:8770`, el nombre del contenedor, que en una prueba no resuelve: el proxy
 * falla al conectar y nunca se llega a ejercitar lo que pasa cuando el core **sí** acepta y
 * luego calla, que es lo que N12 arregla. Con una dirección local, una prueba puede poner ahí un
 * servidor mudo. El plazo se acorta para no esperar treinta segundos por caso.
 */
process.env['JARVIS_CORE_URL'] = process.env['JARVIS_CORE_URL'] ?? 'http://127.0.0.1:8794';
process.env['JARVIS_CORE_TIMEOUT_MS'] = process.env['JARVIS_CORE_TIMEOUT_MS'] ?? '800';
process.env['JARVIS_TEST_TMP'] = dir;
