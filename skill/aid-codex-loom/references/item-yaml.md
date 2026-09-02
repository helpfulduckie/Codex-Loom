# Item YAML Reference

Item files are YAML sequences. A single file can mix local item definitions, `import:`, and `include:` entries in any order.

**"Item", not "card".** The item is the definition; a story card is one of the things it can render into. An item may render into a story card, into component slots, into both, or — with `storyCard: false` and a component target — into components only.

---

## Complete Item Schema

```yaml
- id: Aness                       # compiler identifier; defaults to name; must be unique
  name:
    display: Aness                 # short name used in rendering and the {$Aness} token
    full: Aness Rozen              # long name (or use a scalar: name: Aness Rozen)
  pronouns: female                 # female | male | nonbinary | they
  aid:
    title: Aness Rozen             # AID display title (may differ from name)
    type: Character                # output folder; default template name
    triggers: [Aness, Rozen]       # trigger keywords (sequence or single string)
  notes:                           # the AID description field; story-card output only
    Aness is a healer.
  render:
    template: Character            # .template filename (case-insensitive; defaults to aid.type)
    wrapper: none                  # none | square | curly — story-card output only
    storyCard: true                # default when omitted
    plotEssential:                 # one optional target per component
      slot: cast
      order: 2
      template: CharacterBrief     # per-target template override
  body:
    Tagline: Journeyman Healer; Magic Researcher
    Physical Traits:
      gender: female
      age: mid 20s
      hair: black hair, braided, waist-length
    Personality:
      keywords: [inquisitive, polite, sarcastic]
      expanded: |
        - {$Aness} love[s] magic research — {$Aness.she} instinctively leap[s]
  variants:
    networked:
      body:
        Physical Traits:
          other: a blue interface crystal
    Felix:
      name: {display: Felix, full: Felix Grayls}
      pronouns: male
      aid:
        title: Felix Grayls
        triggers: [Felix, Grayls]
      body:
        Physical Traits:
          gender: male
          hair: -{in a controlled bun}   # field operation: remove substring
  branches:
    felix: Felix            # apply the Felix variant in the felix branch
    networked: networked
    flashback: ~            # null: exclude the item from the flashback branch
```

---

## Top-Level Fields

| Field | Required | Notes |
|---|---|---|
| `id` | recommended | Compiler key; defaults to `name`; globally unique; immutable across variants |
| `name` | yes | Scalar string or `{display, full}` object |
| `pronouns` | recommended | Controls `{$she}` etc.; `female` / `male` / `nonbinary` / `they` |
| `aid` | only with a story-card target | AID story-card metadata |
| `render` | optional | Template, wrapper, and placement targets |
| `body` | yes | All item content — nested mappings, strings, block scalars, arrays |
| `notes` | optional | The AID description field. `description:` is an accepted alias; declaring both is an ERROR |
| `v` | optional | Item variables, read in templates as `{$v.key}` |
| `meta` | optional | An annotation channel for tooling. **No template ever reads it** |
| `variants` | optional | Named deltas; nestable to any depth |
| `branches` | optional | Maps branch names to variant names for dispatch |
| `kind` | optional | `story` (default) or `reference` |

**`kind: reference`** marks an item that exists to be read by a script or by a human in the story-card editor rather than by the AI. It exempts the item from the prose heuristics and from nothing else. It reaches AID nowhere — Velvet Lattice forwards only title, type, keys, value and description.

**`meta:` is for convention packs, not for content.** Never validated by the loader, never proposed as a relocation target for a typo'd key. A pack reads `meta.<packName>.<key>`, so `meta.duckieConv.role` and a `stat-tracker` pack's keys never collide. The compiler writes it into the card's `~~~` fence so the offline `--lint` arm can read it back, and it is branch-addressable like any other whole-value field. See `references/convention-packs.md`.

---

## `aid:` Block

**Required only when a story-card target exists.** An item routed only into components has no triggers and no AID type, and demanding them would be ceremony.

| Field | Description |
|---|---|
| `title` | AID display title. If absent, templates use `{$name}`. |
| `type` | Output folder name, and the default template name. `aid.type` and `render.template` default to each other. |
| `triggers` | Keyword list or single string. In templates: `{join(", ", $aid.triggers)}`. |

**`encapsulate:` and `known:` are gone.** Both left with the story-card envelope — encapsulation is now unconditional, and `known:` existed only so a template could emit an `[e]` marker, which is `notes:` text now. Declaring either is an unknown-key ERROR.

---

## `render:` Block — where the item goes

| Field | Description |
|---|---|
| `template` | Template name (case-insensitive). Defaults to `aid.type`. Names a `templates:` entry in a field table, or a `.template` file |
| `wrapper` | `none` (default) / `square` → `[ ]` / `curly` → `{ }`. **Story-card output only.** |
| `notesTemplate` | Template override for the `notes:` field. |
| `storyCard` | Boolean, default `true`. `false` means this item produces no story card. |
| `plotEssential`, `summary`, `aiInstructions`, `authorsNote`, `adventureDescription`, `opening` | A render target — see below |
| `branchFraming` | Recognized, permanently unread — branch framing sits at an interior node, where no items resolve |

