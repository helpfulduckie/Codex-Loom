'use strict';

/**
 * The diagnostic bus.
 *
 * Every diagnostic carries a stable code, a severity, and — where the loader could
 * supply one — a source span. Codes exist so that three things are possible that plain
 * message strings cannot support: documentation anchors, lint suppression, and test
 * assertions that survive rewording a message.
 *
 * This module is deliberately free of `fs` and `console`, so it can be imported from
 * anywhere — including the pure `model/` layer, which reports problems without printing
 * them. Collect diagnostics here; let the CLI decide what reaches a terminal.
 *
 * `REGISTRY` below is the one place every diagnostic code is declared. Modules that
 * raise a code import `CODES` (name → id string, derived from `REGISTRY`) and never
 * hold their own table. `documentation/11-diagnostics.md` carries the hand-written
 * prose for each code; `diag.test.js` asserts the two agree on id, severity and band.
 */

const SEVERITY = Object.freeze({
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
});

const SEVERITY_LABEL = Object.freeze({
  error: 'ERROR',
  warn: 'WARN',
  info: 'INFO',
});

const { ERROR, WARN } = SEVERITY;

/**
 * The diagnostic registry — every code, its severity, and a one-line summary.
 *
 * This is the single place a code is declared. Modules that raise codes import `CODES`
 * (below) and reference `CODES.SOME_NAME`; none carry a local table. The bands only
 * constrain the id number:
 *
 *   CL01xx  loading — file discovery, YAML parse, entry-point resolution
 *   CL02xx  schema — unknown keys, wrong types, relocation suggestions
 *   CL03xx  items — resolution, variants, imports, branch dispatch
 *   CL04xx  render — templates, render functions, the leaked-artifact sweep
 *   CL05xx  tokens — variables, roles, placeholders, scoping
 *   CL06xx  components — slots, sections, sources, card-type and prompt-coverage checks
 *   CL07xx  emit — output layout, platform field caps
 *
 * `CL0143` (duplicate Codex overlay) and `CL0310` (unresolvable branch dispatch) are
 * named by the design docs but not yet raised; they are reserved in
 * `documentation/11-diagnostics.md` and deliberately absent here until something mints
 * them.
 *
 * `severity` is authoritative for codes reported through `onWarn(code, message)`, which
 * carries no severity of its own (`severityOf` recovers it). Codes raised by a direct
 * `diagnostics.error()` / `.warn()` call pass their severity at the call site; the value
 * here still has to match, and `diag.test.js` checks every entry against the severity
 * column of `documentation/11-diagnostics.md`.
 *
 * `summary` is a terse gloss for readers of this file. The authored prose — why a code
 * is an ERROR not a WARN, what it replaced, what bites — lives in `11-diagnostics.md`
 * and at the raise site, not here.
 *
 * `layer: 'opinion'` marks a quality judgment that can be wrong — one a project may
 * silence with `lint.level`. Everything without it is a fact about the output that
 * `lint.level` cannot reach. Convention-pack findings (`CL-<pack>/NNNN`) are opinion-layer
 * too, by their prefix rather than an entry here. See `isOpinion`.
 */
