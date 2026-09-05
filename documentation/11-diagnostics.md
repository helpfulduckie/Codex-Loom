# Diagnostic codes

Every v4 diagnostic carries a stable code, a severity, and — where the loader can supply
one — a source position. This file is the registry.

Codes are stable identifiers, not descriptions. A message may be reworded at any time; a
code may not be reused for a different problem once it has shipped. That stability is what
lets three things work:

- **Documentation anchors** — a code in a terminal is searchable here.
- **Suppression** — `# codex-loom-disable-next-line CL0442` (planned; not yet implemented).
- **Test assertions** that survive rewording the message they assert on.

## Format

```
ERROR CL0310 codex/npcs.cl.yaml:112:9
  Item "Kaiden" dispatches branch "felix" to variant "Felix", which is not defined
  on this item or on library item "Kaiden" (library:main).
```

Severity is one of `ERROR`, `WARN`, `INFO`. The location degrades gracefully as
information runs out — `file:line:col`, then `file:line`, then `file`, then nothing — so a
diagnostic about a whole project still renders correctly.

A check that runs once per branch leaf appends the leaf to the header, as `(branch a/b)`
or `(branch (root))`, after the location. This is how a role or cross-item error that
fires on several leaves is told apart: the message is the same on each, and the branch is
what differs.

```
ERROR CL0542 compile.cl.yaml (branch felix/hard)
  role "LI" is bound to "Liesel", which does not resolve on this branch.
```

**Template-level positions are imprecise until the render rewrite.** A malformed
`{join(...)}` can be attributed to its template file but not to a span within it. This is
a known, bounded limitation of the current render pipeline rather than a defect: precise
spans need the deferred render rewrite.

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

`CL0101`, `CL0102` and `CL0105` are raised per file by whichever loader reached it — the
item registry, an `include:`, a component document, or `compile.cl.yaml` itself — and the
loader moves on to the next file, so three broken files are three reports in one run. The
load bus aborts the compile once loading finishes. `fields.cl.yaml` is the exception: a
field table that fails to parse is `CL0223`, because a broken field table is its own kind
of mistake.

### CL0105 in detail

`triggers: [{$name.display}]` is **valid YAML** — a flow sequence containing a single-key
flow mapping — so it parses silently to `[{"$name.display": null}]` and produces a
wrong-typed value that surfaces far from where it was written. The preparser
quotes tokens in the positions it can identify; this check catches the whole class
regardless of position, and costs one walk of the parsed tree.

Only `$` reaches this check from a plain parse. An unquoted `{%role}` is a hard parse
error (`CL0101`) on YAML's `%` directive indicator, not a silent swallow — but `%` stays
in the guard's set because `{%…}` is a live token family, so a mapping of that shape
arriving by any route is still worth flagging.

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
| `CL0117` | ERROR | A convention pack is missing, unparseable, or not shaped like a pack — the pack is named. |
| `CL0118` | WARN | `lint.packs.<name>: ~` on a branch that never inherited that pack — nothing was unbound. |
| `CL0119` | ERROR | A convention pack's declared `name:` disagrees with the `lint.packs` key it was loaded under — both are named. |
| `CL0120` | WARN | A declared input path does not exist on disk. |
| `CL0130` | WARN | An `include:` path does not exist. |
| `CL0131` | ERROR | The same file was included more than once. |
| `CL0140` | ERROR | An item has neither `id:` nor `name:`. |
| `CL0141` | ERROR | Duplicate item id. |
| `CL0142` | WARN | An item declares more than one `v:` alias; they are merged. |
| `CL0144` | ERROR | An item id contains `:`, which is reserved as the library separator in a reference. |

### CL0111–CL0115 in detail

Five conditions from `--snapshot`'s freeze, raised by the drift check on every compile
that has `structure.input.snapshot` set — never by a project that leaves the key unset,
which is every project until it opts in. All five read `snapshot/manifest.json`; none of
them read the live library, because the *drift* line — a library file that changed since
the last sync — is deliberately informational only and never reaches this bus: a freeze
whose drift blocks a build is a dependency lock with worse ergonomics, not a freeze.

