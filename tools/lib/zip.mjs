// Minimal ZIP reader — enough to pull text entries out of the official CPV archive.
//
// Node has no built-in unzip, and adding a dependency to a repo that otherwise has zero of them is
// a poor trade for one file. ZIP's central directory is simple: find the End Of Central Directory
// record, walk the entries, inflate the ones we want. Only the two compression methods that occur
// in practice are supported (stored and deflate).

import zlib from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

export function listZipEntries(buf) {
  // The EOCD sits at the end, after an optional comment, so scan backwards for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a ZIP file (no end-of-central-directory record found).");

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== CEN_SIG) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function readZipEntry(buf, entry) {
  // The local header repeats the name/extra lengths; data starts after them.
  const lo = entry.localOffset;
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  // Method 9 is Deflate64 (enhanced deflate). Node's zlib cannot decompress it, and nothing here
  // changes that — but Windows and 7-Zip both can, so say exactly what to do instead of failing
  // with a stack trace.
  if (entry.method === 9) {
    throw new Error(
      `"${entry.name}" is compressed with Deflate64, which Node cannot decompress.\n` +
      `  Extract the archive first, then point this script at the file inside it:\n\n` +
      `    Expand-Archive -Path "<the .zip>" -DestinationPath "<a new folder>"\n` +
      `    node tools/build-cpv-list.mjs "<a new folder>\\${entry.name}"\n\n` +
      `  (7-Zip, or right-click > Extract All, work equally well.)`
    );
  }
  throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
}
