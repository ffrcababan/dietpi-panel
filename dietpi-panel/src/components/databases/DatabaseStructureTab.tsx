'use client';

import React, { useState } from 'react';
import {
  IconCheck,
  IconCode,
  IconCopy,
  IconEdit,
  IconKey,
  IconLink,
  IconPlus,
  IconTrash,
} from '@/components/Icons';
import { StatusBadge } from '@/components/StatusBadge';
import type { DbColumnInfo, DbTableInfo } from '@/app/api/databases/[name]/manage/route';

export const DatabaseStructureTab = React.memo(function DatabaseStructureTab({
  tableInfo,
  onAddColumn,
  onEditColumn,
  onDropColumn,
}: {
  tableInfo: DbTableInfo;
  onAddColumn: () => void;
  onEditColumn: (col: DbColumnInfo) => void;
  onDropColumn: (colName: string) => void;
}) {
  const [copiedDdl, setCopiedDdl] = useState(false);
  const triggers = tableInfo.triggers ?? [];

  const handleCopyDdl = async () => {
    if (!tableInfo.sql) return;
    try {
      await navigator.clipboard.writeText(tableInfo.sql);
      setCopiedDdl(true);
      window.setTimeout(() => setCopiedDdl(false), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="space-y-4">
      {/* Metadata KPI Strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-borderline bg-surface px-4 py-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Object</div>
          <div className="mt-1 flex items-center gap-2">
            <span className="font-mono text-sm font-semibold text-slate-100 truncate">
              {tableInfo.name}
            </span>
            <StatusBadge
              tone={tableInfo.type === 'view' ? 'blue' : 'green'}
              label={tableInfo.type}
            />
          </div>
        </div>
        <div className="rounded-xl border border-borderline bg-surface px-4 py-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Rows &amp; Cols</div>
          <div className="mt-1 font-mono text-sm font-semibold text-slate-100">
            {tableInfo.rowCount.toLocaleString()} rows · {tableInfo.columns.length} cols
          </div>
        </div>
        <div className="rounded-xl border border-borderline bg-surface px-4 py-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Primary Key</div>
          <div className="mt-1 font-mono text-xs text-slate-200 truncate">
            {tableInfo.primaryKey.length > 0
              ? tableInfo.primaryKey.join(', ')
              : tableInfo.withoutRowId
                ? 'None'
                : 'Implicit ROWID'}
          </div>
        </div>
        <div className="rounded-xl border border-borderline bg-surface px-4 py-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Constraints</div>
          <div className="mt-1 font-mono text-xs text-slate-200">
            {tableInfo.indexes.length} idx · {tableInfo.foreignKeys.length} FK · {triggers.length} trg
          </div>
        </div>
      </div>

      {/* Columns */}
      <section className="rounded-xl border border-borderline bg-surface overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-borderline bg-canvas/50 px-5 py-3.5">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Columns ({tableInfo.columns.length})
            </h2>
            <p className="text-xs text-slate-400">
              Add, rename, change data type, or drop columns on{' '}
              <span className="font-mono text-slate-300">{tableInfo.name}</span>.
            </p>
          </div>
          {tableInfo.type === 'table' && (
            <button
              type="button"
              onClick={onAddColumn}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-accent-hover transition"
            >
              <IconPlus className="w-3.5 h-3.5" />
              <span>Add Column</span>
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-borderline bg-canvas/40 uppercase text-[11px] text-slate-400">
              <tr>
                <th className="px-4 py-2.5 font-medium">#</th>
                <th className="px-4 py-2.5 font-medium">Column</th>
                <th className="px-4 py-2.5 font-medium">Type</th>
                <th className="px-4 py-2.5 font-medium">Constraints</th>
                <th className="px-4 py-2.5 font-medium">Default</th>
                {tableInfo.type === 'table' && (
                  <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-borderline/80 font-mono">
              {tableInfo.columns.map((col) => {
                const disableDrop = col.pk > 0 || tableInfo.columns.length <= 1;
                return (
                  <tr key={col.name} className="hover:bg-elevated/35">
                    <td className="px-4 py-2.5 text-slate-500">{col.cid}</td>
                    <td className="px-4 py-2.5 font-semibold text-slate-100">{col.name}</td>
                    <td className="px-4 py-2.5 text-sky-300">{col.type || 'ANY'}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1.5 font-sans">
                        {col.pk > 0 && <StatusBadge tone="amber" label={`PK #${col.pk}`} />}
                        {col.notnull ? (
                          <StatusBadge tone="blue" label="NOT NULL" />
                        ) : (
                          <StatusBadge tone="slate" label="Nullable" />
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-slate-300">
                      {col.defaultValue ?? <span className="text-slate-600">—</span>}
                    </td>
                    {tableInfo.type === 'table' && (
                      <td className="px-4 py-2.5 text-right whitespace-nowrap space-x-2 font-sans">
                        <button
                          type="button"
                          onClick={() => onEditColumn(col)}
                          className="inline-flex items-center gap-1 rounded-md border border-borderline bg-elevated px-2.5 py-1 text-[11px] text-slate-200 hover:border-slate-500 transition"
                        >
                          <IconEdit className="w-3 h-3" />
                          <span>Edit</span>
                        </button>
                        <button
                          type="button"
                          disabled={disableDrop}
                          title={
                            col.pk > 0
                              ? 'Primary key columns cannot be dropped directly'
                              : tableInfo.columns.length <= 1
                                ? 'Cannot drop the only remaining column'
                                : `Drop column ${col.name}`
                          }
                          onClick={() => onDropColumn(col.name)}
                          className="inline-flex items-center gap-1 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-[11px] text-rose-300 hover:bg-rose-500/20 disabled:opacity-30 transition"
                        >
                          <IconTrash className="w-3 h-3" />
                          <span>Drop</span>
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Indexes & Foreign Keys */}
      {(tableInfo.indexes.length > 0 || tableInfo.foreignKeys.length > 0) && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {tableInfo.indexes.length > 0 && (
            <section className="rounded-xl border border-borderline bg-surface overflow-hidden">
              <div className="flex items-center gap-2 border-b border-borderline bg-canvas/50 px-4 py-3">
                <IconKey className="w-4 h-4 text-amber-400" />
                <h3 className="text-xs font-semibold text-slate-100">
                  Indexes &amp; Unique Constraints ({tableInfo.indexes.length})
                </h3>
              </div>
              <div className="divide-y divide-borderline/70">
                {tableInfo.indexes.map((idx) => (
                  <div
                    key={idx.name}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-mono font-medium text-slate-200">
                        {idx.name}
                      </div>
                      <div className="font-mono text-[11px] text-slate-400">
                        ({idx.columns.join(', ')})
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <StatusBadge
                        tone={idx.unique ? 'amber' : 'slate'}
                        label={idx.unique ? 'UNIQUE' : 'INDEX'}
                      />
                      <StatusBadge
                        tone="blue"
                        label={
                          idx.origin === 'pk'
                            ? 'Primary Key'
                            : idx.origin === 'u'
                              ? 'Constraint'
                              : 'CREATE INDEX'
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {tableInfo.foreignKeys.length > 0 && (
            <section className="rounded-xl border border-borderline bg-surface overflow-hidden">
              <div className="flex items-center gap-2 border-b border-borderline bg-canvas/50 px-4 py-3">
                <IconLink className="w-4 h-4 text-sky-400" />
                <h3 className="text-xs font-semibold text-slate-100">
                  Foreign Keys ({tableInfo.foreignKeys.length})
                </h3>
              </div>
              <div className="divide-y divide-borderline/70">
                {tableInfo.foreignKeys.map((fk, fi) => (
                  <div
                    key={`${fk.id}-${fi}`}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs"
                  >
                    <div className="font-mono text-slate-200">
                      <span className="text-accent">{fk.from}</span> →{' '}
                      <span className="text-sky-300">
                        {fk.table}({fk.to})
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400">
                      <span>DEL: {fk.onDelete}</span>
                      <span>·</span>
                      <span>UPD: {fk.onUpdate}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* Triggers */}
      {triggers.length > 0 && (
        <section className="rounded-xl border border-borderline bg-surface overflow-hidden">
          <div className="border-b border-borderline bg-canvas/50 px-4 py-3 text-xs font-semibold text-slate-200">
            Triggers ({triggers.length})
          </div>
          <div className="divide-y divide-borderline/70">
            {triggers.map((trg) => (
              <div key={trg.name} className="p-4 space-y-2">
                <div className="font-mono text-xs font-semibold text-amber-300">{trg.name}</div>
                <pre className="overflow-x-auto rounded-lg border border-borderline bg-[#080b10] p-3 font-mono text-[11px] text-slate-300 whitespace-pre-wrap">
                  {trg.sql}
                </pre>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* DDL Definition */}
      {tableInfo.sql && (
        <section className="rounded-xl border border-borderline bg-surface p-4 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
              <IconCode className="w-4 h-4 text-accent" />
              <span>DDL Definition</span>
            </div>
            <button
              type="button"
              onClick={handleCopyDdl}
              className="inline-flex items-center gap-1.5 rounded-lg border border-borderline bg-elevated px-2.5 py-1 text-[11px] text-slate-200 hover:border-slate-500 transition"
            >
              {copiedDdl ? (
                <>
                  <IconCheck className="w-3 h-3 text-emerald-400" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <IconCopy className="w-3 h-3" />
                  <span>Copy DDL</span>
                </>
              )}
            </button>
          </div>
          <pre className="overflow-x-auto rounded-lg border border-borderline bg-[#080b10] p-3.5 font-mono text-[11px] leading-relaxed text-slate-300 whitespace-pre-wrap">
            {tableInfo.sql}
          </pre>
        </section>
      )}
    </div>
  );
});
