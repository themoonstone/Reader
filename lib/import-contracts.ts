import type { DraftInput } from "./contracts";
export type ImportPriority = "P1" | "P2" | "P3";
export type ImportRow = {
  key: string;
  sheet: string;
  row: number;
  data: DraftInput;
  warnings: string[];
};
export type ImportGroup = {
  key: string;
  term: string;
  meaning: string;
  rows: ImportRow[];
  candidates: {
    id: string;
    meaning: string;
    priority: string;
    lifecycle: string;
  }[];
};
export type ImportPreview = {
  selection?: ImportScope;
  fileDuplicates?: FileDuplicate[];
  profile: "bebe-strict-v1" | "little-farm-v1" | "phrasebud-v1";
  formatLabel: string;
  suggestedTitle: string;
  token: string;
  fileName: string;
  totalRows: number;
  counts: Record<string, number>;
  skippedSheets: string[];
  detailSheets: number;
  groups: ImportGroup[];
  excludedRows: number;
  warnings: string[];
};
export type ImportChoice = {
  groupKey: string;
  action: "new" | "split" | "existing" | "skip";
  expressionId?: string;
};
export type ImportResult = {
  sourceId: string;
  createdExpressions: number;
  importedContexts: number;
  skippedContexts: number;
  updatedContexts?: number;
  retainedChanges?: number;
  snapshot?: string;
  fileDuplicateContexts?: number;
  skippedGroupContexts?: number;
};

export type ImportDiffRow = {
  key: string;
  term: string;
  selected: boolean;
  status: "new" | "duplicate" | "changed" | "protected" | "ambiguous";
  reason: string;
  contextId?: string;
  fields: { field: string; before: string; after: string }[];
};
export type ImportDiff = {
  token: string;
  sourceId?: string;
  rows: ImportDiffRow[];
  counts: Record<ImportDiffRow["status"], number>;
};

export type ImportProfile = ImportPreview["profile"];
export type SheetInfo = {
  sheetId: string;
  name: string;
  order: number;
  state: "visible" | "hidden" | "veryHidden";
  role: "data" | "auxiliary" | "empty" | "unsupported";
  profile: ImportProfile | null;
  estimatedRows: number | null;
  headerIssues: string[];
  reason: string;
};
export type WorkbookInspection = {
  version: 1;
  fileHash: string;
  fileName: string;
  sheets: SheetInfo[];
  inspectionToken: string;
};
export type SheetSelection = {
  mode: "selected-sheets-v1";
  inspectionToken: string;
  selectedSheetIds: string[];
  priorities?: ImportPriority[];
};
export type ImportScope = {
  version: 2;
  mode: "selected-sheets-v1";
  generation: string;
  fileHash: string;
  selectedSheets: { sheetId: string; name: string }[];
  book: string;
  fileDuplicateCount: number;
  priorities?: ImportPriority[];
};
export type FileDuplicate = {
  kept: { sheet: string; row: number };
  skipped: { sheet: string; row: number }[];
};
