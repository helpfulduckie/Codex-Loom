# Migrating a v3 Project to v4

v4 is a clean break from v3: the config format changed, the four component
syntaxes collapsed into one, templates lost their envelope, and the `{@name}`
reference family was removed. This page is the whole conversion — what
`codex-loom --migrate` does for you, and the hand edits for the cases it flags
for review.

Everything here is a one-time move. Once a project is on v4 none of it applies
again, and the rest of the documentation describes v4 as it stands with no
reference back to this page.

---

## Run `--migrate` first

**`codex-loom --migrate path/to/project/` converts a v3 project in place and
does not compile.** It rewrites `compile.yaml`, every item file, every template
and every component document to the v4 schema, then writes
`migration-report.md` alongside the config listing every file it touched and a
review queue of the conversions that need a human eye. Run `codex-loom` again
once the report is clear.

**`--migrate --rename-cl` additionally gives every file the project reads the
`.cl.yaml` / `.cl.yml` extension** — the config, every item and library file,
and every component document named by path (its `components:` reference is
rewritten to match). The suffix is optional — plain `.yaml` still loads — but
it marks a file as Codex Loom's rather than something else's, which lets an
editor key syntax highlighting to `*.cl.yaml`. If a project has already
migrated without it, `codex-loom --rename-cl path/to/project/` applies the
rename on its own.

`--migrate` runs alone; it cannot be combined with a compile or a report mode.

---

## `{@name}` references become `{%name}`

**v3 had a second reference family, `{@name}`, declared under
`structure.input.components` and `structure.input.canon`.** It is removed. Its
lookup searched every per-type map in sequence and returned the first name
match, so `{@pe}` resolved identically no matter which type declared it — no
project could depend on the grouping, because the grouping never worked.

**Library names are now auto-exposed as `{%variable}` tokens**, so
`{%characters}/Aness.yaml` does what `{@characters}/Aness.yaml` used to. That
leaves one naming system. A library name colliding with a declared
variable is an ERROR (`CL0521`), since the two now share a namespace.

`--migrate` rewrites `{@}` references automatically: a name declared under the
old `structure.input.canon` changes sigil, and a component alias is replaced by
the value it was declared as.

---

## Migrating a v3 template

**A v3 template opened with the envelope, and everything below the last `~~~`
was the body.** Delete everything up to and including that line — that is the
whole conversion, and `--migrate` does it mechanically. Keep any `{wrapper}`
tag that lived in the header: it wraps the body, not the envelope.

**Then check the surviving body for `{$aid.encapsulate}`, `{$aid.known}`, and
any `{$aid.title}` the migrator dropped** as a duplicate of `name.full`. Those
tokens now render empty rather than failing loudly.

Two envelope keys a v3 template could read are gone with the envelope:

- **`aid.encapsulate`** — the compiler writes `encapsulate: false` on every
  card unconditionally now. It was never a real choice: every site in the
  Velvet Lattice loader defaults it to true and false is what the output needs.
- **`aid.known`** — existed only so a template could write
  `{if $aid.known}notes: '[e]'{/if}`. The flag moves onto the item as
  `notes: {known: true}` and a notes template renders it — see
  [Item YAML](03-item-yaml.md). Declaring either key now is an unknown-key ERROR.

**`style: hint` is gone, and a `.hint` file is no longer resolved by name.**
With `style:` removed a `.hint` file is an ordinary template — name it in a
render target's `template:` and it is used. Existing `Character.hint.template`
files keep working; they are just selected explicitly now. See
[Components](09-components.md) for the per-target `template:` syntax, which is
what `style: hint` used to reach for and is more flexible: the story card and
the Plot Essentials entry can name any two templates rather than one template
and its `.hint` sibling.

**A local `.partial` override is not auto-converted.** A project's copy of a
shared partial that adds behavior on top of it has no `--migrate` step: an
arbitrary partial delta cannot be expressed as `label` / `labelWhen` /
added-field declarations in general, so `.template` and `.partial` stay the
escape hatch. Re-author the override by hand as a project `fields.cl.yaml`
table, or leave it as a partial.

---

## Migrating a v3 `notes: '[e]'` marker

**v3 emitted the `[e]` background-knowledge marker as flat text; v4 carries it
as a flag.** `--migrate` converts `notes: '[e]'` to:

```yaml surface=item
notes: {known: true}
```

and reports that a notes template is still needed — without one the flag is
carried and never written. The difference matters twice: a convention pack
cannot read `[e]` back out of free text, and a branch that does not load the
mod the marker belongs to needs a way to switch the string off, which swapping
the notes template provides and a baked-in string does not.

A scalar `notes: '[e]'` is still valid; it simply renders verbatim and cannot
be varied per branch.

---

## Migrating a v3 block-list opening

**v3 pointed `opening:` at a YAML sequence of paragraph blocks**, each with its
own `branches:` and `variants:`. That format is gone — it was the fourth of
four syntaxes for one idea, and its variant rules disagreed with every other
dispatch in the language. `--migrate` converts it; a block-list opening reaching
the compiler is an error naming what it should become.

Before — the v3 block list:

