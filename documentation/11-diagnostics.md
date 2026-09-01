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

Only `$` reaches this check from a plain parse. An unquoted `{%role}` is a hard parse
error (`CL0101`) on YAML's `%` directive indicator, not a silent swallow — but `%` stays
in the guard's set because `{%…}` is a live token family, so a mapping of that shape
arriving by any route is still worth flagging. `@` is not covered: the `{@}` token family
was removed in §6.1, so a `{'@pe': null}` mapping names nothing this check could report.

### CL01xx continued

| Code | Severity | Meaning |
|---|---|---|
| `CL0110` | ERROR | `compile.yaml` is not a mapping of configuration keys. |
| `CL0111` | WARN | `structure.input.snapshot` names a directory `--snapshot` never populated. |
| `CL0112` | WARN | `snapshot/manifest.json` exists but is not valid JSON, or not the expected shape. |
| `CL0113` | WARN | A `structure.input.library`/`templates` entry the config declares has no section in an otherwise-valid manifest. |
| `CL0114` | WARN | A file under `snapshot/<name>/` on disk has no entry in the manifest. |
| `CL0115` | ERROR | A file under `snapshot/<name>/` no longer matches its own manifest-recorded hash. |
| `CL0116` | ERROR | `--snapshot` cannot compute `requiresRoles` for a library entry because the entry's own items do not validate. |
| `CL0117` | ERROR | A convention pack (§8.2.2) is missing, unparseable, or not shaped like a pack — the pack is named. |
| `CL0118` | WARN | `lint.packs.<name>: ~` on a branch that never inherited that pack — nothing was unbound. |
| `CL0119` | ERROR | A convention pack's declared `name:` disagrees with the `lint.packs` key it was loaded under — both are named. |
| `CL0120` | WARN | A declared input path does not exist on disk. |
| `CL0130` | WARN | An `include:` path does not exist. |
| `CL0131` | ERROR | The same file was included more than once. |
| `CL0140` | ERROR | An item has neither `id:` nor `name:`. |
| `CL0141` | ERROR | Duplicate item id. |
| `CL0142` | WARN | An item declares more than one `v:` alias; they are merged. |
| `CL0144` | ERROR | An item id contains `:`, which is reserved as the canon-set separator in a reference. |

### CL0111–CL0115 in detail

Five conditions from `--snapshot`'s freeze (§11.2), raised by `checkDrift` on every compile
that has `structure.input.snapshot` set — never by a project that leaves the key unset,
which is every project until it opts in. All five read `snapshot/manifest.json`; none of
them read the live library, because the *drift* line — a library file that changed since
the last sync — is deliberately informational only and never reaches this bus (§Decision 4
of the Phase 7 plan: a freeze whose drift blocks a build is a dependency lock with worse
ergonomics, not a freeze).

`CL0115` is the one ERROR in the band, because it is not drift — it is the *frozen copy
itself* disagreeing with what was recorded about it, which only a hand edit after
`--snapshot` produces. A stale snapshot is expected and comfortable; a corrupted one means
the freeze can no longer answer the question it exists to answer.

`CL0113` and `CL0114` are mutually exclusive per entry: a config-declared name with no
manifest section (`CL0113`) is checked, and skipped, before the file-level comparison that
would raise `CL0114` ever runs for that same entry — there is nothing to compare a missing
section against.

`CL0116` is raised by `syncLibrary` itself, on `--snapshot`, not by `checkDrift` at compile
time — the other five read an existing manifest, and this one is raised while writing a
new one. `requiresRoles` (§9.4.4) is computed by elimination: a `{$X}` token that resolves
to no item id anywhere in the snapshotted library is published as a required role. That is
only trustworthy for an entry whose own item content validates cleanly — a set with a
schema violation or a broken registry build gets `CL0116` instead of a role list, since an
elimination result computed over content the compiler itself cannot load would be a claim
resting on nothing. Sync still runs and the entry's files are still frozen; only its
`requiresRoles` key is withheld.

### CL02xx — schema

| Code | Severity | Meaning |
|---|---|---|
| `CL0201` | ERROR | Unknown key. Carries a spelling suggestion when one is close. |
| `CL0202` | ERROR | Key has the wrong value type. |
| `CL0203` | ERROR | A required key is missing. |
| `CL0204` | WARN | Key is recognized but not read — either its phase has not landed or it never will; it is ignored. |
| `CL0205` | WARN | Key has been superseded by another spelling. |
| `CL0206` | ERROR | Key takes a closed set of values and got something else. |
| `CL0207` | ERROR | A number is outside its descriptor's inclusive `min`/`max` bounds. Used by convention-pack schemas (§8.2.2); no `compile.yaml` key declares bounds. |
| `CL0208` | ERROR | A string does not match its descriptor's `pattern:` regex, compiled case-insensitively. Used by convention-pack schemas (§8.2.2); no `compile.yaml` key declares a pattern. |
| `CL0209` | ERROR | `version: 4` is missing or wrong. A missing key or `version: 3` names `--migrate` (§14.1); any other value is reported as unsupported. Raised before the rest of schema validation, so a v3 config gets this line alone. |
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
| `CL0322` | WARN | An item emitting a story card has neither `aid.type` nor `render.template`. |
| `CL0323` | ERROR | An item declares both `notes:` and `description:`. |
| `CL0324` | ERROR | An item could not be resolved — most often a failed `import:`. |
| `CL0325` | ERROR | Two item definitions resolve to the same id on one branch. |
| `CL0326` | WARN | A selector aimed at many items matched none of them. |
| `CL0340` | ERROR | A reference is defined in more than one canon set and is not qualified. |
| `CL0341` | ERROR | A reference names a canon set not declared in `structure.input.library`. |
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

