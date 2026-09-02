'use strict';

/**
 * Binds the fenced examples in documentation/NN-*.md to live code, so a feature change
 * that outdates a chapter makes noise in the suite. Before this there was no definition of
 * "done" for the docs the way a code change can point at the tests.
 *
 * Two kinds of binding:
 *
 * ── 1. Schema surface (every ```yaml block) ────────────────────────────────────
 *
 * The block's surface is *declared* in the fence info string, not inferred (this replaces
 * `scripts/check-doc-examples.js`, whose file→surface table rotted on any reorg):
 *
 *     ```yaml surface=config level=structure.input
 *     ```yaml surface=item
 *     ```yaml surface=component
 *     ```yaml surface=fieldtable
 *     ```yaml check=none reason=<why>
 *
 * `surface=` picks the schema; `level=` (config only) walks it down a dotted path first.
 * `check=none` opts a block out — an illustrative fragment, pseudo-YAML with
 * `<placeholders>`, or a v3 shape with no v4 surface. A bare ```yaml fence fails.
 *
 * A schema check is a floor: it proves a documented key exists and is well-typed, not that
 * the surrounding prose describes the behavior correctly.
 *
 * ── 2. Render-and-compare (a `transform=` / `expect=` fence pair) ──────────────
 *
 * For a chapter that shows an input and the output it produces, the two fences are tagged
 * and the transform is actually run:
 *
 *     ```js transform=script-banner id=<pair>
 *     ...input...
 *     ```
 *     ``` expect=<pair>
 *     ...the exact output the prose claims...
 *     ```
 *
 * The test runs the named transform on the input and asserts it equals the `expect` block
 * byte-for-byte. This is the layer that catches *behavioral* drift. Grown per chapter only
 * where a binding earns its keep — see TRANSFORMS for the current roster.
 *
 * Precedent for a doc-binding test: `diag.test.js`'s "REGISTRY agrees with
 * documentation/11-diagnostics.md" block.
 */

const fs = require('fs');
const path = require('path');

const { validate } = require('../../src/schema');
const { CONFIG_SCHEMA } = require('../../src/config/schema');
const { ITEM_SCHEMA } = require('../../src/loader/schema');
const { COMPONENT_SCHEMA } = require('../../src/loader/component-schema');
const { FIELD_TABLE_SCHEMA } = require('../../src/loader/field-table-schema');
const { Diagnostics } = require('../../src/diag');
const { parseYaml } = require('../../src/loader/yaml');
const { scriptBanner } = require('../../src/extract');
const { stanzaSource } = require('../../src/render/field-list');
const { render } = require('../../src/template');
const { applyFieldOp } = require('../../src/model/fieldops');
const { applyTokenPass } = require('../../src/model/pronouns');
const { resolveBranchSpec, enumerateLeaves } = require('../../src/model/branches');
const { convertOpening } = require('../../src/migrate/opening');
const { convertDescription } = require('../../src/migrate/description');
const { isDeepStrictEqual } = require('util');

const DOCS = path.join(__dirname, '../../documentation');

const SURFACE_SCHEMA = {
  config: CONFIG_SCHEMA,
  item: ITEM_SCHEMA,
  component: COMPONENT_SCHEMA,
  fieldtable: FIELD_TABLE_SCHEMA,
};

/**
 * Fixture item contexts for the `render-template` transform. A chapter's worked examples
 * all read one running character; declaring it here once, with values chosen to match the
 * outputs the prose states, is what makes those `→` claims checkable. `context=<name>` on
 * the fence picks one.
 */
