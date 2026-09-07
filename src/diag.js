'use strict';


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

const REGISTRY = Object.freeze({
  YAML_PARSE_FAILED:            { id: 'CL0101', severity: ERROR, summary: 'YAML syntax is invalid, so this file is skipped and loading continues; fix the syntax, then compile again.' },
  YAML_FILE_UNREADABLE:         { id: 'CL0102', severity: ERROR, summary: 'This file cannot be read, so its content is skipped and loading continues; restore the file or fix its path and permissions.' },
  YAML_EMPTY_FILE:              { id: 'CL0103', severity: WARN,  summary: 'This file is empty, so it contributes no items; add YAML content or remove the empty file.' },
  YAML_NULL_DOCUMENT:           { id: 'CL0104', severity: WARN,  summary: 'This YAML document is null, so it contributes no items; add a document or remove the empty document.' },
  TOKEN_SWALLOWED_BY_YAML:      { id: 'CL0105', severity: ERROR, summary: 'YAML read a Codex Loom token as a mapping key, so the intended text is lost; quote the token value and loading continues for other files.' },
  CONFIG_NOT_A_MAPPING:         { id: 'CL0110', severity: ERROR, summary: 'compile.yaml is not a mapping, so configuration cannot be loaded; replace its top-level value with configuration keys.' },
  SNAPSHOT_DIR_MISSING:         { id: 'CL0111', severity: WARN,  summary: 'The configured snapshot directory is missing, so frozen inputs are unavailable; run --snapshot to populate it before relying on the freeze.' },
  SNAPSHOT_MANIFEST_UNPARSEABLE:{ id: 'CL0112', severity: WARN,  summary: 'The snapshot manifest is not valid JSON or has the wrong shape, so snapshot tracking is skipped; repair or regenerate manifest.json.' },
  SNAPSHOT_MISSING_ENTRY:       { id: 'CL0113', severity: WARN,  summary: 'A configured library/templates entry is absent from the manifest, so that entry cannot be checked as frozen; regenerate the snapshot manifest.' },
  SNAPSHOT_FILE_UNTRACKED:      { id: 'CL0114', severity: WARN,  summary: 'A file exists under the snapshot but is not tracked by the manifest, so it is outside the freeze; remove it or regenerate the snapshot.' },
  SNAPSHOT_HASH_MISMATCH:       { id: 'CL0115', severity: ERROR, summary: 'A frozen file differs from its recorded hash, so the snapshot is corrupted and compilation stops; restore the file or regenerate the snapshot.' },
  LIBRARY_ROLE_SCAN_REFUSED:    { id: 'CL0116', severity: ERROR, summary: '--snapshot could not compute requiresRoles because the library items are invalid, so that role list is omitted; fix the items and rerun --snapshot.' },
  PACK_MALFORMED:               { id: 'CL0117', severity: ERROR, summary: 'The convention pack cannot be loaded, so its rules are unavailable; provide a readable pack with the required shape.' },
  PACK_UNBIND_UNKNOWN:          { id: 'CL0118', severity: WARN,  summary: 'This branch unbinds a convention pack it never inherited, so nothing changes; remove the ~ entry or inherit the pack first.' },
  PACK_NAME_MISMATCH:           { id: 'CL0119', severity: ERROR, summary: 'The convention pack name differs from its lint.packs key, so portable diagnostics and suppressions can break; make the key and name match.' },
  PATH_NOT_FOUND:               { id: 'CL0120', severity: WARN,  summary: 'A configured input path is missing, so content at that path is skipped; create the path or correct the configuration.' },
  INCLUDE_NOT_FOUND:            { id: 'CL0130', severity: WARN,  summary: 'An include path is missing, so included items are skipped; create the file or correct the include path.' },
  DOUBLE_INCLUDE:               { id: 'CL0131', severity: ERROR, summary: 'The same file is included more than once, so the repeated items are skipped; keep one include of the file.' },
  ITEM_WITHOUT_IDENTITY:        { id: 'CL0140', severity: ERROR, summary: 'This item has no id or name, so it cannot enter the registry; add one identity field and loading continues for other items.' },
  DUPLICATE_ITEM_ID:            { id: 'CL0141', severity: ERROR, summary: 'An item id is already defined, so the later definition is skipped; remove the duplicate or give it a unique id.' },
  MULTIPLE_VAR_ALIASES:         { id: 'CL0142', severity: WARN,  summary: 'This item declares multiple variable-block aliases, so they are merged with later fields winning; keep one alias to make the result unambiguous.' },
  ID_CONTAINS_COLON:            { id: 'CL0144', severity: ERROR, summary: 'This item id contains a colon, so it cannot be referenced unambiguously with library-qualified ids; remove the colon.' },

  UNKNOWN_KEY:                  { id: 'CL0201', severity: ERROR, summary: 'An unknown key is ignored, so its value has no effect; remove it or rename it to a supported key.' },
  WRONG_TYPE:                   { id: 'CL0202', severity: ERROR, summary: 'A key has the wrong value type, so that value is not validated or used; replace it with the required type.' },
  MISSING_REQUIRED:             { id: 'CL0203', severity: ERROR, summary: 'A required key is absent, so the containing value cannot be validated or used; add the key.' },
  NOT_YET_IMPLEMENTED:          { id: 'CL0204', severity: WARN,  summary: 'A recognized key is ignored because the compiler does not read it; remove it or use a supported key until it is implemented.' },
  SUPERSEDED_KEY:               { id: 'CL0205', severity: WARN,  summary: 'A key uses an older spelling; replace it with the current spelling so the configuration keeps working if the old spelling is removed.' },
  VALUE_NOT_ALLOWED:            { id: 'CL0206', severity: ERROR, summary: 'A key has a value outside its allowed set, so the value is rejected; replace it with one of the listed values.' },
  VALUE_OUT_OF_RANGE:           { id: 'CL0207', severity: ERROR, summary: "A number is outside its descriptor's inclusive min/max bounds, so the value is rejected; change it to a value within the bounds." },
  PATTERN_MISMATCH:             { id: 'CL0208', severity: ERROR, summary: "A string does not match its descriptor's pattern, so the value is rejected; change it to match the required regex." },
  UNSUPPORTED_VERSION:          { id: 'CL0209', severity: ERROR, summary: 'The project is not declared as v4, so configuration loading stops; set version: 4 or run --migrate for a v3 project.' },
  MISPLACED_KEY:                { id: 'CL0210', severity: ERROR, summary: 'A valid key is at the wrong level, so it is ignored there; move it to the reported level.' },

  VARIANT_DELTA_VAR_ALIASES:    { id: 'CL0320', severity: WARN,  summary: 'A variant delta declares multiple variable-block aliases; they merge with later fields winning.' },
  VARIANT_NOT_FOUND:            { id: 'CL0321', severity: WARN,  summary: 'A variant dispatch names no variant in the selected item tree, so that dispatch has no effect.' },
  NO_TYPE_OR_TEMPLATE:          { id: 'CL0322', severity: WARN,  summary: 'An item emits a story card without aid.type or render.template, so no card template can be selected.' },
  NOTES_AND_DESCRIPTION:        { id: 'CL0323', severity: ERROR, summary: 'An item declares notes: and description: for the same field; remove one spelling.' },
  ITEM_RESOLUTION_FAILED:       { id: 'CL0324', severity: ERROR, summary: 'An item import could not be resolved; the item is skipped.' },
  DUPLICATE_RESOLVED_ID:        { id: 'CL0325', severity: ERROR, summary: 'Two item definitions resolve to one id on a branch, so both cannot be emitted.' },
  SELECTOR_MATCHED_NOTHING:     { id: 'CL0326', severity: WARN,  summary: 'A selector aimed at multiple items matched none, so it changes nothing.' },
  BRANCH_WILDCARD_UNBIND:       { id: 'CL0327', severity: WARN,  summary: "A branch spec maps '*' to ~; use '_: ~' to exclude the unnamed branches." },
  FIELD_OP_NOOP:                { id: 'CL0328', severity: WARN,  summary: "A field operation matches nothing, so it changes no value; check for drift or a typo." },
  CROSS_ITEM_REF_MISSING:       { id: 'CL0330', severity: WARN,  summary: 'A cross-item reference names no resolved item, so the token remains unresolved.' },
  AMBIGUOUS_REF:                { id: 'CL0340', severity: ERROR, summary: 'A reference is defined in more than one library set and needs a qualifier.' },
  UNKNOWN_CANON_SOURCE:          { id: 'CL0341', severity: ERROR, summary: 'A reference names a library set not declared in structure.input.library; use a declared set.' },
  REF_NOT_FOUND:                { id: 'CL0342', severity: ERROR, summary: 'A reference names an id that the selected registry does not define.' },

  TEMPLATE_CONTAINS_FENCE:      { id: 'CL0410', severity: ERROR, summary: 'A template still contains the story-card envelope fence, so its body is invalid; remove the fence and envelope keys, and the invalid template remains until fixed.' },
  NOTES_TEMPLATE_NOT_FOUND:     { id: 'CL0411', severity: ERROR, summary: 'compile.yaml names a notes template that is not loaded, so configured notes rendering cannot run; add or rename the template, and the notes fallback continues until fixed.' },
  ITEM_NOTES_TEMPLATE_NOT_FOUND:{ id: 'CL0412', severity: ERROR, summary: 'An item names a notes template that is not loaded, so that item cannot use its requested notes rendering; add or rename the template, and the item continues without that template until fixed.' },
  TEMPLATE_PARSE_FAILED:        { id: 'CL0413', severity: ERROR, summary: 'A render-function call cannot be parsed, so the affected text cannot be rendered; correct the call syntax, and the malformed call remains literal until fixed.' },
  TEMPLATE_UNKNOWN_FUNCTION:    { id: 'CL0414', severity: ERROR, summary: 'A template calls an unknown render function, so that call cannot render; replace it with a supported function, and the unknown call remains until fixed.' },
  TEMPLATE_UNCLOSED_BLOCK:      { id: 'CL0415', severity: ERROR, summary: 'A template control block has no closer, so its intended conditional or wrapper behavior cannot apply; close the block, and the opening tag remains literal until fixed.' },
  PARTIAL_CYCLE:                { id: 'CL0416', severity: ERROR, summary: 'Partials include one another in a cycle, so expansion cannot finish; break the include cycle, and the cyclic directive renders empty until fixed.' },
  PARTIAL_NOT_FOUND:            { id: 'CL0417', severity: ERROR, summary: 'An include names a partial that is not loaded, so that partial content is unavailable; add or rename the partial, and the directive renders empty until fixed.' },
  CROSS_ITEM_CYCLE:             { id: 'CL0418', severity: ERROR, summary: 'Cross-item render references form a cycle, so the referenced fields cannot finish expanding; break the cycle, and cyclic references remain unresolved until fixed.' },
  TEMPLATE_NOT_FOUND:           { id: 'CL0420', severity: ERROR, summary: "An item has no matching loaded template, so its requested output cannot be rendered; add or select the template, and the item remains unrendered until fixed." },
  RENDER_FAILED:                { id: 'CL0421', severity: ERROR, summary: 'A template threw while rendering an item, so that item has no reliable rendered output; fix the reported template or data error, and the item remains unrendered until fixed.' },
  FIELD_TABLE_UNUSABLE:         { id: 'CL0422', severity: ERROR, summary: 'A field table or templateFor slot file cannot be read as a mapping, so its fields, groups and templates are unavailable; repair the file, and affected entries remain unavailable until fixed.' },
  FIELD_SOURCE_CONFLICT:        { id: 'CL0423', severity: ERROR, summary: 'A field declaration specifies multiple sources, so the extra sources are ignored; keep one of from:, parts: or try:, and the precedence winner continues until fixed.' },
  FIELD_TABLE_BAD_REF:          { id: 'CL0424', severity: WARN,  summary: 'A group or template names an undeclared field or group, so that entry contributes nothing; declare or correct the name, and the missing entry remains empty until fixed.' },
  FIELD_TABLE_STRAY_FILE:       { id: 'CL0425', severity: WARN,  summary: 'A likely misspelled field-table filename is ignored, so its declarations are not loaded; rename it to fields.cl.yaml or fields.cl.yml, and its declarations remain unavailable until fixed.' },
  FIELD_UNREAD_UNKNOWN:         { id: 'CL0426', severity: WARN,  summary: 'An authored body key has no declaration or template reader, so its content is dropped from the compiled card; remove or declare and render the key, and the content stays dropped until fixed.' },
  FIELD_UNREAD_MISROUTED:       { id: 'CL0427', severity: WARN,  summary: 'An authored body key is declared but none of the item’s renders reads it, so its content is dropped from the compiled card; include the field in a rendered template or remove it, and the content stays dropped until fixed.' },
  FIELD_DECLARED_UNUSED:        { id: 'CL0428', severity: WARN,  summary: 'A declared field is named by no template or included partial, so its declaration has no effect; remove it or reference it, and the declaration remains unused until fixed.' },
  DUPLICATE_NAMED_FILE:         { id: 'CL0429', severity: ERROR, summary: 'Two template files resolve to one case-insensitive name, so loading stops without choosing a winner; remove or rename one file, and compilation cannot load the directory until fixed.' },
  LEAKED_FIELD_TOKEN:           { id: 'CL0430', severity: ERROR, summary: 'Compiled output still contains a field, pronoun or character token, so AID will receive the literal token and the build fails; fix the authoring reference or resolver input, and the token remains in output until fixed.' },
  LEAKED_VARIABLE:              { id: 'CL0431', severity: ERROR, summary: 'Compiled output still contains a compile.yaml variable token, so AID will receive the literal token and the build fails; declare or correct the variable reference, and the token remains in output until fixed.' },
  LEAKED_RENDER_FUNCTION:       { id: 'CL0432', severity: ERROR, summary: 'Compiled output still contains a render-function call, so AID will receive unevaluated syntax and the build fails; fix the source call or renderer, and the call remains in output until fixed.' },
  LEAKED_TEMPLATE_TAG:          { id: 'CL0433', severity: ERROR, summary: 'Compiled output still contains a template control tag, so AID will receive unevaluated syntax and the build fails; close or correct the source tag, and the tag remains in output until fixed.' },
  LEAKED_VERB_MARKER:           { id: 'CL0434', severity: ERROR, summary: 'Compiled output still contains a verb-conjugation marker, so AID will receive the marker literally and the build fails; correct the source marker or its subject, and the marker remains in output until fixed.' },
  LEAKED_JS_ARTIFACT:           { id: 'CL0435', severity: ERROR, summary: 'Compiled output contains a JavaScript interpolation artifact, so AID will receive corrupted text and the build fails; fix the source interpolation, and the artifact remains in output until fixed.' },
  SUSPECT_VERB_MARKER:          { id: 'CL0436', severity: WARN,  layer: 'opinion', summary: 'Compiled output contains an unrecognized bracketed lowercase word, so the intended conjugation may be wrong; correct the source marker if it is a typo, and the suspicious text remains until fixed.' },
  SUSPECT_JS_WORD:              { id: 'CL0437', severity: WARN,  layer: 'opinion', summary: 'Compiled output contains bare undefined or NaN, so authoring data or interpolation may be missing; fix the source value or interpolation, and the word remains in output until fixed.' },

  VARIABLE_UNDECLARED:          { id: 'CL0510', severity: ERROR, summary: 'A referenced variable is undeclared, so its token stays literal and compilation fails; declare or correct the key, and the literal remains until fixed.' },
  VARIABLE_CYCLE:               { id: 'CL0511', severity: ERROR, summary: 'Variables reference each other in a cycle, so expansion cannot finish and compilation fails; break the cycle, and cyclic tokens remain literal until fixed.' },
  VARIABLE_UNBIND_UNKNOWN:      { id: 'CL0512', severity: WARN,  summary: 'A variable is unbound with ~ but was never inherited, so nothing is removed; remove ~ or inherit the variable, and the no-op remains until fixed.' },
  VARIABLE_PRE_BRANCH:          { id: 'CL0520', severity: ERROR, summary: 'A branch-only variable is used before branches resolve, so its token cannot expand and compilation fails; move the variable to root scope or the use into a branch, and it remains unresolved until fixed.' },
  LIBRARY_NAME_COLLIDES:        { id: 'CL0521', severity: ERROR, summary: 'A library name collides with a variable name, so path resolution is ambiguous and loading fails; rename one declaration, and the ambiguity remains until fixed.' },
  LIBRARY_DEPENDENCY_UNCOVERED: { id: 'CL0522', severity: WARN,  summary: 'An outside component is not covered by a library entry, so --snapshot leaves it live; declare its directory as a library, and edits remain unfrozen until fixed.' },
  PLACEHOLDER_UNBIND_UNKNOWN:   { id: 'CL0530', severity: WARN,  summary: 'A placeholder is unbound with ~ but was never inherited, so no question is removed; remove ~ or inherit the placeholder, and the no-op remains until fixed.' },
  PLACEHOLDER_CYCLE:            { id: 'CL0531', severity: ERROR, summary: 'Placeholder questions reference each other in a cycle, so expansion cannot finish and compilation fails; break the cycle, and cyclic references remain unexpanded until fixed.' },
  PLACEHOLDER_UNDECLARED:       { id: 'CL0532', severity: ERROR, summary: 'An undeclared %key% reaches output, so AID receives the literal token; declare or correct the key, and the literal remains until fixed.' },
  PLACEHOLDER_INVALID_CONTEXT:  { id: 'CL0533', severity: ERROR, summary: 'A placeholder reaches a destination AID never fills, so that output cannot work as authored; remove or relocate the token, and the invalid placeholder remains until fixed.' },
  PLACEHOLDER_IN_TITLE:         { id: 'CL0534', severity: WARN,  summary: 'A placeholder reaches a title that AID does not substitute, so the raw token is shown; remove or relocate it, and the title stays literal until fixed.' },
  PLACEHOLDER_UNUSED:            { id: 'CL0535', severity: WARN, layer: 'opinion', summary: 'A declared placeholder is never referenced, so the player is asked a question whose answer goes nowhere; use or remove the key, and the unused prompt remains until fixed.' },
  PLACEHOLDER_DUPLICATE_QUESTION:{ id: 'CL0536', severity: WARN, layer: 'opinion', summary: 'Multiple placeholders declare one question, so AID gives their keys one shared answer; differentiate or merge the keys, and they remain coupled until fixed.' },
  ROLE_UNDECLARED:              { id: 'CL0540', severity: ERROR, summary: 'A {$X} token matches neither a role nor an item id, so it cannot resolve and compilation fails; correct the role or item name, and the token remains unresolved until fixed.' },
  ROLE_COLLIDES_WITH_ITEM:      { id: 'CL0541', severity: ERROR, summary: 'A role name is also an item id, so {$X} resolution is ambiguous and compilation fails; rename the role or item, and the ambiguity remains until fixed.' },
  ROLE_TARGET_EXCLUDED:         { id: 'CL0542', severity: ERROR, summary: 'A role targets an item absent from this branch, so its tokens cannot resolve there; bind an available item or adjust branch scope, and the role remains unresolved until fixed.' },
  ROLE_INDIRECTION:             { id: 'CL0543', severity: ERROR, summary: 'A role targets another role instead of an item id, so one-step role resolution fails; bind it directly to an item, and its tokens remain unresolved until fixed.' },
  ROLE_UNBIND_UNKNOWN:          { id: 'CL0544', severity: WARN,  summary: 'A role is unbound with ~ but was never inherited, so nothing is removed; remove ~ or inherit the role, and the no-op remains until fixed.' },
  ROLE_UNUSED:                  { id: 'CL0545', severity: WARN,  summary: 'A declared role is never referenced, so its binding has no effect; use or remove the role, and the unused declaration remains until fixed.' },
  NATIVE_PLACEHOLDER_SHAPE:     { id: 'CL0546', severity: WARN, layer: 'opinion', summary: 'AID will treat identifier-shaped ${...} as a player prompt rather than a Codex Loom token; write {$...} when substitution is intended, and the prompt remains until fixed.' },

  SECTION_TEXT_AND_SLOT:        { id: 'CL0601', severity: ERROR, summary: 'A section declares both text: and slot: true, so the compiler cannot know whether to render prose or receive items; split the prose into a separate section.' },
  SECTION_RENDERS_NOTHING:      { id: 'CL0602', severity: WARN,  summary: 'A section has no text, heading or slot, so it contributes no output; add content, make it a slot, or remove it.' },
  SECTION_WRAP_UNKNOWN:         { id: 'CL0603', severity: WARN,  summary: "A section's render.wrap is neither each nor all, so each is used; change it to each or all." },
  SECTION_VARIANT_NOT_FOUND:    { id: 'CL0604', severity: WARN,  summary: "A section's branch dispatch names an undefined variant, so that dispatch has no effect; correct the variant name or define it." },
  COMPONENT_DISPATCH_MATCHED_NOTHING:{ id: 'CL0605', severity: WARN, summary: 'A component dispatch names a variant no section defines, so the dispatch changes nothing; correct the name or add the variant to a section.' },
  IMPORT_NOT_FOUND:             { id: 'CL0606', severity: ERROR, summary: 'A component import names a missing file, so its sections are unavailable; correct from: or add the file.' },
  IMPORT_CYCLE:                 { id: 'CL0607', severity: ERROR, summary: 'A component import chain loops, so the cyclic import cannot be merged; break the cycle.' },
  IMPORT_DELETE_UNKNOWN:        { id: 'CL0608', severity: WARN,  summary: 'A section is deleted with ~ but no import provided it, so nothing is removed; remove the deletion or import the section first.' },
  ITEM_RENDERS_EMPTY:           { id: 'CL0609', severity: ERROR, summary: 'An item reaches a render target but renders no body there, so the target receives no usable content; add a rendered field or exclude the item.' },
  ITEM_NO_OUTPUT:               { id: 'CL0610', severity: ERROR, summary: 'An item resolves on a branch but produces no output, so it cannot reach AID; add a target or story card, or exclude it from the branch.' },
  TARGET_UNDECLARED_SLOT:       { id: 'CL0611', severity: ERROR, summary: 'A render target names no declared slot, so the item cannot be placed; correct slot: or declare the slot.' },
  TARGET_NOT_A_SLOT:            { id: 'CL0612', severity: ERROR, summary: 'A render target names a text section rather than a slot, so the item cannot be placed; add slot: true or target a real slot.' },
  TARGET_NAMES_NO_SLOT:         { id: 'CL0613', severity: ERROR, summary: 'A render target names no slot, so the item has nowhere to go; add slot: naming a declared slot.' },
  SLOT_EMPTY:                   { id: 'CL0614', severity: WARN,  summary: 'A declared slot has no items on a branch, so that slot contributes no item content; add or route an item.' },
  COMPONENT_RENDERS_NOTHING:    { id: 'CL0615', severity: ERROR, summary: 'A component renders no output on a branch, so its destination is empty; add a renderable section or exclude the component there.' },
  LEAF_DESCRIPTION_NO_OPENING:  { id: 'CL0616', severity: ERROR, summary: 'A leaf has an adventure description but no Opening.md, so Velvet Lattice has no opening prompt; add Opening.md or remove the description.' },
  SECTION_SOURCE_NOT_FOUND:     { id: 'CL0617', severity: ERROR, summary: "A section's file: or from.script: names no readable file, so its source text is unavailable; correct the path or add the file." },
  SECTION_EXTRACT_UNKNOWN:      { id: 'CL0618', severity: ERROR, summary: "A section's extract: names no known transform, so its source cannot be converted to text; choose a supported transform." },
  SECTION_TEXT_AND_SOURCE:      { id: 'CL0619', severity: ERROR, summary: 'A section declares multiple text sources, so precedence would be ambiguous; keep only text:, file: or from:.' },
  COMPONENT_METADATA_UNSUPPORTED:{ id: 'CL0620', severity: WARN, summary: 'metadata: is attached to a component output with no frontmatter destination, so the metadata is discarded; move it to a frontmatter-capable output.' },
  DESCRIPTION_KEYS_COLLIDE:     { id: 'CL0621', severity: WARN,  summary: 'Both description keys target one unbranched file, so one value will win; keep one description key or add branches.' },
  CARD_NAME_COLLISION:          { id: 'CL0622', severity: ERROR, summary: 'Two story cards share a name on one leaf, so Velvet Lattice merges them and one card is lost; give the cards distinct names.' },
  STORY_CARD_ENTRY_NO_TITLE:    { id: 'CL0623', severity: ERROR, summary: 'A render.storyCards entry has no title, so no AID card name or frontier key exists; add title:.' },
  STORY_CARD_ENTRY_UNKNOWN_SECTION:{ id: 'CL0624', severity: WARN, summary: "A render.storyCards entry names an undeclared section, so that selection is dropped; correct sections: or declare the section." },
  STORY_CARD_ENTRY_RENDERS_NOTHING:{ id: 'CL0625', severity: WARN, summary: 'A render.storyCards entry renders no text on a branch, so no card is written there; correct variant:/sections: or add content.' },
  CARD_TYPE_CASE_COLLISION:     { id: 'CL0626', severity: ERROR, summary: 'Two aid.type values differ only by case, so their files collide on a case-insensitive filesystem and one group is overwritten; rename one type.' },
  CARD_TYPE_LEADING_SPACE:      { id: 'CL0628', severity: WARN,  summary: 'An aid.type has leading whitespace, so the compiler trims it before writing; remove the whitespace.' },
  ADVENTURE_DESCRIPTION_ADVANCED:{ id: 'CL0629', severity: ERROR, summary: 'adventureDescription declares advanced: or description: metadata, so unsupported frontmatter would be written; keep those keys on the scenario blurb only.' },
  LEAF_NO_OPENING:              { id: 'CL0630', severity: WARN,  summary: 'A leaf resolves neither opening: nor adventureDescription:, so Velvet Lattice starts it with an empty prompt; add one or inherit it.' },
  LEAF_NO_AIN:                  { id: 'CL0631', severity: WARN,  summary: "A leaf resolves no aiInstructions:, so Velvet Lattice writes an empty string that suppresses AID's default; add or inherit aiInstructions:." },
  CARD_TYPE_INVALID:            { id: 'CL0632', severity: ERROR, summary: 'aid.type is not a legal path segment, so card files cannot be written safely; use a nonempty type without illegal characters, . / .. or trailing space/period.' },
  BRANCH_FRAMING_IGNORED:       { id: 'CL0633', severity: WARN,  summary: 'branchFraming is set where there are no child branches to frame, so it has no effect; remove it or move it to a branching node.' },
  COMPONENT_NO_OUTPUT:          { id: 'CL0634', severity: ERROR, summary: 'A requested component produces no output anywhere, so the compiled scenario is missing that component; provide renderable content or correct its source.' },
  CARD_NO_TRIGGERS:             { id: 'CL0635', severity: WARN,  layer: 'opinion', summary: 'A story card has no triggers, so AID can never pull it into context; add trigger values or use kind: reference.' },

  TRIGGER_CONTAINS_COMMA:       { id: 'CL0701', severity: ERROR, summary: 'A trigger value contains a comma, which Velvet Lattice would split into two triggers.' },
  TRIGGER_EMPTY:                { id: 'CL0702', severity: WARN,  summary: 'A trigger value is empty and will reach AID as an empty key.' },
  OPENING_OVER_LIMIT:           { id: 'CL0710', severity: ERROR, summary: "An Opening.md exceeds AID's 4,000-character limit." },
  OPENING_NEAR_LIMIT:           { id: 'CL0711', severity: WARN,  summary: 'An Opening.md is within 10% of the 4,000-character limit.' },
  CARD_BODY_OVER_LIMIT:         { id: 'CL0712', severity: ERROR, summary: "A story card body exceeds AID's 2,000-character limit." },
  CARD_BODY_NEAR_LIMIT:         { id: 'CL0713', severity: WARN,  summary: 'A story card body is within 10% of the 2,000-character limit.' },
  NOTES_OVER_LIMIT:             { id: 'CL0714', severity: ERROR, summary: "An item's notes: exceeds AID's 10,000-character description limit." },
  NOTES_NEAR_LIMIT:             { id: 'CL0715', severity: WARN,  summary: "An item's notes: is within 10% of the 10,000-character limit." },
});