`CL0325` catches the duplicate that the registry structurally cannot see. A def carrying
`import:` with no `id:` of its own claims no registry id — it *is* the item it names — so
two of them, or one alongside an explicit def of that id, never meet in the registry and
its duplicate-id check never runs. What ships is two entries in one Plot Essentials slot
and two story cards sharing a name and a trigger list, from a compile that reported
nothing. The check runs per branch, because branch dispatch legitimately sends one of a
colliding pair away; a def dispatched off this branch is not a duplicate on it.

`CL0326` exists because `CL0321` had to stop firing at two positions. How many targets a
selector was aimed at decides what a missing variant means. Aimed at one item — an
`import:`'s `importVariants:`, or an item's own `branches:` — a name the item does not
define is a typo, and `CL0321` says so. Aimed at every item in an included file, which is
what an `include:` does with both keys, most items will miss the name by construction:
naming the variant on each item is exactly the repetition the include removes. `CL0321`
there was one warning per item per selector per branch — seventeen on a twenty-item lore
file where three define the name — for authoring that was never wrong.

`CL0326` is what makes that silence safe, and it is the whole of what replaces the
per-item warning. A misspelled fanned-out name applies to nothing, alters no output, and
would otherwise raise nothing at all. Three of seven targets matched is normal; zero of
seven is a mistake, and only the second is reported. The `importVariants:` half is checked
once per compile, because that selector does not depend on the branch; the `branches:`
half is checked per branch, because a dispatch has no answer without one.

### CL04xx — render

| Code | Severity | Meaning |
|---|---|---|
| `CL0410` | ERROR | A `.template` or `.partial` still contains a `~~~` fence. |
| `CL0429` | ERROR | Two files in one templates directory resolve to the same name (case-insensitively). Aborts the load — the merge has no defensible winner. |
| `CL0411` | ERROR | A `render.notesTemplate` in compile.yaml names a template that is not loaded. |
| `CL0412` | ERROR | A `render.notesTemplate` on an item names a template that is not loaded. |
| `CL0413` | ERROR | A render-function call in a template or body field does not parse. |
| `CL0414` | ERROR | A template uses an unknown render-function name. |
| `CL0415` | ERROR | An `{if}`, `{wrapper}`, or `{preserve}` block is not closed. |
| `CL0416` | ERROR | A partial includes itself, directly or indirectly. |
| `CL0417` | ERROR | An `{include NAME}` names a partial that is not loaded. |
| `CL0418` | ERROR | Cross-item render-function references form a cycle. |
| `CL0420` | ERROR | No loaded template matches an item's `aid.type` or `render.template`. |
| `CL0421` | ERROR | A template threw while rendering an item. |
| `CL0430` | ERROR | A `{$…}` field, pronoun or character token survived into rendered output. |
| `CL0431` | ERROR | A `{%key}` compile.yaml variable survived into rendered output. |
| `CL0432` | ERROR | A render function (`{join}`, `{list}`, `{and}`, …) leaked into rendered output. |
| `CL0433` | ERROR | A template control tag (`{if}`, `{wrapper}`, `{preserve}`, `{include}`) leaked into rendered output. |
| `CL0434` | ERROR | A verb-conjugation marker (`[s]`/`[es]`/`[is]`/`[was]`/`[has]`) was left unresolved. |
| `CL0435` | ERROR | A JS interpolation artifact (`[object Object]` and friends) reached rendered output. |
| `CL0422` | ERROR | A `fields.cl.yaml` is not a mapping, or one of its `fields:`/`groups:`/`templates:` entries has the wrong shape. |
| `CL0423` | ERROR | A `fields:` entry carries an unknown key or an unknown `render:` function name. |
| `CL0424` | WARN | A group member or template entry names something that is not a declared field or group. |
| `CL0425` | WARN | A file in a templates directory looks like a misspelled `fields.cl.yaml` and is being ignored. |
| `CL0426` | WARN | A `body:` key is read by no field in the resolved template and no declaration names it — a typo; its content is dropped. |
| `CL0427` | WARN | A `body:` key is a declared field the resolved template's list does not include — misrouted; the message names the group it lives in. |
| `CL0428` | WARN | A field is declared in the field table but no template names it, directly or through a group. |
| `CL0436` | WARN | A bracketed lowercase word is not a recognized verb-conjugation marker — likely a typo. |
| `CL0437` | WARN | A bare `undefined`/`NaN` appears in rendered output. |

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

