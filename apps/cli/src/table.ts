// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal aligned-text table renderer. No external dependency: every column is
// padded to the width of its longest cell, columns separated by two spaces.

export function renderTable(headers: readonly string[], rows: readonly string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, i) => (i === cells.length - 1 ? (cell ?? "") : (cell ?? "").padEnd(widths[i] ?? 0))).join("  ");
  const out = [line(headers)];
  if (rows.length === 0) {
    out.push(`(no rows)`);
    return out.join("\n");
  }
  for (const row of rows) out.push(line(row));
  return out.join("\n");
}
