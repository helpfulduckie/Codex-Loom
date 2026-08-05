# Diagnostic codes

Every v4 diagnostic carries a stable code, a severity, and — where the loader can supply
one — a source position. This file is the registry.

Codes are stable identifiers, not descriptions. A message may be reworded at any time; a
code may not be reused for a different problem once it has shipped. That stability is what
lets three things work:

- **Documentation anchors** — a code in a terminal is searchable here.
- **Suppression** — `# codex-loom-disable-next-line CL0442` (planned; see §4.4).
- **Test assertions** that survive rewording the message they assert on.

## Format

```
ERROR CL0310 codex/npcs.cl.yaml:112:9
  Item "Kaiden" dispatches branch "felix" to variant "Felix", which is not defined
  on this item or on canon item "Kaiden" (canon:main).
```

Severity is one of `ERROR`, `WARN`, `INFO`. The location degrades gracefully as
information runs out — `file:line:col`, then `file:line`, then `file`, then nothing — so a
diagnostic about a whole project still renders correctly.

**Template-level positions are imprecise until the render rewrite.** A malformed
`{join(...)}` can be attributed to its template file but not to a span within it. This is
a known, bounded shortfall of the phase ordering rather than a defect (spec §13).

## Bands

| Band | Concern |
|---|---|
| `CL01xx` | Loading — file discovery, YAML parsing, entry-point resolution |
| `CL02xx` | Schema — unknown keys, wrong value types, relocation suggestions |
| `CL03xx` | Items — resolution, variants, imports, branch dispatch |
| `CL04xx` | Render — templates, render functions, lint checks |
| `CL05xx` | Tokens — variables, roles, placeholders, scoping |
| `CL06xx` | Components — slots, sections, missing component sources |
| `CL07xx` | Emit — output layout, platform limits |

## Registry

### CL01xx — loading

| Code | Severity | Meaning |
|---|---|---|
| `CL0101` | ERROR | YAML document is malformed and could not be parsed. |
| `CL0102` | ERROR | File could not be read. |
| `CL0103` | WARN | File is empty; skipped. |
| `CL0104` | WARN | Document within a multi-document file is null; skipped. |
| `CL0105` | ERROR | A Codex Loom token was parsed as a YAML mapping key. |

### CL0105 in detail

`triggers: [{$name.display}]` is **valid YAML** — a flow sequence containing a single-key
flow mapping — so it parses silently to `[{"$name.display": null}]` and produces a
wrong-typed value that surfaces far from where it was written. The preparser (§4.1)
quotes tokens in the positions it can identify; this check catches the whole class
regardless of position, and costs one walk of the parsed tree.

Only `$` reaches this check. `%` and `@` are reserved indicators in YAML, so an unquoted
`{%role}` or `{@pe}` is a hard parse error (`CL0101`) rather than a silent swallow. The
check covers all three sigils anyway, because a mapping of that shape can arrive from
somewhere other than a plain parse. (`{@}` is removed as a token family in §6.1, but the
guard still recognizes the sigil so a half-migrated project fails clearly.)

### CL01xx continued

| Code | Severity | Meaning |
|---|---|---|
| `CL0110` | ERROR | `compile.yaml` is not a mapping of configuration keys. |
| `CL0120` | WARN | A declared input path does not exist on disk. |
| `CL0130` | WARN | An `include:` path does not exist. |
| `CL0131` | ERROR | The same file was included more than once. |
| `CL0140` | ERROR | An item has neither `id:` nor `name:`. |
| `CL0141` | ERROR | Duplicate item id. |
| `CL0142` | WARN | An item declares more than one `v:` alias; they are merged. |
| `CL0143` | WARN | Duplicate Codex overlay for one import target; the first is kept. |

### CL02xx — schema

| Code | Severity | Meaning |
|---|---|---|
| `CL0201` | ERROR | Unknown key. Carries a spelling suggestion when one is close. |
| `CL0202` | ERROR | Key has the wrong value type. |
| `CL0203` | ERROR | A required key is missing. |
| `CL0204` | WARN | Key is recognized but its phase has not landed; it is ignored. |
| `CL0205` | WARN | Key has been superseded by another spelling. |
| `CL0210` | ERROR | Key is valid, but at a different level — with the level named. |

### CL0210 in detail

The more valuable half of unknown-key checking, because of an asymmetry in how the two
kinds of mistake fail. A misspelling usually produces output that is obviously missing
something. A *correctly spelled key in the wrong position* produces output that looks
complete and is quietly wrong — and it can sit in shared canon, inherited by every project
that imports it, until something else happens to point near it.

So the validator checks for relocation before reaching for edit distance, and only falls
back to spelling when no relocation match exists, which also stops the two kinds of
suggestion competing to explain the same key.

The relocation search considers **only closed, schema-validated levels**. Open namespaces
— `body:`, `notes:`, `v:` — accept arbitrary keys by design, so indexing them would make
every key valid somewhere and turn every typo into a technically-true, useless *"did you
mean to nest it under `notes:`?"*.

Spelling suggestions use Damerau-Levenshtein, which counts a transposition as one edit.
Under a tolerance tight enough to avoid nonsense suggestions, plain Levenshtein scores
`titel` against `title` as 2 and misses the single commonest typo there is.

### CL03xx — items

| Code | Severity | Meaning |
|---|---|---|
| `CL0320` | WARN | A variant delta declares more than one `v:` alias; they are merged. |
| `CL0321` | WARN | A named variant does not exist in the item's variant tree. |
| `CL0322` | WARN | An item has neither `aid.type` nor `render.template`. |
| `CL0330` | WARN | A cross-item reference names an item that does not exist. |

`model/` uses neither `fs` nor `console` (§3.3), so these are reported through a
caller-supplied `onWarn(code, message)` rather than printed where they arise. Reserved:
`CL0310`, unresolvable branch dispatch.

### CL05xx — tokens

| Code | Severity | Meaning |
|---|---|---|
| `CL0510` | ERROR | A referenced variable is not declared anywhere. |
| `CL0511` | ERROR | Variables form a reference cycle; every key in the loop is named. |
| `CL0520` | ERROR | A branch-scoped variable was used where only root variables resolve. |
| `CL0521` | ERROR | A canon name collides with a declared variable. |

`CL0521` exists because canon names are auto-exposed as variables (§6.1), so the two share
one namespace. A collision is an ERROR rather than a silent precedence rule: there is no
answer to "which one wins" that an author could predict.

### CL0520 in detail

Some values resolve **once, before branch enumeration**, so they can only ever see
root-level variables: `include:`/`import:` paths and everything under `structure:`. A
branch-scoped variable used there is not a typo — it is a scoping mistake, and reporting
it as undeclared would send the author hunting for a declaration that does exist.

Distinguishing the two requires knowing which names branches declare, so the loader
collects that set before resolving any path. A name declared at root *and* overridden per
branch is not affected: it resolves at root and is overridden later, which is the normal
pattern.

Codes for the remaining bands are registered as the phases that mint them land. `CL0310`
(unresolvable branch dispatch) is named by the spec, not yet implemented, and reserved at
that number.
