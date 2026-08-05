# Errors & Warnings

Codex Loom prints errors and warnings to the console during compilation. Errors (fatal or per-item) prevent output from being written. Warnings indicate likely authoring mistakes or missing optional content but do not stop compilation.

> **Config and item loading now emit coded diagnostics.** Everything reported while
> reading `compile.yaml` and loading item files carries a `CL0nnn` code, a severity and a
> source position, and is documented in [Diagnostic codes](11-diagnostics.md) rather than
> here — for example, a missing input directory is now
> `WARN CL0120 compile.cl.yaml:4:13 / Items path not found: …` instead of a bare
> `WARN: cards path not found`.
>
> The messages below are the compile and render phases, which still print directly. They
> move onto the diagnostic bus as their modules are decomposed, and each one that moves
> is removed from this page and added to the code registry.

---

## Fatal Errors

These abort compilation entirely.

| Message | Cause | Fix |
|---|---|---|
| `Duplicate template name "x" found in <dir>` | Two `.template` files with the same name exist in the same directory tree. | Rename one of the files. Different directories are allowed to share names (later overrides earlier). |
| `Duplicate partial name "x" found in <dir>` | Two `.partial` files with the same name exist in the same directory tree. | Rename one of the files. |
| `Item in <context> is missing both id and name fields` | An item entry has neither `id:` nor `name:`. | Add an `id:` or `name:` field to the item. |
| `Duplicate item ID "x" in <context>` | Two items share the same ID in the same context (canon or project). | Change one item's `id:` to something unique. |
| `Item ID "x" exists in both canon and project` | A project item has the same ID as a canon item. | Use `import:` to extend the canon item instead of redefining it, or rename the project item. |
| `Duplicate item ID "x" across canon dirs` | Two items in different canon directories share the same ID. | Rename one of the canon items. |
| `PE file must be a YAML sequence: <path>` | The Plot Essentials YAML file is not a sequence. | Ensure the file starts with `-` entries (a YAML list). |
| `AIN file must be a YAML mapping: <path>` | The AI Instructions YAML file is not a mapping. | Ensure the file is a YAML object with `sections:` etc. |
| `AN file must be a YAML mapping: <path>` | The Author's Note YAML file is not a mapping. | Ensure the file is a YAML object with `sections:` etc. |
| `Failed to load YAML at <path>: <reason>` | A YAML file could not be parsed. | Fix the YAML syntax error in the file. |
| `Invalid aid.type "<type>" for item "<id>": <reason>` | After all `{%}`/`{$}` token resolution, an item's `aid.type` is not a legal folder/file name (illegal char `< > : " / \ | ? *`, control char, `.`/`..`, or trailing space/period). `aid.type` becomes `Story Cards/{type}/{type}.md`; it is validated against its fully-resolved value. | Fix the `aid.type` value (or the variable/field feeding it) so it is a valid path segment. Spaces inside the name are fine. |

---

## Per-Item Errors

These skip the affected item (or PE block) but allow compilation to continue.

| Message | Cause | Fix |
|---|---|---|
| `ERR resolving item "<id>": <reason>` | Item resolution failed — usually an import that couldn't be found. | Check the `import:` ID matches an item in canon. |
| `ERR: no template found for item "<id>" (type: <type>)` | Neither `render.template` nor `aid.type` matched any loaded template file. | Add a `.template` file named after the item's type, or set `render.template:` explicitly. |
| `ERR rendering item "<id>": <reason>` | An error occurred during template rendering (malformed function call, etc.). | Check the template for syntax errors. |
| `Import failed: no item with id "<id>" found in registry` | An `import:` entry references an ID not found in canon or project. | Check the ID spelling and that the canon directory is correctly configured. |
| `ERR [PE]: no item with id "<id>" found in registry` | A PE block's `import:` references an item that doesn't exist. | Fix the import ID in the PE file. |
| `ERR [PE]: resolving import "<id>": <reason>` | A PE item-body block failed to resolve its imported item. | Check the item ID and any variant path for typos. |
| `ERR [PE]: no template found for item "<id>"` | A PE item-body block's item has no matching template. | Ensure a template exists for the item's type, or add `render.template:` to the block. |
| `ERR [PE]: rendering item "<id>": <reason>` | An error occurred rendering a PE item block. | Check the template syntax. |

---

## Warnings

Warnings indicate likely authoring mistakes but do not stop compilation.