`CL0412`–`CL0418`, `CL0420` and `CL0421` are per-item and report at render time, which is why they
are not the load-time check `CL0411` is. Each drops the one thing it names — the notes
line, the failed directive, or the whole item — and leaves the rest of the leaf intact, and each fails the run
once the tree is written.

`CL0429` is a hard load-time failure, not a bus diagnostic: when two files in one
templates directory resolve to the same name, `loadNamedFiles` throws before any
compile begins. It cannot degrade to a WARN — with two files claiming one name the
merged name→file map has no defensible winner — and it runs before a diagnostics bus is
in scope, since two of the three `loadTemplates` call sites pass none. The message names
both colliding files. Later directories on the search path still override earlier ones on
a name collision (that is the intended layering); the error is only for a collision
*within* a single directory.

### CL0430–CL0437 in detail

`CL0430`–`CL0435` are the leaked-artifact sweep, run over every finished string the
compiler writes: each story card, each assembled component, each `Opening.md`, and the
Description. Every one of them means **the compiler failed and the failure is visible in
the file it just wrote** — a fact about the output, not an opinion about it — which is why
they are ERRORs and why `lint.level` cannot reach them (spec §12.5).

They share the `CL043x` decade rather than filing `{%key}` under `CL05xx` with the other
variable diagnostics. What is reported here is not the token family but the leak: one
detector set, run at one moment, over one finished string. Splitting them by what leaked
would scatter a single check across three bands and make the sweep unsearchable.

**Before Phase 5 these printed a bare `WARN:` line with no code and gated nothing**, while
`--lint` listed the same patterns as ERRORs. One check gave two answers depending on which
half of the tool ran it. A project shipping a leaked `{$she}` now fails the compile.

`CL0436` and `CL0437` run in the same sweep and are *not* facts. Both judge whether
ordinary prose was meant: `[does]` may be a deliberate bracket, and "undefined" is an
English word. They stay WARN, they are tagged opinion-layer, and `lint.level` reaches them.

### CL0422–CL0428 in detail — the field table

`CL0422`–`CL0425` are load-time checks on `fields.cl.yaml` itself: a malformed document,
an unknown key or render function, a group or template entry that names nothing, and a
filename that is a near-miss of `fields.cl.yaml` (a `templateFor` slot file that only
resembles one is left alone). A structurally broken entry is skipped and the rest of the
table still loads, because a downstream project may override the whole file.

`CL0426`–`CL0428` are the unread-field audit (spec §13.6). A field-list template names the
`body:` keys it renders, so a key no field reads is content the compiler silently drops —
the diagnostic the external schema reference was hand-maintained to stand in for. One
symptom splits three ways: a key **no declaration names** is a typo (`CL0426`), a key
**declared but absent from this template's list** is misrouted and the message names the
group it lives in (`CL0427`), and a **declared field no template names** is a dead
declaration (`CL0428`, the counterpart to `CL0545`). None is an opinion — a field is read
or it is not — so `lint.level` cannot reach them.

The audit runs on resolved leaf paths, not top-level keys, so `from: [personality.keywords,
personality.expanded]` still flags `personality.other`. Findings key on `(item id, field
path)` and are emitted once: a `body:` field resolves through every `variants:` and
`branches:` expansion, so one mistake on a 32-leaf project would otherwise report 32 times.
A `{ allowExtra: true }` marker in a template's list opts the whole template out — Directory
and Unstructured compose their bodies from author-shaped sub-keys feeding an interpolated
value, and the property belongs to the template, not to each field.

### CL06xx — components

