# Codex Loom v4 — Design Spec (as built)

This is the maintainer-facing account of *why v4 is shaped the way it is*. It is the
trimmed, repo-resident successor to the vault design spec: the vault version carried the
full deliberation, the rejected alternatives, and a phase-by-phase sequencing plan; this
one keeps the decisions that survived into the code and states them as fact.

`documentation/dev-guide.md` is the companion — it maps the same ground onto files and
data flow. Where the dev-guide says *what a module does*, this file says *what constraint
it satisfies*.

---

## §0. How to read this file

**Section numbers are a contract.** They match the vault spec's numbering so that a `§N`
citation in `dev-guide.md` or a source comment resolves here without editing. The
sequence has gaps — there is no §10 body (it merged into §7), and §15/§16 (sequencing and
the decision log) are dropped as history. A gap is deliberate, not a missing section.

**"As built" means the code is the authority.** Where this file and the vault spec
disagree, the code won; the vault spec was frozen mid-rebuild and several later phases
diverged from it. A design idea that was specified but never built is noted in one line
and not described.

**Velvet Lattice is a separate project.** `loader.py`, `scenario.py`, `types.py`,
`utils.py` and `to_latitude_dict` name files and symbols in the Velvet Lattice
repository, a third-party tool Codex Loom compiles *for*. Line references to them
(`loader.py:60`) are relative to that repo, never to any local checkout. Several rules in
§8 are justified only by what that code does, and the source comments say so at the
raise site.

**Diagnostic codes** are `CLNNNN`, registered in `src/diag.js` and documented in
`documentation/11-diagnostics.md`. This file names a code where it explains a decision;
it does not re-document the code.

---

## §1. Goals

**v4 is a consolidation release, not a rewrite.** The authoring language was largely
right. What had gone wrong is that mechanisms were bolted onto the item model rather than
built through it, and each re-implemented resolution slightly differently — Plot
Essentials had its own loader, openings had a fourth block syntax, `{@name}` was a second
token family that never worked as grouped. The resolver, field-op, pronoun and report
semantics carry forward with their existing test suites; what changed is everything
around them.

1. **One resolution pipeline.** An item resolves exactly one way, wherever it ends up —
   a story card, a Plot Essentials block, an AI Instructions section.
2. **Ergonomic YAML.** No defensive quoting, no invisible significant whitespace.
3. **Loud failures with locations.** Every diagnostic names a file and, where the loader
   can supply one, a line. A schema-key typo is an ERROR, not a silent no-op.
4. **Shared library on the author's schedule.** A scenario pins the library version it
   compiled against and moves off it deliberately.
5. **Shared library for everything.** AI Instructions, Author's Note and Plot Essentials
   layouts get the same import / variant / branch grammar items already have.
6. **Expressive references.** Refer to *the love interest* or *the protagonist* without
   knowing which item that is on this branch.
7. **A quarantined output format.** All Velvet Lattice knowledge lives in one module.
8. **Fewer concepts.** A mechanism that duplicates another is deleted, not documented.

---

## §2. Non-goals

- **No v3 compatibility.** v4 is a clean break (§14). Viable because Codex Loom has one
  user and had not been shared when the break was made.
- **No break from Velvet Lattice in v4.** VL is third-party; replacing it with a
  first-party uploader is on the backlog, which is why §8 treats the emitter as a
  planned seam (§8.6) rather than as tidiness.
- **No expression language.** Roles resolve one level of indirection and stop (§9).
- **No second resolver.** Every component gets the item grammar; nothing resolves an
  item body except `src/model/item.js`.

---

## §3. Architecture

**One file per concern.** `src/compile.js` orchestrates the pipeline; item loading,
resolution, token expansion, rendering, emit, the per-leaf loop, the tree-level writes
and the report dispatch are each their own module or directory. The full roster is the
Module Map in `dev-guide.md`; this section states the rules that roster obeys.

### §3.2 Target module shape

**Every carried-forward v3 module has a named v4 home, and adding a concern is a new
module rather than a new block in `compile.js`.** v3's `resolver.js` was doing config
loading, item loading and registry construction in one file; it split three ways along
seams that already existed. The component table (`src/emit/components.js`) is the pattern:
adding a component type is a row in `SLOTTED_COMPONENTS`, not another bespoke branch in
the compile spine.

`compile.js` is the pipeline spine and nothing else. The per-leaf loop, the tree writes
and the report dispatch each moved to their own module (`src/leafLoop.js`,
`src/treeFiles.js`, `src/reportDispatch.js`) so that the spine reads as a sequence of
named stages.

### §3.3 Structural invariants

**`src/model/` is pure: no `fs`, no `console`.** It reports problems through a
caller-supplied `onWarn(code, message)` and returns failed lookups described rather than
thrown, so the caller decides what reaches a terminal. This is what lets the same
resolution code run inside a compile, inside `--snapshot`'s role scan, and inside a test
with no I/O. A test (`__tests__/unit/model-branches.test.js`) enforces both halves: it
greps every `src/model/*.js` for `require('fs')` and `console.`, and asserts the
directory roster is exactly `branches.js`, `component.js`, `fieldops.js`, `item.js`,
`pronouns.js`, `refs.js` — so a new model file has to be a deliberate addition to the
test, not a place a `console.warn` can quietly reappear.

**`import:` versus `imports:` is a cardinality signal.** `import:` (items) takes exactly
one library counterpart — an item either *is* a library item with local deltas or it is a
local item. `imports:` (components) takes a list, because a component composes a
house-style base, then a world layer, then project deltas. The `s` is the difference and
it is deliberate.

**List versus mapping is a stated rule.** Lists where order and layering matter
(`imports:`, `templates:`); mappings where identity and override matter
(`variables:`, `roles:`, `branches:`, `lint.packs`). Anything that merges down the branch
chain is a mapping, because the merge is key-wise.

**`{}` and `[]` are interchangeable wherever a collection is expected**, normalized to
the declared type at the schema boundary. They are two spellings of *nothing*, not two
shapes of content — a non-empty wrong type is still a `CL0202` ERROR.

### §3.4 Cards become items

**The atomic content unit is renamed from *card* to *item*.** AI Dungeon's "Story Card"
is a specific, narrower thing; Codex Loom's "card" had meant "a unit that might become a
story card, or might become a Plot Essentials block" since v3 gave Plot Essentials the
ability to import cards. The name was describing one of its outputs rather than itself.

Every component in §7 holds items. An item with a story-card target becomes an AID Story
Card; an item routed into AI Instructions becomes a block of that document. Three things
are therefore conditional on an item rather than universal:

- **`aid:`** (type, triggers) means something only for a story-card target, so it is
  required only when one is declared (§7.3).
- **`render.template`** is optional. Absent, a scalar passes through verbatim and a
  mapping renders as `key: value` lines — the same rule §4.5 states for `notesTemplate`.
- **Unscoped pronoun tokens** (`{$she}`) need a subject, so they are an ERROR in an item
  with no `pronouns:`. Scoped tokens (`{$LI.he}`, `{$Aness.she}`) work in any item, which
  is what lets roles reach prose (§9.7).

---

## §4. Authoring ergonomics

### §4.1 A leading token no longer needs quoting

**`triggers: [{$name.display}]` is valid YAML that parses to the wrong thing.** It is a
flow sequence holding a single-key flow mapping, so it silently becomes
`[{"$name.display": null}]` and surfaces as a wrong-typed value far from where it was
written. Two mechanisms close this:

- **The preparser** (`src/loader/preparse.js`) quotes a leading `{$…}` / `{%…}` token in
  the block and flow positions it can identify, before the YAML parser sees it.
- **A post-parse guard** walks the parsed tree for a mapping whose sole key starts with
  `$`, `%` or `@` and raises `CL0105`. This catches the whole class regardless of
  position, for one walk of the tree.

Only `$` reaches the guard from a plain parse. An unquoted `{%role}` is a hard YAML parse
error (`CL0101`) on the `%` directive indicator, not a silent swallow — but `%` stays in
the guard's set because `{%…}` is a live token family and a mapping of that shape
arriving by any route is still worth flagging.

### §4.2 Triggers with significant edge whitespace

**A leading or trailing space in a trigger is encoded as `_`.** `_Era_` is the trigger
`" Era "`; an interior `_` is literal. Multiple edge underscores map one-to-one, so
`__Aria` is two leading spaces. `decodeTriggerPadding` in `src/emit/vl.js` reverses it
just before the value is written, so Velvet Lattice never learns the convention — what it
reads is an ordinary quoted string. A plain padded string cannot survive the round trip
into AID, which is why the convention exists at all.

### §4.3 Schema validation and unknown keys

**Every key not in the declared surface is an ERROR.** The `compile.cl.yaml` surface is
`src/config/schema.js`; the item surface is `src/loader/schema.js`; both run through the
shared engine in `src/schema.js`.

