# Roles Reference

`roles:` binds a name to an item id, per branch. `{$LI}` in item or component prose
resolves through that binding rather than naming an item directly, so the same card can
mean "whoever this branch cast as the love interest" without editing the prose.

**Reach for a role whenever prose written once must name a character who changes per
branch.** Naming the item directly (`{$Malcolm}`) breaks the moment another branch casts
someone else; a hardcoded pronoun beside it breaks regardless.

---

## Declaring and Binding

```yaml
roles:
  protagonist: Aness
  LI:          Kaiden
  rival:       Voss

branches:
  subject:
    roles:
      protagonist: Veryn
      LI: Felicia
      rival: ~          # unbinds — this branch has no rival
```

**`roles:` merges down the branch chain key by key**, the same as `variables:` and
`placeholders:`. A branch inherits every ancestor binding and may rebind or unbind any of
them; siblings are independent.

**`~` deletes the inherited key** rather than setting it null, so an unbound role behaves
identically to one never declared rather than resolving to the literal word `null`.

**`protagonist` is an ordinary entry in `roles:`, not a separate key.** `{$Aness}` resolves
to `"you"` when `Aness` is bound as `protagonist` on the active branch, and otherwise
behaves like any other role.

---

## Using a Role in Prose

**A role token is written exactly like an item reference, because it is one once
resolved.** `{$LI}`, `{$LI.he}`, `{$LI.his~}`, `{$LI's}`, `{$LI.body.Backstory}` all work —
every form `references/pronouns.md` documents for `{$Id…}`.

```yaml
sections:
  relationship:
    text: |
      The player's history with {$LI} is unresolved. {$LI.he} does not raise it
      unprompted, and {$LI.his~} restraint should read as deliberate.
```

Resolution rewrites the leading name to its bound item id before anything else runs, so
pronoun resolution and cross-item field references see an ordinary item reference.

**Roles resolve in component prose, not only in item bodies.** An Author's Note or AI
Instructions rule referencing `{$LI}` resolves the same way a character card's body does.

### Where roles resolve

| Site | Resolves roles? |
|---|---|
| Story cards, Plot Essentials, AI Instructions, Author's Note, a leaf's `opening:` | Yes — all pass through the leaf loop |
| `opening:` / `branchFraming:` as an **inline string** or a **prose `.md`** | Yes — the same token pass runs, whatever the shape |
| `branchFraming` at any branch node, **the project root included** | Yes — inherits the roles table down the tree; the root reads the project's own `roles:` |
| The root `Description` | Yes, from the project's own `roles:` |

**Shape does not matter — an inline `opening:` resolves roles exactly as a `sections:`
file does.** `opening: "%heroName% woke, and {$rival} was gone."` resolves `{$rival}` to
its bound item; a `{$token}` that matches no role and no item still leaks to `CL0430`
(leaked token) the way it would from any other component, and an unresolved `{%var}` in
the spec is still `CL0634`. Placeholders (`%heroName%`) and compile variables (`{%setting}`)
work inline alongside `{$…}`.

**The one asymmetry is `{$protagonist}` → "you".** Every `{$role}` resolves to its item
everywhere; becoming "you" also needs a resolved branch protagonist. Leaves and
`branchFraming` (interior or root) have one; the root `Description` pins it null, so
`{$protagonist}` there renders as the bound item's name.

---

## No Separate Sigil

**A role token and an item-id token share the `{$…}` grammar.** `{$LI}` and `{$Malcolm}`
look identical to any reader who has not consulted the roles table — every alternative
sigil was blocked (`&`/`*` are YAML syntax, `@` was removed in a prior phase).

**All-caps for a role name is a convention, not an enforced rule.** Nothing stops an item
id from being all-caps too. Follow the convention anyway; it is the only thing making a
role legible at a glance.

The shared grammar is why a role name colliding with a real item id is its own ERROR
(`CL0541`) rather than being silently resolved one way or the other.

---

## Diagnostics

| Code | Severity | Meaning |
|---|---|---|
| `CL0540` | ERROR | A `{$X}` token resolves to neither a declared role nor a known item id. The message names both readings and lists the roles in scope |
| `CL0541` | ERROR | A role name and an item id are the same string — rename one |
| `CL0542` | ERROR | A role is bound to an item id that does not resolve on this branch — missing, or excluded here |
| `CL0543` | ERROR | A role is bound to another role name. A role resolves one level of indirection, always |
| `CL0544` | WARN | A role is unbound with `~` but was never inherited at that node |
| `CL0545` | WARN | A role is declared and never referenced anywhere in the compile |
| `CL0512` | WARN | The same "nothing there to unbind" case for a **variable** |

**`CL0540` and `CL0430` can both fire on one unresolved token, deliberately.** `CL0540` is
the role-aware report naming what's in scope; `CL0430` is the general output sweep catching
any leftover `{$…}`.

**Role errors collect rather than abort.** Every role ERROR accumulates on the diagnostics
bus, so one compile tells you all four cards that need a binding.

---

## `canon.cl.yaml` — Reserved, Not Yet Read

A library directory may contain a file named `canon.cl.yaml`. Codex Loom **excludes it from
item loading** — never parsed as an item, never raises unknown-key errors, copied
byte-for-byte by `--snapshot`.

**Nothing currently reads it.** The reservation exists so an author can write one by hand
for their own documentation — which roles and placeholders a library expects — without
breaking the project. Enforcement does not wait on it: a role requirement is checked the
moment a card references it.
