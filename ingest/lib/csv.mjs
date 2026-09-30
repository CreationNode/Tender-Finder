// Streaming CSV reader.
//
// The SAM bulk extract is large (hundreds of MB in some months). Reading it into memory would blow
// up a CI runner, so this consumes the HTTP stream and yields one row object at a time. It handles
// quoted fields containing commas and embedded newlines, which government CSVs are full of.

export async function* streamCsvRows(response, { delimiter = "," } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");

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
    buffer = decoder.decode(value, { stream: true });
    consume(buffer);
    while (emit.length) {
      const cells = emit.shift();
      if (!header) { header = cells.map((h) => h.trim()); continue; }
      if (cells.length === 1 && cells[0] === "") continue;   // blank line
      yield rowToObject(header, cells);
    }
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