Unknown-key handling checks for **relocation before spelling**. A misspelled key usually
produces output that is visibly missing something; a *correctly spelled key at the wrong
level* produces output that looks complete and is quietly wrong, and can sit in a shared
library inherited by every consuming project. So the validator first checks whether the key
is valid at another level (`CL0210`, which names the level), and only falls back to an
edit-distance spelling suggestion (`CL0201`) when no relocation match exists. Spelling
uses Damerau-Levenshtein, which counts a transposition as one edit — plain Levenshtein
scores `titel` against `title` as 2 and misses the commonest typo there is.

The relocation search considers only closed, schema-validated levels. Open namespaces
(`body:`, `notes:`, `v:`) accept arbitrary keys by design, so indexing them would make
every key valid somewhere.

**Keys whose behavior lands in a later phase are declared from the start**, carry a note,
and produce a `CL0204` "recognized but not read" WARN rather than an unknown-key ERROR.
Writing the schema once beats editing it every phase, and an author writing ahead of the
tool gets told so plainly.

### §4.4 Diagnostics carry source positions

**A diagnostic renders as `SEVERITY CLNNNN file:line:col` then an indented message.** The
location degrades gracefully as information runs out — `file:line:col`, then `file:line`,
then `file`, then nothing — so a diagnostic about a whole project still renders correctly.

**Template-level positions are imprecise, by known limitation.** A malformed `{join(...)}`
can be attributed to its template file but not to a span within it. Precise spans need a
render-pipeline change that has not been made; this is bounded and documented, not a
defect to chase.

### §4.5 `notes:` — the AID description field

**`notes:` becomes AID's card `description`.** It is a top-level item field, so it is
variant- and branch-addressable and field operations apply to it. `description:` is an
accepted alias — the two collapse to `notes:` during resolution, so nothing downstream
sees which spelling arrived. Declaring **both** on one item is `CL0323`, an ERROR rather
than a merge: two names for one field means the author believes they are two fields, and
picking a silent winner would hide that.

**What reaches the fence is always a string.** The Velvet Lattice loader types that field
`str` and assigns it straight through, so a mapping is rendered to text before it is
written — never as nested YAML keys. By default a scalar passes through verbatim and a
mapping becomes `key: value` lines; the line is omitted entirely when the rendered text
is empty.

### §4.5.1 Which template renders `notes:` — the ladder

For anything richer than a literal, a template renders the text, found by a three-rung
ladder, most specific first:

| Rung | Source |
|---|---|
| 1 | `render.notesTemplate` on the item |
| 2 | the branch-addressable notes default: `templateFor.notes` keyed on `aid.type`, then the `render.notesTemplate` scalar in `compile.cl.yaml` — both merged down the branch chain |
| 3 | none — the default rendering above |

Rung 2 sits on the branch node because which mods a branch loads is what decides whether a
marker like `[e]` means anything there; a branch that drops the mod points `notesTemplate`
at a blank template and every card in it stops emitting the marker. **"Off" is a blank
template, not `~`** — `~` unbinds to rung 3, and rung 3 still writes something. A per-item
slot alone was rejected because the `[e]`-to-flag reshape would then have cost a
declaration on 253 items. Phase 13 removed an earlier `<body template>.notes` suffix rung.

Naming a template that is not loaded is `CL0411` (config-level, checked at load, once) or
`CL0412` (item-level, checked at render, per item — that one is open and can be
variable-driven).

### §4.6 File types

**`.cl.yaml` is the v4 extension for every authored file; plain `.yaml` is consumed
indefinitely.** The suffix marks a file as Codex Loom's rather than something else's;
`--migrate --rename-cl` applies it to the config. The config entry-point search
(`CONFIG_BASENAMES` in `src/util.js`) tries `compile.cl.yaml`, `compile.cl.yml`,
`compile.yaml`, `compile.yml` in that order, and a directory holding two of them throws
rather than silently compiling one.

### §4.7 The `v:` block

Unchanged from v3. Arbitrary author-defined key/value data, accessed in templates as
`{$v.key}`. Aliases `var` / `vars` / `variable` / `variables` all normalize to `v`;
declaring more than one as sibling keys is `CL0142`, and the subfields are merged
last-writer-wins.

### §4.8 `kind:` — narrative items versus reference items

**`kind: reference` marks an item that exists to be read by a script or by a person in
the story-card editor, not by the AI.** A mod's config card is the clearest case — a real
story card with a deliberately empty trigger list, which no render target can express.
`story` is the default; any third value is an error.

**What `reference` exempts is the soft heuristics, and nothing else:**

| Check | Applies to `reference`? |
|---|---|
| `empty-triggers` lint | No — trigger-less is the intended state |
| Seed-map inclusion | No — it would sit permanently atop "never seeded" |
| Card-size ranking | Reported in its own section — it never enters context |
| Platform field caps (§8.5) | **Yes** |
| Unresolved-token / leaked-artifact sweep | **Yes** |

The rule is that soft heuristics skip reference items and hard limits apply to
everything: a card over AID's field cap is malformed whatever it exists for.

**`kind:` is a property of the copy, not of the library item.** Importing a narrative item
and declaring `kind: reference` on the import makes that copy reference material and
leaves the library item alone; a variant can change it too. The compiled card carries
`kind: reference` in its fence so the reports — which read the compiled tree, not the
YAML — can tell which cards to treat as reference material. Velvet Lattice keeps
unrecognized fence keys as metadata and forwards them to AID nowhere, so the key changes
nothing about the uploaded card. The exemption reads the fence rather than inferring
reference-ness from an empty trigger list, because inference would disable the
`empty-triggers` check entirely: a narrative card that *lost* its triggers is exactly
what that check exists to catch, and under inference it looks identical to a reference
card.

---

## §5. Token families

**There are two compile-time token families and they do not overlap.** `{%key}` is the
*path / value* family — a string value declared in `compile.cl.yaml` `variables:` (plus
every `structure.input.library` name, auto-exposed). `{$…}` is the *field-reference*
family — `{$body.X}`, `{$v.X}`, `{$Id.body.Field}`, the pronoun tokens, the role tokens.
The comparison table is in `documentation/07-templates.md`; the rule that matters here is
that they resolve through separate machinery and a `{%}` context never sees a `{$}` and
vice versa.

### §5.1 Undeclared references are ERRORs, uniformly

**An undeclared reference of any family is an ERROR, not a silent empty.** An undeclared
`{%key}` is `CL0510`; a `{$X}` resolving to neither a role nor an item id is `CL0540`; a
`%key%` reaching output undeclared is `CL0532`. The uniformity is the point — v3 let some
of these pass through as empty strings, and the symptom surfaced as missing content in a
live scenario rather than as a build failure.

**All `{%}` expansion routes through one function** — `resolveVariables` in
`src/util.js`, recursive, cycle-detecting (`CL0511` names every key in the loop), and
reporting undeclared names through a caller-supplied sink. There is no second
implementation and no second `{@}` family. Call sites are thin wrappers
(`config.expandPathTokens`, `resolveComponentSpec`, the `include:`-path block in
`loader/registry`, `loader/component.js`). Adding a context that needs tokens is a new
call site, never a new regex.

**Some values resolve once, before branch enumeration** — `include:` / `import:` paths
and everything under `structure:`. A branch-scoped variable used there is a scoping
mistake, not a typo, so it gets its own code (`CL0520`) rather than being reported as
undeclared and sending the author hunting for a declaration that exists. Distinguishing
the two requires the loader to collect the set of branch-declared names before resolving
any path.

---

## §6. compile.cl.yaml

**The key surface is `src/config/schema.js`, validated by `src/schema.js`.** Everything
not declared there is an unknown-key diagnostic (§4.3). `version: 4` is required with no
compatibility mode — its absence is what tells a v3 project to run `--migrate` (`CL0209`),
reported before the rest of schema validation so a v3 config gets that one line rather
than a cascade.

### §6.1 `{@}` and `structure.input.components` are deleted

**v3 had a second reference family, `{@name}`, declared under
`structure.input.components` and `structure.input.canon`.** Its lookup searched every
per-type map in sequence and returned the first name match, so `{@pe}` resolved
identically no matter which type declared it — no project could depend on the grouping,
because the grouping never worked.

**Library names are now auto-exposed as `{%variable}` tokens.**
`{%characters}/Aness.cl.yaml` does what `{@characters}/…` used to. That leaves one naming
system and one expander. A library name colliding with a declared variable is `CL0521`,
an ERROR rather than a silent precedence rule, because there is no answer to "which one
wins" that an author could predict.

`structure.input.canon` is `structure.input.library` — see §11.0 for why the word
changed.

### §6.2 Variables resolve against variables

