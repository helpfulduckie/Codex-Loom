'use strict';

/**
 * Item reference resolution (v4 spec §17.2–§17.3).
 *
 * A reference is either a plain id — `kaiden` — or qualified with the canon set that owns
 * it — `grimwood:magic`. Qualification is optional, and needed only where two canon sets
 * define the same id. §17.3 reports that collision here, at the reference, rather than at
 * registry build: loading two sets that both define `magic` is a fact about the sets, not a
 * fault in a project that references neither of them or references both qualified.
 *
 * Pure by §3.3 — nothing is thrown or printed. A failed lookup comes back as a described
 * result and the caller decides whether that becomes a throw, a console line, or a
 * diagnostic. A plain `Map` carrying none of the sidecars resolves exactly as it did before
 * this module existed, which is what keeps the test corpus's hand-built registries working.
 */

const CODES = Object.freeze({
  AMBIGUOUS_REF: 'CL0340',
  UNKNOWN_CANON_SOURCE: 'CL0341',
  REF_NOT_FOUND: 'CL0342',
});

/**
 * Split a reference into `{ source, id }`, both lowercased.
 *
 * `:` is illegal inside an item id (§17.2), so the first colon is unambiguously the
 * separator and there is no need to scan for the last one.
 */
function splitRef(ref) {
  const text = String(ref);
  const at = text.indexOf(':');
  if (at === -1) return { source: null, id: text.trim().toLowerCase() };
  return {
    source: text.slice(0, at).trim().toLowerCase(),
    id: text.slice(at + 1).trim().toLowerCase(),
  };
}

/** The canonical spelling of a reference — what overlay keys and dedupe sets are keyed by. */
function normalizeRef(ref) {
  const { source, id } = splitRef(ref);
  return source === null ? id : `${source}:${id}`;
}

/**
 * Resolve a reference against a registry.
 *
 * Returns `{ item }` on success, or `{ item: null, code, message, hint }` describing why
 * not. `message` for the not-found case deliberately keeps its pre-§17 wording, because it
 * is the one this function produces that was already being read by people.
 */
function resolveItemRef(registry, ref) {
  const { source, id } = splitRef(ref);
  const label = String(ref);

  if (source !== null) {
    const sources = registry.sources;
    if (sources && !sources.has(source)) {
      const known = [...sources].sort();
      return {
        item: null,
        code: CODES.UNKNOWN_CANON_SOURCE,
        message: `"${label}" names canon set "${source}", which is not declared in structure.input.canon.`,
        hint: known.length
          ? `Declared canon sets: ${known.join(', ')}.`
          : 'No canon sets are declared for this project.',
      };
    }

    const qualified = registry.qualified;
    const item = qualified ? qualified.get(`${source}:${id}`) : undefined;
    if (item) return { item };

    return {
      item: null,
      code: CODES.REF_NOT_FOUND,
      message: `no item with id "${id}" found in canon set "${source}"`,
    };
  }

  const item = registry.get(id);
  if (item) return { item };

  const rival = registry.ambiguous ? registry.ambiguous.get(id) : undefined;
  if (rival && rival.length > 1) {
    const lines = rival
      .map((c) => `  canon:${c._canonSource}  ${c._source}`)
      .join('\n');
    const options = rival.map((c) => `\`${c._canonSource}:${id}\``);
    return {
      item: null,
      code: CODES.AMBIGUOUS_REF,
      message: `"${id}" is defined in ${rival.length} canon sets.\n${lines}`,
      hint: `Qualify the reference: ${options.join(' or ')}.`,
    };
  }

  return {
    item: null,
    code: CODES.REF_NOT_FOUND,
    message: `no item with id "${label}" found in registry`,
  };
}

/** The failure text as one string — for call sites that throw rather than collect. */
function describeRefFailure(result) {
  return result.hint ? `${result.message}\n${result.hint}` : result.message;
}

module.exports = { splitRef, normalizeRef, resolveItemRef, describeRefFailure, CODES };
