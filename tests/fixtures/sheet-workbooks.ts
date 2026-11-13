import ExcelJS from "exceljs";
import { standardHeaders } from "../../lib/standard-import";
export const standardRow = (
  term = "carve out",
  chapter = "Chapter 8",
  book = "Sheet Test Book",
) => [
  term,
  "腾出时间",
  book,
  chapter,
  "12",
  `We ${term} time.`,
  term,
  1,
  "已核对完整句",
  "P1",
  "",
  "",
  "",
  "",
  "",
];
export async function workbookFile(edit?: (w: ExcelJS.Workbook) => void) {
  const w = new ExcelJS.Workbook();
  w.addWorksheet("Chapter 8").addRows([standardHeaders, standardRow()]);
  w.addWorksheet("Chapter 9").addRows([
    standardHeaders,
    standardRow("make room", "Chapter 9"),
  ]);
  w.addWorksheet("填写说明").addRow(["说明"]);
  edit?.(w);
  return Buffer.from(await w.xlsx.writeBuffer());
}