const REGISTRY = Object.freeze({
  // ── CL01xx  loading ────────────────────────────────────────────────────────
  YAML_PARSE_FAILED:            { id: 'CL0101', severity: ERROR, summary: 'YAML document is malformed and could not be parsed.' },
  YAML_FILE_UNREADABLE:         { id: 'CL0102', severity: ERROR, summary: 'File could not be read.' },
  YAML_EMPTY_FILE:              { id: 'CL0103', severity: WARN,  summary: 'File is empty; skipped.' },
  YAML_NULL_DOCUMENT:           { id: 'CL0104', severity: WARN,  summary: 'A document within a multi-document file is null; skipped.' },
  TOKEN_SWALLOWED_BY_YAML:      { id: 'CL0105', severity: ERROR, summary: 'A Codex Loom token was parsed as a YAML mapping key.' },
  CONFIG_NOT_A_MAPPING:         { id: 'CL0110', severity: ERROR, summary: 'compile.yaml is not a mapping of configuration keys.' },
  SNAPSHOT_DIR_MISSING:         { id: 'CL0111', severity: WARN,  summary: 'structure.input.snapshot names a directory --snapshot never populated.' },
  SNAPSHOT_MANIFEST_UNPARSEABLE:{ id: 'CL0112', severity: WARN,  summary: 'snapshot/manifest.json exists but is not valid JSON or not the expected shape.' },
  SNAPSHOT_MISSING_ENTRY:       { id: 'CL0113', severity: WARN,  summary: 'A declared library/templates entry has no section in an otherwise-valid manifest.' },
  SNAPSHOT_FILE_UNTRACKED:      { id: 'CL0114', severity: WARN,  summary: 'A file under snapshot/<name>/ has no entry in the manifest.' },
  SNAPSHOT_HASH_MISMATCH:       { id: 'CL0115', severity: ERROR, summary: 'A file under snapshot/<name>/ no longer matches its manifest-recorded hash.' },
  LIBRARY_ROLE_SCAN_REFUSED:    { id: 'CL0116', severity: ERROR, summary: '--snapshot cannot compute requiresRoles for a library entry whose own items do not validate.' },
  PACK_MALFORMED:               { id: 'CL0117', severity: ERROR, summary: 'A convention pack is missing, unparseable, or not shaped like a pack.' },
  PACK_UNBIND_UNKNOWN:          { id: 'CL0118', severity: WARN,  summary: 'lint.packs.<name>: ~ on a branch that never inherited that pack.' },
  PACK_NAME_MISMATCH:           { id: 'CL0119', severity: ERROR, summary: "A pack's declared name: disagrees with the lint.packs key it was loaded under." },
  PATH_NOT_FOUND:               { id: 'CL0120', severity: WARN,  summary: 'A declared input path does not exist on disk.' },
  INCLUDE_NOT_FOUND:            { id: 'CL0130', severity: WARN,  summary: 'An include: path does not exist.' },
  DOUBLE_INCLUDE:               { id: 'CL0131', severity: ERROR, summary: 'The same file was included more than once.' },
  ITEM_WITHOUT_IDENTITY:        { id: 'CL0140', severity: ERROR, summary: 'An item has neither id: nor name:.' },
  DUPLICATE_ITEM_ID:            { id: 'CL0141', severity: ERROR, summary: 'Duplicate item id.' },
  MULTIPLE_VAR_ALIASES:         { id: 'CL0142', severity: WARN,  summary: 'An item declares more than one v: alias; they are merged.' },
  ID_CONTAINS_COLON:            { id: 'CL0144', severity: ERROR, summary: 'An item id contains ":", which is reserved as the canon-set separator.' },

  // ── CL02xx  schema ────────────────────────────────────────────────────────
  UNKNOWN_KEY:                  { id: 'CL0201', severity: ERROR, summary: 'Unknown key. Carries a spelling suggestion when one is close.' },
  WRONG_TYPE:                   { id: 'CL0202', severity: ERROR, summary: 'Key has the wrong value type.' },
  MISSING_REQUIRED:             { id: 'CL0203', severity: ERROR, summary: 'A required key is missing.' },
  NOT_YET_IMPLEMENTED:          { id: 'CL0204', severity: WARN,  summary: 'Key is recognized but not read; it is ignored.' },
  SUPERSEDED_KEY:               { id: 'CL0205', severity: WARN,  summary: 'Key has been superseded by another spelling.' },
  VALUE_NOT_ALLOWED:            { id: 'CL0206', severity: ERROR, summary: 'Key takes a closed set of values and got something else.' },
  VALUE_OUT_OF_RANGE:           { id: 'CL0207', severity: ERROR, summary: "A number is outside its descriptor's inclusive min/max bounds." },
  PATTERN_MISMATCH:             { id: 'CL0208', severity: ERROR, summary: "A string does not match its descriptor's pattern: regex." },
  UNSUPPORTED_VERSION:          { id: 'CL0209', severity: ERROR, summary: 'version: 4 is missing or wrong; a missing key or version: 3 names --migrate.' },
  MISPLACED_KEY:                { id: 'CL0210', severity: ERROR, summary: 'Key is valid, but at a different level — with the level named.' },

  // ── CL03xx  items ─────────────────────────────────────────────────────────
  VARIANT_DELTA_VAR_ALIASES:    { id: 'CL0320', severity: WARN,  summary: 'A variant delta declares more than one v: alias; they are merged.' },
  VARIANT_NOT_FOUND:            { id: 'CL0321', severity: WARN,  summary: "A named variant does not exist in the item's variant tree." },
  NO_TYPE_OR_TEMPLATE:          { id: 'CL0322', severity: WARN,  summary: 'An item emitting a story card has neither aid.type nor render.template.' },
  NOTES_AND_DESCRIPTION:        { id: 'CL0323', severity: ERROR, summary: 'An item declares both notes: and description:.' },
  ITEM_RESOLUTION_FAILED:       { id: 'CL0324', severity: ERROR, summary: 'An item could not be resolved — most often a failed import:.' },
  DUPLICATE_RESOLVED_ID:        { id: 'CL0325', severity: ERROR, summary: 'Two item definitions resolve to the same id on one branch.' },
  SELECTOR_MATCHED_NOTHING:     { id: 'CL0326', severity: WARN,  summary: 'A selector aimed at many items matched none of them.' },
  BRANCH_WILDCARD_UNBIND:       { id: 'CL0327', severity: WARN,  summary: "A branch spec maps '*' to ~, which reads as \"exclude from every branch\" and is silently skipped; the author meant '_: ~'." },
  FIELD_OP_NOOP:                { id: 'CL0328', severity: WARN,  summary: "A field op's target is absent so it changes nothing — every op in a chain missed, or a lone -{} / swap missed." },
  CROSS_ITEM_REF_MISSING:       { id: 'CL0330', severity: WARN,  summary: 'A cross-item reference names an item that does not exist.' },
  AMBIGUOUS_REF:                { id: 'CL0340', severity: ERROR, summary: 'A reference is defined in more than one canon set and is not qualified.' },
  UNKNOWN_CANON_SOURCE:         { id: 'CL0341', severity: ERROR, summary: 'A reference names a canon set not declared in structure.input.library.' },
  REF_NOT_FOUND:                { id: 'CL0342', severity: ERROR, summary: 'A reference names an id that no canon set defines.' },

  // ── CL04xx  render ────────────────────────────────────────────────────────
  TEMPLATE_CONTAINS_FENCE:      { id: 'CL0410', severity: ERROR, summary: 'A .template or .partial still contains a ~~~ fence.' },
  NOTES_TEMPLATE_NOT_FOUND:     { id: 'CL0411', severity: ERROR, summary: 'A render.notesTemplate in compile.yaml names a template that is not loaded.' },
  ITEM_NOTES_TEMPLATE_NOT_FOUND:{ id: 'CL0412', severity: ERROR, summary: 'A render.notesTemplate on an item names a template that is not loaded.' },
  TEMPLATE_PARSE_FAILED:        { id: 'CL0413', severity: ERROR, summary: 'A render-function call in a template or body field does not parse.' },
  TEMPLATE_UNKNOWN_FUNCTION:    { id: 'CL0414', severity: ERROR, summary: 'A template uses an unknown render-function name.' },
  TEMPLATE_UNCLOSED_BLOCK:      { id: 'CL0415', severity: ERROR, summary: 'An {if}, {wrapper} or {preserve} block is not closed.' },
  PARTIAL_CYCLE:                { id: 'CL0416', severity: ERROR, summary: 'A partial includes itself, directly or indirectly.' },
  PARTIAL_NOT_FOUND:            { id: 'CL0417', severity: ERROR, summary: 'An {include NAME} names a partial that is not loaded.' },
  CROSS_ITEM_CYCLE:             { id: 'CL0418', severity: ERROR, summary: 'Cross-item render-function references form a cycle.' },
  TEMPLATE_NOT_FOUND:           { id: 'CL0420', severity: ERROR, summary: "No loaded template matches an item's aid.type or render.template." },
  RENDER_FAILED:                { id: 'CL0421', severity: ERROR, summary: 'A template threw while rendering an item.' },
  FIELD_TABLE_MALFORMED:        { id: 'CL0422', severity: ERROR, summary: 'A fields.cl.yaml is not a mapping, or a fields:/groups:/templates: entry has the wrong shape.' },
  FIELD_TABLE_UNKNOWN_KEY:      { id: 'CL0423', severity: ERROR, summary: 'A fields: entry carries an unknown key or an unknown render: function name.' },
  FIELD_TABLE_BAD_REF:          { id: 'CL0424', severity: WARN,  summary: 'A group member or template entry names something that is not a declared field or group.' },
  FIELD_TABLE_STRAY_FILE:       { id: 'CL0425', severity: WARN,  summary: 'A file in a templates directory looks like a misspelled fields.cl.yaml and is being ignored.' },
  FIELD_UNREAD_UNKNOWN:         { id: 'CL0426', severity: WARN,  summary: 'A body: key is read by no field and named by no declaration — a typo; its content is dropped.' },
  FIELD_UNREAD_MISROUTED:       { id: 'CL0427', severity: WARN,  summary: "A body: key is a declared field the resolved template's list does not include." },
  FIELD_DECLARED_UNUSED:        { id: 'CL0428', severity: WARN,  summary: 'A field is declared in the field table but no template names it.' },
  DUPLICATE_NAMED_FILE:         { id: 'CL0429', severity: ERROR, summary: 'Two files in one templates directory resolve to the same name. Aborts the load.' },
  LEAKED_FIELD_TOKEN:           { id: 'CL0430', severity: ERROR, summary: 'A {$…} field, pronoun or character token survived into rendered output.' },
  LEAKED_VARIABLE:              { id: 'CL0431', severity: ERROR, summary: 'A {%key} compile.yaml variable survived into rendered output.' },
  LEAKED_RENDER_FUNCTION:       { id: 'CL0432', severity: ERROR, summary: 'A render function leaked into rendered output.' },
  LEAKED_TEMPLATE_TAG:          { id: 'CL0433', severity: ERROR, summary: 'A template control tag leaked into rendered output.' },
  LEAKED_VERB_MARKER:           { id: 'CL0434', severity: ERROR, summary: 'A verb-conjugation marker was left unresolved.' },
  LEAKED_JS_ARTIFACT:           { id: 'CL0435', severity: ERROR, summary: 'A JS interpolation artifact reached rendered output.' },
  SUSPECT_VERB_MARKER:          { id: 'CL0436', severity: WARN,  layer: 'opinion', summary: 'A bracketed lowercase word is not a recognized verb-conjugation marker — likely a typo.' },
  SUSPECT_JS_WORD:              { id: 'CL0437', severity: WARN,  layer: 'opinion', summary: 'A bare undefined/NaN appears in rendered output.' },

  // ── CL05xx  tokens ────────────────────────────────────────────────────────
  VARIABLE_UNDECLARED:          { id: 'CL0510', severity: ERROR, summary: 'A referenced variable is not declared anywhere.' },
  VARIABLE_CYCLE:               { id: 'CL0511', severity: ERROR, summary: 'Variables form a reference cycle; every key in the loop is named.' },
  VARIABLE_UNBIND_UNKNOWN:      { id: 'CL0512', severity: WARN,  summary: 'A variable is unbound with ~ but was never inherited at that node.' },
  VARIABLE_PRE_BRANCH:          { id: 'CL0520', severity: ERROR, summary: 'A branch-scoped variable was used where only root variables resolve.' },
  LIBRARY_NAME_COLLIDES:        { id: 'CL0521', severity: ERROR, summary: 'A library name collides with a declared variable.' },
  LIBRARY_DEPENDENCY_UNCOVERED: { id: 'CL0522', severity: WARN,  summary: 'A component reads from outside the project and no structure.input.library entry covers it.' },
  PLACEHOLDER_UNBIND_UNKNOWN:   { id: 'CL0530', severity: WARN,  summary: 'A placeholder is unbound with ~ but was never inherited at that node.' },
  PLACEHOLDER_CYCLE:            { id: 'CL0531', severity: ERROR, summary: 'Placeholder questions form a reference cycle; every key in the loop is named.' },
  PLACEHOLDER_UNDECLARED:       { id: 'CL0532', severity: ERROR, summary: 'A %key% reaching compiled output is not declared on that branch.' },
  PLACEHOLDER_INVALID_CONTEXT:  { id: 'CL0533', severity: ERROR, summary: 'A placeholder reached a destination AID does not fill: the Description, or a card type.' },
  PLACEHOLDER_IN_TITLE:         { id: 'CL0534', severity: WARN,  summary: 'A placeholder reached a title, where AID does not do what writing one implies.' },
  PLACEHOLDER_UNUSED:           { id: 'CL0535', severity: WARN,  layer: 'opinion', summary: 'A placeholder is declared and referenced nowhere beneath its declaring node.' },
  PLACEHOLDER_DUPLICATE_QUESTION:{ id: 'CL0536', severity: WARN, layer: 'opinion', summary: 'Two or more placeholders declare the same question text.' },
  ROLE_UNDECLARED:              { id: 'CL0540', severity: ERROR, summary: 'A {$X} token resolves to neither a declared role nor a known item id.' },
  ROLE_COLLIDES_WITH_ITEM:      { id: 'CL0541', severity: ERROR, summary: 'A role name and an item id are the same string, which is ambiguous.' },
  ROLE_TARGET_EXCLUDED:         { id: 'CL0542', severity: ERROR, summary: 'A role is bound to an item id that does not resolve on this branch.' },
  ROLE_INDIRECTION:             { id: 'CL0543', severity: ERROR, summary: 'A role is bound to another role name rather than directly to an item id.' },
  ROLE_UNBIND_UNKNOWN:          { id: 'CL0544', severity: WARN,  summary: 'A role is unbound with ~ but was never inherited at that node.' },
  ROLE_UNUSED:                  { id: 'CL0545', severity: WARN,  summary: 'A role is declared and never referenced by a resolved token anywhere in the compile.' },

  // ── CL06xx  components ────────────────────────────────────────────────────
  SECTION_TEXT_AND_SLOT:        { id: 'CL0601', severity: ERROR, summary: 'A section declares both text: and slot: true.' },
  SECTION_RENDERS_NOTHING:      { id: 'CL0602', severity: WARN,  summary: 'A section has no text, no heading and is not a slot, so it renders nothing.' },
  SECTION_WRAP_UNKNOWN:         { id: 'CL0603', severity: WARN,  summary: "A section's render.wrap is neither each nor all; each is used." },
  SECTION_VARIANT_NOT_FOUND:    { id: 'CL0604', severity: WARN,  summary: "A section's branch dispatch names a variant the section does not define." },
  COMPONENT_DISPATCH_MATCHED_NOTHING:{ id: 'CL0605', severity: WARN, summary: 'A component-level branch dispatch names a variant no section defines.' },
  IMPORT_NOT_FOUND:             { id: 'CL0606', severity: ERROR, summary: 'A component imports: entry names a from: that does not resolve to a file.' },
  IMPORT_CYCLE:                 { id: 'CL0607', severity: ERROR, summary: 'A component import chain loops back on a file already being resolved.' },
  IMPORT_DELETE_UNKNOWN:        { id: 'CL0608', severity: WARN,  summary: 'A section is deleted with ~ but no import provided it.' },
  ITEM_NO_OUTPUT:               { id: 'CL0610', severity: ERROR, summary: 'An item resolves onto a branch and produces no output there.' },
  TARGET_UNDECLARED_SLOT:       { id: 'CL0611', severity: ERROR, summary: 'A render target names a slot the component does not declare.' },
  TARGET_NOT_A_SLOT:            { id: 'CL0612', severity: ERROR, summary: 'A render target names a section that exists but is not a slot.' },
  TARGET_NAMES_NO_SLOT:         { id: 'CL0613', severity: ERROR, summary: 'A render target names no slot at all.' },
  SLOT_EMPTY:                   { id: 'CL0614', severity: WARN,  summary: 'A declared slot has no items on a branch.' },
  COMPONENT_RENDERS_NOTHING:    { id: 'CL0615', severity: ERROR, summary: 'A component renders to nothing on a branch.' },
  LEAF_DESCRIPTION_NO_OPENING:  { id: 'CL0616', severity: ERROR, summary: 'A leaf carries an adventure description and declares no Opening.md.' },
  SECTION_SOURCE_NOT_FOUND:     { id: 'CL0617', severity: ERROR, summary: "A section's file: or from.script: does not resolve to a file." },
  SECTION_EXTRACT_UNKNOWN:      { id: 'CL0618', severity: ERROR, summary: "A section's extract: names no known transform." },
  SECTION_TEXT_AND_SOURCE:      { id: 'CL0619', severity: ERROR, summary: 'A section declares more than one of text:, file: and from:.' },
  COMPONENT_METADATA_UNSUPPORTED:{ id: 'CL0620', severity: WARN, summary: 'metadata: on a component whose output has no place for frontmatter.' },
  DESCRIPTION_KEYS_COLLIDE:     { id: 'CL0621', severity: WARN,  summary: 'Both description keys aimed at one file — an unbranched project.' },
  CARD_NAME_COLLISION:          { id: 'CL0622', severity: ERROR, summary: 'Two story cards share a display name on the same leaf; Velvet Lattice merges by name.' },
  STORY_CARD_ENTRY_NO_TITLE:    { id: 'CL0623', severity: ERROR, summary: 'A render.storyCards entry declares no title:.' },
  STORY_CARD_ENTRY_UNKNOWN_SECTION:{ id: 'CL0624', severity: WARN, summary: "A render.storyCards entry's sections: names a section the component does not declare." },
  STORY_CARD_ENTRY_RENDERS_NOTHING:{ id: 'CL0625', severity: WARN, summary: 'A render.storyCards entry renders no text on a branch; no card is written.' },
  CARD_TYPE_CASE_COLLISION:     { id: 'CL0626', severity: ERROR, summary: 'Two aid.type values differ only by case, so one overwrites the other on a case-insensitive filesystem.' },
  CARD_TYPE_LEADING_SPACE:      { id: 'CL0628', severity: WARN,  summary: 'An aid.type has leading whitespace; it is trimmed.' },
  ADVENTURE_DESCRIPTION_ADVANCED:{ id: 'CL0629', severity: ERROR, summary: 'adventureDescription declares advanced: or description: in metadata: — both belong to the scenario blurb only.' },
  LEAF_NO_OPENING:              { id: 'CL0630', severity: WARN,  summary: 'A branch leaf resolves neither an opening: nor an adventureDescription:, inherited or its own.' },
  LEAF_NO_AIN:                  { id: 'CL0631', severity: WARN,  summary: "A branch leaf resolves no aiInstructions:; Velvet Lattice writes an empty string, suppressing AID's default." },
  CARD_TYPE_INVALID:            { id: 'CL0632', severity: ERROR, summary: 'aid.type fails path-legality: empty, an illegal path character, . / .., or a trailing space/period.' },
  BRANCH_FRAMING_IGNORED:       { id: 'CL0633', severity: WARN,  summary: 'branchFraming on a node with nothing below it to frame — the root with no branches, or a leaf.' },
  COMPONENT_NO_OUTPUT:          { id: 'CL0634', severity: ERROR, summary: 'A requested component produced no output anywhere in the compile.' },

  // ── CL07xx  emit ─────────────────────────────────────────────────────────
  TRIGGER_CONTAINS_COMMA:       { id: 'CL0701', severity: ERROR, summary: 'A trigger value contains a comma, which Velvet Lattice would split into two triggers.' },
  TRIGGER_EMPTY:                { id: 'CL0702', severity: WARN,  summary: 'A trigger value is empty and will reach AID as an empty key.' },
  OPENING_OVER_LIMIT:           { id: 'CL0710', severity: ERROR, summary: "An Opening.md exceeds AID's 4,000-character limit." },
  OPENING_NEAR_LIMIT:           { id: 'CL0711', severity: WARN,  summary: 'An Opening.md is within 10% of the 4,000-character limit.' },
  CARD_BODY_OVER_LIMIT:         { id: 'CL0712', severity: ERROR, summary: "A story card body exceeds AID's 2,000-character limit." },
  CARD_BODY_NEAR_LIMIT:         { id: 'CL0713', severity: WARN,  summary: 'A story card body is within 10% of the 2,000-character limit.' },
  NOTES_OVER_LIMIT:             { id: 'CL0714', severity: ERROR, summary: "An item's notes: exceeds AID's 10,000-character description limit." },
  NOTES_NEAR_LIMIT:             { id: 'CL0715', severity: WARN,  summary: "An item's notes: is within 10% of the 10,000-character limit." },
});

