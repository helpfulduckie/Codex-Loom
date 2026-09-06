'use strict';


const { CODES } = require('../diag');

function splitRef(ref) {
  const text = String(ref);
  const at = text.indexOf(':');
  if (at === -1) return { source: null, id: text.trim().toLowerCase() };
  return {
    source: text.slice(0, at).trim().toLowerCase(),
    id: text.slice(at + 1).trim().toLowerCase(),
  };
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
        message: `"${label}" names library set "${source}", which is not declared in structure.input.library.`,
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
      message: `no item with id "${id}" found in library set "${source}"`,
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
      message: `"${id}" is defined in ${rival.length} library sets.\n${lines}`,
      hint: `Qualify the reference: ${options.join(' or ')}.`,
    };
  }

  return {
    item: null,
    code: CODES.REF_NOT_FOUND,
    message: `no item with id "${label}" found in registry`,
  };
}

function describeRefFailure(result) {
  return result.hint ? `${result.message}\n${result.hint}` : result.message;
}

module.exports = { splitRef, resolveItemRef, describeRefFailure };
