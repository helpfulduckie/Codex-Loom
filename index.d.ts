/** Authored YAML values and resolved metadata that survive JSON serialization. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type FieldPath = string[];
export type Severity = 'error' | 'warn' | 'info';
export interface SnapshotDiagnostic {
  code: string; severity: Severity; message: string;
  file: string | null; line: number | null; col: number | null;
}
export interface Diagnostic extends SnapshotDiagnostic {
  hint: string | null; branch: string | null; branches: string[] | null;
  allBranches: boolean; related: { label: string; file: string | null; line: number | null; col: number | null }[];
}
export type SourceOverrides = Record<string, string> | Map<string, string>;
export interface PreviewOptions {
  sources?: SourceOverrides; live?: boolean; tolerant?: boolean; lintLevel?: string;
}
export interface CompileOptions extends PreviewOptions {
  diff?: boolean; annotate?: boolean; variance?: boolean; inventory?: boolean; usage?: boolean; schemaTables?: boolean;
  log?: { info(message: string): void; verbose(message: string): void };
  diagnostics?: { merge(diagnostics: unknown): void };
}
export interface Location {
  file: number; line: number | null; col: number | null; library: string | null;
}
export interface Origin extends Location { authoredPath: FieldPath | null }
export interface FieldLayer {
  kind: string; name: string | null; library: string | null; op: JsonValue;
  file: number | null; line: number | null; col: number | null;
  before: JsonValue; beforeAbsent: boolean; beforeOrigin: Origin | null;
  after: JsonValue; deleted: boolean;
}
export interface Field { path: FieldPath; value: JsonValue; origin: Origin | null; layers: FieldLayer[] }
export interface RemovedField { path: FieldPath; layers: FieldLayer[] }
export interface Uses { variables: string[]; roles: string[] }
export interface PreviewItem {
  id: string | null; source: number | null; definition: Location | null; importedAt: Location | null;
  included: boolean; uses: Uses | null; fields: Field[]; removedFields: RemovedField[];
}
export interface Card { type: string; name: string; rendered: string; itemId: string | null }
export interface Output { path: string; branchPath: string[] }
export interface SectionSetting {
  path: FieldPath; value: JsonValue; origin: Location | null; layers: FieldLayer[];
}
export interface Occupant { id: string; order: number; template: string | null; text: string }
export interface Section {
  name: string; slot: boolean; state: 'gated' | 'empty' | 'rendered'; position: number;
  variants: string[]; source: Location | null; settings: SectionSetting[];
  occupants: Occupant[]; uses: Uses | null; text: string | null;
}
export interface BindingLayer {
  branchPath: string[]; removed: boolean; before: JsonValue; after: JsonValue; at: Location | null;
}
export interface Binding {
  name: string; bound: boolean; value: JsonValue; resolved: JsonValue;
  layers: BindingLayer[]; derived?: boolean;
}
export interface Component {
  selectedAt: Location | null; selectedOn: string[]; output: number | null;
  sections: number[] | null; uses: Uses | null; pathVariables: string[];
  text: string; segments: { key: string; text: string }[];
  source: { file: number | null; line: number | null; col: number | null } | null;
  inline: boolean; metadata: JsonValue;
}
export interface SlotInventory {
  label: string; branchPath: string[];
  components: { key: string; label: string; passthrough: boolean;
    slots: { name: string; heading: string | null; gated: boolean;
      occupants: { id: string; order: number }[] }[] }[];
}
export interface Leaf {
  label: string; branchPath: string[]; folderPath: string[]; roles: Record<string, string>;
  context: { variables: number[]; roles: number[] }; items: number[];
  excluded: { id: string | null; source: number | null; reason: 'branches' | 'variant'; variant: string | null; at: Location | null }[];
  cards: number[]; cardFiles: number[]; components: Record<string, Component>; slots: SlotInventory | null;
}
export interface Branch { name: string; branchPath: string[]; leaf: boolean; children: Branch[] }
export interface LibraryItem { id: string; name: string | null; line: number | null; col: number | null; imported: boolean; digest: string }
export interface Library {
  name: string; path: string; sourcePath: string; frozen: boolean;
  files: { file: number; items: LibraryItem[] }[];
}
export interface InputRoot { kind: 'library' | 'template'; name: string; path: string; sourcePath: string; frozen: boolean }
export interface Project {
  config: string; title: string | null; base: string; items: string[]; templates: string[];
  inputRoots: InputRoot[]; output: string; reports: string | null; snapshot: string | null;
}
export interface TextFile { path: string; content: string; binary?: false }
export interface BinaryFile { path: string; binary: true; bytes: number; digest: `sha256:${string}` }
export type PreviewFile = TextFile | BinaryFile;
export interface PreviewData {
  droppedKeys: number; diagnostics: Diagnostic[]; sourceFiles: string[]; items: PreviewItem[];
  cards: Card[]; sections: Section[]; bindings: Binding[]; outputs: Output[];
  branches: Branch[]; libraries: Library[]; leaves: Leaf[]; files: PreviewFile[];
}
/** An ok preview may contain compile diagnostics with severity error. */
export interface OkPreview extends PreviewData { status: 'ok'; project: Project }
export interface BlockedPreview extends PreviewData { status: 'blocked'; project: null }
export type PreviewResult = OkPreview | BlockedPreview;
export type Change = 'added' | 'removed' | 'changed';
export type LeafPair = [string, string];
export interface ItemChange { id: string; change: Change; fields: FieldPath[]; output: boolean }
export interface LeafComparison {
  a: string; b: string; items: ItemChange[];
  cards: { name: string; type: string; itemId: string | null; change: Change }[];
  components: { key: string; change: Change; sections: { name: string; change: Change }[] }[];
}
export interface PreviewComparison {
  status: 'ok' | 'blocked'; leaves: LeafComparison[]; unpaired: { a: string[]; b: string[] };
  items: { id: string; outputLeaves: LeafPair[]; fieldLeaves: LeafPair[] }[];
  libraries: { library: string; id: string; change: Change; fileA: string | null;
    fileB: string | null; imported: boolean; compiledAs: string[]; reachesOutput: boolean }[];
  files: { changed: string[]; added: string[]; removed: string[] };
}
export interface FreezeEntry { name: string; kind: 'library' | 'template' | 'leftover'; isNew: boolean; added: string[]; removed: string[]; changed: string[] }
export interface FreezeData { diagnostics: SnapshotDiagnostic[]; filesWritten: number; removedFolders: string[]; entries: FreezeEntry[] }
export interface OkFreeze extends FreezeData { status: 'ok'; reason: null; snapshot: string; manifest: string }
export interface BlockedFreeze extends FreezeData { status: 'blocked'; reason: string; snapshot: null; manifest: null }
export type FreezeResult = OkFreeze | BlockedFreeze;
export interface SnapshotInspectionEntry extends FreezeEntry {
  sourcePath: string | null; snapshotPath: string; live: Record<string, string>; frozen: Record<string, string>;
}
export interface SnapshotInspectionData {
  diagnostics: SnapshotDiagnostic[]; config: string; hasChanges: boolean; manifestChanged: boolean;
  entries: SnapshotInspectionEntry[];
}
export interface OkSnapshotInspection extends SnapshotInspectionData {
  status: 'ok'; reason: null; snapshot: string; manifest: string; fingerprint: string;
}
export interface BlockedSnapshotInspection extends SnapshotInspectionData {
  status: 'blocked'; reason: string; snapshot: null; manifest: null; fingerprint: null;
}
export type SnapshotInspection = OkSnapshotInspection | BlockedSnapshotInspection;
export function compile(configPath: string, options?: CompileOptions): void;
export function preview(configPath: string, options?: PreviewOptions): PreviewResult;
export function comparePreviews(a: PreviewResult, b: PreviewResult, options?: { pairs?: LeafPair[] }): PreviewComparison;
export function preparse(text: string): string;
export function inspectSnapshot(configPath: string): SnapshotInspection;
export function freezeLibraries(configPath: string, options?: { expectedState?: string }): FreezeResult;