| Code | Severity | Meaning |
|---|---|---|
| `CL0601` | ERROR | A section declares both `text:` and `slot: true`. |
| `CL0602` | WARN | A section has no text, no heading and is not a slot, so it renders nothing. |
| `CL0603` | WARN | A section's `render.wrap` is neither `each` nor `all`; `each` is used. |
| `CL0604` | WARN | A section's branch dispatch names a variant the section does not define. |
| `CL0605` | WARN | A component-level branch dispatch names a variant no section defines. |
| `CL0606` | ERROR | A component `imports:` entry names a `from:` that does not resolve to a file. |
| `CL0607` | ERROR | A component import chain loops back on a file already being resolved. |
| `CL0608` | WARN | A section is deleted with `~` but no import provided it. |
| `CL0610` | ERROR | An item resolves onto a branch and produces no output there. |
| `CL0611` | ERROR | A render target names a slot the component does not declare. |
| `CL0612` | ERROR | A render target names a section that exists but is not a slot. |
| `CL0613` | ERROR | A render target names no slot at all. |
| `CL0614` | WARN | A declared slot has no items on a branch. |
| `CL0615` | ERROR | A component renders to nothing on a branch. |
| `CL0616` | ERROR | A leaf carries an adventure description and declares no `Opening.md`. |
| `CL0617` | ERROR | A section's `file:` or `from.script:` does not resolve to a file. |
| `CL0618` | ERROR | A section's `extract:` names no known transform. |
| `CL0619` | ERROR | A section declares more than one of `text:`, `file:` and `from:`. |
| `CL0620` | WARN | `metadata:` on a component whose output has no place for frontmatter. |
| `CL0621` | WARN | Both description keys aimed at one file — an unbranched project. |
| `CL0622` | ERROR | Two story cards share a display name on the same leaf — Velvet Lattice merges by name, so only one reaches AID. |
| `CL0623` | ERROR | A `render.storyCards` entry (§7.8) declares no `title:` — the title is the card's AID name and the frontier keys on it. |
| `CL0624` | WARN | A `render.storyCards` entry's `sections:` names a section the component does not declare; it is dropped from that entry. |
| `CL0625` | WARN | A `render.storyCards` entry renders no text on a branch — its `variant:` / `sections:` selectors left nothing. No card is written. |
| `CL0626` | ERROR | Two `aid.type` values differ only by case, so they are one file on a case-insensitive filesystem and one group's cards are overwritten. |
| `CL0627` | WARN | An `aid.type` names an AID built-in category in non-lowercase form; it is folded to lowercase. |
| `CL0628` | WARN | An `aid.type` has leading whitespace; it is trimmed. |
| `CL0629` | ERROR | `adventureDescription` declares `advanced:` or `description:` in `metadata:` — both belong to the scenario blurb only. |
| `CL0630` | WARN | A branch leaf resolves neither an `opening:` nor an `adventureDescription:`, inherited or its own — Velvet Lattice would start it with an empty prompt. |
| `CL0631` | WARN | A branch leaf resolves no `aiInstructions:`, inherited or its own — Velvet Lattice writes an empty-string AI Instructions, which suppresses AID's model default rather than falling back to it. |
| `CL0632` | ERROR | `aid.type` fails path-legality: empty/whitespace, an illegal path character, `.`/`..`, or a trailing space/period. |
| `CL0633` | WARN | `branchFraming` on a node with nothing below it to frame — the root with no branches, or a leaf. |
| `CL0634` | ERROR | A requested component produced no output anywhere in the compile. |

`CL0601` is an error rather than a resolved precedence because the two readings differ in
output and neither is obviously right: text inside a slot could sit before or after the
occupants, and could fall inside or outside the slot's wrapper. A preamble is already
expressible as its own text section positioned ahead of the slot, so refusing the
ambiguity costs an author nothing and keeps the option of allowing it later.

`CL0602` stays a warning because an empty section is inert rather than wrong — a section
gated off on every branch by its own dispatch is the ordinary way to park content. The
error that matters is one level up: a *component* that renders to nothing, `CL0615`.

`CL0605` is `CL0326`'s shape one layer up, and exists for the same reason. `branches:` on a
section names one target, so a variant it does not define is a typo and `CL0604` says so.
`branches:` on the component document names *every* section it holds, so missing most of
them is what fanning out is — warning per section would report the feature working. What
that silence costs is the typo, and this is what buys it back: a name matching no section at
all applies to nothing, alters no output, and would otherwise raise nothing.

`CL0606` and `CL0607` are errors because both leave the finished component missing whatever
the import was carrying, and the file that lands still looks complete — the local sections
render, the slots fill, and the shared half is simply absent. A `from:` resolves against the
*project base* unless it is absolute — the same base `include:` and every `components:` entry
use, chosen over the importing file's own directory because a `{%variable}` is written
relative to the project and a bare path would not be, which would give one key two bases
depending on whether the string happened to contain a token. It
expands against the *root* variable table rather than a branch's: the document is cached by
resolved path and shared across every leaf, so a `from:` that varied by branch would make
one cache key stand for two documents. `CL0607` skips the offending import rather than
following it, because the alternative is a stack overflow naming neither file.

`CL0608` is `CL0530`'s shape one layer up. `~` on a section name removes a section an import
provided; removing one nothing provided is meaningless as written and reliably means the
author expected an import to supply it — a renamed section upstream, or a misspelling. It
stays a warning because the result is what the author asked for either way: no section of
that name. A document with no `imports:` at all never raises it, because there `~` is the
plain "omit this" it has always been.

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

`CL0616` is the price of per-node descriptions. Velvet Lattice sets a node's prompt to
`components["Opening"] or node.description`, so a leaf carrying a description and no
`Opening.md` does not open on an empty prompt — it opens on the blurb, as though the store
listing were the first scene. It is an ERROR rather than a warning because the output is
wrong in a way that reads as deliberate: the file is present, well-formed, and shows a
paragraph the author wrote. In v3 the pairing could not be constructed at all, since a
description was only ever written at the output root where there is no opening to be
confused with, so this check arrived with `adventureDescription:` and is inseparable from it.