const CODES = Object.freeze(
  Object.fromEntries(Object.entries(REGISTRY).map(([name, entry]) => [name, entry.id]))
);

const SEVERITY_BY_ID = Object.freeze(
  Object.fromEntries(Object.values(REGISTRY).map((entry) => [entry.id, entry.severity]))
);

function severityOf(code) {
  const severity = SEVERITY_BY_ID[code];
  if (severity === undefined) {
    throw new Error(`severityOf: unknown diagnostic code "${code}" — every code must be declared in REGISTRY.`);
  }
  return severity;
}


const OPINION_IDS = Object.freeze(new Set(
  Object.values(REGISTRY).filter((e) => e.layer === 'opinion').map((e) => e.id)
));

function isOpinion(code) {
  if (typeof code !== 'string') return false;
  return OPINION_IDS.has(code) || code.startsWith('CL-');
}

const LINT_LEVELS = Object.freeze(['off', 'error', 'warn']);

const SEVERITY_RANK = Object.freeze({ [SEVERITY.INFO]: 0, [SEVERITY.WARN]: 1, [SEVERITY.ERROR]: 2 });

function applyLintLevel(severity, level) {
  if (!level) return severity;
  if (level === 'off') return null;
  const ceiling = level === 'error' ? SEVERITY.ERROR : SEVERITY.WARN;
  const clamped = SEVERITY_RANK[severity] <= SEVERITY_RANK[ceiling] ? severity : ceiling;
  return SEVERITY_RANK[clamped] < SEVERITY_RANK[ceiling] ? null : clamped;
}