/** name → id string, derived from `REGISTRY`. This is what raise sites import and use. */
const CODES = Object.freeze(
  Object.fromEntries(Object.entries(REGISTRY).map(([name, entry]) => [name, entry.id]))
);

/** id → severity, derived from `REGISTRY`, for `severityOf`. */
const SEVERITY_BY_ID = Object.freeze(
  Object.fromEntries(Object.values(REGISTRY).map((entry) => [entry.id, entry.severity]))
);

/**
 * Recover a code's severity from its id alone — for diagnostics raised through
 * `onWarn(code, message)`, which carries none. Every code is in `REGISTRY`, so an
 * unknown one is a typo at the raise site and throws rather than defaulting.
 */
function severityOf(code) {
  const severity = SEVERITY_BY_ID[code];
  if (severity === undefined) {
    throw new Error(`severityOf: unknown diagnostic code "${code}" — every code must be declared in REGISTRY.`);
  }
  return severity;
}

// ── the compiler / lint split ───────────────────────────────────────────────

/** ids of the `layer: 'opinion'` entries, derived from `REGISTRY`. */
const OPINION_IDS = Object.freeze(new Set(
  Object.values(REGISTRY).filter((e) => e.layer === 'opinion').map((e) => e.id)
));

/**
 * True for a diagnostic `lint.level` is allowed to silence: the four `layer: 'opinion'`
 * codes, plus every convention-pack finding (`CL-<pack>/NNNN`, opinion-layer by the prefix
 * — pack codes are not in `REGISTRY`). Every other code is a fact about the output that
 * `lint.level` cannot reach, which is what makes `level: off` safe to write.
 *
 * Called on the raw code before anything validates it, so it must tolerate any string.
 */
