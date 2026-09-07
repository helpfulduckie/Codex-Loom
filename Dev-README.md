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

Two fixture sets back the suite, and they fail differently:

- **`__tests__/fixtures/pathological/`** freezes the *diagnostic stream* — two projects that
  are wrong on purpose, with a committed snapshot of every code, severity, file and message
  they raise. It is authored from the spec, so where the compiler disagrees the fixture pins
  the disagreement rather than being edited to match.
- **`goldenFixtures/`** freezes v3.3.2-compiled *output* and asserts the v4 compiler
  reproduces it byte-for-byte. These are real scenario projects and unpublished
  worldbuilding, so they live in a
  separate **private** repository — `helpfulduckie/Codex-Loom-Fixtures`, cloned into the
  gitignored `goldenFixtures/` — rather than in this tree. You will not have access to it,
  and you do not need it: `__tests__/fixtures/golden.test.js` reports its tests as skipped
  when the directory is absent, and the other 50 suites run normally.