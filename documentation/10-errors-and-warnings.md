# Errors & Warnings

Codex Loom prints errors and warnings to the console during compilation. Errors (fatal or per-card) prevent output from being written. Warnings indicate likely authoring mistakes or missing optional content but do not stop compilation.

---

## Fatal Errors

These abort compilation entirely.

| Message | Cause | Fix |
|---|---|---|
| `Duplicate template name "x" found in <dir>` | Two `.template` files with the same name exist in the same directory tree. | Rename one of the files. Different directories are allowed to share names (later overrides earlier). |
| `Duplicate partial name "x" found in <dir>` | Two `.partial` files with the same name exist in the same directory tree. | Rename one of the files. |
| `Card in <context> is missing both id and name fields` | A card entry has neither `id:` nor `name:`. | Add an `id:` or `name:` field to the card. |
| `Duplicate card ID "x" in <context>` | Two cards share the same ID in the same context (canon or project). | Change one card's `id:` to something unique. |
| `Card ID "x" exists in both canon and project` | A project card has the same ID as a canon card. | Use `import:` to extend the canon card instead of redefining it, or rename the project card. |
| `Duplicate card ID "x" across canon dirs` | Two cards in different canon directories share the same ID. | Rename one of the canon cards. |
| `PE file must be a YAML sequence: <path>` | The Plot Essentials YAML file is not a sequence. | Ensure the file starts with `-` entries (a YAML list). |
| `AIN file must be a YAML mapping: <path>` | The AI Instructions YAML file is not a mapping. | Ensure the file is a YAML object with `sections:` etc. |
| `AN file must be a YAML mapping: <path>` | The Author's Note YAML file is not a mapping. | Ensure the file is a YAML object with `sections:` etc. |
| `Failed to load YAML at <path>: <reason>` | A YAML file could not be parsed. | Fix the YAML syntax error in the file. |

---

## Per-Card Errors

These skip the affected card (or PE block) but allow compilation to continue.

| Message | Cause | Fix |
|---|---|---|
| `ERR resolving card "<id>": <reason>` | Card resolution failed — usually an import that couldn't be found. | Check the `import:` ID matches a card in canon. |
| `ERR: no template found for card "<id>" (type: <type>)` | Neither `render.template` nor `aid.type` matched any loaded template file. | Add a `.template` file named after the card's type, or set `render.template:` explicitly. |
| `ERR rendering card "<id>": <reason>` | An error occurred during template rendering (malformed function call, etc.). | Check the template for syntax errors. |
| `Import failed: no card with id "<id>" found in registry` | An `import:` entry references an ID not found in canon or project. | Check the ID spelling and that the canon directory is correctly configured. |
| `ERR [PE]: no card with id "<id>" found in registry` | A PE block's `import:` references a card that doesn't exist. | Fix the import ID in the PE file. |
| `ERR [PE]: resolving import "<id>": <reason>` | A PE card-body block failed to resolve its imported card. | Check the card ID and any variant path for typos. |
| `ERR [PE]: no template found for card "<id>"` | A PE card-body block's card has no matching template. | Ensure a template exists for the card's type, or add `render.template:` to the block. |
| `ERR [PE]: rendering card "<id>": <reason>` | An error occurred rendering a PE card block. | Check the template syntax. |

---

## Warnings

Warnings indicate likely authoring mistakes but do not stop compilation.

| Message | Cause | Fix |
|---|---|---|
| `WARN: cards path not found: <path>` | A `structure.input.cards` directory does not exist. | Check the path in `compile.yaml`. |
| `WARN: canon "<name>" path not found: <path>` | A `structure.input.canon` directory does not exist. | Check the canon path in `compile.yaml`. |
| `WARN: templates path not found: <path>` | A `structure.input.templates` directory does not exist. | Check the templates path in `compile.yaml`. |
| `WARN: include path not found: <path>` | An `include:` path does not exist. | Check the include path and canon directory configuration. |
| `WARN: variant "<name>" not found in variant tree of "<card>"` | A variant path references a variant name that doesn't exist in the variant tree. | Check the spelling of the variant name and ensure it's defined under `variants:` on the card. |
| `WARN: card "<name>" has neither aid.type nor render.template` | A card has no type information — it cannot be rendered. | Add `aid.type:` or `render.template:` to the card. |
| `WARN: cycle detected in variable "{%key}"` | A `{%variable}` reference forms a cycle with another variable. | Remove the circular reference in `variables:`. |
| `WARN: variable "{%key}" not declared` | A `{%key}` reference in a template or field has no matching entry in `variables:`. | Declare the variable in `compile.yaml` or fix the typo. |
| `WARN: component key "{@name}" not found` | A `{@name}` reference doesn't match any name in `structure.input.components`. | Check the component key spelling and configuration. |
| `WARN: openingChoice on leaf branch "<name>" — ignoring` | `openingChoice:` was declared on a leaf branch (it only applies to non-leaf nodes). | Move it to a non-leaf branch node, or use `opening:` instead. |
| `WARN: cross-card ref {$Id.body.FieldName} — card not found` | A cross-card body reference references a card ID not found in the compiled output. | Check that the referenced card is included in this branch and has the correct ID. |
| `WARN [PE]: file not found: <path>` | The Plot Essentials YAML file path doesn't exist. | Check the `components.plotEssential` path. |
| `WARN [PE]: no .hint template found for "<type>", falling back to full template` | A PE block with `style: hint` has no `.hint` template. | Create a `TypeName.hint.template` file or change the block's style. |
| `WARN [PE]: template "<name>" not found for inline block` | The `render.template` override on a freeform PE block doesn't match any loaded template. | Check the template name spelling. |
| `WARN [AIN]: file not found: <path>` | The AI Instructions YAML file path doesn't exist. | Check the `components.aiInstructions` path. |
| `WARN [AIN]: document variant "<name>" not found` | A branch variant dispatch references an AIN document variant that doesn't exist. | Check the variant name in the AIN file's `variants:` block. |
| `WARN [AN]: file not found: <path>` | The Author's Note YAML file path doesn't exist. | Check the `components.authorsNote` path. |
| `WARN [AN]: Author's Note does not support "card:" block — ignoring` | An AN file has a `card:` block, which is only valid for AIN files. | Remove the `card:` block from the AN file. |
| `WARN: No branch leaves found — nothing to compile.` | The output directory has no branch leaf folders for the overview generator to scan. | Run a full compile first before generating a leaf review. |

---

## Common Authoring Mistakes

**"No template found" for a card**

The most common cause is a mismatch between the card's `aid.type` value and the template filename. Both are matched case-insensitively. If your card has `aid.type: Character`, the template must be named `Character.template`.

**"Import failed: no card with id"**

Check that:
1. The canon directory is correctly declared in `compile.yaml` under `structure.input.canon`
2. The card ID in the `import:` entry matches the card's `id:` field (or `name:` if `id:` is absent) in the canon file
3. The canon file is within the configured canon directory (loaded recursively)

**"Variant not found" but the variant exists**

Variant dispatch uses the **card definition's** variant tree. For imports, `importVariants:` sources from the **canonical card's** variant tree — not the import definition's `variants:` block. The import definition's `variants:` block holds local named deltas for branch dispatch only.

**"Cross-card ref not found"**

Cross-card refs (`{$Id.body.FieldName}`) are resolved after all cards for a branch are compiled. If the referenced card has `only:` or `except:` filters that exclude it from the current branch, it won't be available for cross-card resolution.