`CL0115` is the one ERROR in the band, because it is not drift — it is the *frozen copy
itself* disagreeing with what was recorded about it, which only a hand edit after
`--snapshot` produces. A stale snapshot is expected and comfortable; a corrupted one means
the freeze can no longer answer the question it exists to answer.

`CL0113` and `CL0114` are mutually exclusive per entry: a config-declared name with no
manifest section (`CL0113`) is checked, and skipped, before the file-level comparison that
would raise `CL0114` ever runs for that same entry — there is nothing to compare a missing
section against.

`CL0116` is raised by `--snapshot` itself, while it writes the manifest, not by the drift
check at compile time — the other five read an existing manifest, and this one is raised
while writing a new one. `requiresRoles` is computed by elimination: a `{$X}` token that resolves
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
| `CL0204` | WARN | Key is recognized but not read — either it is not yet consumed or it never will be; it is ignored. |
| `CL0205` | WARN | Key has been superseded by another spelling. |
| `CL0206` | ERROR | Key takes a closed set of values and got something else. |
| `CL0207` | ERROR | A number is outside its descriptor's inclusive `min`/`max` bounds. Used by convention-pack schemas; no `compile.yaml` key declares bounds. |
| `CL0208` | ERROR | A string does not match its descriptor's `pattern:` regex, compiled case-insensitively. Used by convention-pack schemas; no `compile.yaml` key declares a pattern. |
| `CL0209` | ERROR | `version: 4` is missing or wrong. A missing key or `version: 3` names `--migrate`; any other value is reported as unsupported. Raised before the rest of schema validation, so a v3 config gets this line alone. |
| `CL0210` | ERROR | Key is valid, but at a different level — with the level named. |

### CL0210 in detail

The more valuable half of unknown-key checking, because of an asymmetry in how the two
kinds of mistake fail. A misspelling usually produces output that is obviously missing
something. A *correctly spelled key in the wrong position* produces output that looks
complete and is quietly wrong — and it can sit in a shared library, inherited by every project
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
| `CL0327` | WARN | A branch spec maps `'*'` to `~`; it is skipped, and `'_': ~` is what was meant. |
| `CL0328` | WARN | A field op changes nothing: every op in a chain missed, or a lone `-{}` / `/{}/{}` missed. |
| `CL0340` | ERROR | A reference is defined in more than one library set and is not qualified. |
| `CL0341` | ERROR | A reference names a library set not declared in `structure.input.library`. |
| `CL0342` | ERROR | A reference names an id that no library set defines. |
| `CL0330` | WARN | A cross-item reference names an item that does not exist. |

The resolution layer touches no filesystem and prints nothing, so these are collected on
the diagnostics bus rather than printed where they arise. Reserved: `CL0310`, unresolvable
branch dispatch.

`CL0323` is an error rather than a merge because the two keys are two spellings of one
field. Two values under two names means the author believes they are two fields, and any
silent winner hides that belief instead of correcting it. The declared `notes:` wins so
output stays deterministic while it is fixed.

`CL0324` is the reason a failed `import:` does not compile quietly. The item is dropped
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

`CL0327` fires when a branch spec — an item's `branches:`, an import's, an include
directive's, or a component's — maps `'*'` to `~`. The walker skips a null wildcard on
purpose: read literally `'*': ~` excludes the item from *every* branch, which no one means
to write, and honoring it would silently empty an item out of a whole scenario. But the
skip is not the same as the item being fine — every author who writes `'*': ~` meant
`'_': ~`, the catch-all that excludes the branches they did *not* name. So the skip stays
and the silence goes. The finding is keyed on the spec object, not the leaf, so a project
with fifty leaves resolving against one bad spec gets one warning.