function busWarner(diagnostics, loc) {
  return (code, message) => diagnostics.add(severityOf(code), code, message, loc || {});
}

class Diagnostic {
  constructor({ code, severity, message, file, line, col, hint, branch }) {
    this.code = code;
    this.severity = severity;
    this.message = message;
    this.file = file || null;
    this.line = typeof line === 'number' ? line : null;
    this.col = typeof col === 'number' ? col : null;
    this.hint = hint || null;
    this.branch = branch || null;
  }

  get location() {
    if (!this.file) return '';
    if (this.line === null) return this.file;
    if (this.col === null) return `${this.file}:${this.line}`;
    return `${this.file}:${this.line}:${this.col}`;
  }

  format() {
    const head = [
      SEVERITY_LABEL[this.severity] || this.severity, this.code, this.location,
      this.branch ? `(branch ${this.branch})` : '',
    ].filter(Boolean).join(' ');
    const indent = (text) => String(text).split('\n').map((l) => `  ${l}`).join('\n');
    const parts = [head, indent(this.message)];
    if (this.hint) parts.push(indent(this.hint));
    return parts.join('\n');
  }

  toString() {
    return this.format();
  }
}

class Diagnostics {
  constructor(options = {}) {
    this._items = [];
    this._lintLevel = options.lintLevel || null;
  }

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
      branch: loc.branch,
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
