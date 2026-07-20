// Minimal, dependency-free CSV helpers (RFC4180-ish: handles quoted fields,
// escaped quotes ("") and commas/newlines inside quotes). Deliberately not
// pulling in a package like `csv-parse` for this — the format needed here
// (flat rows of strings) doesn't need anything heavier.

/** Parses CSV text into an array of row objects keyed by the header row. */
export function parseCsv(text) {
  const rows = tokenizeCsv(text);
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows
    .slice(1)
    .filter((row) => row.some((cell) => cell !== "")) // skip blank trailing lines
    .map((row) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = row[i] !== undefined ? row[i] : "";
      });
      return obj;
    });
}

function tokenizeCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  // Flush trailing field/row (files without a final newline)
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function escapeCsvField(value) {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Serializes an array of objects into CSV text using the given column list. */
export function toCsv(columns, rows) {
  const headerLine = columns.map((c) => escapeCsvField(c.label ?? c.key)).join(",");
  const lines = rows.map((row) =>
    columns.map((c) => escapeCsvField(typeof c.key === "function" ? c.key(row) : row[c.key])).join(",")
  );
  return [headerLine, ...lines].join("\n");
}
