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

These skip the affected item but allow compilation to continue.

**Component and placement problems are coded diagnostics, not free-text messages.** The `[PE]`, `[AIN]` and `[AN]` messages that used to appear here belonged to the separate resolvers Plot Essentials, AI Instructions and Author's Note each ran, and those are gone — every component now takes one path. A slot named by no component, a section that is not a slot, an empty slot, and an item that produces no output on a branch are `CL0610`–`CL0615` in [11-diagnostics.md](11-diagnostics.md). A component whose file is missing or empty is reported at the end of the compile as a requested component that produced no output.

| Message | Cause | Fix |
|---|---|---|
| `ERR resolving item "<id>": <reason>` | Item resolution failed — usually an import that couldn't be found. | Check the `import:` ID matches an item in canon. |
| `ERR: no template found for item "<id>" (type: <type>)` | Neither `render.template` nor `aid.type` matched any loaded template file. | Add a `.template` file named after the item's type, or set `render.template:` explicitly. |
| `ERR rendering item "<id>": <reason>` | An error occurred during template rendering (malformed function call, etc.). | Check the template for syntax errors. |
| `Import failed: no item with id "<id>" found in registry` | An `import:` entry references an ID not found in canon or project. | Check the ID spelling and that the canon directory is correctly configured. |

---

## Warnings

Warnings indicate likely authoring mistakes but do not stop compilation.

| Message | Cause | Fix |
|---|---|---|
| `WARN: variant "<name>" not found in variant tree of "<item>"` | A variant path references a variant name that doesn't exist in the variant tree. | Check the spelling of the variant name and ensure it's defined under `variants:` on the item. |
| `WARN: item "<id>" has multiple variable-block aliases (["v", "vars"]). Merging...` | An item definition has more than one of `v`/`var`/`vars`/`variable`/`variables` as sibling top-level keys. | Use a single alias consistently. Subfields are merged and last-writer-wins, but the result may not be what you intended. |
| `WARN: item "<id>" variant delta contains multiple variable-block aliases (["v", "vars"]). Merging...` | A variant delta has more than one variable-block alias as sibling keys. | Use a single alias in the variant. Subfields are merged last-writer-wins. |
| `WARN: item "<name>" emits a story card but has neither aid.type nor render.template` | A story card has no type information, so no template can be selected for it. Items routed only into components are exempt — a `template:` on the target specifies them, and `render.storyCard: false` with no target is `CL0610` instead. | Add `aid.type:` or `render.template:`, or set `render.storyCard: false` if it was only ever meant to render into a component. |
| `WARN: component key "{%name}" not found` | A `{%name}` reference doesn't match any name in `variables`. | Check the component key spelling and configuration. |
| `WARN: branchFraming on leaf branch "<name>" — ignoring` | `branchFraming:` was declared on a leaf branch (it only applies to non-leaf nodes). | Move it to a non-leaf branch node, or use `opening:` instead. |
| `WARN: cross-item ref {$Id.body.FieldName} — item not found` | A cross-item body reference references an item ID not found in the compiled output. | Check that the referenced item is included in this branch and has the correct ID. |
| `WARN: No branch leaves found — nothing to compile.` | The output directory has no branch leaf folders for the overview generator to scan. | Run a full compile first before generating a leaf review. |

---

## Leaked artifacts are errors, and they fail the build

**A token that survives into compiled output means the compiler failed, and the failure is
sitting in the file it wrote.** An unresolved `{$she}`, an unexpanded `{%era}`, a leaked
`{join}` or `{if}`, an unresolved `[s]`, an `[object Object]` — each is a fact about the
output rather than an opinion about it, so each is an ERROR with a code, and a project
carrying one no longer exits zero. They are `CL0430`–`CL0435` in
[Diagnostic codes](11-diagnostics.md).

**Before this they printed a bare `WARN:` line and gated nothing**, while `--lint` listed
the same patterns as errors — one check with two answers, depending on which half of the
tool you ran. If a project of yours starts failing here, it was shipping a leaked token
before and the compile was not telling you.

Two checks in the same sweep stay warnings, because both are guesses about prose rather
than facts about output: a bracketed word that is not one of the five real conjugation
markers (`CL0436`, e.g. `[does]` for `[s]`), and a bare `undefined`/`NaN` (`CL0437`), which
is also two ordinary English words. Those two are part of the opinion layer, so
`lint.level` can turn them down or off.

---

## Turning the opinion layer down — `lint.level`

**`lint.level` decides which of Codex Loom's opinions you hear; it cannot touch the
facts.** The distinction is the point: an unknown key, an undeclared role, a platform cap,
a leaked token — those are things the compiler knows are wrong, and no setting silences
them. What `level` reaches are the quality heuristics: trigger-less cards, prose guesses,
unused placeholder declarations, and the findings of convention packs.

```yaml
lint:
  level: error        # off | error | warn
```

Read `error` as **"validate my mod configs, skip the prose heuristics"** — that is what
choosing it does, and it is the reason to choose it. The three values:

| `level` | What you hear from the opinion layer |
|---|---|
| `off` | Nothing. |
| `error` | Only its errors — pack findings about mod config. The prose heuristics are all warnings, so they disappear. |
| `warn` | Everything, and nothing in the layer can fail your build: an opinion-layer error is reported as a warning instead. |
| *(unset)* | Everything, at the severity each finding was raised with. This is the default. |

`--lint-level=off|error|warn` overrides the config key for one run. It is deliberately
separate from `--verbose`, which is about compile progress rather than about which
diagnostics you want.

**`--lint` honors `lint.level` too, as long as it can find your `compile.cl.yaml`.** Point it
at a project directory or a config path and it reads the key; point it at a bare output tree
and there is no config to read, so only the flag applies. The flag wins over the key either
way — it is what you typed for this run, the key is what the project says every run.

**`lint.level` written on a *branch* is not applied, and says so.** A per-branch ceiling
needs a diagnostic to know which branch raised it, which arrives with convention packs; until
then a branch-level `level:` draws a `CL0204` "not yet implemented" warning rather than
looking like it worked. `lint.packs` on a branch is fine and merges down the chain normally.

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