function isOpinion(code) {
  if (typeof code !== 'string') return false;
  return OPINION_IDS.has(code) || code.startsWith('CL-');
}

/** The three values `lint.level` and `--lint-level` accept, in the order they say less. */
const LINT_LEVELS = Object.freeze(['off', 'error', 'warn']);

const SEVERITY_RANK = Object.freeze({ [SEVERITY.INFO]: 0, [SEVERITY.WARN]: 1, [SEVERITY.ERROR]: 2 });

/**
 * Apply a `lint.level` to one opinion-layer diagnostic. Returns the severity it reaches the
 * author at, or `null` if it does not reach them at all.
 *
 * **`level` names the one severity the opinion layer is allowed to speak at.** Clamp the
 * diagnostic to it, then drop whatever is left below it — one rule, and it is the only rule
 * that satisfies both things §12.5 asks for. Under `warn` an opinion ERROR demotes to WARN,
 * so nothing in the opinion layer can fail a build; under `error` the prose heuristics, all
 * of them WARN, disappear and pack findings about mod config survive at full severity. That
 * second case is the author-facing meaning the docs lead with: *validate my mod configs,
 * skip the prose heuristics*.
 *
 * Unset is not a level. A project that says nothing gets every opinion at the severity it
 * was raised with, which is what keeps a pack ERROR able to fail a build by default.
 */