const CONTEXTS = {
  aness: {
    id: 'Aness',
    name: { display: 'Aness', full: 'Aness Rozen' },
    pronouns: 'female',
    aid: { title: 'Aness Rozen', type: 'Character', triggers: ['Aness', 'Rozen'] },
    render: { template: 'Character', wrapper: 'none' },
    v: { affiliation: 'Zenus Institute' },
    body: {
      Tagline: 'Journeyman Healer; Magic Researcher',
      'Physical Traits': {
        gender: 'female',
        age: 'mid 20s',
        hair: 'black hair, braided, waist-length',
        eyes: 'brown eyes',
        build: 'tall, willowy build',
      },
      Personality: {
        keywords: ['inquisitive', 'polite', 'sarcastic', 'compassionate'],
        expanded: 'She leaps to explore theory.',
      },
      Magic: {
        affinity: 'high ice-affinity; moderate growth-affinity',
        effect: ['water whip attacks', 'minor water shields', 'small healing spells'],
      },
      Background: ['a journeyman healer', 'assigned to the Zenus project'],
    },
  },
};
// A copy whose keyword list holds a single element — the "single-element array" cases.
CONTEXTS['aness-min'] = JSON.parse(JSON.stringify(CONTEXTS.aness));
CONTEXTS['aness-min'].body.Personality.keywords = ['inquisitive'];

/**
 * The render-and-compare roster. A `transform=<name>` input fence is run as `fn(body, ann)`
 * and compared to its `expect=` partner. Transforms stay dependency-light — a pure function
 * or one fed a hand-built plain-object context; anything needing a project on disk belongs
 * in its own integration test.
 *
 *   script-banner    src/extract.js scriptBanner — a JS comment block → cleaned prose
 *   stanza-source    src/render/field-list.js stanzaSource — one or more `fields:` entries →
 *                    the `.template` source they are shorthand for, joined `\n\n` as
 *                    renderFieldList joins them. Input may be a bare `name: {…}` map or
 *                    wrapped in `fields:`.
 *   render-template  src/template.js render — a `.template` body string rendered against
 *                    the `context=<name>` fixture in CONTEXTS.
 *   field-op         src/model/fieldops.js applyFieldOp — input YAML is `{ current, op }`;
 *                    the result is deep-compared to the `expect` block parsed as YAML
 *                    (STRUCTURAL), since a field op returns arrays and mappings, not strings.
 *   pronoun-pass     src/model/pronouns.js applyTokenPass — input YAML is
 *                    `{ text, cast?, item?, itemPronouns?, protagonist? }`; `cast` becomes a
 *                    registry, `protagonist` the active branch protagonist, and the token +
 *                    conjugation pass runs over `text`.
 *   branch-dispatch  src/model/branches.js — input YAML is `{ spec, path }`
 *                    (→ resolveBranchSpec, the variant list or null) or `{ leaves }`
 *                    (→ enumerateLeaves, the leaf paths). STRUCTURAL.
 *   migrate-opening  src/migrate/opening.js convertOpening — a v3 opening block list →
 *                    `{ sections }`. STRUCTURAL. The `expect` block carries `surface=component`
 *                    too, so the v4 output is schema-checked as well as diffed.
 *   migrate-description  src/migrate/description.js convertDescription — a v3
 *                    `description.yaml` two-field doc → `{ sections }`. STRUCTURAL.
 */
const TRANSFORMS = {
  'script-banner': (src) => scriptBanner(src),
  'stanza-source': (src) => {
    const doc = parseYaml(src, '<stanza-source>').value;
    const fields = doc && typeof doc === 'object' && doc.fields ? doc.fields : doc;
    return Object.entries(fields)
      .map(([name, decl]) => stanzaSource({ name, decl }))
      .join('\n\n');
  },
  'render-template': (src, ann) => {
    const ctx = CONTEXTS[ann.context];
    if (!ctx) throw new Error(`render-template needs a known context=<name>; got "${ann.context}"`);
    return render(src, ctx, new Map(), null, {});
  },
  'field-op': (src) => {
    const { current, op } = parseYaml(src, '<field-op>').value;
    return applyFieldOp(current, op);
  },
  'branch-dispatch': (src) => {
    const spec = parseYaml(src, '<branch-dispatch>').value;
    if (spec && spec.leaves !== undefined) return enumerateLeaves(spec.leaves);
    return resolveBranchSpec(spec.spec, spec.path || []);
  },
  'migrate-opening': (src) => {
    const blocks = parseYaml(src, '<migrate-opening>').value;
    return { sections: convertOpening(blocks, src, '.').sections };
  },
  'migrate-description': (src) => {
    const doc = parseYaml(src, '<migrate-description>').value;
    return { sections: convertDescription(doc).sections };
  },
  'pronoun-pass': (src) => {
    const spec = parseYaml(src, '<pronoun-pass>').value;
    const registry = new Map();
    for (const [id, def] of Object.entries(spec.cast || {})) {
      registry.set(id.toLowerCase(), { id, ...def });
    }
    const subject = spec.item
      ? registry.get(spec.item.toLowerCase())
      : { id: '_self', pronouns: spec.itemPronouns };
    return applyTokenPass(spec.text, {
      item: subject,
      registry,
      branchProtagonist: spec.protagonist ? String(spec.protagonist).toLowerCase() : null,
      resolvedById: registry,
      roles: null,
      onWarn: () => {},
      onRoleUsed: () => {},
    });
  },
};

