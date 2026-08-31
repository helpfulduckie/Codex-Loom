'use strict';

const { CODES: DIAG_CODES } = require('./diag');
const { loadComponentDocument } = require('./loader/component');
const { DESCRIPTION_DESCRIPTOR } = require('./emit/components');

/**
 * The shared mutable state of a `compileRun`, grouped into the cohesive clusters the
 * decomposed phases actually pass around. Each class is a bundle plus the closures that
 * have to stay stable references across every render path — not a behavior change: the
 * fields hold exactly what the loose `Map`/`Set`/closure locals held before.
 */

/**
 * Placeholder bookkeeping. `usage` is every declared key a written text referenced, keyed
 * by branch path; `declarations` and `duplicates` are filled by `writePlaceholdersRecursive`
 * and drained by the unused / duplicate-question checks in `finalizeDiagnostics`.
 */
class PlaceholderTracker {
  constructor() {
    this.usage = new Map();
    this.declarations = [];
    this.duplicates = new Map();
  }
}

/**
 * Role bookkeeping for `CL0545`. `onUsed` is the success callback threaded into every
 * render path (`resolveRole` calls it only on a bind that did something); `usage` names
 * every role a resolved token bound to; `declarations` is the output of the whole-tree
 * role-declaration pass.
 */
class RoleTracker {
  constructor() {
    this.usage = new Set();
    this.declarations = [];
    this.onUsed = (key) => this.usage.add(String(key).toLowerCase());
  }
}

/**
 * Requested-but-unwritten components. `record` is threaded into the leaf loop and the
 * scenario-blurb writer; `finalizeDiagnostics` turns each entry into an error and, if any
 * exist at all, the spine throws.
 */
class GapList {
  constructor() {
    this.entries = [];
    this.record = (leaf, component, spec, reason) => this.entries.push({
      leaf, component, spec: spec == null ? '(none)' : String(spec), reason,
    });
  }

  get length() {
    return this.entries.length;
  }
}

/**
 * The sectioned-component loader. A component document is read, validated and normalized
 * once per resolved path (its `imports:` chain included) rather than once per leaf, so a
 * schema violation or an import cycle reaches the author once instead of once for every
 * leaf that names the component. The `metadata:` guards (`CL0619`–`CL0621`) fire on the
 * cache miss for the same reason. `dependencyLedger` is every path any load touched —
 * `imports:` targets included — which is what the dependency-coverage sweep in
 * `finalizeDiagnostics` needs and what `_docs` (keyed by top-level spec) cannot answer.
 */
class ComponentLoader {
  constructor({ diagnostics, variables, base }) {
    this._diagnostics = diagnostics;
    this._variables = variables;
    this._base = base;
    this._docs = new Map();
    this.dependencyLedger = new Set();

    this.load = (spec, descriptor) => {
      if (!this._docs.has(spec)) {
        const loaded = loadComponentDocument(spec, {
          diagnostics: this._diagnostics,
          label: descriptor.label,
          variables: this._variables,
          base: this._base,
          dependencyLedger: this.dependencyLedger,
        });
        // `metadata:` is declared on every component and emitted by the ones whose output
        // has somewhere to put frontmatter — Description today. Reported on the cache miss
        // so the author hears it once, rather than once per leaf.
        if (loaded && loaded.metadata && !descriptor.frontmatter) {
          this._diagnostics.warn(
            DIAG_CODES.COMPONENT_METADATA_UNSUPPORTED,
            `"${descriptor.label}" declares metadata:, which is written as frontmatter and `
            + `only ${DESCRIPTION_DESCRIPTOR.file} carries any — Velvet Lattice reads scenario `
            + 'tags from there. The metadata is ignored here.',
            { file: String(spec) },
          );
        }
        // The other half of the same flag. `adventureDescription` shares `Description.md`
        // with the scenario blurb and so inherits `frontmatter: true`, but
        // only the blurb should carry `advanced:` and `description:`. Both are Scenario
        // fields VL reads at the root and nowhere else, and the markdown one has no adventure
        // equivalent the player could undo. Checked on the cache miss with CL0620, so an
        // author hears it once rather than once per leaf.
        if (loaded && loaded.metadata && descriptor.key === 'adventureDescription') {
          const offending = ['advanced', 'description']
            .filter((key) => Object.prototype.hasOwnProperty.call(loaded.metadata, key));
          if (offending.length > 0) {
            this._diagnostics.error(
              DIAG_CODES.ADVENTURE_DESCRIPTION_ADVANCED,
              `"${descriptor.label}" declares ${offending.map((k) => `${k}:`).join(' and ')} in `
              + 'metadata:, which belongs to the scenario blurb only.',
              { file: String(spec) },
              {
                hint: 'Velvet Lattice reads both keys at the root and nowhere else, so they do '
                  + 'nothing at a leaf today. AID has no markdown description for an adventure, '
                  + 'and if it gains one this frontmatter would set a field the player cannot '
                  + `change. Move them to the ${DESCRIPTION_DESCRIPTOR.label} component; other `
                  + 'metadata keys are fine here.',
              },
            );
          }
        }
        this._docs.set(spec, loaded);
      }
      return this._docs.get(spec);
    };
  }
}

module.exports = {
  PlaceholderTracker, RoleTracker, GapList, ComponentLoader,
};
