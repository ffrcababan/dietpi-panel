'use client';

import React, { useState } from 'react';
import {
  IconCheck,
  IconCopy,
  IconDownload,
  IconPlay,
  IconTerminal,
  IconTrash,
} from '@/components/Icons';
import { StatusBadge } from '@/components/StatusBadge';
import {
  downloadRowsAsCsv,
  downloadRowsAsJson,
} from '@/components/databases/exportUtils';
import type {
  DbCellValue,
  DbScriptResponse,
} from '@/app/api/databases/[name]/manage/route';

export function formatDbCellDisplay(val: DbCellValue): {
  text: string;
  isNull?: boolean;
  isBlob?: boolean;
} {
  if (val === null || val === undefined) {
    return { text: 'NULL', isNull: true };
  }
  if (typeof val === 'object' && '__blob' in val) {
    return { text: `[BLOB ${val.bytes} B]`, isBlob: true };
  }
  return { text: String(val) };
}

export const DatabaseSqlTab = React.memo(function DatabaseSqlTab({
  selectedTable,
  sqlText,
  useTransaction,
  busy,
  scriptError,
  scriptResult,
  history,
  onChangeSql,
  onChangeUseTransaction,
  onClearHistory,
  onExecute,
}: {
  selectedTable: string;
  sqlText: string;
  useTransaction: boolean;
  busy: boolean;
  scriptError: string | null;
  scriptResult: DbScriptResponse | null;
  history: string[];
  onChangeSql: (val: string) => void;
  onChangeUseTransaction: (val: boolean) => void;
  onClearHistory: () => void;
  onExecute: () => void;
}) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const quoteT = selectedTable ? `"${selectedTable.replace(/"/g, '""')}"` : '"my_table"';

  const snippets = [
    {
      label: 'SELECT *',
      sql: `SELECT * FROM ${quoteT} LIMIT 50;`,
    },
    {
      label: 'COUNT(*)',
      sql: `SELECT COUNT(*) AS total_rows FROM ${quoteT};`,
    },
    {
      label: 'CREATE TABLE',
      sql: `CREATE TABLE items (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT NOT NULL,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);`,
    },
    {
      label: 'ADD INDEX',
      sql: selectedTable
        ? `CREATE INDEX idx_${selectedTable}_col ON ${quoteT} ("column_name");`
        : `CREATE INDEX idx_items_name ON "items" ("name");`,
    },
    {
      label: 'PRAGMA Info',
      sql: selectedTable
        ? `PRAGMA table_info(${quoteT});\nPRAGMA index_list(${quoteT});`
        : `SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name;`,
    },
  ];

  const handleCopyJson = async (
    stmtIdx: number,
    cols: string[],
    rows: DbCellValue[][]
  ) => {
    const objs = rows.map((r) => {
      const rec: Record<string, DbCellValue> = {};
      cols.forEach((c, ci) => {
        rec[c] = r[ci] ?? null;
      });
      return rec;
    });
    try {
      await navigator.clipboard.writeText(JSON.stringify(objs, null, 2));
      setCopiedIdx(stmtIdx);
      window.setTimeout(() => setCopiedIdx(null), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-borderline bg-surface p-5 space-y-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/15 border border-sky-500/30 text-sky-400">
              <IconTerminal className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-slate-100">
                SQL Script Workbench
              </h2>
              <p className="text-xs text-slate-400">
                Multi-statement PDO SQLite runner ·{' '}
                <kbd className="rounded border border-borderline bg-canvas px-1 text-[10px]">Ctrl</kbd>+
                <kbd className="rounded border border-borderline bg-canvas px-1 text-[10px]">Enter</kbd> to run
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {snippets.map((snip) => (
              <button
                key={snip.label}
                type="button"
                disabled={busy}
                onClick={() => onChangeSql(snip.sql)}
                className="rounded-lg border border-borderline bg-canvas px-2.5 py-1 text-[11px] font-mono text-slate-300 hover:border-accent/50 hover:text-slate-100 disabled:opacity-50 transition"
              >
                {snip.label}
              </button>
            ))}
          </div>
        </div>

        <textarea
          rows={9}
          spellCheck={false}
          disabled={busy}
          value={sqlText}
          onChange={(e) => onChangeSql(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              if (!busy && sqlText.trim()) onExecute();
            }
          }}
          placeholder="Write one or more SQLite SQL statements separated by semicolons..."
          className="w-full rounded-xl border border-borderline bg-[#080b10] p-3.5 font-mono text-xs leading-relaxed text-slate-100 placeholder-slate-600 focus:border-accent focus:outline-none"
        />

        {history.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <span className="text-[11px] text-slate-500 mr-1">Recent:</span>
            {history.map((item, hIdx) => (
              <button
                key={hIdx}
                type="button"
                disabled={busy}
                onClick={() => onChangeSql(item)}
                title={item}
                className="max-w-[200px] truncate rounded-md border border-borderline/80 bg-canvas/80 px-2 py-0.5 font-mono text-[10px] text-slate-400 hover:border-slate-500 hover:text-slate-200 transition"
              >
                {item.replace(/\s+/g, ' ')}
              </button>
            ))}
            <button
              type="button"
              onClick={onClearHistory}
              className="ml-auto inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-rose-300 transition"
            >
              <IconTrash className="w-3 h-3" />
              <span>Clear history</span>
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-borderline/70 pt-3">
          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              disabled={busy}
              checked={useTransaction}
              onChange={(e) => onChangeUseTransaction(e.target.checked)}
              className="rounded border-borderline bg-canvas text-accent"
            />
            <span>Run inside transaction (auto-rollback all changes if any statement fails)</span>
          </label>

          <div className="flex items-center gap-2">
            {sqlText.trim() && (
              <button
                type="button"
                disabled={busy}
                onClick={() => onChangeSql('')}
                className="rounded-lg border border-borderline bg-elevated px-3 py-2 text-xs text-slate-300 hover:text-white disabled:opacity-50 transition"
              >
                Clear
              </button>
            )}
            <button
              type="button"
              disabled={busy || !sqlText.trim()}
              onClick={onExecute}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50 transition"
            >
              <IconPlay className="w-3.5 h-3.5" />
              <span>{busy ? 'Executing...' : 'Execute Script'}</span>
            </button>
          </div>
        </div>
      </section>

      {scriptError && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 font-mono text-xs text-rose-200 whitespace-pre-wrap break-words">
          {scriptError}
        </div>
      )}

      {scriptResult && !scriptResult.requiresConfirmation && (
        <div className="space-y-4">
          {scriptResult.results.map((stmt) => (
            <section
              key={stmt.index}
              className="rounded-xl border border-borderline bg-surface overflow-hidden shadow-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-borderline bg-canvas/60 px-4 py-2.5">
                <div className="min-w-0 flex items-center gap-2">
                  <StatusBadge
                    tone={stmt.kind === 'rows' ? 'blue' : 'green'}
                    label={`#${stmt.index} ${
                      stmt.kind === 'rows'
                        ? `${stmt.rowCount ?? 0} row(s)`
                        : `${stmt.changes ?? 0} affected`
                    }`}
                  />
                  <code className="truncate font-mono text-[11px] text-slate-300 max-w-xl">
                    {stmt.sql.replace(/\s+/g, ' ')}
                  </code>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {stmt.kind === 'rows' &&
                    stmt.columns &&
                    (stmt.rows ?? []).length > 0 && (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            handleCopyJson(
                              stmt.index,
                              stmt.columns ?? [],
                              stmt.rows ?? []
                            )
                          }
                          className="inline-flex items-center gap-1 rounded-md border border-borderline bg-elevated px-2 py-0.5 text-[11px] text-slate-200 hover:border-slate-500 transition"
                        >
                          {copiedIdx === stmt.index ? (
                            <>
                              <IconCheck className="w-3 h-3 text-emerald-400" />
                              <span>Copied</span>
                            </>
                          ) : (
                            <>
                              <IconCopy className="w-3 h-3" />
                              <span>JSON</span>
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            downloadRowsAsCsv(
                              `query-${stmt.index}`,
                              stmt.columns ?? [],
                              stmt.rows ?? []
                            )
                          }
                          className="inline-flex items-center gap-1 rounded-md border border-borderline bg-elevated px-2 py-0.5 text-[11px] text-slate-200 hover:border-slate-500 transition"
                        >
                          <IconDownload className="w-3 h-3" />
                          <span>CSV</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const cols = stmt.columns ?? [];
                            const objs = (stmt.rows ?? []).map((r) => {
                              const rec: Record<string, DbCellValue> = {};
                              cols.forEach((c, ci) => {
                                rec[c] = r[ci] ?? null;
                              });
                              return rec;
                            });
                            downloadRowsAsJson(`query-${stmt.index}`, objs);
                          }}
                          className="inline-flex items-center gap-1 rounded-md border border-borderline bg-elevated px-2 py-0.5 text-[11px] text-slate-200 hover:border-slate-500 transition"
                        >
                          <IconDownload className="w-3 h-3" />
                          <span>.json</span>
                        </button>
                      </>
                    )}
                  <span className="font-mono text-[11px] text-slate-500">
                    {stmt.durationMs} ms
                  </span>
                </div>
              </div>

              {stmt.kind === 'rows' && stmt.columns && (
                <>
                  {stmt.truncated && (
                    <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-[11px] text-amber-200">
                      Showing first 500 rows returned by this statement.
                    </div>
                  )}
                  <div className="overflow-x-auto max-h-[38vh]">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-borderline bg-canvas/40 font-mono text-[11px] text-slate-400 sticky top-0">
                        <tr>
                          {stmt.columns.map((c, ci) => (
                            <th
                              key={`${c}-${ci}`}
                              className="px-3.5 py-2 font-medium whitespace-nowrap"
                            >
                              {c}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-borderline font-mono">
                        {(stmt.rows ?? []).length === 0 ? (
                          <tr>
                            <td
                              colSpan={Math.max(1, stmt.columns.length)}
                              className="px-4 py-5 text-center text-slate-500"
                            >
                              Query returned 0 rows.
                            </td>
                          </tr>
                        ) : (
                          (stmt.rows ?? []).map((row, ri) => (
                            <tr key={ri} className="hover:bg-elevated/30">
                              {row.map((cell, ci) => {
                                const disp = formatDbCellDisplay(cell);
                                return (
                                  <td
                                    key={ci}
                                    className={`px-3.5 py-2 max-w-[260px] truncate ${
                                      disp.isNull
                                        ? 'italic text-slate-500'
                                        : disp.isBlob
                                          ? 'text-purple-300'
                                          : 'text-slate-200'
                                    }`}
                                    title={disp.text}
                                  >
                                    {disp.text}
                                  </td>
                                );
                              })}
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
});