`CL0328` catches a field op that matched nothing. `-{x}` and `/{a}/{b}` are
`split(…).join(…)` underneath, which returns the value untouched when the target is
absent — a silent no-op, and exactly what upstream drift produces: a shared library item's
text changes from "in a controlled bun" to "in a tight bun", a consuming project's
`hair: -{in a controlled bun}` quietly stops applying, and the card compiles clean
carrying text that was meant to be gone. Warning on *every* missed op is unusable —
`06-field-operations.md`'s pronoun swap-chain (`/{She}/{He}`, `/{she}/{he}`,
`/{her}/{his}`) is built on misses, since any one description carries some of those forms
and not others. So the report is scoped like `CL0326`: it fires only when **every**
removal/swap in a chain missed, or when a **standalone** `-{}` / `/{}/{}` missed. Those
are always mistakes, and they are what drift produces.

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
| `CL0422` | ERROR | A `fields.cl.yaml` or a `templateFor` slot file could not be read, or is not a mapping — everything it declares is unavailable. |
| `CL0423` | ERROR | A `fields:` declaration gives more than one of `from:`, `parts:` and `try:`. |
| `CL0424` | WARN | A group member or template entry names something that is not a declared field or group. |
| `CL0425` | WARN | A file in a templates directory looks like a misspelled `fields.cl.yaml` and is being ignored. |
| `CL0426` | WARN | A `body:` key the consuming project authored is read by no template the item renders through and no declaration names it — a typo; its content is dropped. |
| `CL0427` | WARN | A `body:` key the consuming project authored is a declared field that none of the item's renders include — misrouted; the message names the group it lives in. |
| `CL0428` | WARN | A field is declared in the field table but no template names it, directly, through a group, or inside a partial a template includes. |
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
templates directory resolve to the same name, template loading throws before any
compile begins. It cannot degrade to a WARN — with two files claiming one name the
merged name→file map has no defensible winner — and it runs before the diagnostics bus
exists. The message names both colliding files. Later directories on the search path still override earlier ones on
a name collision (that is the intended layering); the error is only for a collision
*within* a single directory.

### CL0430–CL0437 in detail

`CL0430`–`CL0435` are the leaked-artifact sweep, run over every finished string the
compiler writes: each story card, each assembled component, each `Opening.md`, and the
Description. Every one of them means **the compiler failed and the failure is visible in
the file it just wrote** — a fact about the output, not an opinion about it — which is why
they are ERRORs and why `lint.level` cannot reach them.

They share the `CL043x` decade rather than filing `{%key}` under `CL05xx` with the other
variable diagnostics. What is reported here is not the token family but the leak: one
detector set, run at one moment, over one finished string. Splitting them by what leaked
would scatter a single check across three bands and make the sweep unsearchable.

A leaked `{$she}` fails the compile, and `--lint` flags the same patterns on an
already-compiled tree.

`CL0436` and `CL0437` run in the same sweep and are *not* facts. Both judge whether
ordinary prose was meant: `[does]` may be a deliberate bracket, and "undefined" is an
English word. They stay WARN, they are tagged opinion-layer, and `lint.level` reaches them.

`CL0546` and `CL0635` are the offline scanner's other two opinions, and they are filed in
the bands their subject belongs to rather than here — a confusable `${...}` is a token
question and a trigger-less card is a story-card one, whatever pass happens to notice them.
Both were reported by category label alone until Package 3 put every lint finding on the
diagnostic bus; they were the only two checks in the tool with no code, which is also why
they have the highest ids in their bands rather than sitting beside their neighbors.

### CL0422–CL0428 in detail — the field table