```yaml transform=migrate-opening id=migrate-blocklist-opening
- text: "A world of magic and intrigue awaits."
- text: "You have mastered the arcane arts."
  variants:
    researcher-mage:
      text: "You have mastered the arcane arts, informed by archival research."
  branches:
    researcher:
      branches: {mage: researcher-mage, _: ~}
    _: ~
- text: "{%paragraphs}/knight-oath.md"
```

After — `--migrate` produces named sections, `text:` split from `file:`, and (unnamed blocks) `blockN` names to rename before sharing:

```yaml surface=component expect=migrate-blocklist-opening
sections:
  block1:
    text: "A world of magic and intrigue awaits."
  block2:
    text: "You have mastered the arcane arts."
    variants:
      researcher-mage:
        text: "You have mastered the arcane arts, informed by archival research."
    branches:
      researcher:
        branches: {mage: researcher-mage, _: ~}
      _: ~
  block3:
    file: "{%paragraphs}/knight-oath.md"
```

Three things change, and only one of them can alter output:

- **Blocks get names.** A name is what lets an importing project override,
  reposition or delete a section, which an anonymous block could never allow.
  The migrator takes names from the comment above each block where the author
  left one and generates `blockN` otherwise — rename them before sharing the
  file.
- **`text:` stops being overloaded.** v3 decided whether a block's `text:` was
  prose or a path by testing the string against the filesystem on every
  compile, so prose that looked like a path was silently read as one. `text:`
  and `file:` are separate keys, and the migrator answers the question once.
- **A dispatch naming two variants now applies both.** v3 applied the first and
  silently discarded the rest. This is the one difference that can move output,
  and the migrator emits a note for any block carrying more than one variant.

---

## Migrating a v3 Plot Essentials file

**A v3 Plot Essentials file validated against the v4 grammar reports `blocks:`
as an unknown key**, which is the intended signal. `blocks:` were anonymous and
could only ever be replaced wholesale; v4 sections are named, so an importing
project can reposition, edit or delete one.

| v3 | v4 |
|---|---|
| A freeform block with `body.text` | A named section with `text:` |
| `- import: Aness` with `render.wrapper` | A slot section, plus `render.plotEssential: {slot: …}` on the Aness item |
| `blocks:` grouping under a heading | One slot with that `heading:`, and `wrap: all` if the group shared a wrapper |
| `render.style: hint` | A per-target `template:` on the item's render target |
| `render.style: skip` | Do not declare the target |
| `render.stripFence` | Deleted with the fence it removed; drop the key |
| Block `position:` deciding occupant order | `order:` on each item's render target |

The item side of the inversion — an item declaring `render.plotEssential`
naming the slot it belongs in — is described in [Components](09-components.md).

---

## Migrating a v3 AI Instructions document

**v3's AI Instructions carried document-level `branches:` and `variants:`, and
neither survives with its v3 meaning.** They were a second branch walker and a
second delta vocabulary for what a section already does, and the two dispatches
disagreed — `~` on a section excludes it, while `~` on a v3 AI Instructions
document meant "apply no variants".

- **Document-level `variants:` is gone.** A component declares no variants of its
  own; writing one reports a misplaced-key ERROR pointing at the section surface.
- **Document-level `branches:` exists in v4 but means something different.** It is
  a fan-out selector: the name is looked up in *each section's* own `variants:` and
  applied wherever found, rather than selecting a document-level variant. See
  [`branches:` on the whole component](09-components.md#branches-on-the-whole-component).

Either way the migration is "move the logic down one level", because v3's
document variants have no v4 counterpart to move to:

| v3, at the document level | v4, on the section |
|---|---|
| `branches: {subject: intimate}` with `variants: {intimate: {apply: [close]}}` | `branches: {subject: close}` on each section that defines a `close` variant |
| `variants: {detached: {sections: {rules: ~}}}` | `branches: {detached: ~}` on the `rules` section |
| `branches: {x: {ain: …, cards: …}}` | `render.storyCards` — see [Components](09-components.md#swappable-alternates--renderstorycards) |

---

## Migrating a v3 `description.yaml`

**v3's two-field format becomes two sections.** `--migrate` does this
conversion; by hand it is:

```yaml transform=migrate-description id=migrate-description-twofield
body:   './components/blurb.md'
script: '{%scripts}/library.js'
stripTrailingInstructions: true
```

```yaml surface=component expect=migrate-description-twofield
sections:
  body:
    file: './components/blurb.md'
  modBanner:
    from:
      script: '{%scripts}/library.js'
      extract: scriptBanner
```

**`stripTrailingInstructions: true` needs no replacement — it is now the only
behavior.** If a project had it `false`, the trailing comment group it was
keeping will stop appearing; move that line into a `text:` section of its own.

**The `.js` shorthand — `description: ./scripts/library.js`, pointing the key
straight at a script — is gone.** Write it as a component with a `from:`
section instead.

---

## Excluding an item from a branch — unchanged

**Branch exclusion works the same in v4 as it did in v3:** set a branch name to
null (`~`) in the item's `branches:` dispatch map. There are no `only:` or
`except:` keys.

To exclude every branch you did *not* name, use the fallback key — `_: ~`, not
`'*': ~`. A null wildcard is skipped rather than honored, so `'*': ~` leaves the
item included everywhere — and, since v4, raises `CL0327` naming `_: ~` as the
fix. See
[Branches & Variants](05-branches-and-variants.md#fallback-_--only-when-nothing-else-matched).
