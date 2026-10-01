// Minimal ZIP reader (stored and deflated entries), so ingest needs no npm dependency for zipped
// open-data exports. Reads the central directory, which carries reliable sizes even when the local
// headers use data descriptors.

import zlib from "node:zlib";

const MAX_ENTRY_BYTES = Number(process.env.UNZIP_MAX_ENTRY_MB || 512) * 1024 * 1024;

export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    // An entry we can't decode is an error, not a missing file: silently skipping it made a day's
    // export look empty. The output cap guards against a corrupt or hostile size.
    if (method !== 0 && method !== 8) throw new Error(`zip entry ${name} uses unsupported compression method ${method}`);
    const data = method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
    files.push({ name, data });
  }
  return files;
}
