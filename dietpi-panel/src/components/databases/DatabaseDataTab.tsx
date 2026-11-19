'use client';

import React from 'react';
import {
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconEdit,
  IconEye,
  IconPlus,
  IconSearch,
  IconTrash,
  IconX,
} from '@/components/Icons';
import { formatDbCellDisplay } from '@/components/databases/DatabaseSqlTab';
import {
  downloadRowsAsCsv,
  downloadRowsAsJson,
} from '@/components/databases/exportUtils';
import type {
  DbColumnInfo,
  DbRowItem,
  DbRowKey,
  DbTableInfo,
} from '@/app/api/databases/[name]/manage/route';

export const DatabaseDataTab = React.memo(function DatabaseDataTab({
  tableInfo,
  columns,
  rows,
  rowsMatchesTable,
  loadingRows,
  rowsError,
  searchInput,
  appliedSearch,
  sortBy,
  sortDir,
  page,
  pageSize,
  totalRows,
  totalPages,
  selectedRowKeys,
  onChangeSearchInput,
  onApplySearch,
  onClearSearch,
  onToggleSort,
  onToggleRowCheck,
  onToggleAllPageRows,
  onOpenInsertRow,
  onOpenInspectRow,
  onOpenEditRow,
  onRequestDeleteRows,
  onChangePage,
  onChangePageSize,
}: {
  tableInfo: DbTableInfo;
  columns: DbColumnInfo[];
  rows: DbRowItem[];
  rowsMatchesTable: boolean;
  loadingRows: boolean;
  rowsError: string | null;
  searchInput: string;
  appliedSearch: string;
  sortBy: string;
  sortDir: 'ASC' | 'DESC';
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
  selectedRowKeys: Record<string, DbRowKey>;
  onChangeSearchInput: (v: string) => void;
  onApplySearch: () => void;
  onClearSearch: () => void;
  onToggleSort: (colName: string) => void;
  onToggleRowCheck: (keyObj: DbRowKey) => void;
  onToggleAllPageRows: (checked: boolean) => void;
  onOpenInsertRow: () => void;
  onOpenInspectRow: (row: DbRowItem) => void;
  onOpenEditRow: (row: DbRowItem) => void;
  onRequestDeleteRows: (keys: DbRowKey[]) => void;
  onChangePage: (nextPage: number) => void;
  onChangePageSize: (nextSize: number) => void;
}) {
  const selectedKeysList = Object.values(selectedRowKeys);
  const displayRows = rowsMatchesTable ? rows : [];
  const allPageChecked =
    displayRows.length > 0 &&
    displayRows.every(
      (r) => r.rowKey && Boolean(selectedRowKeys[JSON.stringify(r.rowKey)])
    );

  const startRowNum = totalRows === 0 ? 0 : (page - 1) * pageSize + 1;
  const endRowNum = Math.min(totalRows, page * pageSize);

  const handleExportCsv = () => {
    const colNames = columns.map((c) => c.name);
    const matrix = displayRows.map((r) => colNames.map((cn) => r.cells[cn] ?? null));
    downloadRowsAsCsv(`${tableInfo.name}-page-${page}`, colNames, matrix);
  };

  const handleExportJson = () => {
    downloadRowsAsJson(
      `${tableInfo.name}-page-${page}`,
      displayRows.map((r) => r.cells)
    );
  };

  return (
    <section className="rounded-xl border border-borderline bg-surface overflow-hidden shadow-sm">
      {/* Data Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-borderline bg-canvas/60 px-4 py-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onApplySearch();
          }}
          className="flex flex-wrap items-center gap-2 flex-1 min-w-[220px]"
        >
          <div className="relative flex-1 max-w-sm">
            <IconSearch className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              placeholder={`Search ${columns.length} columns...`}
              value={searchInput}
              onChange={(e) => onChangeSearchInput(e.target.value)}
              className="w-full rounded-lg border border-borderline bg-canvas pl-8 pr-7 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:border-accent focus:outline-none"
            />
            {(searchInput || appliedSearch) && (
              <button
                type="button"
                onClick={onClearSearch}
                title="Clear search"
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-200"
              >
                <IconX className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <button
            type="submit"
            className="rounded-lg border border-borderline bg-elevated px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500 transition"
          >
            Search
          </button>
          {appliedSearch && (
            <span className="rounded-md bg-accent/10 border border-accent/30 px-2 py-0.5 font-mono text-[11px] text-accent">
              &ldquo;{appliedSearch}&rdquo;
            </span>
          )}
        </form>

        <div className="flex flex-wrap items-center gap-2">
          {displayRows.length > 0 && (
            <>
              <button
                type="button"
                onClick={handleExportCsv}
                title="Download visible rows as CSV"
                className="inline-flex items-center gap-1 rounded-lg border border-borderline bg-canvas px-2.5 py-1.5 text-xs text-slate-300 hover:border-slate-500 hover:text-white transition"
              >
                <IconDownload className="w-3.5 h-3.5" />
                <span>CSV</span>
              </button>
              <button
                type="button"
                onClick={handleExportJson}
                title="Download visible rows as JSON"
                className="inline-flex items-center gap-1 rounded-lg border border-borderline bg-canvas px-2.5 py-1.5 text-xs text-slate-300 hover:border-slate-500 hover:text-white transition"
              >
                <IconDownload className="w-3.5 h-3.5" />
                <span>JSON</span>
              </button>
            </>
          )}

          {tableInfo.type === 'table' && selectedKeysList.length > 0 && (
            <button
              type="button"
              onClick={() => onRequestDeleteRows(selectedKeysList)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/15 px-3 py-1.5 text-xs font-medium text-rose-200 hover:bg-rose-500/25 transition"
            >
              <IconTrash className="w-3.5 h-3.5" />
              <span>Delete ({selectedKeysList.length})</span>
            </button>
          )}

          {tableInfo.type === 'table' && (
            <button
              type="button"
              onClick={onOpenInsertRow}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-accent-hover transition"
            >
              <IconPlus className="w-3.5 h-3.5" />
              <span>Add Row</span>
            </button>
          )}
        </div>
      </div>

      {rowsError && (
        <div className="border-b border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-200">
          {rowsError}
        </div>
      )}

      {!tableInfo.hasEditableKey && tableInfo.type === 'table' && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[11px] text-amber-200">
          This table has no ROWID or PRIMARY KEY — rows can be inspected or added, while inline edit/delete is disabled.
        </div>
      )}

      <div className="overflow-x-auto max-h-[60vh]">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="border-b border-borderline bg-[#0e131e] font-mono text-[11px] text-slate-400 sticky top-0 z-10">
            <tr>
              {tableInfo.hasEditableKey && (
                <th className="px-3 py-2.5 w-9">
                  <input
                    type="checkbox"
                    checked={allPageChecked}
                    onChange={(e) => onToggleAllPageRows(e.target.checked)}
                    aria-label="Select all rows on page"
                    className="rounded border-borderline bg-canvas text-accent"
                  />
                </th>
              )}
              {columns.map((c) => (
                <th key={c.name} className="px-3.5 py-2.5 font-medium whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => onToggleSort(c.name)}
                    title={`Sort by ${c.name} (${c.type || 'ANY'})`}
                    className="inline-flex items-center gap-1.5 hover:text-slate-100 transition group"
                  >
                    <span className={sortBy === c.name ? 'text-accent font-semibold' : ''}>
                      {c.name}
                    </span>
                    {c.pk > 0 && (
                      <span
                        title="Primary Key"
                        className="rounded bg-amber-500/15 px-1 text-[9px] text-amber-300"
                      >
                        PK
                      </span>
                    )}
                    <span className="text-[10px] text-slate-500 font-normal">
                      {c.type || 'ANY'}
                    </span>
                    {sortBy === c.name && (
                      <span className="text-accent font-bold">
                        {sortDir === 'ASC' ? '↑' : '↓'}
                      </span>
                    )}
                  </button>
                </th>
              ))}
              <th className="px-3.5 py-2.5 text-right whitespace-nowrap sticky right-0 bg-[#0e131e] border-l border-borderline/60">
                Actions
              </th>
            </tr>
          </thead>

          <tbody className="divide-y divide-borderline/80 font-mono">
            {!rowsMatchesTable && loadingRows ? (
              Array.from({ length: 5 }).map((_, sIdx) => (
                <tr key={`skel-${sIdx}`} className="animate-pulse">
                  {tableInfo.hasEditableKey && (
                    <td className="px-3 py-3">
                      <div className="h-3.5 w-3.5 rounded bg-elevated" />
                    </td>
                  )}
                  {columns.map((c) => (
                    <td key={c.name} className="px-3.5 py-3">
                      <div className="h-3.5 w-24 rounded bg-elevated" />
                    </td>
                  ))}
                  <td className="px-3.5 py-3">
                    <div className="ml-auto h-4 w-16 rounded bg-elevated" />
                  </td>
                </tr>
              ))
            ) : displayRows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + (tableInfo.hasEditableKey ? 2 : 1)}
                  className="px-5 py-12 text-center font-sans text-xs text-slate-500"
                >
                  {loadingRows
                    ? 'Loading rows...'
                    : appliedSearch
                      ? `No rows match "${appliedSearch}".`
                      : 'Table has 0 rows.'}
                </td>
              </tr>
            ) : (
              displayRows.map((row, rIdx) => {
                const rkStr = row.rowKey ? JSON.stringify(row.rowKey) : String(rIdx);
                const isChecked = row.rowKey ? Boolean(selectedRowKeys[rkStr]) : false;
                return (
                  <tr
                    key={rkStr}
                    className={`group transition-colors ${
                      isChecked ? 'bg-accent/10' : 'hover:bg-elevated/40'
                    }`}
                  >
                    {tableInfo.hasEditableKey && (
                      <td className="px-3 py-2">
                        {row.rowKey && (
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => row.rowKey && onToggleRowCheck(row.rowKey)}
                            aria-label={`Select row ${rIdx + 1}`}
                            className="rounded border-borderline bg-canvas text-accent"
                          />
                        )}
                      </td>
                    )}
                    {columns.map((c) => {
                      const raw = row.cells[c.name] ?? null;
                      const disp = formatDbCellDisplay(raw);
                      return (
                        <td
                          key={c.name}
                          onClick={() => onOpenInspectRow(row)}
                          title={`${disp.text} (click to inspect row)`}
                          className="px-3.5 py-2 max-w-[260px] truncate cursor-pointer"
                        >
                          {disp.isNull ? (
                            <span className="inline-block rounded bg-slate-800/80 px-1.5 py-0.5 text-[10px] italic text-slate-400">
                              NULL
                            </span>
                          ) : disp.isBlob ? (
                            <span className="inline-block rounded bg-purple-500/15 border border-purple-500/30 px-1.5 py-0.5 text-[10px] text-purple-300">
                              {disp.text}
                            </span>
                          ) : typeof raw === 'number' ? (
                            <span className="text-sky-300">{disp.text}</span>
                          ) : (
                            <span className="text-slate-200">{disp.text}</span>
                          )}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-right whitespace-nowrap space-x-1.5 font-sans sticky right-0 bg-surface group-hover:bg-elevated border-l border-borderline/60">
                      <button
                        type="button"
                        onClick={() => onOpenInspectRow(row)}
                        title="Inspect row values"
                        aria-label="Inspect row"
                        className="inline-flex items-center justify-center rounded-md border border-borderline bg-canvas p-1 text-slate-300 hover:border-slate-500 hover:text-white transition"
                      >
                        <IconEye className="w-3.5 h-3.5" />
                      </button>
                      {tableInfo.hasEditableKey && (
                        <>
                          <button
                            type="button"
                            onClick={() => onOpenEditRow(row)}
                            title="Edit row"
                            aria-label="Edit row"
                            className="inline-flex items-center justify-center rounded-md border border-borderline bg-elevated p-1 text-slate-200 hover:border-accent/60 hover:text-accent transition"
                          >
                            <IconEdit className="w-3.5 h-3.5" />
                          </button>
                          {row.rowKey && (
                            <button
                              type="button"
                              onClick={() => row.rowKey && onRequestDeleteRows([row.rowKey])}
                              title="Delete row"
                              aria-label="Delete row"
                              className="inline-flex items-center justify-center rounded-md border border-rose-500/30 bg-rose-500/10 p-1 text-rose-300 hover:bg-rose-500/20 transition"
                            >
                              <IconTrash className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Footer */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-borderline bg-canvas/60 px-4 py-2.5 text-xs text-slate-400">
        <div>
          Showing <span className="font-mono text-slate-200">{startRowNum}</span>–
          <span className="font-mono text-slate-200">{endRowNum}</span> of{' '}
          <span className="font-mono text-slate-200">{totalRows.toLocaleString()}</span> row(s)
          {loadingRows && rowsMatchesTable && (
            <span className="ml-2 text-[11px] text-accent">Refreshing...</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={pageSize}
            onChange={(e) => onChangePageSize(Number.parseInt(e.target.value, 10))}
            aria-label="Rows per page"
            className="rounded-lg border border-borderline bg-canvas px-2 py-1 text-xs text-slate-200 focus:border-accent focus:outline-none"
          >
            {[25, 50, 100, 200].map((ps) => (
              <option key={ps} value={ps}>
                {ps} / page
              </option>
            ))}
          </select>

          <div className="inline-flex items-center rounded-lg border border-borderline bg-elevated overflow-hidden">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => onChangePage(1)}
              title="First page"
              className="px-2 py-1 text-xs text-slate-200 hover:bg-canvas disabled:opacity-35 border-r border-borderline transition"
            >
              First
            </button>
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => onChangePage(Math.max(1, page - 1))}
              aria-label="Previous page"
              className="px-2 py-1 text-slate-200 hover:bg-canvas disabled:opacity-35 border-r border-borderline transition"
            >
              <IconChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="px-2.5 py-1 font-mono text-[11px] text-slate-300 bg-canvas/50">
              {page} / {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => onChangePage(Math.min(totalPages, page + 1))}
              aria-label="Next page"
              className="px-2 py-1 text-slate-200 hover:bg-canvas disabled:opacity-35 border-l border-borderline transition"
            >
              <IconChevronRight className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => onChangePage(totalPages)}
              title="Last page"
              className="px-2 py-1 text-xs text-slate-200 hover:bg-canvas disabled:opacity-35 border-l border-borderline transition"
            >
              Last
            </button>
          </div>
        </div>
      </div>
    </section>
  );
});
