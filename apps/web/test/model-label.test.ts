/**
 * Cómo se dice un modelo, y qué se acepta como tal antes de enviar.
 */
import { describe, expect, it } from 'vitest';
import { MODEL_ID_PATTERN } from '@jarvis/contracts';
import { MODEL_ID, modelLabel } from '../src/ui/labels.js';

describe('el nombre de un modelo, para leerlo', () => {
  it('un Claude se dice por familia y versión, con o sin fecha', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-sonnet-5')).toBe('Sonnet 5');
    expect(modelLabel('claude-haiku-5-5-20261001')).toBe('Haiku 5.5');
    expect(modelLabel('claude-opus-5-5[1m]')).toBe('Opus 5.5 [1m]');
  });

  it('un alias es el más reciente de su familia', () => {
    expect(modelLabel('opus')).toBe('Opus, el más reciente');
  });

  it('lo que no se reconoce se deja como está', () => {
    expect(modelLabel('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(modelLabel('anthropic/claude-sonnet-5')).toBe('anthropic/claude-sonnet-5');
    expect(modelLabel('claude-3-5-sonnet-20241022')).toBe('claude-3-5-sonnet-20241022');
  });
});

describe('qué se acepta como nombre de modelo', () => {
  const contract = new RegExp(MODEL_ID_PATTERN);
  const samples = [
    'claude-opus-5-5', 'opus', 'gpt-5.6-sol', 'anthropic/claude-sonnet-5', 'claude-opus-5-5[1m]',
    'ollama:qwen3@latest', '', '-m', '--dangerously-skip-permissions', 'opus; rm -rf ~', 'con espacio',
    'a'.repeat(128), 'a'.repeat(129), '$(whoami)', '`id`',
  ];

  it('la copia de la web dice lo mismo que el contrato, que es el que manda', () => {
    for (const sample of samples) expect(MODEL_ID.test(sample), sample).toBe(contract.test(sample));
  });

  it('nada que empiece por guion ni que lleve algo que una shell lea', () => {
    for (const bad of ['-m', '--yolo', 'opus; rm', '$(id)', 'a b']) expect(MODEL_ID.test(bad), bad).toBe(false);
  });
});
