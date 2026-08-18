'use strict';

/**
 * `Placeholders.yaml` emission (§12.2) — Phase 4 Step 2.
 *
 * The subject is compile-time nesting expansion, which exists because Velvet Lattice
 * produces nested placeholders only by accident: `process_placeholders` substitutes in one
 * pass, in mapping order, and never re-runs over question values, so `%inner%` inside an
 * outer question resolves only when the inner key is iterated *later*. VL merges parent
 * keys ahead of local ones, so the natural layout — shared inner question at the root,
 * branch-specific outer question on a branch — is exactly the broken order.
 *
 * Expanding here removes the dependency: what VL receives is already nested, and its single
 * pass cannot get the order wrong.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const YAML = require('yaml');
const {
  expandQuestions, localKeysOf, writeNodePlaceholders, checkUndeclaredPlaceholders,
  checkPlaceholderContext, findAllPlaceholders, findNativePlaceholders,
  reportUnusedPlaceholders, FILENAME,
} = require('../../src/emit/placeholders');
const { CODES } = require('../../src/diag');

const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loom-ph-'));
  dirs.push(dir);
  return dir;
};

describe('expandQuestions', () => {
  test('expands {%variables} in question text', () => {
    const out = expandQuestions({ who: "What is your {%role}'s name?" }, { role: 'rival' });
    expect(out.who).toBe("What is your rival's name?");
  });

  test('expands a nested %key% into the AID native form', () => {
    const out = expandQuestions({
      liName: "What is your Love Interest's name?",
      liGender: 'What is %liName% gender?',
    }, {});
    expect(out.liGender).toBe("What is ${What is your Love Interest's name?} gender?");
  });

  test('order of declaration does not matter — the trap VL falls into', () => {
    const outerFirst = expandQuestions({
      liGender: 'What is %liName% gender?',
      liName: 'Name?',
    }, {});
    const innerFirst = expandQuestions({
      liName: 'Name?',
      liGender: 'What is %liName% gender?',
    }, {});
    expect(outerFirst.liGender).toBe('What is ${Name?} gender?');
    expect(innerFirst.liGender).toBe(outerFirst.liGender);
  });

  test('nests more than one level deep', () => {
    const out = expandQuestions({
      a: 'A?',
      b: 'B about %a%?',
      c: 'C about %b%?',
    }, {});
    expect(out.c).toBe('C about ${B about ${A?}?}?');
  });

  test('an undeclared reference is left as written, for §12.3 check 1 to report', () => {
    const warnings = [];
    const out = expandQuestions({ q: 'About %nobody%?' }, {}, {
      onWarn: (code, message) => warnings.push({ code, message }),
    });
    expect(out.q).toBe('About %nobody%?');
    expect(warnings).toHaveLength(0);
  });

  test('a cycle errors once and names the whole loop', () => {
    const warnings = [];
    const out = expandQuestions({
      a: 'A refers to %b%',
      b: 'B refers to %a%',
    }, {}, { onWarn: (code, message) => warnings.push({ code, message }) });

    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe(CODES.PLACEHOLDER_CYCLE);
    expect(warnings[0].message).toMatch(/a/);
    expect(warnings[0].message).toMatch(/b/);
    // The reference survives rather than expanding to something misleading — the ERROR is
    // the thing to act on, and a half-expanded question would read as intentional.
    expect(out.a).toContain('%b%');
  });

  test('a self-reference is a cycle', () => {
    const warnings = [];
    expandQuestions({ loop: 'Refers to %loop%' }, {}, {
      onWarn: (code) => warnings.push(code),
    });
    expect(warnings).toEqual([CODES.PLACEHOLDER_CYCLE]);
  });
});

describe('localKeysOf', () => {
  test('returns declared keys', () => {
    expect(localKeysOf({ placeholders: { a: 'A?', b: 'B?' } })).toEqual(['a', 'b']);
  });

  test('drops unbinds — a null question would emit ${} downstream', () => {
    expect(localKeysOf({ placeholders: { a: 'A?', b: null } })).toEqual(['a']);
  });

  test('a node declaring nothing contributes nothing', () => {
    expect(localKeysOf({})).toEqual([]);
    expect(localKeysOf(null)).toEqual([]);
  });
});

describe('writeNodePlaceholders', () => {
  test('emits only the keys the node adds, not the merged table', () => {
    const dir = tmp();
    const node = { placeholders: { local: 'Local?' } };
    const merged = { inherited: 'Inherited?', local: 'Local?' };
    writeNodePlaceholders(dir, node, merged, {});

    const written = YAML.parse(fs.readFileSync(path.join(dir, FILENAME), 'utf8'));
    expect(written).toEqual({ local: 'Local?' });
    expect(written.inherited).toBeUndefined();
  });

  test('a local question nesting an inherited key carries it inline', () => {
    // The cross-node case, and the reason expansion cannot be left to Velvet Lattice: VL
    // merges the parent's key ahead of this one, so its single pass would substitute the
    // inner key before the outer question existed in the text.
    const dir = tmp();
    const node = { placeholders: { liGender: 'What is %liName% gender?' } };
    const merged = { liName: 'Their name?', liGender: 'What is %liName% gender?' };
    writeNodePlaceholders(dir, node, merged, {});

    const written = YAML.parse(fs.readFileSync(path.join(dir, FILENAME), 'utf8'));
    expect(written.liGender).toBe('What is ${Their name?} gender?');
    expect(written.liName).toBeUndefined();
  });

  test('a node adding nothing writes no file', () => {
    const dir = tmp();
    expect(writeNodePlaceholders(dir, {}, { inherited: 'Inherited?' }, {})).toBeNull();
    expect(fs.existsSync(path.join(dir, FILENAME))).toBe(false);
  });

  test('a node that only unbinds writes no file — VL cannot express a removal', () => {
    const dir = tmp();
    writeNodePlaceholders(dir, { placeholders: { gone: null } }, {}, {});
    expect(fs.existsSync(path.join(dir, FILENAME))).toBe(false);
  });

  test('a stale file is removed when the node stops declaring anything', () => {
    // Otherwise the deleted declaration outlives its source: VL still reads the orphan and
    // still inherits it down the whole subtree.
    const dir = tmp();
    writeNodePlaceholders(dir, { placeholders: { a: 'A?' } }, { a: 'A?' }, {});
    expect(fs.existsSync(path.join(dir, FILENAME))).toBe(true);

    writeNodePlaceholders(dir, {}, {}, {});
    expect(fs.existsSync(path.join(dir, FILENAME))).toBe(false);
  });

  test('round-trips through YAML with characters that need quoting', () => {
    const dir = tmp();
    const question = 'Name: which one? (e.g. "Aness", or leave blank)';
    writeNodePlaceholders(dir, { placeholders: { q: question } }, { q: question }, {});
    expect(YAML.parse(fs.readFileSync(path.join(dir, FILENAME), 'utf8')).q).toBe(question);
  });
});

describe('checkUndeclaredPlaceholders', () => {
  const bus = () => {
    const found = [];
    return {
      found,
      diagnostics: {
        error: (code, message, loc, opts) => found.push({ code, message, hint: opts && opts.hint }),
      },
    };
  };

  test('a declared key is silent', () => {
    const { found, diagnostics } = bus();
    checkUndeclaredPlaceholders('Hello %heroName%.', { heroName: 'Name?' }, {
      diagnostics, where: 'a card',
    });
    expect(found).toHaveLength(0);
  });

  test('an undeclared key errors and names the site and branch', () => {
    const { found, diagnostics } = bus();
    checkUndeclaredPlaceholders('Hello %ghost%.', { heroName: 'Name?' }, {
      diagnostics, where: 'story card "Greeter"', branch: 'open',
    });
    expect(found).toHaveLength(1);
    expect(found[0].code).toBe(CODES.PLACEHOLDER_UNDECLARED);
    expect(found[0].message).toContain('story card "Greeter"');
    expect(found[0].message).toContain('open');
    // The declared list is the actionable half — an undeclared key is usually a typo of a
    // declared one, and the two are indistinguishable until printed together.
    expect(found[0].hint).toContain('heroName');
  });

  test('one key repeated in one text reports once', () => {
    const { found, diagnostics } = bus();
    checkUndeclaredPlaceholders('%x% and %x% and %x%', {}, { diagnostics, where: 'a card' });
    expect(found).toHaveLength(1);
  });

  test('prose percentages are not placeholders', () => {
    // VL's own pattern requires word characters between the delimiters, so "up 5% and down
    // 3%" has spaces where a key would be. Matching it would fire on ordinary prose.
    const { found, diagnostics } = bus();
    checkUndeclaredPlaceholders('Morale is up 5% and supplies down 3%.', {}, {
      diagnostics, where: 'a card',
    });
    expect(found).toHaveLength(0);
  });

  test('says so when nothing is declared, rather than printing an empty list', () => {
    const { found, diagnostics } = bus();
    checkUndeclaredPlaceholders('%x%', {}, { diagnostics, where: 'a card' });
    expect(found[0].hint).toMatch(/No placeholders are declared/);
  });

  test('skip suppresses names already reported against a finer location', () => {
    const { found, diagnostics } = bus();
    checkUndeclaredPlaceholders('%a% and %b%', {}, {
      diagnostics, where: 'component "Plot Essentials"', skip: new Set(['a']),
    });
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('%b%');
  });

  test('returns the names it reported, so a caller can build a skip set', () => {
    const { diagnostics } = bus();
    const reported = checkUndeclaredPlaceholders('%a% %b% %a%', {}, {
      diagnostics, where: 'a card',
    });
    expect(reported).toEqual(['a', 'b']);
  });
});

describe('findNativePlaceholders', () => {
  test('a nested placeholder is one occurrence, not a truncated match plus a tail', () => {
    // The reason this is brace-balanced rather than a regex: Codex Loom *emits* nesting
    // (§12.2), so a non-greedy matcher would misread the compiler's own output.
    expect(findNativePlaceholders('${What is ${Their name?} like?}'))
      .toEqual(['${What is ${Their name?} like?}']);
  });

  test('finds several in one text', () => {
    expect(findNativePlaceholders('${A?} then ${B?}')).toEqual(['${A?}', '${B?}']);
  });

  test('ignores a bare brace group with no dollar', () => {
    expect(findNativePlaceholders('{not a placeholder}')).toEqual([]);
  });
});

describe('findAllPlaceholders', () => {
  test('finds both spellings', () => {
    expect(findAllPlaceholders('%key% and ${Question?}'))
      .toEqual(['%key%', '${Question?}']);
  });
});

describe('checkPlaceholderContext', () => {
  const bus = () => {
    const found = [];
    return {
      found,
      diagnostics: {
        error: (code, message) => found.push({ code, message, severity: 'error' }),
        warn: (code, message) => found.push({ code, message, severity: 'warn' }),
      },
    };
  };

  test('text with no placeholder is silent', () => {
    const { found, diagnostics } = bus();
    checkPlaceholderContext('Ordinary prose.', { diagnostics, where: 'the Description', reason: 'r' });
    expect(found).toHaveLength(0);
  });

  test('a declared key is still an error where the destination forbids it', () => {
    // The context check takes no table. Where a placeholder cannot go, declaring it
    // changes nothing — which is what separates this from the undeclared check.
    const { found, diagnostics } = bus();
    checkPlaceholderContext('You play %heroName%.', {
      diagnostics, where: 'the Description', reason: 'never filled',
    });
    expect(found).toHaveLength(1);
    expect(found[0].code).toBe(CODES.PLACEHOLDER_INVALID_CONTEXT);
    expect(found[0].severity).toBe('error');
  });

  test('catches the native spelling too', () => {
    const { found, diagnostics } = bus();
    checkPlaceholderContext('You play ${Your name?}.', {
      diagnostics, where: 'the Description', reason: 'never filled',
    });
    expect(found).toHaveLength(1);
  });

  test('severity warn uses the title code', () => {
    const { found, diagnostics } = bus();
    checkPlaceholderContext('The %heroName% Path', {
      diagnostics, where: 'a branch title', severity: 'warn', reason: 'half-works',
    });
    expect(found[0].code).toBe(CODES.PLACEHOLDER_IN_TITLE);
    expect(found[0].severity).toBe('warn');
  });

  test('reports each distinct occurrence once', () => {
    const { found, diagnostics } = bus();
    checkPlaceholderContext('%a% %a% %b%', { diagnostics, where: 'x', reason: 'r' });
    expect(found).toHaveLength(2);
  });
});

describe('reportUnusedPlaceholders — §12.3 check 2', () => {
  const bus = () => {
    const found = [];
    return { found, diagnostics: { warn: (code, message) => found.push({ code, message }) } };
  };
  const usageOf = (pairs) => new Map(pairs.map(([k, paths]) => [k, new Set(paths)]));

  test('a key used somewhere beneath its declaring node is silent', () => {
    const { found, diagnostics } = bus();
    reportUnusedPlaceholders(
      [{ path: 'north', label: 'on branch "north"', keys: ['hold'] }],
      usageOf([['hold', ['north/keep']]]),
      { diagnostics },
    );
    expect(found).toHaveLength(0);
  });

  test('a root key used on one branch of three is silent — the whole point of the scope', () => {
    // An unscoped version of this check fires constantly on well-formed projects (§6.4):
    // declaring a placeholder at the root and using it on some branches is normal.
    const { found, diagnostics } = bus();
    reportUnusedPlaceholders(
      [{ path: '', label: 'at the project root', keys: ['saga'] }],
      usageOf([['saga', ['north']]]),
      { diagnostics },
    );
    expect(found).toHaveLength(0);
  });

  test('a branch key used only on a sibling still warns', () => {
    // The declaration does not reach the sibling, so the sibling's use is somebody else's
    // key with the same name — and this branch's prompt really does go nowhere.
    const { found, diagnostics } = bus();
    reportUnusedPlaceholders(
      [{ path: 'north', label: 'on branch "north"', keys: ['hold'] }],
      usageOf([['hold', ['south']]]),
      { diagnostics },
    );
    expect(found).toHaveLength(1);
    expect(found[0].code).toBe(CODES.PLACEHOLDER_UNUSED);
  });

  test('a prefix that is not a path boundary does not count as beneath', () => {
    // "northgate" starts with "north" as a string and is not under it as a branch.
    const { found, diagnostics } = bus();
    reportUnusedPlaceholders(
      [{ path: 'north', label: 'on branch "north"', keys: ['hold'] }],
      usageOf([['hold', ['northgate']]]),
      { diagnostics },
    );
    expect(found).toHaveLength(1);
  });

  test('a key never referenced anywhere warns', () => {
    const { found, diagnostics } = bus();
    reportUnusedPlaceholders(
      [{ path: '', label: 'at the project root', keys: ['ghost'] }],
      new Map(),
      { diagnostics },
    );
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('%ghost%');
  });
});