`CL0630` and `CL0631` are the other side of `CL0616` — a leaf that resolves *nothing* for
a prompt-bearing component, not one that resolves the wrong thing. `CL0630` fires when a
leaf has neither an `opening:` nor an `adventureDescription:` in its inheritance chain, so
Velvet Lattice's `components["Opening"] or node.description` yields an empty first turn;
a leaf that has a description but no opening is `CL0616`'s ERROR instead, and `CL0630`
steps aside for it. `CL0631` is the harsher case even though it is also a WARN: a leaf
with no `aiInstructions:` anywhere in its chain gets `aiInstructions: ""` written on AID's
side, and an empty string is not the same as an absent one — AID falls back to its model
default only when the field is absent, so an empty string silently turns the default off.
Both are WARN rather than ERROR because a deliberately bare leaf is a legitimate choice;
both fire on no shipped project, because every corpus leaf inherits both components from
its root.

`CL0617`, `CL0618` and `CL0619` are the three ways a section's source fails, and all three
are errors because each ends with a section that renders nothing while looking authored.
They are raised once per component file rather than once per branch: sources resolve inside
the load that caches by resolved path, which for a component reaching thirty-two leaves is
the difference between a diagnostic and a wall. `CL0619` refuses a precedence rule for the
same reason `CL0601` does — a file could reasonably replace the text, precede it or follow
it, and every answer is a convention an author would have to look up. The `text:` is kept
and the source ignored, which at least leaves the more explicit half standing.

`CL0620` is a warning because the component is otherwise fine and its output is unaffected.
`metadata:` is declared on every component rather than on Description alone, since the key
describes a document's own metadata and nothing about it is description-shaped — but only a
component that writes a file with a place for frontmatter can emit it, which today is
Description. Declaring it elsewhere is an author expecting an effect there is nowhere to put.

`CL0621` fires only on an unbranched project, where the root is its own leaf and both
description keys write the same `Description.md`. The scenario blurb survives, because it is
the half with a native AID field behind it. It is reported rather than silently resolved
because which of the two the author meant is not recoverable from the file that is left.

`CL0623`–`CL0625` guard §7.8's `render.storyCards` entries. A `render.storyCards` entry is
not an item — it has a `title`, an optional `variant:` and an optional `sections:` subset,
and it renders the component again as a trigger-less `kind: reference` card. `CL0623` is an
ERROR because the title is the card's AID name and its position in the frontier index, so
there is nowhere for an untitled entry to go. `CL0624` and `CL0625` are WARNs on the same
reasoning as `CL0602`: the component field still ships, so a selector that names a missing
section or resolves to nothing is a lost alternate rather than a broken compile.

### CL0629 in detail — the two description keys share a flag they should not

`description:` and `adventureDescription:` both write `Description.md`, so they share one
descriptor row's `frontmatter: true` — and that flag is there for the scenario blurb's sake.
`CL0620` fires when a component *cannot* carry frontmatter; `adventureDescription` can, so
nothing stopped an author from putting `advanced:` or `description:` on a leaf, and the
compiler wrote both through to every leaf's `Description.md` without a word.

The markdown description is a **Scenario** field. A scenario has a landing page that renders
it; an adventure does not. An adventure carries only a plain description, which AID seeds from
the leaf's Opening and Velvet Lattice can overwrite — safe, because the player can change it
from the post-start menu. There is no equivalent escape hatch for a markdown one.

**ERROR rather than WARN, because the risk is asymmetric and one side is irreversible.** VL 0.2
reads node metadata only at the root, so today both keys are inert at a leaf and the author gets
no signal that they wrote something meaningless. The best case for allowing it is that nothing
happens. The worst case is that AID adds markdown descriptions for adventures — plausible, on
the current pace of platform change — the same frontmatter goes live, sets a field on the
player's own adventure, and leaves them no way to change it. Revisit the severity if that
support arrives with a way for the player to edit it.

Only those two keys are refused. Anything else under `adventureDescription`'s `metadata:` is
harmless at a leaf and passes, rather than the check inventing a whitelist for keys VL does not
read at all.

### CL0626–CL0628 in detail — `aid.type` as a path segment

`aid.type` is written to disk as `Story Cards/{type}/{type}.md`, which makes a category name
into a path segment and drags two filesystem facts into the compiler. `validateCardType`
already handles the fatal half — an illegal character, a trailing space or period that
Windows would strip. These three handle what survives validation and still goes wrong.

`CL0626` is `CL0622`'s shape one layer up. `CL0622` exists because Velvet Lattice merges two
cards by name and only one reaches AID; here the *filesystem* merges two types, and the group
written last overwrites the rest. It is worse than the card case in one respect: the compiler
counts every group, so the run reports the full card count while shipping fewer cards, and
the summary table an author would check to catch it is exactly what hides it. ERROR for
`CL0622`'s reason — an author who wrote a case-variant pair is always wrong, because the two
spellings cannot both exist.

