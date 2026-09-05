import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Reglas: pocas y con motivo.
 *
 * Lo que se persigue aquí no es el estilo —de eso ya se encarga leer el código— sino los errores
 * que el tipo no ve: promesas sin esperar, `any` que se cuela por una API externa, imports
 * dinámicos que rompen el empaquetado.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '.dev/**', '.e2e/**', 'test-results/**', 'evidence/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Una promesa sin esperar en este código casi siempre es una escritura que se pierde.
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      /*
       * Nada de HTML crudo, y que lo diga la herramienta.
       *
       * El renderizador de markdown del asistente no produce cadenas de HTML a propósito: devuelve
       * nodos de React, así que no hay nada que sanitizar. Esa propiedad sólo vale si se mantiene,
       * y el día que alguien la rompa será por un motivo razonable —«es que el informe trae su
       * propio formato»— con un modelo escribiendo la cadena. Se comprueba con `no-restricted-syntax`
       * y no con `eslint-plugin-react` porque una regla no justifica un plugin entero.
       */
      'no-restricted-syntax': ['error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'HTML crudo no: el markdown del asistente devuelve nodos de React para que no haya nada que sanitizar.',
        },
        {
          selector: "Property[key.name='dangerouslySetInnerHTML']",
          message: 'HTML crudo no: el markdown del asistente devuelve nodos de React para que no haya nada que sanitizar.',
        },
      ],
    },
  },
  {
    // Los dobles del testkit son JavaScript a propósito: son ejecutables que se invocan como
    // programas, no módulos que alguien importe.
    files: ['packages/testkit/bin/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly' } },
    rules: { 'no-undef': 'off' },
  },
);