**Variable expansion is recursive by key lookup, so declaration order is irrelevant.** A
library entry `libNovalune: '{%libraryRoot}/StoryCards/Novalune'` resolves against
`libraryRoot` whether it is declared above or below. v3 already worked this way; what v4
adds is diagnostic quality — a cycle names every key in the loop (`CL0511`), not only the
one where detection happened. Library path resolution no longer needs the bespoke two-pass
v3 used to build a lookup table first: a library entry naming a sibling is just a variable
naming a variable, and the one expander handles it.

### §6.3 `scripts:` is top-level and merges per file

**`scripts:` is a top-level key, sibling to `components:`, not a key inside it.** It
names the Velvet Lattice scripting hooks copied verbatim into each leaf's `Scripts/`
folder. Two forms: a directory path, or a mapping of the four hook names
(`input` / `context` / `output` / `library`) to files. It merges down the branch chain
key-wise, so a branch can swap one hook or unbind the set — which mods a branch ships is a
per-branch fact.

### §6.3a `render:` is top-level and branch-addressable

**`render:` carries project- and branch-level rendering defaults**, one key so far
(`notesTemplate`). It is here rather than only on the item because the thing it expresses
is a property of the branch, not of the card. It lives at the top level rather than
nested inside another block because the branch merge is a shallow `Object.assign` — a map
nested one level deeper would be replaced wholesale by any branch that touched one role.

### §6.4 `~` unbinds; an empty collection does not

**`~` (null) against an inherited key deletes it from the merged table; `{}` or `[]`
sets it to an empty collection.** A role read as "not there" behaves identically to one
never declared, rather than resolving to the literal word `null`.

**Unbinding something that was never inherited is a WARN**, one per namespace:
`CL0512` (variables), `CL0530` (placeholders), `CL0544` (roles), `CL0118` (lint packs).
It usually means a bare `heroName:` with nothing after it — which parses as null, i.e.
`~` — was meant to be a declaration. `scripts:` alone still sets the key to null on a `~`
instead of removing it, so there is nothing for an unbind-unknown check to say about it.

---

## §7. Items, components, and placement

### §7.1 What was wrong

**v3 had four syntaxes for one idea.** Plot Essentials had its own loader (`pe.js`),
descriptions had another (`description.js`), openings had an anonymous ordered block list
with a `branches:` dispatch and a `variants:` vocabulary of its own (`opening.js`), and a
block's `text:` was tested against the filesystem on every compile to decide whether it
was prose or a path — so prose that looked like a path was silently read as one. The
opening block list's dispatch took the *first* variant name and discarded the rest, where
every other dispatch in the language stacks them. None of these three files exists in v4.

### §7.2 The inversion: items declare placement, components declare shape

**A component describes where content can go; an item says where it goes.** A component
document is a record of named `sections:`. A section either carries `text:` or is marked
`slot: true`. Membership lives on the item: an item declares `render.plotEssential`
(or `render.aiInstructions`, etc.) naming the slot it belongs in, and the component never
learns who filled it.

This is what makes a component overridable and genuinely project-independent. An
importing project repositions, edits or deletes a named section without touching any
item; an item routes into `cast` without the shared component knowing anything about that
item. The two ends are put back together only in the compiled output and in the
`--with-inventory` report (§7.9).

### §7.3 The component table

**`src/emit/components.js` holds one descriptor per component type.** The rows differ by
output filename, heading-level default, and a few flags; where each file lands in the
tree is §7.3a's frontier logic, not a column here.

| Descriptor | File | Dir | Heading dflt | Notes |
|---|---|---|---|---|
| `plotEssential` | `Plot Essentials.md` | `Components/` | 0 | slots |
| `summary` | `Summary.md` | `Components/` | 0 | slots; VL reads it into `storySummary` |
| `aiInstructions` | `AI Instructions.md` | `Components/` | 2 | slots |
| `authorsNote` | `Author Notes.md` | `Components/` | 2 | VL's spelling, not a typo |
| `opening` | `Opening.md` | `Components/` | 0 | slots; `inlineProse`; 4,000-char cap |
| `branchFraming` | `Opening.md` | `Components/` | 0 | interior nodes only; no slots |
| `adventureDescription` | `Description.md` | node root | 0 | slots; `frontmatter` |
| `description` | `Description.md` | node root | 0 | root only; `frontmatter` |

`defaultHeadingLevel` is a column and not a constant because v3's two formats disagree on
what a bare `heading:` means: Plot Essentials reads it as level 0 (a plain line), AI
Instructions as level 2 (a Markdown heading), and both are right for their own output.
`model/component.js` carries `headingLevel` through unset and the default is applied here,
where the component is known.

### §7.3a Where each file is written — the emit strategy

**§7.3's "slots?" column is declaration semantics; this is what the emitter does with
them.** They were the same question until the emitter stopped writing every component,
placeholder, script and story card to every leaf. A reader who conflates them will look
for a file where it is no longer written.

**A file is written at the node that owns it, and Velvet Lattice inherits it down from
there.** VL's `ScenarioNode.__init__` merges placeholders, scripts, components and story
cards from its parent as `{**parent, **local}`, so a leaf resolves to its ancestors'
files without holding copies. **Components merge on filename; story cards merge on card
name.**

**`Label.md` and `Description.md` do not inherit** — VL reads both from the node's own
directory with no parent in scope — so each lands at every node that needs one.
`Label.md` is additionally *suppressed* where the rendered label equals the directory
segment, because VL falls back to the directory name when the file is absent; that is a
redundancy rule, not an inheritance one. Collapsing `Description.md` alongside the
inheriting categories would silently empty every leaf's adventure description, and it is
the one mistake in this area that produces no diagnostic.

**Story cards are placed by frontier.** For each `(type, name)` pair and each distinct
rendered text, the emitter (`src/inherit.js`) computes the minimal set of nodes whose
subtrees partition exactly the leaves that produced that text, and writes one copy per
frontier node. A card constant everywhere lands at the output root; a card scoped to a
subtree lands once per subtree; a card with per-branch variant bodies has each version
placed on its own frontier.

**The frontier keys on `(type, name)`, never on item id.** A `variants:` item keeps one
id while its name and its `aid.type` differ per branch, so keying placement on id files
one variant under another's type. This was the one real bug found implementing the step,
and it is silent — the misfiled card still renders and still resolves somewhere.

**The frontier is computed from rendered output, not from `branches:`.** It reads which
leaves produced byte-identical text and finds the covering nodes. Predicting placement
from the branch tree before compiling is possible and deliberately not done: the
byte-identity check is what makes the placement safe, and a prediction that disagreed
with it would be wrong in exactly the cases that matter.

**A duplicate card name on one leaf is `CL0622`, an ERROR, cross-type or not.** VL's
registry is keyed on name alone, so only one card ever reaches AID and there is no winner
worth preserving. Under copy-to-every-leaf a collision resolved identically everywhere;
under frontier placement the winner would depend on where each card was declared in the
tree, so making it an error is what closes that failure mode.

### §7.4 Placement rules

**Sections sort by `render.position`, then by file order.** Occupants within a slot sort
by the target's `order:`, then by item id — items live in their own files after the
inversion, so there is no document order to fall back on, and filesystem traversal order
must never reach the output because it varies between machines. `sortOccupants` in
`emit/components.js` is the single statement of that rule; the inventory report imports it
rather than restating it.

**A slot owns the wrapping of what lands in it; the item's own `render.wrapper` is
ignored there.** `render.wrapper` governs story-card output only. `render.wrap` on the
slot decides whether that wrapper encloses `each` occupant (the default, the ordinary
Plot Essentials idiom) or `all` of them as one joined block.

**The no-output invariant: an item that resolves onto a branch must leave a mark on it.**
Failing to — no target declared, or a target into a slot the component gated off on that
branch — is `CL0610`, and it fires on the consequence, not the mechanism. An item whose
own `branches:` excludes it is never resolved there and is never asked, which is what
lets slot-level gating stay a legitimate way to drop a whole slot's contents from one
branch.

### §7.6 Shared components get the item grammar

**Every component can pull in another with `imports:`**, so one document is written once
and used by many projects — a single AI Instructions body currently sits in dozens of
places across the scenario corpus, reached by copy or absolute path, neither of which
supports a variant or a one-line override.

`imports:` is a list applied in order: a house-style base, then a world layer, then the
project's own deltas. A later import wins over an earlier one on the same section name;
local `sections:` win over all of them, layering field-by-field rather than replacing —
an override can edit one named line of `text:` without restating the block. `~` deletes
an inherited section; deleting one nothing provided is `CL0608`.

**A `from:` path resolves against the project base**, the same base `include:` and every
`components:` entry use — chosen over the importing file's own directory because a
`{%variable}` is written relative to the project and a bare path would not be. It expands
against the *root* variable table: the document is cached by resolved path and shared
across every leaf, so a `from:` that varied by branch would make one cache key stand for
two documents. A `from:` naming no file is `CL0606`; a loop is `CL0607` and the offending
import is skipped rather than followed.

