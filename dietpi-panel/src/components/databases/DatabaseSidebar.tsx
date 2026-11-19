'use client';

import React from 'react';
import {
  IconDatabase,
  IconEye,
  IconPanelLeftClose,
  IconPanelLeftOpen,
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
  collapsed,
  onToggleCollapse,
  onChangeFilter,
  onSelectTable,
  onCreateTable,
  onDropTable,
}: {
  tables: DbTableInfo[];
  filteredTables: DbTableInfo[];
  selectedTable: string;
  tableFilter: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onChangeFilter: (val: string) => void;
  onSelectTable: (tableName: string) => void;
  onCreateTable: () => void;
  onDropTable: (table: DbTableInfo) => void;
}) {
  if (collapsed) {
    return (
      <aside className="rounded-xl border border-borderline bg-surface overflow-hidden flex flex-col items-center py-3 px-1.5 gap-3 lg:w-14 shrink-0 self-start">
        <button
          type="button"
          onClick={onToggleCollapse}
          title="Expand tables explorer"
          aria-label="Expand tables explorer"
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-borderline bg-canvas text-slate-300 hover:border-accent/60 hover:text-accent transition"
        >
          <IconPanelLeftOpen className="w-4 h-4" />
        </button>

        <div className="h-px w-7 bg-borderline" />

        <button
          type="button"
          onClick={onCreateTable}
          title="Create New Table"
          aria-label="Create New Table"
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 border border-accent/35 text-accent hover:bg-accent/25 transition"
        >
          <IconPlus className="w-4 h-4" />
        </button>

        <div className="flex flex-col items-center gap-1 max-h-[54vh] overflow-y-auto w-full px-0.5">
          {tables.map((t) => {
            const active = selectedTable === t.name;
            return (
              <button
                key={t.name}
                type="button"
                onClick={() => onSelectTable(t.name)}
                title={`${t.name} (${t.rowCount} rows)`}
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition ${
                  active
                    ? 'bg-accent/20 text-accent ring-1 ring-accent/40'
                    : 'text-slate-400 hover:bg-elevated hover:text-slate-100'
                }`}
              >
                {t.type === 'view' ? (
                  <IconEye className="w-3.5 h-3.5" />
                ) : (
                  <IconTable className="w-3.5 h-3.5" />
                )}
              </button>
            );
          })}
        </div>
      </aside>
    );
  }

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

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onCreateTable}
            className="inline-flex items-center gap-1 rounded-lg border border-borderline bg-elevated px-2 py-1 text-[11px] font-medium text-slate-200 hover:border-accent/60 hover:text-accent transition"
          >
            <IconPlus className="w-3 h-3" />
            <span>Table</span>
          </button>
          <button
            type="button"
            onClick={onToggleCollapse}
            title="Collapse tables explorer"
            aria-label="Collapse tables explorer"
            className="hidden lg:flex h-7 w-7 items-center justify-center rounded-lg border border-borderline bg-canvas text-slate-400 hover:border-slate-500 hover:text-slate-100 transition"
          >
            <IconPanelLeftClose className="w-3.5 h-3.5" />
          </button>
        </div>
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