`CL0627` folds an `aid.type` naming one of AID's five built-in categories — `character`,
`class`, `race`, `location`, `faction` — to lowercase. AI Dungeon stores the type string
verbatim and groups by exact match, so `Character` arrives as a *custom* category sitting
beside the built-in `character` rather than inside it. This was confirmed against the
platform: a card pushed as `Race` comes back as `Race`, and a `Location` card and a
`location` card do not group in the scenario editor. Velvet Lattice folded these itself
until 0.2 dropped the normalization, and nothing downstream replaced it. Only bare built-in
names fold — `Character - Dalor` and `Spell - Ice` are deliberate custom groupings and are
left alone.

`CL0627` is reported once per distinct authored value rather than once per card, because the
fold is one authoring decision however many cards share it; per-card reporting would print
27 identical lines for the Institute corpus and bury the finding.

`CL0628` trims leading whitespace. The trailing case is fatal above, since Windows strips it
and the type would silently become a different one; a leading space instead survives into a
real ` Character/` directory and reaches AID as a category differing from the obvious one by
an invisible character. It is trimmed rather than rejected because there is exactly one thing
the author meant. A value that is both trimmed and folded reports only `CL0628`, whose
message already names the final value.

**Order matters between the three.** Normalization runs first and the collision check reads
its output, so `Character` and `character` — which fold to one built-in — are a merge the
compiler performed on purpose and are not reported as a collision. Only a pair that still
differs after folding, like `Widget` and `widget`, still collides. Reversing the order would
report every folded pair as an error.

### CL07xx — emit

| Code | Severity | Meaning |
|---|---|---|
| `CL0701` | ERROR | A trigger value contains a comma. |
| `CL0702` | WARN | A trigger value is empty and will reach AID as an empty key. |
| `CL0710` | ERROR | An `Opening.md` exceeds AID's 4,000-character limit. |
| `CL0711` | WARN | An `Opening.md` is within 10% of the 4,000-character limit. |
| `CL0712` | ERROR | A story card body exceeds AID's 2,000-character limit. |
| `CL0713` | WARN | A story card body is within 10% of the 2,000-character limit. |
| `CL0714` | ERROR | An item's `notes:` exceeds AID's 10,000-character `description` limit. |
| `CL0715` | WARN | An item's `notes:` is within 10% of the 10,000-character limit. |

Both trigger codes are facts about what Velvet Lattice can carry to AID rather than
opinions about content, which is why they live in the compiler and not in lint. `CL0701` is
the sharper of the two: VL joins the trigger list into AID's single `keys` string with
commas, so a comma *inside* a trigger silently becomes two triggers, and the emitter is the
last stage that can still see the difference.

### The platform caps in detail

`CL0710`–`CL0715` are §8.5's field limits. AID truncates rather than refusing, so exceeding
one does not fail the upload — the content arrives shortened and the loss surfaces during
play. A `kind: reference` item is **not** exempt: soft heuristics skip reference items and
hard limits do not, because the platform does not care why an item exists (§4.8).

**Each cap measures less than the file it lives in.**

- A **card body** is Velvet Lattice's `entry` — the section with its `~~~` fence removed
  and trimmed — which becomes AID's `value`. The `## Title` line, the fence and `notes:`
  are all outside this particular cap; `notes:` is checked separately, against its own.
- An **`Opening.md`** is capped per file, not per branch chain. VL merges components keyed
  by filename, so a leaf's opening *replaces* an ancestor's rather than extending it. The
  interior-node framing file and the root framing file are each capped the same way.
- **`notes:`** is typed `str` and assigned straight to AID's `description`, which caps at
  10,000 characters — the same post-substitution measurement as the other two.

**The length measured is the one after placeholder substitution, and that is the whole
point of the check.** VL replaces `%key%` with `${question}`, and a question is longer than
the key naming it — roughly `len(question) - len(key) + 1` characters per reference. An
Opening of 3,900 rendered characters with several placeholders is over 4,000 in AID. When
the two lengths differ the diagnostic prints both:

```
ERROR CL0710 Branches/subject/Components/Opening.md
  Opening for branch "subject" is 4,118 characters after placeholder substitution
  (limit 4,000).
  Rendered length is 3,902; the 6 placeholder references add 216 characters when
  Velvet Lattice expands them to their question text.
```

**The WARN band is 90% of each cap.** Discovering a hard failure at the cap with no prior
signal means finding out when the card is already too big to trim comfortably. A value
exactly at the cap warns rather than erroring — the cap is inclusive.

### CL05xx — tokens