`CL0422` is the load-time check on a field-table document as a whole: it did not parse, or
parsed to something other than a mapping, and the entire file is skipped as a result. It
covers `templateFor` slot files (§13.4) as well as `fields.cl.yaml`, because the loss is the
same kind with a narrower blast radius — a slot file that cannot be read takes its tier's
templates with it, and every item on that branch falls back to its base template. Both
messages lead with that consequence rather than with the parser's complaint, which rides
along as the hint: a field table that fails to load is silent downstream, and an author who
is only told the YAML is bad still has to work out why their cards came back empty. The
key surface underneath that — an unknown key, a wrong type, an unrecognized `render:` name —
is caught the same way any other schema-checked surface in the compiler is, as `CL0201`,
`CL0202` or `CL0206`, not folded into `CL0422`. `CL0423` is a narrower, field-specific check
that no schema descriptor can express: a declaration naming more than one of `from:`, `parts:`
and `try:`, which are mutually exclusive because they are three ways of saying where a field's
text comes from, not settings that combine. `CL0424` flags a group member or template entry
that names nothing, and `CL0425` flags a filename that is a near-miss of `fields.cl.yaml` (a
`templateFor` slot file that only resembles one is left alone). A structurally broken entry
is skipped and the rest of the table still loads, because a downstream project may override
the whole file.

`CL0426`–`CL0428` are the unread-field audit. A field-list template names the
`body:` keys it renders, so a key no template reads is content the compiler silently drops —
the diagnostic the external schema reference was hand-maintained to stand in for. One
symptom splits three ways: a key **no declaration names** is a typo (`CL0426`), a key
**declared but read by none of the item's renders** is misrouted and the message names the
group it lives in (`CL0427`), and a **declared field no template names** is a dead
declaration (`CL0428`, the counterpart to `CL0545`). None is an opinion — a field is read
or it is not — so `lint.level` cannot reach them.

**The check is per item, not per template.** An item can render through more than one field
list on a branch — its story card, a Plot Essentials roster slot, a shorter context tier —
and a key read by *any* of them is read. `CL0426`/`CL0427` test a `body:` key against the
union of every list the item resolves to, so `secret`, present in the full `Character`
template but not the roster's line, is not a misroute on the roster render. A key read only
by a list that came from a `templateFor` slot file (a tier, or a component rendering role)
is never a `CL0427` — those lists omit declared fields by design — but a field that no list
anywhere names is still a `CL0428`.

**On an imported item, only the consuming project's own keys are audited.** A `body:` key
that arrived through `import:` unchanged is the library author's concern; `CL0426`/`CL0427`
fire only on keys the consuming project introduced or gave a new value to. A library item
that carries fields for consumers who want them does not nag a consumer that renders a
subset.

**`CL0428` sees partials.** A field referenced only inside a `{ include: somePartial }` —
`{$body.role}` in a roster-line partial, say — is named, not dead. The sweep reads the same
`$body.` / `$notes.` references out of an included partial (and any partial it includes)
that `CL0426`/`CL0427` already do.

The audit runs on resolved leaf paths, not top-level keys, so `from: [personality.keywords,
personality.expanded]` still flags `personality.other`. Findings key on `(item id, field
path)` and are emitted once: a `body:` field resolves through every `variants:` and
`branches:` expansion, so one mistake on a 32-leaf project would otherwise report 32 times.
A `{ allowExtra: true }` marker in any of an item's lists opts that whole item out —
Directory and Unstructured compose their bodies from author-shaped sub-keys feeding an
interpolated value, and the property belongs to the template, not to each field.

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
| `CL0609` | ERROR | An item reaches a render target — a component slot or its own story-card body — but its body renders to nothing there. |
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
| `CL0623` | ERROR | A `render.storyCards` entry declares no `title:` — the title is the card's AID name and the frontier keys on it. |
| `CL0624` | WARN | A `render.storyCards` entry's `sections:` names a section the component does not declare; it is dropped from that entry. |
| `CL0625` | WARN | A `render.storyCards` entry renders no text on a branch — its `variant:` / `sections:` selectors left nothing. No card is written. |
| `CL0626` | ERROR | Two `aid.type` values differ only by case, so they are one file on a case-insensitive filesystem and one group's cards are overwritten. |
| `CL0628` | WARN | An `aid.type` has leading whitespace; it is trimmed. |
| `CL0629` | ERROR | `adventureDescription` declares `advanced:` or `description:` in `metadata:` — both belong to the scenario blurb only. |
| `CL0630` | WARN | A branch leaf resolves neither an `opening:` nor an `adventureDescription:`, inherited or its own — Velvet Lattice would start it with an empty prompt. |
| `CL0631` | WARN | A branch leaf resolves no `aiInstructions:`, inherited or its own — Velvet Lattice writes an empty-string AI Instructions, which suppresses AID's model default rather than falling back to it. |
| `CL0632` | ERROR | `aid.type` fails path-legality: empty/whitespace, an illegal path character, `.`/`..`, or a trailing space/period. |
| `CL0633` | WARN | `branchFraming` on a node with nothing below it to frame — the root with no branches, or a leaf. |
| `CL0634` | ERROR | A requested component produced no output anywhere in the compile. |
| `CL0635` | WARN | A story card has an empty or missing trigger list, so it can never be pulled into context. `kind: reference` is exempt. |

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