**Component-level `branches:` is a fan-out selector.** It names *every* section the
document holds: the variant name is looked up in each section's own `variants:` and
applied wherever found. Sections that do not define it are silently unaffected — most
will be, which is what fanning out means. A name matching *no* section is `CL0605`, the
one report a misspelling at this position produces. There is no component-level
`variants:` block; a name here is always a selector over what sections declare.

### §7.7 Description is a component, not a file format

**There are two description keys and they write the same file at different levels.**
`description:` is the scenario blurb AID shows in listings — root only, written once to
`{output}/Description.md`. `adventureDescription:` is the description a leaf carries,
which AID applies to the adventure started from that leaf — declared anywhere, inherited
down the tree, written to each leaf's `Description.md`. Items route into an
`adventureDescription` slot exactly as into a Plot Essentials slot; the blurb has no
branch, so there is no cast to place into it.

| | `description:` | `adventureDescription:` |
|---|---|---|
| AID uses it as | the listing-page blurb | the adventure's description |
| Declared | root only | anywhere in the tree |
| Inherits | no — one listing, copied 30× says nothing | yes |
| Items route in | no | yes |

**A section takes its text from one of `text:`, `file:`, `from:`.** Declaring two is
`CL0619` (the `text:` is kept). `from:` reads a file through a named transform; the only
transform is `scriptBanner`, which reads a JavaScript file's leading `//` comment block
and cleans it up for prose. An unrecognized transform name is `CL0618` and names the
roster; adding one is a row in `documentation/` and a function in `src/extract.js`.

**`metadata:` becomes a YAML frontmatter block** above the body. Velvet Lattice reads
scenario tags from `Description.md`'s frontmatter, which is what this is for. The key is
declared on every component but only the two description descriptors emit it — nothing
else writes a file with a place for frontmatter — so `metadata:` elsewhere is `CL0620`
and ignored. `adventureDescription` additionally refuses `advanced:` / `description:` in
its `metadata:` (`CL0629`): those belong to the scenario blurb, and the risk of writing
them onto a player's own adventure with no way to edit it back is asymmetric enough to be
an ERROR.

**A leaf with an adventure description and no `Opening.md` is `CL0616`.** Velvet Lattice
sets a node's prompt to `components["Opening"] or node.description`, so the pairing opens
the adventure on the blurb, as though the store listing were the first scene. It is an
ERROR rather than a warning because the output is wrong in a way that reads as
deliberate — the file is present, well-formed, and shows a paragraph the author wrote.
Per-node descriptions themselves depend on a VL oversight: there is no editor field for
one, but AID *does* apply what VL writes. If that is ever closed, `adventureDescription:`
stops having an effect and `description:` is unaffected.

### §7.8 Components render to multiple targets

**A scenario ships one version of a component in its field and offers alternates as
story cards the player can paste in** — a fuller ruleset, a terser one, the
scenario-specific parts only. `render.storyCards` on the component is a list of entries;
each renders the component again, with the leaf's slot occupants in place, as a
**trigger-less `kind: reference` card**: the rendered text goes in `notes:` (AID's
10,000-character `description` field) and the body is a one-line "copy the description
field" prompt. A trigger-less card never enters context, so the alternates cost nothing
during play, and the `empty-triggers` lint knows not to flag them.

The card's AID `type` — which groups it in the story-card editor — resolves on three
rungs: the entry's own `type:`, then `storyCardType.<component>` in `compile.cl.yaml`
(project-wide, e.g. a `zz_` prefix to sort the alternates to the end of the player's
list), then the component's display label. It is not branch-addressable: which category a
reference card sorts under is a whole-scenario decision.

An entry with no `title:` is `CL0623` (the title is the card's AID name and its frontier
key). An entry whose `sections:` subset names a missing section is `CL0624`; one that
renders nothing on a branch is `CL0625` — both WARN, because the component field still
ships and a lost alternate is not a broken compile.

### §7.9 Discoverability — the accepted cost

**Reading the output tree is not how you check what a slot holds.** `CL0611` fires when a
target names a slot no component declares and `CL0614` fires when a declared slot ends up
empty, so the typo cases are loud — but a slot holding the *wrong* items is well-formed
by every check the compiler runs. `--with-inventory` writes `Overview/Inventory.md`,
which is the one place the two ends of the inversion are put back together: every slot, and
which items landed in it, per branch. Use `--leafReview` to see everything a branch
resolves through its ancestor chain.

---

## §8. The Velvet Lattice emitter

**Every VL-ism lives in `src/emit/vl.js` and nowhere else** — the `## Title` line, the
`~~~` fence, the three fence keys, trigger quoting, the unconditional `encapsulate:
false`. v3 spread that knowledge across every template in every project plus three
independent regex re-implementations in `lint.js`, `seedmap.js` and `util.js`, which is
why the §4.2 trigger fix would otherwise have had to land in every template of every
project rather than in one function. The module is pure (§3.3): it renders a string and
collects trigger diagnostics (`CL0701`, `CL0702`).

**A template renders the body; the emitter writes the envelope around it.** A `~~~` fence
anywhere in a `.template` or `.partial` is a load-time ERROR (`CL0410`) — a template that
writes its own fence produces a second envelope inside the body, where the VL loader
never looks.

### §8.2.1 What the emitter does not own: mod conventions

**The emitter owns the format, not the meaning of markers in it.** v3 lint carried
`missing-encapsulate`, `e-marker-conflict` and `missing-discovery-marker`. The first is
gone because `encapsulate` is no longer author-controlled (§8.4). The other two encode
one mod's convention — `[e]` for background knowledge, `/]` for a discovery point — and
fire wrongly for every project that does not use that mod. Rules of that shape belong in
a convention pack.

### §8.2.2 Convention packs

**A convention pack is declarative data — never code — that the opinion layer runs over a
leaf's compiled cards to check a mod's configuration.** Mod config lives in `notes:`, and
the person who knows what a mod accepts is its author; baking one mod's rules into the
compiler makes the Codex Loom maintainer a bottleneck for every mod anyone uses. A pack
ships alongside the shared library it depends on, is opt-in via `lint.packs`, and
consuming it is not a trust decision. The mechanism and the two bundled packs (`wtg`,
`duckieConv`) are documented in `documentation/14-convention-packs.md`.

### §8.4 `encapsulate` and `wrapper` are the same operation

**`encapsulate: false` is written on every card unconditionally.** It was never a real
choice — every site in the VL loader defaults it to true, and false is what the output
needs. `render.wrapper` (`square` / `curly` / `none`) is applied compile-side, so the
emitted `.md` is exactly what AID receives with no upload-time transformation to
reverse-engineer. That is also what lets §8.5 measure platform limits against the final
string.

### §8.5 Platform limits are enforced, not advised

**AID truncates rather than refusing.** A card over the cap does not fail to upload — it
arrives shortened and the author finds out during play. The compiler is the right place
to catch it because it is the only stage holding the final string.

| Cap | Limit | WARN band | Measures |
|---|---|---|---|
| Story card body | 2,000 | 1,800 | VL's `entry` — the fence-stripped, trimmed body |
| `Opening.md` | 4,000 | 3,600 | per file, not per branch chain — VL merges openings by filename, so a leaf's replaces an ancestor's |
| `notes:` | 10,000 | 9,000 | assigned straight to AID's `description` |

**The measured length is the one after placeholder substitution.** VL replaces `%key%`
with `${question}`, and a question is longer than the key naming it — so a 3,900-character
Opening with several placeholders is over 4,000 in AID. `src/limits.js` performs VL's
substitution (one `replace` per declared key, mirroring `utils.py`) rather than doing the
arithmetic, so the two cannot drift. An undeclared `%key%` is left alone by both, and
reporting it is `CL0532`'s job. The diagnostic prints both lengths when they differ. The
WARN band is a soft heuristic in every sense except one: §4.8 puts the hard cap on
`kind: reference` items too, and the band is part of the same fact.

### §8.6 The emitter is a planned seam

**`parseCards` is the emitter's knowledge read backwards, and it is the contract to
preserve.** Reports and convention packs consume the parsed model — `{title, type,
triggers, notes, body, meta, hasFence, kind}` — rather than the file format, so replacing
Velvet Lattice later means satisfying that shape rather than rewriting every consumer. It
deliberately mirrors `loader.py`: same fence regex, same `^##\s+` header split, same YAML
1.1 version (PyYAML resolves `no` / `yes` / `on` / `off` as booleans, so the emitter must
quote against 1.1's resolver, not 1.2's). `type` is not recoverable from the text — VL
takes it from the containing directory name — so callers that know the directory pass it
in.

### §8.7 The output tree is swept by node