| Code | Severity | Meaning |
|---|---|---|
| `CL0510` | ERROR | A referenced variable is not declared anywhere. |
| `CL0511` | ERROR | Variables form a reference cycle; every key in the loop is named. |
| `CL0512` | WARN | A variable is unbound with `~` but was never inherited at that node. |
| `CL0520` | ERROR | A branch-scoped variable was used where only root variables resolve. |
| `CL0521` | ERROR | A library name collides with a declared variable. |
| `CL0522` | WARN | A component reads from outside the project, and no `structure.input.library` entry covers it. |
| `CL0530` | WARN | A placeholder is unbound with `~` but was never inherited at that node. |
| `CL0531` | ERROR | Placeholder questions form a reference cycle; every key in the loop is named. |
| `CL0532` | ERROR | A `%key%` reaching compiled output is not declared on that branch. |
| `CL0533` | ERROR | A placeholder reached a destination AID does not fill: the Description, or a card's `type`. |
| `CL0534` | WARN | A placeholder reached a title, where AID does not do what writing one implies. |
| `CL0535` | WARN | A placeholder is declared and referenced nowhere beneath its declaring node. |
| `CL0536` | WARN | Two or more placeholders declare the same question text. |
| `CL0540` | ERROR | A `{$X}` token resolves to neither a declared role nor a known item id. |
| `CL0541` | ERROR | A role name and an item id are the same string, which is ambiguous. |
| `CL0542` | ERROR | A role is bound to an item id that does not resolve on this branch. |
| `CL0543` | ERROR | A role is bound to another role name rather than directly to an item id. |
| `CL0544` | WARN | A role is unbound with `~` but was never inherited at that node. |
| `CL0545` | WARN | A role is declared and never referenced by a resolved token anywhere in the compile. |

`CL0530` takes its own decade because `051x` is variables and `052x` is scoping; placeholders
are a third thing in the band and will want neighbors as §12's remaining checks land.

It exists for the §6.4 footgun rather than for careless authors. A bare `heroName:` with
nothing after it parses as null, and null is `~` — so the most natural-looking way to
declare a placeholder is also the way to silently delete one. Unbinding something never
inherited removes nothing and cannot have been meant, which makes it a reliable signal that
the question text is missing; the message says so rather than reporting the deletion
neutrally.

`CL0531` is the cost of resolving nesting at compile time (§12.2). A question may contain
`%key%` referring to another declared placeholder, which Codex Loom expands before writing
the file so that Velvet Lattice's single substitution pass cannot get the order wrong. A
cycle has no expansion, so it is named in full — the author has to break the loop somewhere
and which key the traversal entered on says nothing about where.

`CL0532` is the one placeholder check that is a *fact* rather than an opinion, and so is a
compiler diagnostic rather than lint (§12.5). Velvet Lattice substitutes only the keys its
merged table holds; anything else survives its single pass untouched and is uploaded to AID
as the literal text `%key%`, where the model reads it as noise mid-sentence. Nothing
downstream catches it — VL's own warning scan is about *context*, and fires on keys that are
perfectly fine.

It reports once per key per site, and names the site rather than only the file: by the time
text reaches a write point its source may be a template, a component document or
`compile.cl.yaml`, so a path alone rarely locates the `%key%`. The declared list rides along
as a hint, because an undeclared key is usually a typo of a real one and `%heroname%`
against a declared `heroName` is invisible until the two are printed together.

`CL0533` and `CL0534` are §12.3's context check, rescoped against AID's real behavior
rather than Velvet Lattice's warnings. VL warns on Label, Description/Prompt, AI
Instructions and Summary; two of those are stale, since AID's own documentation added AI
Instructions and Story Summary in March 2026. Placeholders work in every component, and
in a story card's entry, name, triggers and notes. Adopting VL's list would make Codex
Loom stricter than the tool it compiles for, on rules that no longer exist.

Three destinations survive:

| Destination | Behavior | Code |
|---|---|---|
| The Description | Never filled — it is shown before an adventure exists to answer it | `CL0533` |
| A card's `type` | Never filled — it is a category, and a path segment in the compiled tree | `CL0533` |
| A branch title | Prompt fills and the player sees the answer while choosing; the saved adventure keeps the raw text | `CL0534` |
| The scenario title | Never filled — it names the scenario in listings, before an adventure exists | `CL0534` |

Both check the `${...}` spelling as well as `%key%`, and both ignore whether the key is
declared: where a placeholder cannot go, declaring it changes nothing.

The check runs per *placement* rather than per file. §7.10 lets an item route into any
component, so one item body can be legal in one destination and not another on a
per-branch basis, and only the write point knows where the text landed. The `type` check
in particular runs *before* template resolution: `aid.type` selects the template when no
explicit one is named, so a placeholder there also fails to find a template, and CL0420
would otherwise be the only thing reported — the symptom, with the cause skipped past.

`CL0534` covers both titles under one code because it is one authoring mistake — writing
a placeholder into a title and expecting substitution — with two different outcomes. The
message states the outcome rather than the rule, since neither is inferable from anything
visible in the source.

It is a WARN rather than an ERROR in both cases because both are legal to write and a
deliberate one is imaginable: a scenario called `${Roleplaying A Cool AID Scenario}` is a
joke that works precisely because the text is never replaced.

`CL0535` is the reverse of `CL0532`: a question the player answers for nothing. AID's own
guidance puts the practical ceiling at about ten placeholders before players start
abandoning a scenario, so a prompt whose answer goes nowhere is spending a real budget.