| Message | Cause | Fix |
|---|---|---|
| `WARN: variant "<name>" not found in variant tree of "<item>"` | A variant path references a variant name that doesn't exist in the variant tree. | Check the spelling of the variant name and ensure it's defined under `variants:` on the item. |
| `WARN: item "<id>" has multiple variable-block aliases (["v", "vars"]). Merging...` | An item definition has more than one of `v`/`var`/`vars`/`variable`/`variables` as sibling top-level keys. | Use a single alias consistently. Subfields are merged and last-writer-wins, but the result may not be what you intended. |
| `WARN: item "<id>" variant delta contains multiple variable-block aliases (["v", "vars"]). Merging...` | A variant delta has more than one variable-block alias as sibling keys. | Use a single alias in the variant. Subfields are merged last-writer-wins. |
| `WARN: item "<name>" has neither aid.type nor render.template` | An item has no type information — it cannot be rendered. | Add `aid.type:` or `render.template:` to the item. |
| `WARN: unexpanded variable {%key} in <label>` | A `{%key}` token survived into a rendered story card or component output. Usually the variable was undeclared (you'll also see `not declared`), or it was introduced by a later pass (cross-item ref / render function). Targets `{%}` only — a literal `{@…}` in a body is never flagged. | Declare the variable, fix the typo, or remove the stray token. |
| `WARN: unresolved token {$key} in <label>` | A `{$…}` field/pronoun/character token survived verbatim into rendered output — e.g. a misspelled pronoun, an unknown character ID, or a cross-item field miss. Targets `{$…}` only. (A field-ref miss in a *template* renders empty rather than surviving, so it is not flagged.) | Fix the field path / character ID, or remove the token. For names in item data use dotted `{$name.full}`/`{$name.display}`. |
| `WARN: component key "{@name}" not found` | A `{@name}` reference doesn't match any name in `structure.input.components`. | Check the component key spelling and configuration. |
| `WARN: openingChoice on leaf branch "<name>" — ignoring` | `openingChoice:` was declared on a leaf branch (it only applies to non-leaf nodes). | Move it to a non-leaf branch node, or use `opening:` instead. |
| `WARN: cross-item ref {$Id.body.FieldName} — item not found` | A cross-item body reference references an item ID not found in the compiled output. | Check that the referenced item is included in this branch and has the correct ID. |
| `WARN [PE]: file not found: <path>` | The Plot Essentials YAML file path doesn't exist. | Check the `components.plotEssential` path. |
| `WARN [PE]: no .hint template found for "<type>", falling back to full template` | A PE block with `style: hint` has no `.hint` template. | Create a `TypeName.hint.template` file or change the block's style. |
| `WARN [PE]: template "<name>" not found for inline block` | The `render.template` override on a freeform PE block doesn't match any loaded template. | Check the template name spelling. |
| `WARN [AIN]: file not found: <path>` | The AI Instructions YAML file path doesn't exist. | Check the `components.aiInstructions` path. |
| `WARN [AIN]: document variant "<name>" not found` | A branch variant dispatch references an AIN document variant that doesn't exist. | Check the variant name in the AIN file's `variants:` block. |
| `WARN [AN]: file not found: <path>` | The Author's Note YAML file path doesn't exist. | Check the `components.authorsNote` path. |
| `WARN [AN]: Author's Note does not support "item:" block — ignoring` | An AN file has a `item:` block, which is only valid for AIN files. | Remove the `item:` block from the AN file. |
| `WARN: No branch leaves found — nothing to compile.` | The output directory has no branch leaf folders for the overview generator to scan. | Run a full compile first before generating a leaf review. |

---

## Common Authoring Mistakes

**"No template found" for an item**

The most common cause is a mismatch between the item's `aid.type` value and the template filename. Both are matched case-insensitively. If your item has `aid.type: Character`, the template must be named `Character.template`.

**"Import failed: no item with id"**

Check that:
1. The canon directory is correctly declared in `compile.yaml` under `structure.input.canon`
2. The item ID in the `import:` entry matches the item's `id:` field (or `name:` if `id:` is absent) in the canon file
3. The canon file is within the configured canon directory (loaded recursively)

**"Variant not found" but the variant exists**

Variant dispatch uses the **item definition's** variant tree. For imports, `importVariants:` sources from the **canonical item's** variant tree — not the import definition's `variants:` block. The import definition's `variants:` block holds local named deltas for branch dispatch only.

**"Cross-item ref not found"**

Cross-item refs (`{$Id.body.FieldName}`) are resolved after all items for a branch are compiled. If the referenced item has `only:` or `except:` filters that exclude it from the current branch, it won't be available for cross-item resolution.