**`--clean` sweeps every node in the output tree — root, interior nodes, and leaves
alike.** A node owns `Label.md` and `Placeholders.yaml` in addition to its `Story
Cards/`, `Components/` and `Scripts/` directories, and VL reads and inherits both
node-level files down the subtree. Before this was the emitter's job the sweep was
inherited from v3 and touched leaves only, so a placeholder declaration deleted from an
interior node survived in the output and went on being inherited.

The failure is confined to what the compiler *stops* emitting: every file it writes is
overwritten next compile, so a stale node-level file only appears when a key or title is
*removed* from an interior node — the exact edit whose purpose is to make the output stop
carrying it. Ancestors of a live leaf are live; a node not in that set can hold no live
descendant, so a dropped interior node is taken whole with its subtree. A stale node
holding nothing but compiler output is removed; one holding anything else is archived
under `Archive/<timestamp>/`, since the compiler may delete what it wrote and may not
delete what it did not.

---

## §9. Roles

**A role binds a name to an item id, per branch.** `{$LI}` in item or component prose
resolves through that binding rather than naming an item directly, so one card can mean
"whoever this branch cast as the love interest" without editing the prose. Roles are
declared at the project root and rebound per branch node, merging down the chain like
`variables:` and `placeholders:`.

### §9.1 Motivation

**The Institute already hand-rolled this and only got half of it.** It declares
`li: Malcolm` in `variables:` and writes `{%li}` through its cards, with the branch tree
multiplying protagonist × love-interest × relationship. Because `{%li}` is name
substitution only, the surrounding pronouns are hardcoded — "you still feel raw about
**his** betrayal" — and every one of those breaks the day a love interest is female or
nonbinary. Roles are the missing half of something that was already in use.

### §9.2 Design

**Anywhere an item id may appear in a `{$…}` token, a role name may appear instead** —
`{$LI}`, `{$LI.he}`, `{$LI's}`, `{$LI.body.Tagline}`, and all four resolve. The token pass
rewrites a leading role name to its bound id inline; `{$LI.body.Tagline}` needs one extra
step, because on the item path the cross-item resolver runs before the token pass — so
`applyRolePass` normalizes `{$Role…}` to `{$id…}` across every item first. See the
dev-guide's Pronoun Resolution Passes. `{$protagonist}` is not a special
mechanism; it is the built-in `protagonist` role, which already drives the "you"
substitution. The general feature is *less* code than the special case, because the
special case already existed.

**A role token and an item-id token share one namespace and are lexically
indistinguishable.** All-caps for a role name is a documented convention and is
deliberately not enforced. The permanent cost is that every reader of a `{$…}` token must
consult the roles table or be wrong — and the failure shape when one does not is quiet,
because a role that resolves to the right name through the wrong path produces output
that looks correct. The readers that must consult it are the pronoun pass, the
`requiresRoles` computation in `--snapshot`, and the migration review queue; any future
consumer of the token grammar joins that list or is a bug. A separate sigil was rejected
in Phase 8 — `&`, `*` and `@` are all YAML indicators, and `{$role.LI}` collides with the
dot grammar.

### §9.3 Resolution rules

**A role resolves one level of indirection, always** — to an item id, never to another
role (`CL0543`). No expressions, no computed names; logic belongs in the template layer's
`{if}`. Resolution happens *first*, by rewriting the leading role name to its bound item id
before any other test in the token pass (`resolveRole` in `src/model/pronouns.js`), so
every check below it sees an ordinary card reference. The token pass is the one site that
raises the role diagnostics and the one that tracks role usage. On the item path a silent
pre-pass, `applyRolePass`, runs the same rewrite over every item ahead of
`applyCrossItemRefs`, whose `{$Id.body.X}` resolution would otherwise never see an id where
a role name was written.

| Failure | Code |
|---|---|
| A `{$X}` that is neither a declared role nor a known item id | `CL0540` — names both readings and lists the roles in scope |
| A role name that is also an item id | `CL0541` |
| A role bound to an item that does not resolve on this branch | `CL0542` |
| A role bound to another role name | `CL0543` |

Every role ERROR accumulates on the compile bus rather than stopping at the first —
binding a role once beats recompiling four times to find four cards need it. A role that
is declared but cannot resolve leaves its token unresolved on purpose, so the output
sweep's `CL0430` catches it a second time. That two-reports overlap is deliberate:
`CL0540` names the cause at its source, `CL0430` names the fact in the output.

### §9.4 Shared library cards carry a consumer contract

**A shared library card that references `{$LI}` needs the consuming project to bind `LI`,
and `--snapshot` computes that requirement rather than trusting a declaration.** It scans
each library entry's own frozen files for every `{$X}` token and checks whether `X`
resolves to an item id anywhere in the snapshotted library. What resolves nowhere is
published as a `requiresRoles` entry in `snapshot/manifest.json`. This is elimination —
the same reasoning a compile-time undeclared-role ERROR uses — and it is why an entry with
no unresolved tokens gets no `requiresRoles` key rather than an empty array.

**Computed, not declared.** The manifest holds the enforceable fact; the
descriptive contract — which roles and placeholders a library set expects, in prose — is
what `library.cl.yaml` is reserved for. That file is excluded from item loading, copied
byte-for-byte by `--snapshot`, and **not yet read by anything**; enforcement does not wait
on it. A set whose own item content does not validate cleanly gets `CL0116` instead of a
role list — an elimination result computed over content the compiler cannot load would
rest on nothing. The entry's files are still frozen; only its `requiresRoles` key is
withheld.

### §9.7 Roles reach prose

**Component prose resolves roles exactly as an item body does.** An AI Instructions or
Author's Note rule referencing `{$LI}` goes through the same token pass items do — which
matters because a real share of the hardcoded pronouns §9.1 describes live in component
text, not in cards. Every leaf-level component (story cards, Plot Essentials, AI
Instructions, Author's Note, a leaf's own `opening:`) resolves roles; `branchFraming` at
any branch node — the project root included — inherits the roles table down the tree and
resolves them too; the root `Description` reads the project's own `roles:`.

**Shape does not gate it.** An `opening:` or `branchFraming:` written as an inline
sentence or a prose `.md` runs the same token pass a `sections:` document does, so a
`{$role}` in an inline opening resolves — a stray `{$token}` that matches nothing still
leaks to CL0430, and an unresolved `{%var}` in the spec is still CL0634. The one
asymmetry is `{$protagonist}` → "you": it needs a resolved `branchProtagonist`, which a
leaf and `branchFraming` (interior or root) have but the root `Description` pins to
`null`, so `{$protagonist}` in the blurb renders as the bound item's name.

---

## §10. Shared components

Merged into §7. Every component gets the item grammar — `imports:`, variants, branch
dispatch — via §7.6; the library snapshot that freezes a shared component is §11.

---

## §11. The library snapshot

**`--snapshot` freezes a project's shared library into a copy the project carries
alongside its own source.** It copies every `structure.input.library` entry, and every
`structure.input.templates` directory that resolves outside the project base, into
`snapshot/<name>/` as raw bytes, then writes `snapshot/manifest.json`. Once that exists,
`{%name}` tokens resolve to the frozen copy by default, so the project compiles against a
pinned tree instead of whatever the shared library currently holds. Both `snapshot/` and
the manifest are meant to be committed — a snapshot in a temp directory proves nothing.

### §11.0 `library:` not `canon:`

**The key stopped holding only content, so the word "canon" stopped fitting.** Canon
meant reusable characters and worldbuilding; Phase 7 pulled shared components into the key
and shared templates into the freeze, so the old word would name a set with one member
that is house style and another that is neither. "Canon" survives as a directory name and
as an author's own `{%canon}` variable — the mechanism name and the instance name were
always separate and merely shared a word. `structure.input.vault` became
`structure.input.snapshot` in the same pass, because this project's design notes live in
an Obsidian vault and "the vault covers canon components" would parse cleanly while
meaning the wrong thing.

### §11.1 Manifest

`structure.input.snapshot` names where the frozen copy lives; setting it is the only
thing that turns the mechanism on. The manifest carries `manifestVersion` (currently
`2`), a `syncedAt` timestamp, and per entry a `source` path, a `sha256:` hash of every
file, and — from `manifestVersion: 2` — an optional `requiresRoles` (§9.4).

### §11.2 Rules

- **Raw source, not resolved cards.** Variants must survive the copy intact, or local
  `importVariants:` and branch dispatch against library variants break.
- **The redirection decision happens once, at config load.** A library name cannot
  resolve to the snapshot in one code path and to the live source in another — a compile
  is either frozen or it is not, never partially. A partly-frozen compile looks right,
  passes every test, and silently mixes two library versions.
- **`--live` is the escape hatch** back to the live source for the run it is passed on.
  `--snapshot` itself always reads live — freezing from the frozen copy would mean a
  stale snapshot could never be refreshed.
- **Sync is never automatic.** A deliberate update is the whole point. `--snapshot`
  writes a file-level change summary (added / removed / changed-by-hash, per entry) to
  `<reports>/snapshot/sync-diff.txt` before it overwrites, so an author sees what a
  re-sync will pull in.
