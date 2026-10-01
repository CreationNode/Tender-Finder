// Streaming CSV reader.
//
// The SAM bulk extract is large (hundreds of MB in some months). Reading it into memory would blow
// up a CI runner, so this consumes the HTTP stream and yields one row object at a time. It handles
// quoted fields containing commas and embedded newlines, which government CSVs are full of.

export async function* streamCsvRows(response, { delimiter = "," } = {}) {
  const reader = response.body.getReader();
  // SAM's extract has been published as Windows-1252, not UTF-8, so a plain UTF-8 decode turned every
  // accented buyer name and curly quote into U+FFFD. Decode strictly as UTF-8 and, at the first
  // invalid byte, switch to Windows-1252 for the rest of the file (re-decoding that chunk). A valid
  // UTF-8 file never trips the switch.
  let decoder = new TextDecoder("utf-8", { fatal: true });
  let fallback = false;
  const decode = (value, stream) => {
    if (fallback) return decoder.decode(value, { stream });
    try { return decoder.decode(value, { stream }); }
    catch {
      fallback = true;
      decoder = new TextDecoder("windows-1252");
      return decoder.decode(value, { stream });
    }
  };

  let buffer = "";
  let header = null;
  let field = "";
  let row = [];
  let inQuotes = false;
  let pendingQuote = false;

  const finishField = () => { row.push(field); field = ""; };
  const finishRow = () => {
    finishField();
    const cells = row;
    row = [];
    return cells;
  };

  const emit = [];

  const consume = (chunk) => {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (pendingQuote) {
        pendingQuote = false;
        if (ch === '"') { field += '"'; continue; }   // escaped ""
        inQuotes = false;
        // fall through to handle ch normally
      }
      if (inQuotes) {
        if (ch === '"') { pendingQuote = true; continue; }
        field += ch;
        continue;
      }
      if (ch === '"') { inQuotes = true; continue; }
      if (ch === delimiter) { finishField(); continue; }
      if (ch === "\n") { emit.push(finishRow()); continue; }
      if (ch === "\r") continue;
      field += ch;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer = decode(value, true);
    consume(buffer);
    while (emit.length) {
      const cells = emit.shift();
      if (!header) { header = cells.map((h) => h.trim()); continue; }
      if (cells.length === 1 && cells[0] === "") continue;   // blank line
      yield rowToObject(header, cells);
    }
  }

  consume(decode(undefined, false));   // bytes a multi-byte character left in the decoder
  for (const cells of emit.splice(0)) {
    if (!header) { header = cells.map((h) => h.trim()); continue; }
    if (cells.length === 1 && cells[0] === "") continue;
    yield rowToObject(header, cells);
  }
  // flush the final line if the file does not end with a newline
  if (field.length || row.length) {
    const cells = finishRow();
    if (header && !(cells.length === 1 && cells[0] === "")) yield rowToObject(header, cells);
  }
}

function rowToObject(header, cells) {
  const obj = {};
  for (let i = 0; i < header.length; i++) obj[header[i]] = cells[i] ?? "";
  return obj;
}