**The scope is the check.** It is measured over the declaring node's subtree, not over the
project (§6.4). A root-level placeholder used on one branch of three is normal and correct,
so an unscoped version would fire constantly on well-formed projects; a branch-level one
used only on a sibling really is dead, because the declaration does not reach the sibling.
The hint says which of the two rules applied.

A reference inside another placeholder's question counts as use. Nesting is expanded into
the emitted file (§12.2), so the inner question does reach the player — through the outer
prompt rather than on its own. Usage is therefore read off the raw question text, before
expansion substitutes the reference away.

It is a WARN and an opinion rather than a fact (§12.5): an author mid-draft may reasonably
declare a question before writing the text that will use it.

`CL0536` reads declarations and never use sites, and the distinction matters because the
name invites getting it wrong. Two *keys* declaring one question string is the finding; one
key referenced from twenty places is the feature working as intended and says nothing.

AID collapses identical question text into a single prompt, so two such keys are asked once
and both receive that one answer. An author who believed they had two independently
answerable fields has one, and nothing in the source reveals it — which is why the message
states the consequence rather than the rule.

Compared on the *expanded* question, since two keys can differ in source and agree once
`{%variables}` and nesting resolve. What AID sees is the expanded form, so that is what
decides whether the prompts collapse. Collected against each node's merged table — the set
of keys visible together is the set that can collide — and reported once per distinct
group, because a duplicate declared at the root is otherwise re-found at every node beneath
it and is still one mistake to fix.

It is scoped to placeholders today. §6.4 gives `~` the same meaning for variables, roles
and lint packs — each carries its own unbind-unknown WARN (`CL0512`, `CL0544`, `CL0118`)
rather than being folded into this one. `scripts:` alone still sets the key to null on a
`~` instead of removing it, so there is nothing for this check to say about it.

`CL0521` exists because library names are auto-exposed as variables (§6.1), so the two share
one namespace. A collision is an ERROR rather than a silent precedence rule: there is no
answer to "which one wins" that an author could predict.

`CL0522` exists because `--snapshot` freezes declared library entries, not resolved
dependencies (Phase 7 §11.2 Watch). A shared component reached through a plain `variables:`
entry rather than a library entry compiles and renders correctly and freezes not at all —
nothing else notices, because the file never appears anywhere `--snapshot` looks. It fires
once a compile has actually read the file (component `imports:` chains included, not only a
project's top-level `components:` specs) and the file resolves outside the project base
without a covering entry; a component the project authors itself is never in scope for this
check, however it is written.

### CL0520 in detail

Some values resolve **once, before branch enumeration**, so they can only ever see
root-level variables: `include:`/`import:` paths and everything under `structure:`. A
branch-scoped variable used there is not a typo — it is a scoping mistake, and reporting
it as undeclared would send the author hunting for a declaration that does exist.

Distinguishing the two requires knowing which names branches declare, so the loader
collects that set before resolving any path. A name declared at root *and* overridden per
branch is not affected: it resolves at root and is overridden later, which is the normal
pattern.

Codes for the remaining bands are registered as the phases that mint them land. Two codes
are named by the design docs, not yet implemented, and reserved at their numbers: `CL0143`
(duplicate Codex overlay for one import target) and `CL0310` (unresolvable branch
dispatch). Neither is in `diag.js`'s registry until something raises it. `CL04xx` holds
the template checks and the leaked-artifact sweep; the render rewrite (§13) is what fills
the rest of the band.

### `CL-<pack>/NNNN` — convention-pack findings

A convention pack (§8.2.2) codes its findings **outside the numeric bands**:
`CL-<pack>/<rule-id>`, zero-padded to four digits — `CL-wtg/0001`. The prefix is the
pack's declared `name:`, not whatever key the project used, so a pack hosted in a canon
set yields the same codes in every project that loads it and a suppression stays portable.

Every `CL-` code is opinion-layer by construction (`diag.js:isOpinion`): §12.5 puts every
opinion-layer ERROR in a pack, and `lint.level` — plus the per-pack and per-branch
`level:` ceilings — has to be able to reach them. A pack finding names the pack, the
card, and the branch it fired on, because a pack can validate one branch's `notes:`
config and not another's (§8.2.2).

The two bundled packs are `wtg` (`CL-wtg/0001`–`CL-wtg/0003`, the World Time Generator mod
— see Convention Packs) and `duckieConv` (`CL-duckieConv/0001`–`CL-duckieConv/0004`, the
card-authoring conventions of `SCHEMA.md` §7 — a per-role length budget, list caps, a
faction-field redundancy nudge, and a `meta.duckieConv.role` value check). Both are all
WARN. `duckieConv`'s `count` and `mutexHint` rules run only in the inline compile pass, not
in offline `--lint`; its `budget` and role rules run in both.

The pack layer's own core codes are `CL0117` (malformed pack), `CL0118` (`~` on a pack
never inherited) and `CL0119` (`name:` disagrees with the config key) — all in the loading
band, because loading a pack file is a loading concern.