- **The drift notice never fails a build.** Every compile against a populated snapshot
  checks the live library against the manifest and, if anything changed, prints one
  informational line. A current snapshot and a stale one compile identically — that is
  the entire point of a freeze — and the line is the only thing that tells them apart. A
  freeze whose drift blocked a build would be a dependency lock with worse ergonomics.
- **A name with no manifest section falls back to live, silently.** This is why adding a
  new library entry to an already-frozen project does not break anything: it reads live
  until the next `--snapshot` picks it up. The redirection is not where `CL0113` is
  raised, so it does not duplicate that diagnostic.

The snapshot diagnostics (`CL0111`–`CL0116`) are documented in
`documentation/11-diagnostics.md` and `12-snapshot.md`. `CL0115` — a frozen file that no
longer matches its own recorded hash — is the only ERROR among them: a corrupted freeze,
not drift, and the one condition under which a frozen compile can no longer answer the
question it exists to answer.

### §11.3 Scale

Whole-directory copies, no `--used-only` option. The measured shared library tree is ~58
files / ~195 KB, so disk is a non-issue; the binding constraint is review burden at sync
time, and a sync whose diff is too large to read defeats the purpose. Revisit above
~1,000 files.

---

## §12. Player placeholders

**`%key%` is AID's own `${question}` prompt, declared once under `placeholders:` and
answered by the player when the adventure starts.** Declarations sit at the root and per
branch and merge down the chain. `src/emit/placeholders.js` writes `Placeholders.yaml`
into each node, emitting only what that node *adds* — Velvet Lattice merges the table
per-key down the tree, so a branch's file diffs against that branch's declarations rather
than the whole accumulated table.

### §12.1 Nesting, and why the compiler resolves it

**AID supports nested placeholders** — `${What is ${Your friend's name?} like?}` prompts
twice, the outer question showing the inner answer. **Velvet Lattice produces that shape
only by accident.** Its substitution is a single pass, one `text.replace()` per declared
key in mapping order, and it never re-runs over question values; nesting works only
because substituting the outer key drops its question into the text where the inner
`%name%` is still waiting for a loop iteration that has not happened. Declare the inner
key first and a literal `%name%` ships to the model. The trap is not reachable by ordering
alone — VL merges parent keys ahead of local ones, so declaring the shared inner question
at the root and the branch-specific outer question on a branch (the layout this module's
own minimality encourages) is exactly the broken order.

**So nesting resolves at compile time**, and what VL receives is already fully nested; its
single pass then produces the right output regardless of key order. A `%key%` cycle is
`CL0531` and names the whole loop — every key in it, plus any key that can *reach* it, is
left exactly as written, because a partially expanded question reads as an intentional
nest while carrying a literal `%key%` inside it.

**Latitude's premade placeholders** (`${character.name}`, `${character.gender}`, the
pronoun forms) carry their question inline and are outside the mechanism — there is
nothing to declare, and VL's substitution cannot produce one from a `%key%`.

### §12.2 `~` unbinds, and emits nothing

**VL has no way to remove an inherited key** — a child file can only add or override — so
an unbind is a compile-time concept only. It costs nothing downstream: a key VL still
inherits but no text references produces no `${...}` and no prompt. What the unbind buys
is §12.3's undeclared check — `%x%` on a branch that unbound `x` is an undeclared
reference.

### §12.3 Checks, by layer

| Code | Severity | Layer | What |
|---|---|---|---|
| `CL0530` | WARN | compiler | `~` unbinds a key never inherited there |
| `CL0531` | ERROR | compiler | Question text forms a reference cycle |
| `CL0532` | ERROR | compiler | A `%key%` reaching compiled output is undeclared on that branch |
| `CL0533` | ERROR | compiler | A placeholder reached a destination AID does not fill |
| `CL0534` | WARN | compiler | A placeholder reached a title, where writing one does not do what it implies |
| `CL0535` | WARN | opinion | Declared and referenced nowhere beneath its declaring node |
| `CL0536` | WARN | opinion | Two or more keys declare the same question text |

**`CL0532` is checked at the write points, not by scanning the output tree**, because the
diagnostic must name something the author can edit — by the time text reaches a file its
source may be a template, a component document, or `compile.cl.yaml`. It runs across nine
destinations, reports once per key per output file, and rides the declared list along as a
hint because `%heroname%` against a declared `heroName` is invisible until the two are
printed together.

