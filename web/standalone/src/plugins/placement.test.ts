import { describe, it, expect } from 'vitest';
import { validatePlacement } from './placement';
const symbol = '(lib_symbols (symbol "Local:R" (symbol "R_0_1"))) (symbol (lib_id "Local:R") (uuid "11111111-2222-4333-8444-555555555555"))';
describe('plugin placement boundary', () => {
  it('accepts one matching symbol or one footprint for the appropriate editor', () => {
    expect(() => validatePlacement(symbol, 'eeschema')).not.toThrow();
    expect(() => validatePlacement('(footprint "Test")', 'pcbnew')).not.toThrow();
    expect(() => validatePlacement(symbol, 'pcbnew')).toThrow();
    expect(() => validatePlacement('(footprint "Test")', 'eeschema')).toThrow();
  });
  it('rejects extra roots, unrelated definitions and unsupported editor contexts', () => {
    expect(() => validatePlacement(symbol + ' (sheet)', 'eeschema')).toThrow();
    expect(() => validatePlacement(symbol.replace('(lib_id "Local:R")', '(lib_id "Other:R")'), 'eeschema')).toThrow();
    expect(() => validatePlacement(symbol, 'symbol_editor')).toThrow();
  });
  it('bounds parsing before the recursive parser and rejects malformed text', () => {
    expect(() => validatePlacement('('.repeat(60), 'eeschema')).toThrow(/limits/);
    expect(() => validatePlacement('x'.repeat(512 * 1024 + 1), 'eeschema')).toThrow();
    expect(() => validatePlacement(symbol + '\0', 'eeschema')).toThrow();
    expect(() => validatePlacement(')(', 'eeschema')).toThrow();
  });
  it.each([
    ['missing UUID', symbol.replace(/\(uuid [^)]+\)/, '')],
    ['invalid UUID', symbol.replace('11111111-2222-4333-8444-555555555555', 'not-a-uuid')],
    ['duplicate UUID', symbol.replace('(lib_id "Local:R")', '(uuid "11111111-2222-4333-8444-555555555555") (lib_id "Local:R")')],
    ['duplicate library ID', symbol.replace('(lib_id "Local:R")', '(lib_id "Local:R") (lib_id "Other:R")')],
    ['extra library ID arguments', symbol.replace('(lib_id "Local:R")', '(lib_id "Local:R" "Other:R")')],
    ['extra UUID arguments', symbol.replace('555555555555")', '555555555555" "extra")')],
    ['empty definitions', symbol.replace('(lib_symbols (symbol "Local:R" (symbol "R_0_1")))', '(lib_symbols)')],
    ['unrelated definition type', symbol.replace('(symbol "Local:R"', '(sheet "Local:R"')],
    ['trailing root atom', symbol + ' extra'],
    ['unterminated string', symbol + ' "unfinished'],
  ])('rejects %s before native parsing', (_name, text) => {
    expect(() => validatePlacement(text, 'eeschema')).toThrow();
  });
  it('counts UTF-8 bytes and forms, not just characters or nesting', () => {
    expect(() => validatePlacement('(footprint "' + 'é'.repeat(270000) + '")', 'pcbnew')).toThrow(/Invalid clipboard/);
    expect(() => validatePlacement('(footprint "Test" ' + '(pad)'.repeat(12001) + ')', 'pcbnew')).toThrow(/limits/);
  });
  it('ignores parentheses and escaped quotes within quoted properties', () => {
    const quoted = '(footprint "Test" (property "Value" "a (b) \\"quoted\\""))';
    expect(() => validatePlacement(quoted, 'pcbnew')).not.toThrow();
  });
});