`CL0609` is the render-level companion to `CL0610`. `CL0610` fires when nothing structural
carried the item — no target reached a slot. `CL0609` fires when one did and the body
rendered blank there: a field-list or `.template` that is all non-firing conditionals
against an item that carries none of the keys, in a component slot or in the item's own
story-card body. The two are mutually exclusive per target — a target that reached a slot
and rendered nothing is `CL0609`'s, and `CL0610` stays quiet so one mistake is not
reported twice. The slot filters the empty occupant back out at emit, so without this
check the item would vanish from the branch silently. The intended way to drop an item
from a branch is `~` on its branch dispatch or a `branches:` exclusion. `kind: reference`
is exempt on the body path only — §4.8 puts a reference card's payload in `notes:`, and an
empty body there is its normal shape.

`CL0610` is the no-output invariant. It fires on *consequence*, not on mechanism: an item that
resolved onto a branch has to leave a mark on it, and how it failed to — no target
declared, or a target into a slot the component gated off on that branch — does not
change the answer. That scoping is what lets slot-level gating stay a legitimate way to
drop a whole slot's contents from one branch. An item whose own `branches:` excludes it is
never resolved there and is never asked. A target that reached a slot but rendered empty
is `CL0609`, not this.

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
paragraph the author wrote. The check is inseparable from `adventureDescription:` — only a
per-leaf description can sit where an opening would, and a root-only blurb never could.

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

`CL0623`–`CL0625` guard `render.storyCards` entries. Such an entry is
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

**An `aid.type` naming one of AID's five built-in categories — `character`, `class`, `race`,
`location`, `faction` — is folded to lowercase, silently.** AI Dungeon stores the type string
verbatim and groups by exact match, so `Character` would arrive as a *custom* category sitting
beside the built-in `character` rather than inside it. This was confirmed against the
platform: a card pushed as `Race` comes back as `Race`, and a `Location` card and a
`location` card do not group in the scenario editor. Velvet Lattice folded these itself
until 0.2 dropped the normalization, and nothing downstream replaced it. Only bare built-in
names fold — `Character - Dalor` and `Spell - Ice` are deliberate custom groupings and are
left alone.

**The fold is not reported.** It carried a WARN (`CL0627`) until 2026-09-01; the code is
retired and its number is not reused. Capitalizing `Character` is the natural spelling —
it matches a field table's `templates:` keys, and `templateFor` looks types up
case-insensitively — so the rewrite is unconditionally correct and there was nothing for an
author to do about the line. `CL0626` still catches the case that *is* a mistake: two
**custom** types differing only by case, which collide on a case-insensitive filesystem. A
built-in pair cannot reach it, because both spellings fold to the same type first.

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