function applyLintLevel(severity, level) {
  if (!level) return severity;
  if (level === 'off') return null;
  const ceiling = level === 'error' ? SEVERITY.ERROR : SEVERITY.WARN;
  const clamped = SEVERITY_RANK[severity] <= SEVERITY_RANK[ceiling] ? severity : ceiling;
  return SEVERITY_RANK[clamped] < SEVERITY_RANK[ceiling] ? null : clamped;
}

/**
 * Adapt a `Diagnostics` bus to the `onWarn(code, message)` callback `model/` expects.
 *
 * The severity comes from the code, so an ERROR raised inside a pure module reaches the bus
 * as an ERROR and gates the exit code like any other — which is the whole point: the old
 * console adapter printed `WARN` for everything and gated nothing.
 */
function busWarner(diagnostics, loc) {
  return (code, message) => diagnostics.add(severityOf(code), code, message, loc || {});
}

/**
 * One diagnostic. `file`/`line`/`col` are optional throughout: a diagnostic about a
 * whole project has no span, and template-level errors keep imprecise positions until
 * the render rewrite (§13). A missing span degrades the rendering, never the code.
 */
class Diagnostic {
  constructor({ code, severity, message, file, line, col, hint }) {
    this.code = code;
    this.severity = severity;
    this.message = message;
    this.file = file || null;
    this.line = typeof line === 'number' ? line : null;
    this.col = typeof col === 'number' ? col : null;
    this.hint = hint || null;
  }

