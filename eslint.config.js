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