`CL0710`–`CL0715` are the platform's field-length limits. AID truncates rather than
refusing, so exceeding one does not fail the upload — the content arrives shortened and the
loss surfaces during play. A `kind: reference` item is **not** exempt: soft heuristics skip
reference items and hard limits do not, because the platform does not care why an item
exists.

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
| `CL0546` | WARN | A `${...}` holds identifier-shaped content, so it reads as a `{$token}` with the brace and the dollar transposed. |

`CL0530` exists for a specific footgun rather than for careless authors. A bare `heroName:` with
nothing after it parses as null, and null is `~` — so the most natural-looking way to
declare a placeholder is also the way to silently delete one. Unbinding something never
inherited removes nothing and cannot have been meant, which makes it a reliable signal that
the question text is missing; the message says so rather than reporting the deletion
neutrally.

`CL0531` is the cost of resolving nesting at compile time. A question may contain
`%key%` referring to another declared placeholder, which Codex Loom expands before writing
the file so that Velvet Lattice's single substitution pass cannot get the order wrong. A
cycle has no expansion, so it is named in full — the author has to break the loop somewhere
and which key the traversal entered on says nothing about where.

`CL0532` is the one placeholder check that is a *fact* rather than an opinion, and so is a
compiler diagnostic rather than lint. Velvet Lattice substitutes only the keys its
merged table holds; anything else survives its single pass untouched and is uploaded to AID
as the literal text `%key%`, where the model reads it as noise mid-sentence. Nothing
downstream catches it — VL's own warning scan is about *context*, and fires on keys that are
perfectly fine.

It reports once per key per site, and names the site rather than only the file: by the time
text reaches a write point its source may be a template, a component document or
`compile.cl.yaml`, so a path alone rarely locates the `%key%`. The declared list rides along
as a hint, because an undeclared key is usually a typo of a real one and `%heroname%`
against a declared `heroName` is invisible until the two are printed together.

`CL0533` and `CL0534` check where a placeholder landed against where AID actually fills
one. Placeholders work in every component, and in a story card's entry, name, triggers and
notes; the destinations below are the ones where they do not.

| Destination | Behavior | Code |
|---|---|---|
| The Description | Never filled — it is shown before an adventure exists to answer it | `CL0533` |
| A card's `type` | Never filled — it is a category, and a path segment in the compiled tree | `CL0533` |
| A branch title | Prompt fills and the player sees the answer while choosing; the saved adventure keeps the raw text | `CL0534` |
| The scenario title | Never filled — it names the scenario in listings, before an adventure exists | `CL0534` |

Both check the `${...}` spelling as well as `%key%`, and both ignore whether the key is
declared: where a placeholder cannot go, declaring it changes nothing.

The check runs per *placement* rather than per file, because an item can route into any
component: one item body can be legal in one destination and not another on a
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
whole project. A root-level placeholder used on one branch of three is normal and correct,
so an unscoped version would fire constantly on well-formed projects; a branch-level one
used only on a sibling really is dead, because the declaration does not reach the sibling.
The hint says which of the two rules applied.

A reference inside another placeholder's question counts as use. Nesting is expanded into
the emitted file, so the inner question does reach the player — through the outer
prompt rather than on its own. Usage is therefore read off the raw question text, before
expansion substitutes the reference away.

It is a WARN and an opinion rather than a fact: an author mid-draft may reasonably
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

It is scoped to placeholders today. `~` carries the same "unbind" meaning for variables,
roles and lint packs — each with its own unbind-unknown WARN (`CL0512`, `CL0544`, `CL0118`)
rather than being folded into this one. `scripts:` alone still sets the key to null on a
`~` instead of removing it, so there is nothing for this check to say about it.

`CL0521` exists because library names are auto-exposed as variables, so the two share
one namespace. A collision is an ERROR rather than a silent precedence rule: there is no
answer to "which one wins" that an author could predict.

`CL0522` exists because `--snapshot` freezes declared library entries, not resolved
dependencies. A shared component reached through a plain `variables:`
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

