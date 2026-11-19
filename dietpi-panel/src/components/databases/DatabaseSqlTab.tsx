'use client';

import React from 'react';
import { IconTerminal } from '@/components/Icons';
import { StatusBadge } from '@/components/StatusBadge';
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
  onChangeSql,
  onChangeUseTransaction,
  onExecute,
}: {
  selectedTable: string;
  sqlText: string;
  useTransaction: boolean;
  busy: boolean;
  scriptError: string | null;
  scriptResult: DbScriptResponse | null;
  onChangeSql: (val: string) => void;
  onChangeUseTransaction: (val: boolean) => void;
  onExecute: () => void;
}) {
  const quoteT = selectedTable ? `"${selectedTable.replace(/"/g, '""')}"` : '"my_table"';
  const snippets = [
    {
      label: 'SELECT rows',
      sql: `SELECT * FROM ${quoteT} LIMIT 50;`,
    },
    {
      label: 'CREATE TABLE',
      sql: `CREATE TABLE items (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT NOT NULL,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);`,
    },
    {
      label: 'ADD COLUMN',
      sql: `ALTER TABLE ${quoteT} ADD COLUMN status TEXT NOT NULL DEFAULT 'active';`,
    },
    {
      label: 'Schema Info',
      sql: selectedTable
        ? `PRAGMA table_info(${quoteT});`
        : `SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%';`,
    },
  ];

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-borderline bg-surface p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <IconTerminal className="w-4 h-4 text-accent" />
            <div>
              <h2 className="text-sm font-semibold text-slate-100">
                SQL Script Executor
              </h2>
              <p className="text-xs text-slate-400">
                Execute multi-statement SQL scripts via PDO SQLite as <span className="font-mono">www-data</span>. Press <kbd className="rounded border border-borderline bg-canvas px-1 text-[10px]">Ctrl</kbd>+<kbd className="rounded border border-borderline bg-canvas px-1 text-[10px]">Enter</kbd> to run.
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
                className="rounded-md border border-borderline bg-canvas px-2.5 py-1 text-[11px] font-mono text-slate-300 hover:border-accent/50 hover:text-slate-100 disabled:opacity-50 transition"
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
          placeholder="Write SQL statements separated by semicolons..."
          className="w-full rounded-lg border border-borderline bg-[#080b10] p-3.5 font-mono text-xs leading-relaxed text-slate-100 placeholder-slate-600 focus:border-accent focus:outline-none"
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
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

          <button
            type="button"
            disabled={busy || !sqlText.trim()}
            onClick={onExecute}
            className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50 transition"
          >
            {busy ? 'Executing...' : 'Execute Script'}
          </button>
        </div>
      </section>

      {scriptError && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 font-mono text-xs text-rose-200 whitespace-pre-wrap">
          {scriptError}
        </div>
      )}

      {scriptResult && !scriptResult.requiresConfirmation && (
        <div className="space-y-4">
          {scriptResult.results.map((stmt) => (
            <section
              key={stmt.index}
              className="rounded-xl border border-borderline bg-surface overflow-hidden"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-borderline bg-canvas/50 px-4 py-2.5">
                <div className="min-w-0 flex items-center gap-2">
                  <StatusBadge
                    tone={stmt.kind === 'rows' ? 'blue' : 'green'}
                    label={`#${stmt.index} ${stmt.kind === 'rows' ? `${stmt.rowCount ?? 0} row(s)` : `${stmt.changes ?? 0} affected`}`}
                  />
                  <code className="truncate font-mono text-[11px] text-slate-300 max-w-xl">
                    {stmt.sql.replace(/\s+/g, ' ')}
                  </code>
                </div>
                <span className="font-mono text-[11px] text-slate-500 shrink-0">
                  {stmt.durationMs} ms
                </span>
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
                      <thead className="border-b border-borderline bg-canvas/30 font-mono text-[11px] text-slate-400">
                        <tr>
                          {stmt.columns.map((c, ci) => (
                            <th key={`${c}-${ci}`} className="px-3.5 py-2 font-medium whitespace-nowrap">
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
