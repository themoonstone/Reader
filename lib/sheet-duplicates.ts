import { normalize } from "./contracts";
import { hashValue } from "./change-preview";
import { AppError } from "./store";
import type { FileDuplicate, ImportRow } from "./import-contracts";

export function foldSheetRows(rows: ImportRow[], book: string) {
  const contacts = new Map<
    string,
    { row: ImportRow; content: string; duplicate?: FileDuplicate }
  >();
  const unique: ImportRow[] = [],
    duplicates: FileDuplicate[] = [];
  for (const row of rows) {
    const d = row.data,
      meta = d.importMetadata!;
    const contact = hashValue([
      meta.profile,
      normalize(book),
      normalize(d.term),
      d.meaning,
      d.sentence,
      d.chapter,
      d.page,
    ]);
    const {
      rowKey: _key,
      fileName: _file,
      sheet: _sheet,
      row: _row,
      priorityConflict: _conflict,
      ...fields
    } = meta;
    void [_key, _file, _sheet, _row, _conflict];
    const content = hashValue({
      ...d,
      term: normalize(d.term),
      importMetadata: fields,
    });
    const existing = contacts.get(contact);
    if (!existing) {
      contacts.set(contact, { row, content });
      unique.push(row);
      continue;
    }
    if (existing.content !== content)
      throw new AppError(
        `${row.sheet} 第 ${row.row} 行与 ${existing.row.sheet} 第 ${existing.row.row} 行为相同接触但内容冲突，请修正表格或调整所选页`,
      );
    if (!existing.duplicate) {
      existing.duplicate = {
        kept: { sheet: existing.row.sheet, row: existing.row.row },
        skipped: [],
      };
      duplicates.push(existing.duplicate);
    }
    existing.duplicate.skipped.push({ sheet: row.sheet, row: row.row });
  }
  return { rows: unique, duplicates };
}
