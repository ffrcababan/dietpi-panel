'use client';

import React from 'react';
import {
  IconDatabase,
  IconEye,
  IconPlus,
  IconSearch,
  IconTable,
  IconTrash,
  IconX,
} from '@/components/Icons';
import type { DbTableInfo } from '@/app/api/databases/[name]/manage/route';

export const DatabaseSidebar = React.memo(function DatabaseSidebar({
  tables,
  filteredTables,
  selectedTable,
  tableFilter,
  onChangeFilter,
  onSelectTable,
  onCreateTable,
  onDropTable,
}: {
  tables: DbTableInfo[];
  filteredTables: DbTableInfo[];
  selectedTable: string;
  tableFilter: string;
  onChangeFilter: (val: string) => void;
  onSelectTable: (tableName: string) => void;
  onCreateTable: () => void;
  onDropTable: (table: DbTableInfo) => void;
}) {
  return (
    <aside className="w-full lg:w-72 xl:w-80 shrink-0 rounded-xl border border-borderline bg-surface overflow-hidden flex flex-col self-start">
      <div className="flex items-center justify-between gap-2 border-b border-borderline bg-canvas/60 px-3.5 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <IconDatabase className="w-4 h-4 text-accent shrink-0" />
          <span className="text-xs font-semibold text-slate-200 truncate">
            Tables &amp; Views
          </span>
          <span className="rounded-full bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
            {tables.length}
          </span>
        </div>

        <button
          type="button"
          onClick={onCreateTable}
          className="inline-flex items-center gap-1 rounded-lg border border-borderline bg-elevated px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:border-accent/60 hover:text-accent transition shrink-0"
        >
          <IconPlus className="w-3 h-3" />
          <span>Table</span>
        </button>
      </div>

      {tables.length > 4 && (
        <div className="border-b border-borderline bg-canvas/30 px-3 py-2">
          <div className="relative">
            <IconSearch className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              placeholder="Filter tables..."
              value={tableFilter}
              onChange={(e) => onChangeFilter(e.target.value)}
              className="w-full rounded-lg border border-borderline bg-canvas pl-8 pr-7 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:border-accent focus:outline-none"
            />
            {tableFilter && (
              <button
                type="button"
                onClick={() => onChangeFilter('')}
                title="Clear filter"
                aria-label="Clear filter"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-200"
              >
                <IconX className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="divide-y divide-borderline/70 max-h-[60vh] overflow-y-auto">
        {filteredTables.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-slate-500">
            {tables.length === 0
              ? 'Empty database — create a table or run a SQL script.'
              : 'No tables match filter.'}
          </div>
        ) : (
          filteredTables.map((t) => {
            const active = selectedTable === t.name;
            return (
              <div
                key={t.name}
                className={`group flex items-center justify-between gap-2 px-3 py-2.5 transition ${
                  active
                    ? 'bg-accent/10 border-l-2 border-l-accent'
                    : 'hover:bg-elevated/50 border-l-2 border-l-transparent'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectTable(t.name)}
                  className="min-w-0 flex-1 text-left flex items-start gap-2"
                >
                  <span className={`mt-0.5 shrink-0 ${active ? 'text-accent' : 'text-slate-500'}`}>
                    {t.type === 'view' ? (
                      <IconEye className="w-3.5 h-3.5" />
                    ) : (
                      <IconTable className="w-3.5 h-3.5" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`truncate font-mono text-xs font-medium ${
                          active ? 'text-slate-50' : 'text-slate-200'
                        }`}
                      >
                        {t.name}
                      </span>
                      {t.type === 'view' && (
                        <span className="rounded bg-sky-500/15 px-1 py-0.2 text-[9px] font-mono text-sky-300 uppercase shrink-0">
                          view
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] font-mono text-slate-500">
                      {t.rowCount.toLocaleString()} {t.rowCount === 1 ? 'row' : 'rows'} ·{' '}
                      {t.columns.length} cols
                    </div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => onDropTable(t)}
                  title={`Drop ${t.type} ${t.name}`}
                  aria-label={`Drop ${t.type} ${t.name}`}
                  className="rounded-md p-1 text-slate-600 opacity-75 group-hover:opacity-100 hover:bg-rose-500/15 hover:text-rose-400 transition shrink-0"
                >
                  <IconTrash className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
});
