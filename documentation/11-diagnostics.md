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

Codes for the remaining bands are registered as the phases that mint them land. Codes
named by the spec and not yet implemented — `CL0210` (unknown item key with a relocation
suggestion), `CL0310` (unresolvable branch dispatch), `CL0520` (branch-scoped variable used
where only root variables resolve) — are reserved and must keep those numbers.
