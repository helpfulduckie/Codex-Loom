'use strict';

const { splitRef, normalizeRef, resolveItemRef, describeRefFailure, CODES } = require('../../src/model/refs');
const { ItemRegistry } = require('../../src/loader/registry');

describe('splitRef', () => {
  test('a plain id is lowercased and trimmed', () => {
    expect(splitRef('  Kaiden  ')).toEqual({ source: null, id: 'kaiden' });
  });

  test('a qualified ref splits on the first colon', () => {
    expect(splitRef('grimwood:magic')).toEqual({ source: 'grimwood', id: 'magic' });
  });

  test('splits on the FIRST colon only', () => {
    expect(splitRef('grimwood:magic:extra')).toEqual({ source: 'grimwood', id: 'magic:extra' });
  });

  test('whitespace around the colon is tolerated', () => {
    expect(splitRef(' Grimwood : Magic ')).toEqual({ source: 'grimwood', id: 'magic' });
  });
});

describe('normalizeRef', () => {
  test('a plain ref round-trips to its lowercased id', () => {
    expect(normalizeRef('Kaiden')).toBe('kaiden');
  });

  test('a qualified ref round-trips to "source:id"', () => {
    expect(normalizeRef('Grimwood:Magic')).toBe('grimwood:magic');
  });
});

describe('resolveItemRef — plain Map (no sidecars)', () => {
  test('a plain hit resolves', () => {
    const registry = new Map([['kaiden', { id: 'kaiden' }]]);
    expect(resolveItemRef(registry, 'Kaiden')).toEqual({ item: { id: 'kaiden' } });
  });

  test('a miss reports REF_NOT_FOUND with the pre-§17 wording', () => {
    const registry = new Map();
    const result = resolveItemRef(registry, 'x');
    expect(result.item).toBeNull();
    expect(result.code).toBe(CODES.REF_NOT_FOUND);
    expect(result.message).toBe('no item with id "x" found in registry');
  });
});

describe('resolveItemRef — ItemRegistry', () => {
  function buildRegistry() {
    const registry = new ItemRegistry();
    registry.sources.add('grimwood');
    registry.sources.add('hollow');

    const grimwoodMagic = { id: 'magic', _canonSource: 'grimwood', _source: 'grimwood/magic.yaml' };
    const hollowMagic = { id: 'magic', _canonSource: 'hollow', _source: 'hollow/magic.yaml' };
    registry.qualified.set('grimwood:magic', grimwoodMagic);
    registry.qualified.set('hollow:magic', hollowMagic);
    registry.ambiguous.set('magic', [grimwoodMagic, hollowMagic]);

    const soleItem = { id: 'kaiden', _canonSource: 'grimwood', _source: 'grimwood/kaiden.yaml' };
    registry.set('kaiden', soleItem);
    registry.qualified.set('grimwood:kaiden', soleItem);

    return registry;
  }

  test('a qualified ref hits its item', () => {
    const registry = buildRegistry();
    expect(resolveItemRef(registry, 'grimwood:kaiden').item.id).toBe('kaiden');
  });

  test('an ambiguous plain ref reports both canon sources and a hint naming both qualified forms', () => {
    const registry = buildRegistry();
    const result = resolveItemRef(registry, 'magic');
    expect(result.item).toBeNull();
    expect(result.code).toBe(CODES.AMBIGUOUS_REF);
    expect(result.message).toContain('canon:grimwood');
    expect(result.message).toContain('canon:hollow');
    expect(result.hint).toContain('grimwood:magic');
    expect(result.hint).toContain('hollow:magic');
  });

  test('a qualifier naming an undeclared canon set reports UNKNOWN_CANON_SOURCE', () => {
    const registry = buildRegistry();
    const result = resolveItemRef(registry, 'nowhere:magic');
    expect(result.item).toBeNull();
    expect(result.code).toBe(CODES.UNKNOWN_CANON_SOURCE);
    expect(result.message).toContain('"nowhere:magic"');
    expect(result.hint).toContain('grimwood');
    expect(result.hint).toContain('hollow');
  });

  test('a known set that lacks the id reports REF_NOT_FOUND', () => {
    const registry = buildRegistry();
    const result = resolveItemRef(registry, 'hollow:kaiden');
    expect(result.item).toBeNull();
    expect(result.code).toBe(CODES.REF_NOT_FOUND);
    expect(result.message).toContain('canon set "hollow"');
  });
});

describe('describeRefFailure', () => {
  test('joins message and hint with a newline', () => {
    const result = { message: 'msg', hint: 'hint' };
    expect(describeRefFailure(result)).toBe('msg\nhint');
  });

  test('returns the message alone when there is no hint', () => {
    const result = { message: 'msg' };
    expect(describeRefFailure(result)).toBe('msg');
  });
});
