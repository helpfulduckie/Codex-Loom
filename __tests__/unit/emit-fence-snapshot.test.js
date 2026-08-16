'use strict';

/**
 * The fence snapshot over the kitchen-sink item corpus.
 *
 * `kitchen-sink.test.js` pins the item *key surface* — which keys exist and validate.
 * This pins what the emitter *writes* for that surface: the `## title` heading, the `~~~`
 * fence, the trigger line, the unconditional `encapsulate: false`, and `notes:`. Between
 * them the corpus is checked at both ends, which is what the schema tests alone could not
 * do — a key can validate perfectly and still reach AID as the wrong bytes.
 *
 * The envelope is the subject, so bodies are a stub. `emit/vl.js:renderCard` takes a
 * body already rendered and already wrapped (§8.4), and asserting on template output here
 * would just re-test `template.test.js` through a second door.
 *
 * Items are rendered straight off the loaded YAML rather than through resolution. Every
 * field the envelope reads — `name`, `aid.title`, `aid.triggers`, `notes` — is a declared
 * item field, not a resolved one, so resolution would add a dependency without adding
 * coverage. The corpus cannot be resolved anyway: its `import:` and `include:` name things
 * that deliberately do not exist, because its subject is the key surface.
 *
 * One step of resolution has to be reproduced, though. `description:` is an alias that
 * `model/item.js` collapses into `notes:` before the emitter ever runs (§4.5), so rendering
 * raw YAML shows the `description:` item with *no notes line at all* — recording an absence
 * the real pipeline never produces. `collapseNotesAlias` below applies that one step, using
 * `util.NOTES_ALIASES` so it cannot drift from the alias set the compiler honors.
 */

const path = require('path');

const { Diagnostics } = require('../../src/diag');
const { loadYamlDocument } = require('../../src/loader/yaml');
const { renderCard } = require('../../src/emit/vl');
const { NOTES_ALIASES } = require('../../src/util');

/**
 * The `description:` → `notes:` collapse from `model/item.js`, and nothing else about
 * resolution. Mirrors that function's rule: a non-`notes` alias moves into `notes` only
 * when `notes` is unset, since declaring both is an ERROR the schema half already covers.
 */
function collapseNotesAlias(item) {
  const out = { ...item };
  for (const key of Object.keys(out)) {
    if (NOTES_ALIASES.has(key.toLowerCase()) && key !== 'notes') {
      if (out.notes === undefined) out.notes = out[key];
      delete out[key];
    }
  }
  return out;
}

const ITEMS_PATH = path.resolve(
  __dirname, '../fixtures/kitchen-sink/Codex/items.cl.yaml',
);

/**
 * The post-flip spelling of the background-knowledge flag.
 *
 * Phase 2 removed `aid.known` with the envelope (§8.2.1) and moved the flag onto the item
 * as `notes: {known: true}`, for a notes template to render. The corpus does not carry
 * that shape — it predates the flip — and it is the shape behind a known user-visible
 * failure: with no notes template bound, rung 4 renders the mapping literally and the
 * card reaches AID with `notes: 'known: true'` in it, configuration keys and all.
 *
 * It is declared here rather than added to `items.cl.yaml` because four assertions in
 * `kitchen-sink.test.js` are computed over that corpus, and this file should not be able
 * to move them.
 */
const KNOWN_FLAG_ITEM = {
  id: 'Kaiden (known flag)',
  name: 'Kaiden',
  aid: { type: 'Character', triggers: ['Kaiden'] },
  notes: { known: true },
};

describe('emit/vl.js fence — kitchen-sink corpus', () => {
  let items;

  beforeAll(() => {
    ({ value: items } = loadYamlDocument(ITEMS_PATH));
    items = items.map(collapseNotesAlias);
  });

  test('renders the envelope for every corpus item', () => {
    const diagnostics = new Diagnostics();
    const rendered = items.map((item) => {
      const { text } = renderCard({
        item,
        bodyText: `<body of ${item.id}>`,
        diagnostics,
      });
      return text;
    });
    expect(rendered.join('\n\n———\n\n')).toMatchSnapshot();
  });

  test('renders the post-flip known flag as literal notes text', () => {
    const { text } = renderCard({
      item: KNOWN_FLAG_ITEM,
      bodyText: '<body>',
      diagnostics: new Diagnostics(),
    });
    expect(text).toMatchSnapshot();
    // The failure mode itself, asserted rather than left to snapshot review.
    expect(text).toContain("notes: 'known: true'");
  });

  /**
   * The four shapes the corpus exists to pin, named individually so a snapshot review
   * that goes green by accident still has to explain these.
   */
  describe('the shapes the corpus was built to cover', () => {
    let byId;

    beforeAll(() => {
      const diagnostics = new Diagnostics();
      byId = new Map(items.map((item) => [
        item.id,
        renderCard({ item, bodyText: '', diagnostics }).text,
      ]));
    });

    test('underscore padding decodes to spaces in the trigger line (§4.2)', () => {
      expect(byId.get('Aness')).toContain("triggers: [Aness, Vale, ' Aria', 'Voss ']");
    });

    test('a scalar trigger renders as a one-element list', () => {
      expect(byId.get('Wyvern')).toContain('triggers: [Wyvern]');
    });

    test('an empty trigger list omits the key rather than writing []', () => {
      // §4.8: `kind: reference` may legitimately have none, and `triggers: []` is noise.
      expect(byId.get('WTG Time Config')).not.toContain('triggers:');
    });

    test('every card carries the unconditional encapsulate: false (§8.4)', () => {
      for (const text of byId.values()) expect(text).toContain('encapsulate: false');
    });

    /**
     * `render.wrapper` is deliberately absent from all of this. The corpus carries all
     * three values (`curly` on Aness, `none` on Wyvern, `square` on Kaiden), but §8.4
     * applies the wrapper to the *body* before `renderCard` is called — the emitter never
     * sees the key. The wrapper cases are `applyWrapper` in `template.test.js`; asserting
     * them here would assert on the stub body and pass no matter what the wrapper did.
     */
    test('the wrapper never appears in the envelope', () => {
      for (const text of byId.values()) expect(text).not.toContain('wrapper');
    });
  });
});
