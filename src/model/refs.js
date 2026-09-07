'use strict';


const { CODES } = require('../diag');
const { damerauLevenshtein } = require('../util');

function splitRef(ref) {
  const text = String(ref);
  const at = text.indexOf(':');
  if (at === -1) return { source: null, id: text.trim().toLowerCase() };
  return {
    source: text.slice(0, at).trim().toLowerCase(),
    id: text.slice(at + 1).trim().toLowerCase(),
  };
}

function nearestCandidate(value, candidates) {
  let best = null;
  for (const candidate of candidates) {
    const distance = damerauLevenshtein(value.toLowerCase(), candidate.toLowerCase());
    const tolerance = Math.max(1, Math.floor(candidate.length / 3));
    if (distance <= tolerance && (!best || distance < best.distance)) best = { candidate, distance };
  }
  return best && best.candidate;
}

function refHint(value, candidates) {
  const suggestion = nearestCandidate(value, candidates);
  return suggestion ? `Did you mean "${suggestion}"?` : null;
}

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
        message: `reference "${label}" names undeclared library set "${source}"; use a set declared in structure.input.library.`,
        hint: known.length
          ? `Declared library sets: ${known.join(', ')}.`
          : 'No library sets are declared for this project.',
      };
    }

    const qualified = registry.qualified;
    const item = qualified ? qualified.get(`${source}:${id}`) : undefined;
    if (item) return { item };

    return {
      item: null,
      code: CODES.REF_NOT_FOUND,
      message: `library set "${source}" defines no item with id "${id}"; check the id or qualify a different set`,
      hint: refHint(id, qualified ? [...qualified.keys()]
        .filter((key) => key.startsWith(`${source}:`))
        .map((key) => key.slice(source.length + 1)) : []),
    };
  }

  const item = registry.get(id);
  if (item) return { item };

  const rival = registry.ambiguous ? registry.ambiguous.get(id) : undefined;
  if (rival && rival.length > 1) {
    const lines = rival
      .map((c) => `  library:${c._canonSource}  ${c._source}`)
      .join('\n');
    const options = rival.map((c) => `\`${c._canonSource}:${id}\``);
    return {
      item: null,
      code: CODES.AMBIGUOUS_REF,
      message: `reference "${id}" is defined in ${rival.length} library sets, so an unqualified import is ambiguous.\n${lines}`,
      hint: `Qualify the reference: ${options.join(' or ')}.`,
    };
  }

  return {
    item: null,
    code: CODES.REF_NOT_FOUND,
    message: `reference "${label}" names no item in the project or declared libraries`,
    hint: refHint(id, [...registry.keys()]),
  };
}

function describeRefFailure(result) {
  return result.hint ? `${result.message}\n${result.hint}` : result.message;
}

module.exports = { splitRef, resolveItemRef, describeRefFailure };