**`CL0533` / `CL0534` were rescoped against AID's real rules, not Velvet Lattice's warning
list.** VL warns on Label, Description, AI Instructions and Summary; two of those are
stale — AID added AI Instructions and Story Summary as placeholder-bearing in March 2026.
What is left is two destinations where a placeholder does not function (the scenario
Description, a card's `type` — ERROR) and two titles where the outcome is not what writing
one implies (a branch title half-works; a scenario title does not fill — WARN). Neither
severity consults the placeholder table: where a placeholder cannot go, declaring it
changes nothing. The check is per *placement*, not per file, because one item body can be
legal in one destination and not another on a per-branch basis. The `type` check runs
*before* template resolution — `aid.type` selects the template when none is named, so a
placeholder there also fails to find one, and reporting after the ladder would surface
`CL0420` about a template the author never wrote.

**`CL0535` is subtree-scoped, and the scope is the check.** A root-level placeholder used
on one branch of three is normal, so an unscoped version fires constantly on well-formed
projects. A reference inside another question counts as use, read off the *raw* question
text before expansion substitutes it away.

**`CL0536` reads declarations and never use sites.** Two keys declaring one question is
the finding; one key referenced twenty times is the feature. Compared on the *expanded*
question, because two keys can differ in source and agree once variables and nesting
resolve, and the expanded form is what AID collapses.

Placeholder question text is subject to the §8.5 caps, measured *expanded* — the inner
question is counted inside the outer.

### §12.4 The `${...}` confusability check

**`${she}` is one transposition from `{$she}`, and it reaches the player as a prompt
asking them to type the word "she".** The check fires only on `${...}` whose content is
identifier-shaped — no spaces, no punctuation beyond dots — because a real placeholder
holds a question written for a human and draws nothing. `character.`-prefixed premades are
exempt. It is an opinion-layer WARN (`lint.js`), because a deliberate identifier-shaped
placeholder is imaginable.

### §12.5 The compiler / lint split

**This boundary has to be explicit, because `lint.level: off` is otherwise dangerous.**
An author can silence the opinion layer; an author cannot silence correctness. Without a
stated line, `off` would let a project ship with an undeclared role — the exact failure
§1's third goal exists to prevent.

| | Compiler diagnostics | Lint findings |
|---|---|---|
| What | Facts about the output | Opinions about quality |
| Examples | unknown key, undeclared role, the no-output invariant, platform caps, undeclared `%x%`, a placeholder AID will not fill, a leaked `{$she}` or `{join}` | `empty-triggers`, seed-map and card-size ranking, `suspect-verb-marker`, the `${…}` confusability check, unused and duplicate declarations |
| Silenceable | No | Yes — `lint.level`, per-pack `level:`, or unbind the pack |
| An ERROR fails the build | Always | Only packs emit opinion-layer ERRORs (§8.2.2) |

**Every ERROR-severity check in `lint.js` is a leaked-artifact detector** — unresolved
`{$…}` / `{%…}`, leaked `{join}` / `{if}`, unresolved verb markers, JS interpolation
artifacts. Each means the compiler failed and the failure is visible in the output, which
is a fact. They report onto the bus at ERROR (`CL0430`–`CL0435`) *and* keep their entries
in `lint.js`'s `CHECKS` table tagged `layer: 'compiler'` — deleting them would make
`--lint` useless against a tree someone else compiled, which is the one job an offline
scanner has. **A check's layer is a property of what it claims and is carried as a tag
wherever the check happens to run.** Two opinion-layer checks (`CL0535`, `CL0536`) run
inside the compile because they need the branch-merged placeholder table; they are tagged
so `lint.level` reaches them without moving them.

**`level` clamps each opinion diagnostic to the named severity, then drops what is left
below it:**

| `level` | Opinion ERROR | Opinion WARN |
|---|---|---|
| `off` | dropped | dropped |
| `error` | ERROR | dropped |
| `warn` | WARN | WARN |
| *(unset)* | ERROR | WARN |

Unset is not a level — a project that says nothing hears every opinion at the severity it
was raised with, which is what keeps a pack ERROR able to fail a build by default. The
author-facing meaning is what the docs lead with: `level: error` reads as *validate my mod
configs, skip the prose heuristics*, and the clamp-then-drop rule is the one reading that
delivers both that and "`warn` cannot fail my build".

---

## §13. Template engine and the authoring surface above it

### §13.1 The problem

**The shared template set is one stanza shape repeated.** Measured at design time: fifteen
`.template` files, twenty-one `.partial` files, ~125 `{include}` lines and ~112
conditional stanzas, every stanza the shape `{if $body.X}Label: {fn($body.X)}{/if}`,
varying only in a label and a choice between two of the seven render functions. The
consequences that cost real work: nothing states what a field *is* (its label, its render
function, its type membership, and its meaning live in four places); membership is a
three-level graph traversed by hand; **a field a template does not name is silently
dropped with no diagnostic** — the corpus carried eighteen such `(template, field)` pairs;
and any per-field variation forces a duplicate file.

### §13.2 A field is declared once

**A field declaration replaces the stanza.** One entry per field in `fields.cl.yaml`,
carrying `label` (omit for a bare value), `render` (one of the seven functions, default
bare), `join` separator, `wrap` around the value, `wrapLabel` to put the label inside the
wrapper, `block` to put the value on its own line, `from` for a value assembled from more
than one path, `always` for an unconditional line, and `labelWhen` for a conditional
label — which exists because The Institute relabels `appearance` to `Current Appearance`
when `originalAppearance` is also present, its before-and-after premise, and a static
label cannot express it. **A field's declaration never varies by branch**; there is
exactly one `appearance` declaration in a project.

### §13.3 Groups and template lists

**A group is a named sub-list** — what a partial's grouping role becomes. **A template is
an ordered list of field or group names**, expanded in place, list order equal to output
order. An entry may override the declaration inline
(`{ field: vibe, label: Culture Vibe, render: bare }`), which is required rather than a
convenience — `History` renders `vibe` as `Culture Vibe:` without the universal join, and
there is no other way to express it. Groups do not nest, matching item `include:`.

`fields:`, `groups:` and `templates:` are three namespaces in one `fields.cl.yaml` per
templates directory. The loader merges **key-wise, later winning per entry** (not per
file, and not deep): a project overriding one label writes one entry, and a project adding
`labelWhen` restates `label` and `join` alongside it. File-level replacement — what
`loadNamedFiles` does for templates — would make a project overriding one label restate
all fifty, the duplication §13 removes reintroduced through the loader.

**A field-list template renders through the text engine, not around it.**
`src/render/field-list.js` *generates* the `.template` source each declaration is
shorthand for, concatenates the stanzas, and hands the result to `render()`. So a field
list and the hand-written `.template` it replaces go through one identical code path,
which is what makes byte-identity between the two a real property rather than two emitters
happening to agree.

### §13.4 `templateFor` — rendering roles, branch-addressable

**`templateFor` is a branch-merged map from rendering role to selection file**, one slot
per role: `base`, `notes`, and one per component (`plotEssential`, …). An unset slot falls
back to `base`. What merges down the branch chain is the type-to-template map the files
*produce*, key-wise — no new merge rule, the same one-level overwrite `components:` uses.
So a `lowContext` branch declaring `templateFor: { base: terse.cl.yaml }` renders terse
versions of the types `terse.cl.yaml` defines and inherits the full list for every type it
does not mention.

**The three ladders, with `templateFor` inserted:**

| Role | Resolution, most specific first |
|---|---|
| Body | a *chosen* item `render.template` → `templateFor.base` keyed on `aid.type` → `aid.type` matched against a loaded text template → verbatim |
| Notes | item `render.notesTemplate` → `templateFor.notes` keyed on `aid.type`, then the `render.notesTemplate` scalar → §4.5's default |
| Component target | a *chosen* target `template:` → `templateFor.<component>` keyed on `aid.type` → `templateFor.base` keyed on `aid.type` → `aid.type` matched against a loaded text template → verbatim |

**Rung 1 counts a template name as a choice only when it differs from `aid.type`.**
`model/item.js` fills `render.template` and a component target's `template:` with
`aid.type` for every card that names neither, and every type has a shared-table list of
its own name — so a rung 1 that honored that fill would shadow every branch's
`templateFor` map for the whole corpus. A name equal to `aid.type` is treated as absent.
A name that differs — a cross-type name, `Character.hint`, or a free-standing name a
branch's slot file defines — still wins at rung 1. **Pattern 2** is that last case:
`terse.cl.yaml` defines `CharacterFull`, one important NPC writes
`render.template: CharacterFull`, and because the slot file is branch-scoped the full list
applies only where the tier is loaded — a terse cast keeps its one detailed NPC without a
per-item flag. The notes ladder needs no guard, since nothing fills `render.notesTemplate`.

This supersedes the branch-level special case §6.3a was: `render.notesTemplate` on a
branch existed *because* a filename suffix cannot be branch-addressed, and `templateFor`
generalizes that to every rendering role. Context tiering (`10-field-declarations.md`) is
this mechanism with a terse field list per tier and a label-membership guard that proves
a terse list only ever shortens.

### §13.5 Override granularity — library to project

**The library→project axis and the root→branch axis layer at different points and compose
without interacting.** The templates search path handles library→project (a static fact
about the scenario); `templateFor` handles root→branch (what varies inside it). This is
the fix for a divergence the old design could not avoid: overriding a partial to change
one field meant adopting permanent ownership of every other field in it — The Institute's
`personality.partial` copy carries `personality.expanded` unchanged, byte-identical to the
library's and now frozen, so a future library change to that field will not reach the
project and nothing will report it.

### §13.6 What stays a text template

**`.template` is the escape hatch, and three real files need it.** `Notes.template` reads
`$notes` and is not a card body; `System/WTG Time Config.template` is ~40 keys of mod
configuration; and one `name` line mixes a top-level token with an inline conditional
suffix. A field declaration expresses fifteen of the eighteen distinct stanza shapes in
the corpus; those three are the remainder. A field list can still carry an irregular line
through `{ include: name }` (drop an `{include}` for a partial), `{ raw: "…" }` (a literal
fragment), or `{ allowExtra: true }` (opt the whole template out of the §13.7 audit).

### §13.7 The checks this makes possible

Having a declaration to compare against produces three checks, all WARN:

- **`CL0426`** — a `body:` key no declaration names: a typo, and content silently dropped
  from the card. WARN not ERROR because a shared `library:` item can legitimately carry a
  field for a template another project uses, and an ERROR would make shared items
  unshareable.
- **`CL0427`** — a key declared globally but absent from this template's list: misrouted,
  and the message names the group it lives in.
- **`CL0428`** — a declared field no template names: a dead declaration, the counterpart
  to `CL0545`, and what stops the field table rotting the way a hand-maintained schema
  document does.

The audit runs on resolved leaf paths (so `from: [personality.keywords,
personality.expanded]` still flags a typo in a sub-key), keys findings on
`(item id, field path)`, and emits each once — a `body:` field resolves through every
`variants:` and `branches:` expansion, so one mistake would otherwise report once per
leaf. `{ allowExtra: true }` opts a whole template out — Directory and Unstructured
compose their bodies from author-shaped sub-keys feeding an interpolated value, and the
property belongs to the template, not to each field. None of the three is an opinion
code: a field is read or it is not.

### §13.8 The schema document is generated

**The field/label tables and the type-to-field membership are mechanically derivable from
`fields.cl.yaml`.** `--schema-tables` writes `schema-tables.md` under the resolved reports
directory during a compile that already loaded the field table, frozen by the golden
harness the same way `--with-inventory` is. It does **not** write the external `SCHEMA.md`
— that file lives in another repo and this compiler has never written outside its own tree
— a human copies the tables across. Where the generation disagrees with the committed
document, the document is wrong; that drift is what this corrects. The authoring
conventions in that document (budget targets, the card-role spectrum) stay hand-written
and are untouched. Shipped in Phase 12.

---

## §14. Migration

### §14.1 Clean break — no compatibility mode

**`version: 4` is required, and its absence is how a v3 project is detected.** A missing
key or `version: 3` routes to a "run `codex-loom --migrate`" message (`CL0209`), reported
before the rest of schema validation so a v3 config gets that one line rather than a
cascade of unknown-key errors for every key v4 renamed or removed. Viable because Codex
Loom had one user and had not been shared when the break was made.

### §14.2 The migration tool

**`codex-loom --migrate <project>` converts a v3 project in place and does not compile.**
It rewrites `compile.yaml`, every item file, every template and every component document
to the v4 schema, then writes `migration-report.md` beside the config — every file it
touched, and a review queue of the conversions that need a human eye. The review queue is
one thing: a prose fragment that now carries a converted role token beside a hardcoded
gendered pronoun. The migrator cannot decide whether the pronoun should become a role
reference too; only a person can. `--migrate --rename-cl` additionally renames
`compile.yaml` to `compile.cl.yaml` and applies the `.cl.yaml` suffix to the files it
writes. It runs alone — it cannot be combined with a compile or a report mode.

`migrateProjectFully` in `src/migrate/index.js` is the driver; the v3-format converters
are `stripTemplateHeader` in `src/migrate/v3.js` (delete everything through the last
`~~~`), and one per v3 file format §7.1 counted, each converting to `sections:` —
`src/migrate/description.js`, `src/migrate/opening.js`, and the pair
`src/migrate/plot-essentials.js` (decides what each block becomes) and
`plot-essentials-apply.js` (does the surgery). Plot Essentials needs the split because its
conversion is not local: a v3 Plot Essentials file *resolves items*, so every block has to
become a slot on the component plus a render target on the item it named, in a different
file. Author-facing detail — what changes and the hand
edits the review queue asks for — is `documentation/15-migrating-from-v3.md`.

### §14.3 Golden fixtures and the re-baselining protocol

**Before any v4 code was written, the compiled output of three real projects was frozen as
fixtures on v3.** The existing tests pin *intent* — that a variant applies, that a token
resolves — not whole-output identity. Without the fixtures there is no way to distinguish
a refactor regression from the pre-existing bug class the refactor exists to eliminate,
and the failure surfaces as bleed in a live scenario rather than as a red test.

**The protocol is what makes fixtures actionable past Phase 1.** Several phases change
output deliberately, so "match byte-for-byte" cannot hold throughout. Each phase declares
up front whether it is output-preserving; a phase that is not re-baselines, stating the
*expected* shape of the diff in the commit, and anything outside that shape blocks the
phase. A re-baseline is a reviewed, committed artifact — never "regenerate because it went
red." `__tests__/helpers/diffShape.js` and `EXPECTED_DIFF_CLASSES` in `golden.test.js`
classify every changed line of compiled output as `fence`, `title` or `body`, so a phase
can declare the shape of its intended diff and have anything else fail;
`scripts/rebaseline.js` enforces the same classification before it will write a new
baseline.

**The goldens are a separate private repo cloned into the gitignored `goldenFixtures/`**,
because the projects contain unpublished writing. If that directory is absent,
`golden.test.js` and `migrate.integration.test.js` register their suites as skipped, one
`describe` in `emit-vl.test.js` skips, and everything else runs. A green run with the
goldens skipped and a green run with them satisfied look the same — so an output-affecting
change is not done until the goldens are confirmed to have actually run.

---

## §17. Shared Library resolution — multiple library sets in one project

### §17.1 The problem

**`buildCanonRegistry` errors on any id defined in two library sets**, which is correct
while every set is the author's own and a duplicate means a mistake. It stops being
correct the moment a library is shared between authors: two settings both name an item
`magic`, one meaning elemental manipulation and the other blood magic, both authors right,
and a third author wanting both currently cannot have them. Personal curation — renaming
your copy of someone else's set — is the un-Codex-Loom answer: it diverges the local copy
from upstream, which is exactly what the library snapshot (§11) exists to prevent.

### §17.2 Qualified references

**A reference is a plain id (`kaiden`) or one qualified with the library set that owns it
(`grimwood:magic`).** Qualification is optional and needed only where two sets define the
same id. `:` is illegal inside an item id (`CL0144`), so the first colon is unambiguously
the separator.

`resolveItemRef` in `src/model/refs.js` is pure (§3.3): it returns `{ item }` or
`{ item: null, code, message, hint }` and the caller decides what that becomes. The
registry is a plain `Map` first — plain lowercase id → item, so every existing
`registry.get(id)` reads it unchanged — with three sidecars:

| Sidecar | Holds |
|---|---|
| `qualified` | `set:id` → item, for every library item, so `grimwood:magic` always resolves |
| `ambiguous` | plain id → the rival items, for ids more than one set defines |
| `sources` | the declared set names, so an unknown qualifier (`CL0341`) is distinguishable from a known set that lacks the id (`CL0342`) |

### §17.3 Ambiguity is reported at the reference, not at load

**A duplicate id across two library sets is not fatal and is not resolved by declaration
order.** Both copies are kept and the plain key is left empty; only a reference that
cannot choose between them fails, and it fails at the reference (`CL0340`, which names both
rivals and the qualified forms). The absence of the plain key *is* the mechanism — the
unqualified lookup has to miss before the resolver can reach the sidecar and name the
alternatives.

The asymmetry with the two fatal cases is deliberate. One set owning an id twice is a
mistake inside that set; a project id colliding with a library id is a clash whose both
sides the author owns. A cross-set clash is neither, so it is reported where a project can
act on it rather than refused at load.

### §17.4 Rename-on-import

**An `import:` def may carry its own `id:`, which registers the imported item under the
local name** — `id: blood-magic` over `import: grimwood:magic` to hold both magic systems
side by side, or `id: dragon` over `import: wyvern` with local `v:` deltas for a library
monster plus a near neighbor. The single-library case is what justifies this, not the
multi-library one: the wyvern/dragon shape is useful in a project loading one set.

**Only the id moves.** `name:` is left at whatever the imported item called it — `id:
dragon` over `import: wyvern` is still named Wyvern until the author writes `name: Dragon`,
which is the line that says what they meant. Inferring a display name from an id would be
guessing from a slug and would be wrong for every id that is shorter, lowercased or
hyphenated. Two import defs renaming to the same local id are a duplicate that
`buildRegistry` can no longer see, so the check moves to where renamed imports register
(`CL0325`), and a renamed item's provenance row reads `project`, not `library:<set>`.

### §17.6 Templates following the library set

A `library.cl.yaml` declaring per-set default templates — so a set that files age and gender
under `appearance` ships the template that renders them — is **reserved, not yet built**.
See §9.4 and `documentation/13-roles.md`.

---

## Appendix A — Phases, as built

The v4 rebuild ran as a sequence of numbered phases (the vault spec's §15 held the plan).
It is complete; the table records what each phase shipped and which section of this file
covers it. Later work is a task queue, not a phase — there is no Phase 18.

| Phase | Shipped | Sections |
|---|---|---|
| 0 | Golden fixtures frozen from three real scenarios on v3 | §14.3 |
| 1 | Foundation: `preparse.js`, `diag.js`, schema validation, config/loader split, one branch walker, table-driven components, card→item rename, `{@}`→`{%}`, `structure.input.components` removed, shared library resolution | §3, §4.1, §4.3, §4.4, §5.1, §6.1, §17.2–§17.4 |
| 2 | `emit/vl.js`; templates render body only; shared parser; trigger `_` padding; `notes:` field; `encapsulate`→`wrapper` | §4.2, §4.5, §8, §8.4, §8.6 |
| 3 | Item/slot model; `pe.js` deleted; component sections; the no-output invariant; `--with-inventory` | §7.2, §7.4, §7.9 |
| 4 | Player placeholders + the `${…}` confusability lint | §12 |
| 5 | Platform limits (caps, WARN bands, `--card-sizes` rework); `kind:`; the compiler/lint split and `lint.level` | §4.8, §8.5, §12.5 |
| 6 | Component `imports:`; the section fan-out and arity-silence rule; description as a component, split into `description:` / `adventureDescription:`; openings onto the sections grammar; the `notes:` cap | §7.6, §7.7, §7.1 |
| 7 | The library snapshot (items, components, shared templates); `canon:`→`library:` and `vault:`→`snapshot:` renames | §11 |
| 8 | Roles; the migration review queue; the `--migrate` CLI; `protagonist:` retired into `roles:` | §9, §14.2 |
| 9 | Template parser rewrite (`render/parse.js` + `render/eval.js`); template diagnostics onto the bus with a span; the cross-item dependency-ordering rewrite | §13, §4.4 |
| 10 | One compiled-tree shape replacing three ancestor walkers, encoding VL's merge rules; `CL0622`; provenance report; five report modes frozen against baselines; roles reaching framing and the root Description | §7.3a, §17.2 |
| 11 | The config-side branch walk takes a root node; VL-native inheritance — stop copying components, scripts, placeholders and cards to every leaf; drop `Label.md` where it equals the directory name | §7.3a, §8.7 |
| 12 | The declarative template surface — a field declared once, a template an ordered list, `templateFor` branch-addressable; the unread-field audit; the generated schema reference | §13.2–§13.8 |
| 13 | Context tiering as branches, with player-swappable `render.storyCards`; the notes ladder collapsed to three rungs | §7.8, §4.5.1 |
| 14 | Convention packs going live, built by shipping `wtg` as the first real pack | §8.2.2 |
| 15 | Convention packs round two: the `WTG Time Config` rule, and the vocabulary to express it (`requireCard`, `over: body`, `pattern`, `keys`-on-`record`) | §8.2.2 |
| 16 | The `duckieConv` authoring-conventions pack and the `meta:` channel it reads; the `budget` / `count` / `mutexHint` rule primitives | §8.2.2 |
| 17 | Audit-driven refactor: `compile.js` decomposed 3,785→1,026 lines across twelve modules; `resolver.js` / `tokens.js` deleted; `version: 4` validation; the `--migrate` duplicate-id bus fix. No output change | §3.2 |
