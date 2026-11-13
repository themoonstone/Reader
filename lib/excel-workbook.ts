import ExcelJS from "exceljs";
import { inflateRawSync } from "node:zlib";
import { normalizeSpreadsheetXml } from "./xlsx-compat";
import { AppError } from "./store";
const MAX_FILE = 5 * 1024 * 1024;
// Bound the actual archive expansion before asking the XLSX parser to decompress it.
function checkArchive(buffer: Buffer) {
  if (buffer.length > MAX_FILE)
    throw new AppError("Excel 文件不能超过 5 MB", 413);
  let end = -1;
  for (
    let i = buffer.length - 22;
    i >= Math.max(0, buffer.length - 65557);
    i--
  ) {
    if (
      buffer.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + buffer.readUInt16LE(i + 20) === buffer.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new AppError("文件不是有效的 .xlsx 工作簿");
  const count = buffer.readUInt16LE(end + 10),
    size = buffer.readUInt32LE(end + 12),
    offset = buffer.readUInt32LE(end + 16);
  if (
    buffer.readUInt16LE(end + 4) !== 0 ||
    buffer.readUInt16LE(end + 6) !== 0 ||
    count > 2000 ||
    offset + size > end
  )
    throw new AppError("不支持此 Excel 压缩结构");
  let cursor = offset,
    total = 0;
  for (let n = 0; n < count; n++) {
    if (
      cursor + 46 > offset + size ||
      buffer.readUInt32LE(cursor) !== 0x02014b50
    )
      throw new AppError("Excel 文件目录损坏");
    if (buffer.readUInt16LE(cursor + 8) & 1)
      throw new AppError("不支持加密工作簿");
    total += buffer.readUInt32LE(cursor + 24);
    if (total > 40 * 1024 * 1024)
      throw new AppError("Excel 解压内容超过 40 MB，请缩小文件", 413);
    const compressed = buffer.readUInt32LE(cursor + 20),
      length = buffer.readUInt32LE(cursor + 24),
      local = buffer.readUInt32LE(cursor + 42),
      method = buffer.readUInt16LE(cursor + 10);
    if (local + 30 > offset || buffer.readUInt32LE(local) !== 0x04034b50)
      throw new AppError("Excel 压缩条目无效");
    const start =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    if (start + compressed > offset || ![0, 8].includes(method))
      throw new AppError("Excel 压缩条目不受支持");
    try {
      const raw =
        method === 0
          ? buffer.subarray(start, start + compressed)
          : inflateRawSync(buffer.subarray(start, start + compressed), {
              maxOutputLength: Math.max(1, length),
            });
      if (raw.length !== length) throw Error();
    } catch {
      throw new AppError("Excel 压缩内容大小不一致或已损坏");
    }
    cursor +=
      46 +
      buffer.readUInt16LE(cursor + 28) +
      buffer.readUInt16LE(cursor + 30) +
      buffer.readUInt16LE(cursor + 32);
  }
  if (cursor !== offset + size) throw new AppError("Excel 文件目录无效");
}

export async function loadExcelWorkbook(buffer: Buffer, fileName: string) {
  if (!/\.xlsx$/i.test(fileName) || fileName.length > 250)
    throw new AppError("请选择 .xlsx 文件（不支持 .xls / .xlsm）");
  checkArchive(buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(
      (await normalizeSpreadsheetXml(buffer)) as unknown as ExcelJS.Buffer,
    );
  } catch {
    throw new AppError("无法读取工作簿，请确认文件未加密且格式正确");
  }
  for (const sheet of workbook.worksheets)
    if (sheet.rowCount > 10000 || sheet.columnCount > 100)
      throw new AppError(`${sheet.name}：工作表超出支持范围`);
  return workbook;
}