Codes for the remaining bands are registered as the work that mints them lands. Two codes
are named in the design, not yet implemented, and reserved at their numbers: `CL0143`
(duplicate Codex overlay for one import target) and `CL0310` (unresolvable branch
dispatch). Neither is a live code until something raises it. `CL04xx` holds
the template checks and the leaked-artifact sweep; the deferred render rewrite is what
fills the rest of the band.

### `CL-<pack>/NNNN` — convention-pack findings

A convention pack codes its findings **outside the numeric bands**:
`CL-<pack>/<rule-id>`, zero-padded to four digits — `CL-wtg/0001`. The prefix is the
pack's declared `name:`, not whatever key the project used, so a pack hosted in a library
set yields the same codes in every project that loads it and a suppression stays portable.

Every `CL-` code is opinion-layer by construction — recognized by its `CL-` prefix, not by
a registry entry. Every opinion-layer ERROR lives in a pack, and `lint.level` — plus the
per-pack and per-branch `level:` ceilings — has to be able to reach them. A pack finding names the pack, the
card, and the branch it fired on, because a pack can validate one branch's `notes:`
config and not another's.

The two bundled packs are `wtg` (`CL-wtg/0001`–`CL-wtg/0003`, the World Time Generator mod
— see Convention Packs) and `duckieConv` (`CL-duckieConv/0001`–`CL-duckieConv/0004`, a set
of card-authoring conventions — a per-role length budget, list caps, a
faction-field redundancy nudge, and a `meta.duckieConv.role` value check). Both are all
WARN. `duckieConv`'s `count` and `mutexHint` rules run only in the inline compile pass, not
in offline `--lint`; its `budget` and role rules run in both.

The pack layer's own core codes are `CL0117` (malformed pack), `CL0118` (`~` on a pack
never inherited) and `CL0119` (`name:` disagrees with the config key) — all in the loading
band, because loading a pack file is a loading concern.

## Common mistakes

Four failures that come up often enough to name, with the fix rather than the code detail.

**`CL0420` "no template found for item"** — the item's `aid.type` (or `render.template`)
matches no loaded `.template`. Both are matched case-insensitively, so `aid.type: Character`
needs `Character.template`. The other cause is a `templateFor` slot file that does not
define a list for that type on this branch.

**`CL0324` / `CL0342` "import failed"** — the `import:` id resolves to no library item. Check
that the id matches the library file's `id:` (or `name:` when `id:` is absent), that the file
sits inside a declared `structure.input.library` directory, and — for a qualified reference
— that the `set:` prefix names a declared library entry (`CL0341`) rather than a set that
lacks the id (`CL0342`).

**`CL0321` "variant not found" when the variant looks defined** — variant dispatch reads
the **item definition's** own `variants:` tree. On an `import:`, `importVariants:` reads the
**library item's** variant tree instead; the import's own `variants:` block holds only
local deltas for branch dispatch. A name in the wrong one of those two is `CL0321`.

**`CL0330` "cross-item ref not found"** — `{$Id.body.Field}` is resolved after every item
for the branch compiles, checking the branch's compiled items first and then the referenced
item's base definition. An item `~`-excluded from this branch is still reachable through that
base-definition fallback unless it has no definition at all; a genuine miss leaves the token
as-is and raises `CL0330`.

**`CL0330` covers a missing *item*, not a missing *field*.** If the item resolves but the
dotted field path does not, nothing is raised there — the token is left as written and
surfaces later as `CL0430` at the output sweep, with no diagnostic naming the field. A
`CL0430` on a `{$Id.body.Field}` token that raised no `CL0330` means the item was found and
the field path was wrong.

**The reference must name an item id, not a role.** This stage runs before role names are
rewritten, so `{$SomeRole.body.Field}` resolves nowhere and reaches `CL0430` too. Every
other role form is unaffected — see [Roles](13-roles.md#using-a-role-in-prose).
