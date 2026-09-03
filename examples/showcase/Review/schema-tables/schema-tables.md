# The Showcase — generated field reference

_Generated from `fields.cl.yaml` by `codex-loom --schema-tables` (v4 §13.8)._
_The field, label and membership tables here supersede the hand-maintained copies in
`SCHEMA.md` sections 3-5; where they disagree, `SCHEMA.md` has drifted. The authoring
conventions (`SCHEMA.md` sections 1 and 7) are hand-written and not reproduced here._

## Fields

| Field | Label | Renders | Reads |
|---|---|---|---|
| `vibe` | Vibe | join "; " | `vibe` _(wrap [])_ |
| `appearance` | Current Appearance / Appearance _(conditional)_ | join "; " | `Physical Traits.gender`, `Physical Traits.age`, `Physical Traits.hair`, `Physical Traits.other` |
| `originalAppearance` | Original Appearance | join "; " | `originalAppearance` |
| `personality` | Personality | join ", " | `Personality.keywords` |
| `personalityExpanded` | — | bare | `Personality.expanded` |
| `Magic` | Magic | join "; " | `Magic.affinity`, `Magic.effect` |
| `pantheon` | Pantheon | keys() | `pantheon` _(block)_ |
| `Background` | Background | list() | `Background` |
| `relationships` | Relationships | list() | `relationships` |
| `secret` | Hidden Info | bare | `secret` _(wrap [])_ |
| `landmarks` | — | list() | `landmarks` |
| `purpose` | Purpose | bare | `purpose` |
| `structure` | Structure | list() | `structure` |
| `methods` | Methods | list() | `methods` |
| `overview` | — | prose() | `overview` |
| `status` | Status | bare | `status` _(always)_ |

## Groups

| Group | Members | Named by |
|---|---|---|
| `core` | `vibe`, `appearance`, `originalAppearance`, `personality`, `personalityExpanded` | `Character` |

## Type to fields

_Every field a template renders, in order. A group name expands to its members._

### `Character`

- _(include: cardName)_
- **core** _(group)_: `vibe`, `appearance`, `originalAppearance`, `personality`, `personalityExpanded`
- `Magic`
- `Background`
- `relationships`
- `secret`

### `Location`

- _(include: cardName)_
- `vibe` _(override)_
- `landmarks`
- `pantheon`

### `Faction`

- _(include: cardName)_
- `overview`
- `purpose`
- `structure`
- `methods`
- `status`

### `CharacterBrief`

- _(include: cardName)_
- `appearance`
- `personality`

### `Player`

- _(include: youLine)_
- `appearance`
- `personality`
- `personalityExpanded`

## Role and tier templates

_Selected per branch by `templateFor` (§13.4). A `base` entry keyed on a type
overrides that type's body list on the branch; a free-standing name is one an item opts
into with `render.template`. Each list expands one level of groups, like the table above._

### Branch `(root)` — role `base`

#### `Character`

- _(include: cardName)_
- **core** _(group)_: `vibe`, `appearance`, `originalAppearance`, `personality`, `personalityExpanded`
- `Magic`
- `Background`
- `relationships`
- `secret`

#### `Location`

- _(include: cardName)_
- `vibe` _(override)_
- `landmarks`
- `pantheon`

#### `Faction`

- _(include: cardName)_
- `overview`
- `purpose`
- `structure`
- `methods`
- `status`

#### `CharacterBrief`

- _(include: cardName)_
- `appearance`
- `personality`

#### `Player`

- _(include: youLine)_
- `appearance`
- `personality`
- `personalityExpanded`

### Branch `lowContext` — role `base`

#### `Character`

- _(include: cardName)_
- `appearance`
- `personality`

#### `Location`

- _(include: cardName)_

#### `Faction`

- _(include: cardName)_
- `purpose`
- `status`

#### `CharacterFull`

- _(include: cardName)_
- `vibe`
- `appearance`
- `personality`
- `Magic`
- `Background`
- `secret`
