## Project status

**The current compiler is v4, on `main`.** A clean break from v3 with no compatibility
mode — v3.3.2 was the last v3 release. v4 changes the config format, collapses the four
component syntaxes into one, drops the template envelope and the `{@name}` reference
family, splits the compiler from the lint pass, adds player placeholders and the platform
field caps, and adds convention packs and context tiering. A v3 project is converted in
place with `--migrate`; see [documentation/15-migrating-from-v3.md](documentation/15-migrating-from-v3.md)
for the conversion.

## Tests

```bash
npm test
```

Also available: `test:unit`, `test:integration`, `test:coverage`. `npm run compile` compiles
`test/compile.yaml` as a smoke check.

Three fixture sets back the suite, and they fail differently:

- **`examples/`** freezes compiled *output* and is committed here. The example projects are
  the worked examples the documentation points at, and
  `__tests__/fixtures/examples.test.js` asserts their output byte-for-byte.
  `scripts/rebaseline.js` regenerates a baseline after a deliberate output change and
  classifies the diff before it will write.
- **`__tests__/fixtures/pathological/`** freezes the *diagnostic stream*: projects that are
  wrong on purpose, with a committed snapshot of every code, severity, file and message
  they raise. It is authored from the spec, so where the compiler disagrees the fixture pins
  the disagreement rather than being edited to match.
- **`goldenFixtures/`** freezes compiled *output* for real scenario projects and asserts the
  compiler reproduces it byte-for-byte. Those projects contain unpublished worldbuilding, so
  they live in a separate **private** repository, cloned into the gitignored
  `goldenFixtures/`. You will not have access to it, and you do not need it:
  `golden.test.js` and `migrate.integration.test.js` report their tests as skipped when the
  directory is absent, and every other suite runs normally.

`AGENTS.md` carries the working rules for a change: what done means, how baselines are
regenerated, where compiled files are placed, and the comment conventions.
`documentation/dev-guide.md` is the module map.