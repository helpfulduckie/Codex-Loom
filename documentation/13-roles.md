# Roles

`roles:` binds a name to an item id, per branch. `{$LI}` in item or component prose
resolves through that binding rather than naming an item directly, so the same card can
mean "whoever the story cast as the love interest" on one branch and a different item on
another, without editing the prose itself.

---

## The motivating problem

A shared library card written once and reused across branches often needs to say something
like "his betrayal cuts deep" — a hardcoded pronoun sitting next to a name that changes per
branch. Naming the item directly (`{$Malcolm}`) breaks the moment a different branch casts
someone else in that part; the pronoun breaks regardless, since nothing ties it to whoever
is actually bound. `roles:` fixes the first half: a name that means "the current occupant
of this part," resolved per branch before pronouns are.

---

## Declaring and binding

```yaml surface=config
roles:
  protagonist: Aness
  LI:          Kaiden
  rival:       Voss

branches:
  subject:
    roles:
      protagonist: Veryn
      LI: Felicia
      rival: ~          # unbinds the inherited binding — this branch has no rival
```

**`roles:` merges down the branch chain, key by key**, the same as `variables:` and
`placeholders:`. A branch inherits every binding its ancestors declared and may rebind or
unbind any of them; siblings are independent. `~` deletes the inherited key rather than
setting it null — a role read as "not there" behaves identically to one never declared,
rather than resolving to the literal word `null`.

**`protagonist` is the built-in role** — an ordinary entry in `roles:`. `{$Aness}` resolves
to `"you"` when `Aness` is bound as `protagonist` on the active branch; it otherwise
behaves like any other role.

---

## Using a role in prose

A role token is written exactly like an item reference, because it *is* one once resolved
— `{$LI}`, `{$LI.he}`, `{$LI.his~}`, `{$LI's}` all work, the same forms
[Pronoun System](08-pronouns.md) documents for `{$Id...}`. Resolution rewrites the leading
name to its bound item id at the start of the token pass, so the checks that run after it
— pronoun resolution, the output sweep — see an ordinary item reference and need no
role-awareness of their own.

> **`{$LI.body.Field}` does not currently work.** Cross-item field references are resolved
> in an earlier stage than the role rewrite, and that stage understands item ids only, so a
> body reference reached through a role survives to the output sweep and fails as
> `CL0430`. Name the item directly — `{$Kaiden.body.Backstory}` — until the pass ordering
> is fixed. Every other role form above is unaffected.

```yaml surface=component
sections:
  relationship:
    text: |
      The player's history with {$LI} is unresolved. {$LI.he} does not raise it
      unprompted, and {$LI.his~} restraint should read as deliberate.
```

**Every component resolves roles, in every shape.** Story cards, Plot Essentials, AI
Instructions, Author's Note and a leaf's own `opening:` pass through the leaf loop, which
threads `roles` and a resolved `branchProtagonist` in; the same token pass runs whether
the component is a `sections:` document, a prose `.md` file, or an inline string, so
`opening: "%heroName% woke, and {$rival} was gone."` resolves `{$rival}` exactly as a
`sections:` opening would. The remaining sites resolve roles the same way:

- **`branchFraming` at any branch node, the project root included** — inherits the roles
  table down the branch tree exactly as `variables:` does, merging key-wise with `~`
  deleting (the same branch-chain merge the leaf loop uses), so a role bound above a node
  is visible to its framing even when that node declares no `roles:` of its own. A
  project-root `branchFraming:` reads the project's own `roles:`; written as a sentence,
  a prose file or a `sections:` document, it resolves roles in all three.
- **The root `Description`** (the project-level scenario blurb) — reads the project's own
  `roles:`, gated the same way the leaf loop gates it: a project that never declares
  `roles:` passes `null` rather than an empty table, so `CL0540` treats it as role-unaware
  territory rather than a project with zero bindings.

**What differs between sites is only whether `{$protagonist}` can become "you".** Every
`{$role}` token resolves to its bound item everywhere; turning the protagonist into "you"
additionally needs a resolved `branchProtagonist`. A leaf takes that from its branch
chain, and `branchFraming` (interior or root) derives it from the merged protagonist
binding. The root `Description` pins it to `null` — the blurb belongs to no branch — so
`{$protagonist}` there renders as the bound item's name rather than "you".

**Roles resolve in component prose, not only in item bodies.** An Author's Note or AI
Instructions rule referencing `{$LI}` resolves the same way a character card's body does —
components run through the same token pass as items, so it reaches both.

