# The shared example library — two sets that disagree

**`core/` and `grimwood/` are two library sets that both define an item called `magic`, and
that collision is the reason this directory exists.** One is elemental manipulation, the
other is blood magic, both authors are right, and a third author wants both. That is the
case [§17 qualified references](../../documentation/04-imports-and-includes.md#qualified-references)
exists for, and it cannot be shown with a single set.

The example projects beside this directory read it as a shared library rather than each
carrying its own copy — which is also what makes the library snapshot worth demonstrating:
`grimwood/` is somebody else's set and gets pinned, `core/` is the project's own and stays
live.

## Pointing a project at it

```yaml
structure:
  input:
    library:
      core: ../library/core
      grimwood: ../library/grimwood
    templates: [../library/templates, ./templates]
```

The paths climb out of the project directory, which works because a library path resolves
against the config's own location and nothing constrains it to stay inside. The test
harness supports the same shape by copying the whole `examples/` tree rather than one
project directory.

To hold both magic systems at once, qualify one reference and rename the other:

```yaml
- import: core:magic

- id: blood-magic
  import: grimwood:magic
```

An **unqualified** `magic` is `CL0340` — an error, deliberately, and one this directory
never demonstrates. The failing case belongs to `__tests__/fixtures/pathological/`; an
example project has to compile clean.

## Layout, and the one rule about it

```
library/
  core/           library set — items, plus components
    characters.cl.yaml
    settings.cl.yaml
    magic.cl.yaml
    components/
  grimwood/       library set — a second author's, smaller
    magic.cl.yaml
    places.cl.yaml
  templates/      NOT a library set — the shared field table
    fields.cl.yaml
```

**`templates/` is a sibling of the sets, not a directory inside one, and it has to be.**
Declaring a library set makes the compiler walk that directory whole and read every YAML
file in it as an item. A component document — top-level `sections:`, no `id:` or `name:` —
is skipped silently, because a set pointing at a mixed-purpose directory is expected. A
field table is not: a `fields.cl.yaml` filed under `core/` fails the compile with *"missing
both id and name fields"*. So components may live inside a set; the field table may not.

A project reads the field table through `structure.input.templates`, never through
`structure.input.library`.

## What a consumer has to supply

**`Wayfarer` is defined by placeholders, and a library cannot declare placeholders.** A
project importing it must declare `heroName` and `heroTrait` itself:

```yaml
placeholders:
  heroName: What should we call you?
  heroTrait: What are you known for?
```

An undeclared placeholder is not substituted and not reported — the `%heroName%` token
survives into the compiled card as literal text — so nothing catches this for you.

**The Plot Essentials format declares slots and fills almost none of them.** `cast`, `you`
and `world` are empty until a project routes items into them with `render.plotEssential`,
and an empty slot warns (`CL0614`). A shared format that wrote your genre line for you
would be a scenario, not a library.

**Two compile variables are read by the shared components**: `genre` and `settingName`.

## The tone axis

Every character and setting carries a `magical` and a `mundane` variant, selected with
`importVariants:`. They are deltas on one item rather than two items, which is what lets a
setting variant and a tone variant compose on the same field — the case field operations
exist for. `mundane` is sometimes empty (`{}`), which is correct: the base item is already
the mundane reading and the empty variant is what makes the axis uniform to select against.

## No committed output

This directory has no `output/` and is not a row in `examples/projects.js`, because it is
not a project. It is exercised by
`__tests__/integration/examples-library.integration.test.js`, which writes a small consumer
project beside a copy of both sets and compiles it — every file in both sets is parsed and
schema-validated by the act of declaring the set, so an item nobody imports still fails
there if it is wrong.
