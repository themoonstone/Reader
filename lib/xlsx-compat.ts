import JSZip from "jszip";
import { posix } from "node:path";
/** ExcelJS expects unprefixed spreadsheet elements. Normalize valid prefixed OOXML in memory only. */
export async function normalizeSpreadsheetXml(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  let changed = false;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    if (entry.name.endsWith(".rels")) {
      const rel = await entry.async("string");
      const base = posix.dirname(posix.dirname(entry.name));
      const normalized = rel.replace(
        /Target="(\/[^"]+)"/g,
        (_match, target: string) =>
          `Target="${posix.relative(base === "." ? "" : base, target.slice(1))}"`,
      );
      if (normalized !== rel) {
        zip.file(entry.name, normalized);
        changed = true;
      }
      continue;
    }
    if (!entry.name.endsWith(".xml")) continue;
    let xml = await entry.async("string");
    const prefixes = [
      ...xml.matchAll(
        /xmlns:([A-Za-z_][\w.-]*)=["']http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main["']/g,
      ),
    ];
    if (!prefixes.length) continue;
    for (const [, prefix] of prefixes) {
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (/xmlns=["']/.test(xml)) continue; // Avoid changing documents with another default namespace.
      xml = xml
        .replace(new RegExp(`xmlns:${escaped}=`, "g"), "xmlns=")
        .replace(new RegExp(`(<\\/?)${escaped}:`, "g"), "$1");
    }
    zip.file(entry.name, xml);
    changed = true;
  }
  return changed
    ? zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
    : buffer;
}