  /** `file:line:col`, degrading gracefully as position information runs out. */
  get location() {
    if (!this.file) return '';
    if (this.line === null) return this.file;
    if (this.col === null) return `${this.file}:${this.line}`;
    return `${this.file}:${this.line}:${this.col}`;
  }

  /**
   * The §4.4 shape:
   *
   *   ERROR CL0310 codex/npcs.cl.yaml:112:9
   *     Item "Kaiden" dispatches branch "felix" to variant "Felix", which is not
   *     defined on this item or on canon item "Kaiden" (canon:main).
   */
  format() {
    const head = [SEVERITY_LABEL[this.severity] || this.severity, this.code, this.location]
      .filter(Boolean)
      .join(' ');
    const indent = (text) => String(text).split('\n').map((l) => `  ${l}`).join('\n');
    const parts = [head, indent(this.message)];
    if (this.hint) parts.push(indent(this.hint));
    return parts.join('\n');
  }

  toString() {
    return this.format();
  }
}

/** A collector. Nothing is printed; callers decide what to do with what accumulates. */
class Diagnostics {
  /**
   * `lintLevel` is the §12.5 ceiling, and it is applied here — at `add` — rather than at
   * print time. Everything downstream reads the bus: `hasErrors()` gates the exit code, the
   * printer walks `all`, and the pathological fixture snapshots it. Filtering in one of
   * those places and not the others is how a silenced diagnostic still fails a build.
   */
  constructor(options = {}) {
    this._items = [];
    this._lintLevel = options.lintLevel || null;
  }

