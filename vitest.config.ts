import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Los paquetes usan imports con extensión `.js` (NodeNext), que es lo correcto en producción.
 * En los tests queremos las fuentes TypeScript directamente, sin un paso de compilación entre
 * escribir y ver el fallo, así que aquí se reescriben a `.ts` cuando el fichero existe.
 */
const tsSources = (): Plugin => ({
  name: 'jarvis-ts-sources',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer || !source.startsWith('.') || !source.endsWith('.js')) return null;
    const candidate = resolve(dirname(importer), source.replace(/\.js$/, '.ts'));
    return existsSync(candidate) ? candidate : null;
  },
});

const alias = {
  '@jarvis/contracts': resolve(root, 'packages/contracts/src/index.ts'),
  '@jarvis/agent-adapters': resolve(root, 'packages/agent-adapters/src/index.ts'),
  '@jarvis/testkit': resolve(root, 'packages/testkit/src/index.ts'),
};

export default defineConfig({
  plugins: [tsSources()],
  resolve: { alias },
  test: {
    projects: [
      {
        plugins: [tsSources()],
        resolve: { alias },
        test: {
          name: 'contracts',
          include: ['packages/legacy-contract-tests/test/**/*.test.ts'],
          environment: 'node',
          // Los contratos del runner arrancan tmux y procesos de verdad: no caben en 5 segundos.
          testTimeout: 60_000,
          fileParallelism: false,
        },
      },
      {
        plugins: [tsSources()],
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['packages/{contracts,agent-adapters,testkit}/test/**/*.test.ts', 'apps/{core,gateway}/test/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/setup/env.ts'],
        },
      },
      /*
       * La web, aparte y no dentro de `unit`.
       *
       * `unit` es `environment: 'node'` y así tiene que seguir. Lo que se prueba aquí es el parser
       * de markdown, que es una función pura de cadena a descriptores y no necesita DOM: por eso
       * está partido en dos: la parte con casos raros —esquemas de enlace, tope de tamaño, tabla
       * mal cerrada— se prueba sin navegador y sin una sola dependencia nueva. El día que haga
       * falta afirmar sobre lo renderizado, este proyecto cambia a jsdom y `unit` no se entera.
       */
      {
        plugins: [tsSources()],
        resolve: { alias },
        test: {
          name: 'web',
          include: ['apps/web/test/**/*.test.ts'],
          environment: 'node',
        },
      },
      /*
       * La pantalla, con un DOM de verdad.
       *
       * Va aparte de `web` porque aquélla prueba funciones puras en `node` —el parser de markdown— y
       * eso tiene que seguir siendo barato. Aquí se monta React contra jsdom, que cuesta más y sólo
       * hace falta para lo que **únicamente se ve montando**: que un artifact con la forma
       * equivocada no desmonte la conversación entera, que un envío fallido no borre lo escrito, que
       * el stream deje de reintentar.
       *
       * Nada de eso se puede ver desde el core por definición, y nada de eso lo cazó la suite de 571
       * que estaba en verde mientras los tres fallos existían.
       *
       * Va con `include` de `*.dom.test.tsx` para que se distingan de un vistazo y no haya que
       * abrirlas para saber cuál necesita navegador.
       */
      {
        plugins: [tsSources(), react()],
        resolve: { alias },
        test: {
          name: 'web-dom',
          include: ['apps/web/test/**/*.dom.test.tsx'],
          environment: 'jsdom',
        },
      },
      {
        plugins: [tsSources()],
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/setup/env.ts'],
          testTimeout: 120_000,
          hookTimeout: 60_000,
          // Los tests de integración levantan procesos y hablan con tmux: en paralelo se pisan.
          fileParallelism: false,
        },
      },
    ],
  },
});
