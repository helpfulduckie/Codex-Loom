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
| `CL0323` | ERROR | An item declares both `notes:` and `description:`. |
| `CL0324` | ERROR | An item could not be resolved — most often a failed `import:`. |
| `CL0340` | ERROR | A reference is defined in more than one canon set and is not qualified. |
| `CL0341` | ERROR | A reference names a canon set not declared in `structure.input.canon`. |
| `CL0342` | ERROR | A reference names an id that no canon set defines. |
| `CL0330` | WARN | A cross-item reference names an item that does not exist. |

`model/` uses neither `fs` nor `console` (§3.3), so these are reported through a
caller-supplied `onWarn(code, message)` rather than printed where they arise. Reserved:
`CL0310`, unresolvable branch dispatch.

`CL0323` is an error rather than a merge because the two keys are two spellings of one
field. Two values under two names means the author believes they are two fields, and any
silent winner hides that belief instead of correcting it. The declared `notes:` wins so
output stays deterministic while it is fixed.

`CL0324` is the reason a failed `import:` no longer compiles quietly. The item is dropped
and everything around it still renders, so the tree that lands looks complete: correct
card count, tidy summary table, every branch present. What is missing is whatever that
import was carrying — which, when the import also drove a branch's variant dispatch, can
be the entire difference between one leaf and the next. The output is written, then the
run exits non-zero.

### CL04xx — render

| Code | Severity | Meaning |
|---|---|---|
| `CL0410` | ERROR | A `.template` or `.partial` still contains a `~~~` fence. |
| `CL0411` | ERROR | A `render.notesTemplate` in compile.yaml names a template that is not loaded. |
| `CL0412` | ERROR | A `render.notesTemplate` on an item names a template that is not loaded. |
| `CL0420` | ERROR | No loaded template matches an item's `aid.type` or `render.template`. |
| `CL0421` | ERROR | A template threw while rendering an item. |

Templates render the card body; the heading and fence are the compiler's (see
[Templates](07-templates.md)). A template that writes its own fence produces a second
envelope *inside* the body, where the Velvet Lattice loader never looks — output that
reads as plausible and carries keys nothing will apply. It is refused at load time, with
every offending file named, so a half-migrated project reports which templates remain
rather than compiling into something subtly broken.

`CL0411` is checked at load for a different reason: the set of config-declared notes
templates is closed and known before a single card compiles — the root node and every
branch node. Left to render time, one typo would print once per item per leaf, which for
a project the size of The Institute means the same message thousands of times. The
per-item `render.notesTemplate` is not checked here, because that one is open and can be
variable-driven; it reports at render time as `CL0412` and names the item.

`CL0412`, `CL0420` and `CL0421` are per-item and report at render time, which is why they
are not the load-time check `CL0411` is. Each drops the one thing it names — the notes
line, or the whole item — and leaves the rest of the leaf intact, and each fails the run
once the tree is written.

### CL06xx — components

| Code | Severity | Meaning |
|---|---|---|
| `CL0601` | ERROR | A section declares both `text:` and `slot: true`. |
| `CL0602` | WARN | A section has no text, no heading and is not a slot, so it renders nothing. |
| `CL0603` | WARN | A section's `render.wrap` is neither `each` nor `all`; `each` is used. |
| `CL0604` | WARN | A section's branch dispatch names a variant the section does not define. |
| `CL0610` | ERROR | An item resolves onto a branch and produces no output there. |
| `CL0611` | ERROR | A render target names a slot the component does not declare. |
| `CL0612` | ERROR | A render target names a section that exists but is not a slot. |
| `CL0613` | ERROR | A render target names no slot at all. |
| `CL0614` | WARN | A declared slot has no items on a branch. |
| `CL0615` | ERROR | A component renders to nothing on a branch. |

`CL0601` is an error rather than a resolved precedence because the two readings differ in
output and neither is obviously right: text inside a slot could sit before or after the
occupants, and could fall inside or outside the slot's wrapper. A preamble is already
expressible as its own text section positioned ahead of the slot, so refusing the
ambiguity costs an author nothing and keeps the option of allowing it later.

`CL0602` stays a warning because an empty section is inert rather than wrong — a section
gated off on every branch by its own dispatch is the ordinary way to park content. The
error that matters is one level up: a *component* that renders to nothing, `CL0615`.

`CL0610` is the no-output invariant (§7.4), and it replaces v3's suppression checks rather
than reimplementing them. It fires on *consequence*, not on mechanism: an item that
resolved onto a branch has to leave a mark on it, and how it failed to — no target
declared, or a target into a slot the component gated off on that branch — does not
change the answer. That scoping is what lets slot-level gating stay a legitimate way to
drop a whole slot's contents from one branch. An item whose own `branches:` excludes it is
never resolved there and is never asked.

`CL0611`, `CL0612` and `CL0613` are three readings of one mistake — a `slot:` that cannot
be placed — kept apart because the fix differs. `CL0611` is the typo class: the name
matches nothing in the component. `CL0612` means the name is real but names a text
section, so the fix is `slot: true` on that section, not a rename. `CL0613` is a target
that named no slot at all, including the `plotEssential: true` shorthand, which has no
meaning to give it: a component may declare any number of slots and there is no default to
fall back on. A slot the component *does* declare and this branch gates off is none of
these — the name is correct, and the consequence is `CL0610`'s to judge.

`CL0614` is a warning because an empty cast is a legitimate branch. It exists because an
empty slot and a slot whose occupants all mis-typed their `slot:` produce the same output
file, and no corpus will fire it on its own — every slot in every shipped project is
filled on every leaf, which is exactly why the silent version of this check would look
correct.

### CL07xx — emit

| Code | Severity | Meaning |
|---|---|---|
| `CL0701` | ERROR | A trigger value contains a comma. |
| `CL0702` | WARN | A trigger value is empty and will reach AID as an empty key. |

Both are facts about what Velvet Lattice can carry to AID rather than opinions about
content, which is why they live in the compiler and not in lint. `CL0701` is the sharper
of the two: VL joins the trigger list into AID's single `keys` string with commas, so a
comma *inside* a trigger silently becomes two triggers, and the emitter is the last stage
that can still see the difference.

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
that number. `CL04xx` currently holds only the template-fence refusal; the render rewrite
(§13) is what fills the rest of the band.
