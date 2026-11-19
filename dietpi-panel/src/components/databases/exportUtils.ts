import type { DbCellValue } from '@/app/api/databases/[name]/manage/route';

export function formatRawCellText(val: DbCellValue): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object' && '__blob' in val) {
    return `[BLOB ${val.bytes} B base64:${val.base64}]`;
  }
  return String(val);
}

function escapeCsvField(raw: string): string {
  // RFC-4180 CSV quoting when values contain commas, quotes, or newlines
  const needsQuote = /[",\r\n]/.test(raw);
  const escaped = raw.replace(/"/g, '""');
  return needsQuote ? `"${escaped}"` : escaped;
}

export function triggerTextDownload(
  filename: string,
  content: string,
  mimeType: string
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadRowsAsCsv(
  baseName: string,
  columns: string[],
  matrix: DbCellValue[][]
): void {
  const header = columns.map((c) => escapeCsvField(c)).join(',');
  const lines = matrix.map((row) =>
    row
      .map((cell) => {
        if (cell === null || cell === undefined) return '';
        if (typeof cell === 'object' && '__blob' in cell) {
          return escapeCsvField(`[BLOB ${cell.bytes} B]`);
        }
        return escapeCsvField(String(cell));
      })
      .join(',')
  );
  const safeName = baseName.replace(/[^a-zA-Z0-9._-]+/g, '_');
  triggerTextDownload(`${safeName}.csv`, `${[header, ...lines].join('\n')}\n`, 'text/csv;charset=utf-8');
}

export function downloadRowsAsJson(
  baseName: string,
  objects: Record<string, DbCellValue>[]
): void {
  const safeName = baseName.replace(/[^a-zA-Z0-9._-]+/g, '_');
  triggerTextDownload(
    `${safeName}.json`,
    `${JSON.stringify(objects, null, 2)}\n`,
    'application/json;charset=utf-8'
  );
}

export function tryFormatPrettyJson(val: DbCellValue): string | null {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  if (
    (!trimmed.startsWith('{') || !trimmed.endsWith('}')) &&
    (!trimmed.startsWith('[') || !trimmed.endsWith(']'))
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}
