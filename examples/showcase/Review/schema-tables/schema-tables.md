# The Showcase — generated field reference

_Generated from `fields.cl.yaml` by `codex-loom --schema-tables`._
_These tables reflect the resolved field and label declarations, group membership,
and template order. Document authoring conventions and budgets separately._

## Fields

| Field | Label | Renders | Reads |
|---|---|---|---|
| `cardName` | — | bare | `cardName` |
| `youLine` | — | bare | `youLine` |
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
| `core` | `vibe`, `appearance`, `originalAppearance`, `personality`, `personalityExpanded` | `Character` |

## Type to fields

_Every field a template renders, in order. A group name expands to its members._

### `Character`

- `cardName`
- **core** _(group)_: `vibe`, `appearance`, `originalAppearance`, `personality`, `personalityExpanded`
- `Magic`
- `Background`
- `relationships`
- `secret`

### `Location`

- `cardName`
- `vibe` _(override)_
- `landmarks`
- `pantheon`

### `Faction`

- `cardName`
- `overview`
- `purpose`
- `structure`
- `methods`
- `status`

### `CharacterBrief`

- `cardName`
- `appearance`
- `personality`

### `Player`

- `youLine`
- `appearance`
- `personality`
- `personalityExpanded`

## Role and tier templates

_Selected per branch by `templateFor` (§13.4). A `base` entry keyed on a type
overrides that type's body list on the branch; a free-standing name is one an item opts
into with `render.template`. Each list expands one level of groups, like the table above._

### Branch `(root)` — role `base`

#### `Character`

- `cardName`
- **core** _(group)_: `vibe`, `appearance`, `originalAppearance`, `personality`, `personalityExpanded`
- `Magic`
- `Background`
- `relationships`
- `secret`

#### `Location`

- `cardName`
- `vibe` _(override)_
- `landmarks`
- `pantheon`

#### `Faction`

- `cardName`
- `overview`
- `purpose`
- `structure`
- `methods`
- `status`

#### `CharacterBrief`

- `cardName`
- `appearance`
- `personality`

#### `Player`

- `youLine`
- `appearance`
- `personality`
- `personalityExpanded`

### Branch `lowContext` — role `base`

#### `Character`

- `cardName`
- `appearance`
- `personality`

#### `Location`

- `cardName`

#### `Faction`

- `cardName`
- `purpose`
- `status`

#### `CharacterFull`

- `cardName`
- `vibe`
- `appearance`
- `personality`
- `Magic`
- `Background`
- `secret`