---

## No separate sigil, and what that costs

**A role token and an item-id token share the `{$...}` grammar.** `{$LI}` and `{$Malcolm}`
look identical to every reader that does not consult the roles table — a deliberate
decision, since every alternative sigil was blocked (`&`/`*` are YAML syntax, `@` was
removed from Codex Loom in a prior phase). **All-caps for a role name is a convention, not
an enforced rule** — nothing stops an item id from being all-caps too, so `{$LI}` beside
`{$Malcolm}` reads as a different kind of thing by convention, not by a check.

That shared grammar is the reason `requiresRoles` (below) is computed by elimination
rather than by scanning for a distinct token shape, and the reason a role name colliding
with a real item id is its own ERROR (`CL0541`) rather than being silently resolved one way
or the other.

---

## Diagnostics

| Code | Severity | Meaning |
|---|---|---|
| `CL0512` | WARN | A **variable** is unbound with `~` but was never inherited at that node — nothing was there to unbind. |
| `CL0540` | ERROR | A `{$X}` token resolves to neither a declared role nor a known item id. The compiler cannot tell an undeclared role from a misspelled item id, so the message names both readings and lists the roles declared in scope. |
| `CL0541` | ERROR | A role name and an item id are the same string — ambiguous, since the shared grammar can't tell which was meant. Rename one. |
| `CL0542` | ERROR | A role is bound to an item id that does not resolve on this branch — the id doesn't exist, or exists but is excluded here. |
| `CL0543` | ERROR | A role is bound to another role name rather than directly to an item id. A role resolves one level of indirection, always. |
| `CL0544` | WARN | A role is unbound with `~` but was never inherited at that node. |
| `CL0545` | WARN | A role is declared and never referenced by a resolved token anywhere in the compile. Whole-compile, not per-branch: a role legitimately used on one branch and unused on a sibling is not yet a corpus case this check needs to discriminate. |

**`CL0540` and `CL0430` (`LEAKED_FIELD_TOKEN`) can both fire on the same unresolved
token, deliberately.** `CL0540` is the role-aware report, naming what's declared in scope;
`CL0430` is the general output-sweep check that catches any leftover `{$...}` regardless of
cause. One names the cause at its source, the other names a fact about the output — the
same two-reports trade already accepted for other checks that overlap at the boundary
between a specific cause and a general symptom.

**Collection, not abort.** Every role ERROR raised during a compile accumulates on the
compile's diagnostics bus rather than stopping at the first one — binding a role once beats
recompiling four times to discover four cards need it.

---

## `requiresRoles` in the library snapshot

`--snapshot` computes, per library entry, which roles a consumer must bind for that
entry's cards to compile — written into `snapshot/manifest.json` as `requiresRoles`. See
[The Library Snapshot](12-snapshot.md#requiresroles--a-library-entrys-role-contract-computed)
for the manifest shape, how the computation works, and `CL0116`, the refusal a library
entry gets instead of a role list when its own items don't validate.

---

## `library.cl.yaml` — reserved, not yet read

A directory may contain a file named `library.cl.yaml`. Codex Loom **excludes it from item
loading** — it is never parsed as an item, never raises unknown-key errors on whatever it
contains, and is copied byte-for-byte by `--snapshot` like any other file in the directory.
Nothing currently *reads* it: the descriptive contract this filename is reserved for —
documenting which roles, placeholders, and other library sets a directory expects — is not
built yet. Enforcement does not wait on it: a role requirement is real and checked the
moment a card references it, whether or not `library.cl.yaml` exists to explain it in prose.

Until that manifest is built, the reservation exists so an author can write
`library.cl.yaml` by hand — for their own documentation, ahead of any tooling — without
breaking the project the moment it's added.

**The reservation is not scoped to library directories**, despite the name. The item loader
walks project item directories and library directories with the same function, so the
basename is skipped in both. **The skip is silent** — no diagnostic — so a project item file
that happens to be named `library.cl.yaml` disappears from the compile without comment.

> **Renamed from `canon.cl.yaml` on 2026-09-01.** "Canon" was retired as the mechanism word
> in Phase 7 (`structure.input.canon` became `structure.input.library`), and a reserved
> filename the compiler matches by name is a mechanism rather than an instance. Nothing read
> the file, so there is no compatibility shim: a leftover `canon.cl.yaml` now loads as an
> ordinary item and reports as one, which is what makes the stale name visible.