  /** Set after construction, for the bus that exists before `compile.cl.yaml` is read. */
  setLintLevel(level) {
    this._lintLevel = level || null;
    return this;
  }

  get lintLevel() {
    return this._lintLevel;
  }

  add(severity, code, message, loc = {}, opts = {}) {
    let effective = severity;
    if (this._lintLevel && isOpinion(code)) {
      effective = applyLintLevel(severity, this._lintLevel);
      if (effective === null) return null;
    }
    const diag = new Diagnostic({
      code,
      severity: effective,
      message,
      file: loc.file,
      line: loc.line,
      col: loc.col,
      hint: opts.hint,
    });
    this._items.push(diag);
    return diag;
  }

  error(code, message, loc, opts) {
    return this.add(SEVERITY.ERROR, code, message, loc, opts);
  }

  warn(code, message, loc, opts) {
    return this.add(SEVERITY.WARN, code, message, loc, opts);
  }

  info(code, message, loc, opts) {
    return this.add(SEVERITY.INFO, code, message, loc, opts);
  }

  /** Absorb another collector's diagnostics — for folding a sub-compile's results up. */
  merge(other) {
    if (!other) return this;
    const items = Array.isArray(other) ? other : other.all;
    this._items.push(...items);
    return this;
  }

  get all() {
    return this._items.slice();
  }

  bySeverity(severity) {
    return this._items.filter((d) => d.severity === severity);
  }

  get errors() {
    return this.bySeverity(SEVERITY.ERROR);
  }

  get warnings() {
    return this.bySeverity(SEVERITY.WARN);
  }

  hasErrors() {
    return this._items.some((d) => d.severity === SEVERITY.ERROR);
  }

  get length() {
    return this._items.length;
  }

  isEmpty() {
    return this._items.length === 0;
  }

  clear() {
    this._items = [];
    return this;
  }

  format() {
    return this._items.map((d) => d.format()).join('\n\n');
  }

  toString() {
    return this.format();
  }
}

module.exports = {
  Diagnostic, Diagnostics, SEVERITY, SEVERITY_LABEL, REGISTRY, CODES, severityOf, busWarner,
  isOpinion, LINT_LEVELS, applyLintLevel,
};
