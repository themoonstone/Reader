import type { DraftInput } from "./contracts";
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
};
