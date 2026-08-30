# Bundled convention packs

A convention pack (v4 spec §8.2.2) is declarative data — never code — that the opinion
layer runs over a leaf's compiled story cards to validate a mod's `notes:` configuration.

Files here are **bundled packs**, resolved by bare name: a project that writes

```yaml
lint:
  packs:
    wtg: {}
```

loads `packs/wtg.cl.yaml`. A pack referenced with `source:` instead is a project- or
canon-hosted file and does not live here.

## Pack file shape

```yaml
name: wtg                     # must match the key it is declared under
rules:
  - id: 1                     # → CL-wtg/0001
    severity: error           # error | warn — the default severity for this rule
    appliesTo: { titleMatch: '^Configure WTG' }   # predicate; omitted = every card
    schema:                   # optional — a src/schema.js descriptor over parseNotesBlock(notes)
      type: map
      keys:
        Clock Format: { type: string, values: ['12h', '24h'] }
        Debug Mode:   { type: number, min: 0, max: 2 }
    forbid: { match: '/\]' }  # optional — a match contributes a finding
    require: { hasKey: foo }  # optional — a non-match contributes a finding
    message: "…"
```

## Predicate vocabulary

`hasKey`, `equals: {key, value}`, `match` (regex over the notes text and the body
together), `notesMatch`, `bodyMatch`, `titleMatch`, and `all` / `any` / `not` to compose
them. `{ notes: {…} }` scopes a nested predicate to the parsed `notes:` mapping.

The loader raises `CL0117` for a malformed pack and `CL0119` for a `name:` that does not
match its config key — never a crash, never a silent skip.