**`description:` as a target is now `adventureDescription:`.** The split is which of the two descriptions has a branch: the scenario blurb is written once at the root with no cast to place into it, while an adventure description is an ordinary per-leaf component that routes like the rest. The old spelling draws a rename message rather than a bare unknown-key.

### Render targets

Each component key takes a mapping — or `true` / `false` as a shorthand:

| Key | Description |
|---|---|
| `slot` | The name of a slot the component declares |
| `order` | Numeric sort key within the slot, default `5`. Ties break on item id. |
| `template` | Template for *this target*, overriding `render.template` |

```yaml
render:
  template: Character            # default for every target
  storyCard: true
  plotEssential:
    slot: cast
    order: 2
    template: CharacterBrief     # the PE entry is briefer than the story card
```

**Template resolution, per target:** the target's own `template:` → `templateFor.<component>` keyed on `aid.type` → `templateFor.base` keyed on `aid.type` → `aid.type` matched against a loaded text template → verbatim pass-through.

**A `template:` counts as a real choice only when it differs from `aid.type`.** The model fills both `render.template` and a target's `template:` with `aid.type` for every item naming neither, so honoring that fill would shadow every branch's `templateFor` map. See `references/field-declarations.md` → the three ladders.

This is what replaced `style: full | hint | skip` — `hint` was only sugar for "use the `.hint` template", which a per-target `template:` says directly, and `skip` is expressed by not declaring the target.

**There is no `wrapper:` on a target.** The slot owns the wrapping of everything placed in it, precisely so an item with `wrapper: curly` in a curly slot cannot ship double-braced. Writing one is an unknown-key ERROR pointing at `render.wrapper`.

**An item that resolves into a branch must produce at least one output there.** `storyCard: false` with no reachable target is an ERROR naming the item and the branch (`CL0610`) — the replacement for v3's suppression bookkeeping. Excluding the item from the branch with `branches: {x: ~}` is the deliberate way to say "not here".

---

## `body:` Block

Any structure: plain strings, block scalars (`|`), YAML sequences, nested mappings. Field names are case-insensitive throughout, and missing fields render as an empty string.

**Field interpolation** — reference other body fields via `{$body.X}`:
```yaml
body:
  graduation year: 1315
  background: "Graduated in {$body.graduation year}."
```

**Render functions** — `{join(...)}`, `{list(...)}` and friends work inside body field strings, resolved before the pronoun pass and after field interpolation.

---

## `notes:` Block

The AID description field. **Story-card output only** — component output has no fence to carry it, so `notes:` is not emitted into a slot.

**A notes template resolves on three rungs, most specific first:**

1. the item's own `render.notesTemplate`
2. `templateFor.notes` keyed on `aid.type`, then the `render.notesTemplate` scalar in `compile.yaml` — both merged down the branch chain
3. the built-in default

Unlike the body ladder, this one needs no "is it a real choice" guard, because nothing fills `render.notesTemplate` automatically. A notes template reads `$notes` rather than `$body`.

`description:` is an accepted alias, collapsed to `notes` internally. Declaring both on one item is an ERROR (`CL0323`), not a merge.

---

## `variants:` Block

Named deltas layered on top of the item. Can modify `name`, `pronouns`, `aid`, `render` (including its targets) and any `body` field.

Variants nest: `sci-fi/near-future` applies the `sci-fi` delta first, then `sci-fi.variants.near-future`.

**`id` is immutable** — no variant can change it.

A variant is the natural place for a placement change:

```yaml
variants:
  you-block:
    render:
      storyCard: false            # the protagonist lives in PE, not in a story card
      plotEssential: {slot: you, order: 1}
  cast-hint:
    render:
      storyCard: true
      plotEssential: {slot: cast, template: CharacterBrief}

branches:
  subject: you-block
  researcher: cast-hint
```

See `field-operations.md` for `+{}`, `-{}`, `/{}/{}` syntax.

---

## `branches:` on Items

Maps branch names (or paths) to variant names for dispatch:

| Syntax | Meaning |
|---|---|
| `branch: variantName` | Apply one variant |
| `branch: [v1, v2]` | Apply multiple variants in order |
| `branch: ~` | Exclude from this branch |
| `'*': variantName` | Wildcard baseline for all branches |
| Mapping form | `apply:` + a sub-`branches:` for nested dispatch |

Wildcard applies first; an explicit match stacks on top. Null excludes immediately, without wildcard processing.

**The same walker serves component sections**, so `~` means the same thing wherever it appears.

---

## Excluding an Item from Branches

Use null dispatch — there are no `only:` or `except:` keys:

```yaml
branches:
  '*': []          # include, with no variant, on all branches
  flashback: ~     # exclude from flashback

# Or: include only in one branch
branches:
  subject: base
  _: ~             # exclude from every branch not named above
```

Use `_: ~` for the catch-all, not `'*': ~`. A null wildcard is skipped rather than honored — `'*': ~` leaves the item included everywhere and raises `CL0327`.

---

## Multiple Items in One File

```yaml
- id: Aria
  ...

- id: Kaiden
  ...

- include: "{%main}/NPCs/Guards.cl.yaml"

- import: Felicia
  ...
```

Item files use the `.cl.yaml` extension by convention — `characters.cl.yaml`, `items.cl.yaml`. The basename `library.cl.yaml` is reserved and excluded from item loading in any directory the loader walks, project or library; it is never parsed as an item.