/** Transforms whose output is a value, not a string — compared by deep equality. */
const STRUCTURAL = new Set(['field-op', 'branch-dispatch', 'migrate-opening', 'migrate-description']);

/** Required-key complaints are meaningless against a fragment that shows one key. */
const NOISE = new Set(['CL0203']);

/** Walk a schema down a dotted level path, following record/seq `of` for `*` and `[]`. */
function descend(schema, level) {
  if (!level || level === '(root)') return schema;
  let node = schema;
  for (const seg of level.split('.')) {
    if (!node) return null;
    if (seg === '*' || seg === '[]') { node = node.of; continue; }
    node = node.keys ? node.keys[seg] : null;
  }
  return node;
}

function parseInfo(info) {
  const out = {};
  for (const tok of info.split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf('=');
    if (eq === -1) out[tok] = true;
    else out[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return out;
}

/**
 * Every fenced block in a chapter, as `{ file, line, lang, info, body }`. A proper toggle
 * scan (open on the first ``` line, close on the next), so bare ``` fences — the `expect=`
 * blocks and illustrative output — are handled, not just ```yaml.
 */
function extractBlocks(file) {
  const lines = fs.readFileSync(path.join(DOCS, file), 'utf8').split(/\r?\n/);
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^```([A-Za-z0-9_-]*)[ \t]*(.*?)[ \t]*$/);
    if (!m) {
      if (open) open.body.push(lines[i]);
      continue;
    }
    if (open) {
      blocks.push({ file, line: open.line, lang: open.lang, info: open.info, body: open.body.join('\n') });
      open = null;
    } else {
      open = { line: i + 1, lang: m[1], info: m[2].trim(), body: [] };
    }
  }
  return blocks;
}

const files = fs.readdirSync(DOCS).filter((f) => /^\d\d-.*\.md$/.test(f)).sort();
const blocks = files.flatMap(extractBlocks);
const yamlBlocks = blocks.filter((b) => b.lang === 'yaml' || b.lang === 'yml');

describe('every documentation YAML block declares its surface', () => {
  // The annotation is itself a surface that can drift: a new block added with a bare
  // ```yaml fence, or a typo in `surface=`, is caught here rather than silently skipped.
  test('the chapters were found and scanned', () => {
    expect(yamlBlocks.length).toBeGreaterThan(100);
  });

  test.each(yamlBlocks.map((b) => [`${b.file}:${b.line}`, b]))('%s', (_label, b) => {
    const ann = parseInfo(b.info);
    // A ```yaml fence must say what it is: a schema surface, an opt-out, or a half of a
    // render-and-compare pair (`transform=` input or `expect=` output).
    const declared = Boolean(ann.surface) || ann.check === 'none'
      || Boolean(ann.transform) || Boolean(ann.expect);
    expect({ block: `${b.file}:${b.line}`, declared, info: b.info })
      .toEqual({ block: `${b.file}:${b.line}`, declared: true, info: b.info });
    if (ann.surface) expect(Object.keys(SURFACE_SCHEMA)).toContain(ann.surface);
    if (ann.check === 'none') expect(ann.reason).toBeTruthy();
    if (ann.transform) expect(ann.id).toBeTruthy();
  });
});

describe('documentation YAML validates against its declared surface', () => {
  const checkable = yamlBlocks.filter((b) => parseInfo(b.info).surface);

  test.each(checkable.map((b) => [`${b.file}:${b.line}`, b]))('%s', (_label, b) => {
    const ann = parseInfo(b.info);
    const where = `surface=${ann.surface}${ann.level ? ` level=${ann.level}` : ''}`;

    let doc;
    try {
      doc = parseYaml(b.body, `${b.file}:${b.line}`).value;
    } catch (e) {
      throw new Error(
        `${b.file}:${b.line} is annotated ${where} but does not parse as YAML: ${e.message}\n`
        + 'If the block is illustrative, annotate it `check=none reason=…` instead.',
      );
    }
    if (doc === undefined || doc === null) return;

    const diags = new Diagnostics();

    if (ann.surface === 'item') {
      const items = Array.isArray(doc) ? doc : [doc];
      items.forEach((it, n) => {
        if (it && typeof it === 'object' && !Array.isArray(it)) {
          validate(it, ITEM_SCHEMA, { diagnostics: diags, path: [String(n)], displayOffset: 1 });
        }
      });
    } else {
      const node = descend(SURFACE_SCHEMA[ann.surface], ann.level);
      if (!node) throw new Error(`${b.file}:${b.line}: level "${ann.level}" does not resolve in the ${ann.surface} surface`);
      validate(doc, node, { diagnostics: diags });
    }

    const errors = diags.all.filter((d) => d.severity === 'error' && !NOISE.has(d.code));
    if (errors.length) {
      throw new Error(
        `${b.file}:${b.line} (${where}) fails schema validation:\n  `
        + errors.map((d) => `${d.code} ${d.message}`).join('\n  ')
        + '\nEither the doc names a key the compiler removed, or the annotation is wrong.',
      );
    }
  });
});

describe('documentation transforms produce their documented output', () => {
  const inputs = blocks.filter((b) => parseInfo(b.info).transform);
  const expected = new Map();
  for (const b of blocks) {
    const id = parseInfo(b.info).expect;
    if (id) expected.set(id, b);
  }

  test('every transform= fence has an expect= partner, and vice versa', () => {
    const inputIds = inputs.map((b) => parseInfo(b.info).id).sort();
    const expectIds = [...expected.keys()].sort();
    expect({ inputIds, expectIds }).toEqual({ inputIds: expectIds, expectIds });
  });

  const cases = inputs.map((b) => [`${b.file}:${b.line} (${parseInfo(b.info).transform})`, b]);
  test.each(cases)('%s', (_label, b) => {
    const ann = parseInfo(b.info);
    const fn = TRANSFORMS[ann.transform];
    expect(Object.keys(TRANSFORMS)).toContain(ann.transform);

    const want = expected.get(ann.id);
    expect(want).toBeDefined();

    const raw = fn(b.body, ann);

    if (STRUCTURAL.has(ann.transform)) {
      const wanted = parseYaml(want.body, `${want.file}:${want.line}`).value;
      if (!isDeepStrictEqual(raw, wanted)) {
        throw new Error(
          `${b.file}:${b.line}: transform "${ann.transform}" no longer produces the value at `
          + `${want.file}:${want.line}.\n--- doc claims ---\n${JSON.stringify(wanted)}\n`
          + `--- code produces ---\n${JSON.stringify(raw)}\n`
          + '\nAdjudicate: the doc may be stale, or the change may be a regression.',
        );
      }
      return;
    }

    const got = String(raw).replace(/\s+$/, '');
    const wanted = want.body.replace(/\s+$/, '');
    if (got !== wanted) {
      throw new Error(
        `${b.file}:${b.line}: transform "${ann.transform}" no longer produces the output at `
        + `${want.file}:${want.line}.\n--- doc claims ---\n${wanted}\n--- code produces ---\n${got}\n`
        + '\nAdjudicate: the doc may be stale, or the change may be a regression.',
      );
    }
  });
});
