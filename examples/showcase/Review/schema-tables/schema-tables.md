# The Showcase — generated field reference

_Generated from `fields.cl.yaml` by `codex-loom --schema-tables` (v4 §13.8)._
_The field, label and membership tables here supersede the hand-maintained copies in
`SCHEMA.md` sections 3-5; where they disagree, `SCHEMA.md` has drifted. The authoring
conventions (`SCHEMA.md` sections 1 and 7) are hand-written and not reproduced here._

## Fields

| Field | Label | Renders | Reads |
|---|---|---|---|
| `Tagline` | Tagline | bare | `Tagline` |
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
| `core` | `Tagline`, `vibe`, `appearance`, `originalAppearance`, `personality`, `personalityExpanded` | `Character` |

## Type to fields

_Every field a template renders, in order. A group name expands to its members._

### `Character`

- **core** _(group)_: `Tagline`, `vibe`, `appearance`, `originalAppearance`, `personality`, `personalityExpanded`
- `Magic`
- `Background`
- `relationships`
- `secret`

### `Location`

- `Tagline`
- `vibe` _(override)_
- `landmarks`
- `pantheon`

### `Faction`

- `Tagline`
- `overview`
- `purpose`
- `structure`
- `methods`
- `status`

### `CharacterBrief`

- `Tagline`
- `appearance`
- `personality`

## Role and tier templates

_Selected per branch by `templateFor` (§13.4). A `base` entry keyed on a type
overrides that type's body list on the branch; a free-standing name is one an item opts
into with `render.template`. Each list expands one level of groups, like the table above._

### Branch `(root)` — role `base`

#### `Character`

- **core** _(group)_: `Tagline`, `vibe`, `appearance`, `originalAppearance`, `personality`, `personalityExpanded`
- `Magic`
- `Background`
- `relationships`
- `secret`

#### `Location`

- `Tagline`
- `vibe` _(override)_
- `landmarks`
- `pantheon`

#### `Faction`

- `Tagline`
- `overview`
- `purpose`
- `structure`
- `methods`
- `status`

#### `CharacterBrief`

- `Tagline`
- `appearance`
- `personality`

### Branch `lowContext` — role `base`

#### `Character`

- `Tagline`
- `appearance`
- `personality`

#### `Location`

- `Tagline`

#### `Faction`

- `Tagline`
- `purpose`
- `status`

#### `CharacterFull`

- `Tagline`
- `vibe`
- `appearance`
- `personality`
- `Magic`
- `Background`
- `secret`
