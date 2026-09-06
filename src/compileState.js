'use strict';

const { CODES: DIAG_CODES } = require('./diag');
const { loadComponentDocument } = require('./loader/component');
const { DESCRIPTION_DESCRIPTOR } = require('./emit/components');


class PlaceholderTracker {
  constructor() {
    this.usage = new Map();
    this.declarations = [];
    this.duplicates = new Map();
  }
}

class RoleTracker {
  constructor() {
    this.usage = new Set();
    this.declarations = [];
    this.onUsed = (key) => this.usage.add(String(key).toLowerCase());
  }
}

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
        if (loaded && loaded.metadata && !descriptor.frontmatter) {
          this._diagnostics.warn(
            DIAG_CODES.COMPONENT_METADATA_UNSUPPORTED,
            `"${descriptor.label}" declares metadata:, which is written as frontmatter and `
            + `only ${DESCRIPTION_DESCRIPTOR.file} carries any — Velvet Lattice reads scenario `
            + 'tags from there. The metadata is ignored here.',
            { file: String(spec) },
          );
        }
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
