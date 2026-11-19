'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import {
  IconDatabase,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTerminal,
  IconTrash,
} from '@/components/Icons';
import { usePanel } from '@/components/PanelContext';
import { StatusBadge } from '@/components/StatusBadge';
import {
  ColumnEditorModal,
  ConfirmDbActionModal,
  CreateTableModal,
  RowEditorModal,
} from '@/components/databases/DatabaseModals';
import {
  DatabaseSqlTab,
  formatDbCellDisplay,
} from '@/components/databases/DatabaseSqlTab';
import { apiFetcher, apiMutate } from '@/lib/client-api';
import type {
  DbColumnInfo,
  DbRowItem,
  DbRowKey,
  DbRowsResponse,
  DbSchemaResponse,
  DbScriptResponse,
  DbTableInfo,
} from '@/app/api/databases/[name]/manage/route';

type StudioTab = 'data' | 'structure' | 'sql';

type PendingConfirm =
  | { kind: 'dropTable'; table: DbTableInfo }
  | { kind: 'dropColumn'; table: string; column: string }
  | { kind: 'deleteRows'; table: string; rowKeys: DbRowKey[] }
  | { kind: 'dangerousSql'; sql: string; warnings: string[] }
  | null;

export default function DatabaseStudioPage({
  params,
}: {
  params: { name: string };
}) {
  const dbName = decodeURIComponent(params.name);
  const { me } = usePanel();

  const [tab, setTab] = useState<StudioTab>('data');
  const [tableFilter, setTableFilter] = useState('');
  const [selectedTable, setSelectedTable] = useState('');
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);

  // Data Browser state
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [searchInput, setSearchInput] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('ASC');
  const [selectedRowKeys, setSelectedRowKeys] = useState<Record<string, DbRowKey>>({});

  // Modals & busy flags
  const [busy, setBusy] = useState(false);
  const [createTableOpen, setCreateTableOpen] = useState(false);
  const [rowModal, setRowModal] = useState<{
    open: boolean;
    mode: 'insert' | 'update';
    row: DbRowItem | null;
  }>({ open: false, mode: 'insert', row: null });
  const [colModal, setColModal] = useState<{
    open: boolean;
    mode: 'add' | 'update';
    column: DbColumnInfo | null;
  }>({ open: false, mode: 'add', column: null });
  const [confirmState, setConfirmState] = useState<PendingConfirm>(null);

  // SQL Runner state
  const [sqlText, setSqlText] = useState('SELECT name, type FROM sqlite_master WHERE name NOT LIKE \'sqlite_%\';');
  const [useTransaction, setUseTransaction] = useState(true);
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [sqlResult, setSqlResult] = useState<DbScriptResponse | null>(null);

  const manageUrl = `/api/databases/${encodeURIComponent(dbName)}/manage`;

  const {
    data: schemaData,
    error: schemaError,
    mutate: mutateSchema,
  } = useSWR<DbSchemaResponse>(`${manageUrl}?action=schema`, apiFetcher, {
    keepPreviousData: true,
  });

  const tables = useMemo(() => schemaData?.tables ?? [], [schemaData?.tables]);

  useEffect(() => {
    if (tables.length === 0) {
      setSelectedTable('');
      return;
    }
    if (!selectedTable || !tables.some((t) => t.name === selectedTable)) {
      setSelectedTable(tables[0].name);
      setPage(1);
      setSearchInput('');
      setAppliedSearch('');
      setSortBy('');
      setSelectedRowKeys({});
    }
  }, [tables, selectedTable]);

  const activeTableInfo = useMemo(
    () => tables.find((t) => t.name === selectedTable) ?? null,
    [tables, selectedTable]
  );

  const rowsUrl =
    selectedTable && tab === 'data'
      ? `${manageUrl}?action=rows&table=${encodeURIComponent(selectedTable)}&page=${page}&pageSize=${pageSize}&search=${encodeURIComponent(appliedSearch)}&sortBy=${encodeURIComponent(sortBy)}&sortDir=${sortDir}`
      : null;

  const {
    data: rowsData,
    error: rowsError,
    isValidating: loadingRows,
    mutate: mutateRows,
  } = useSWR<DbRowsResponse>(rowsUrl, apiFetcher, {
    keepPreviousData: true,
  });

  const filteredTables = useMemo(() => {
    const q = tableFilter.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter((t) => t.name.toLowerCase().includes(q));
  }, [tables, tableFilter]);

  const selectTable = (tName: string) => {
    setSelectedTable(tName);
    setPage(1);
    setSearchInput('');
    setAppliedSearch('');
    setSortBy('');
    setSortDir('ASC');
    setSelectedRowKeys({});
  };

  const refreshAll = async () => {
    await Promise.all([mutateSchema(), rowsUrl ? mutateRows() : Promise.resolve()]);
  };

  const toggleSort = (colName: string) => {
    if (sortBy === colName) {
      setSortDir((d) => (d === 'ASC' ? 'DESC' : 'ASC'));
    } else {
      setSortBy(colName);
      setSortDir('ASC');
    }
    setPage(1);
  };

  const selectedKeysList = useMemo(
    () => Object.values(selectedRowKeys),
    [selectedRowKeys]
  );

  const toggleRowCheck = (keyObj: DbRowKey) => {
    const id = JSON.stringify(keyObj);
    setSelectedRowKeys((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = keyObj;
      return next;
    });
  };

  const handleSaveRow = async (
    values: Record<string, { isNull?: boolean; value?: string; valueType?: string }>
  ) => {
    if (!me?.csrfToken || !selectedTable) return;
    setBusy(true);
    try {
      if (rowModal.mode === 'insert') {
        await apiMutate(manageUrl, 'POST', me.csrfToken, {
          op: 'rows.insert',
          table: selectedTable,
          values,
        });
        setBanner({ ok: true, text: `Inserted new row into "${selectedTable}".` });
      } else if (rowModal.row?.rowKey) {
        await apiMutate(manageUrl, 'POST', me.csrfToken, {
          op: 'rows.update',
          table: selectedTable,
          rowKey: rowModal.row.rowKey,
          values,
        });
        setBanner({ ok: true, text: `Updated row in "${selectedTable}".` });
      }
      setRowModal({ open: false, mode: 'insert', row: null });
      await refreshAll();
    } finally {
      setBusy(false);
    }
  };

  const handleSaveColumn = async (payload: {
    name: string;
    type: string;
    notNull: boolean;
    updateDefault?: boolean;
    defaultMode: string;
    defaultValue: string;
  }) => {
    if (!me?.csrfToken || !selectedTable) return;
    setBusy(true);
    try {
      if (colModal.mode === 'add') {
        await apiMutate(manageUrl, 'POST', me.csrfToken, {
          op: 'columns.add',
          table: selectedTable,
          column: payload,
        });
        setBanner({
          ok: true,
          text: `Added column "${payload.name}" to "${selectedTable}".`,
        });
      } else if (colModal.mode === 'update' && colModal.column) {
        await apiMutate(manageUrl, 'POST', me.csrfToken, {
          op: 'columns.update',
          table: selectedTable,
          oldName: colModal.column.name,
          next: payload,
        });
        setBanner({
          ok: true,
          text: `Updated column "${payload.name}" in "${selectedTable}".`,
        });
      }
      setColModal({ open: false, mode: 'add', column: null });
      await refreshAll();
    } finally {
      setBusy(false);
    }
  };

  const handleCreateTable = async (payload: {
    tableName: string;
    columns: Array<{
      name: string;
      type: string;
      primaryKey: boolean;
      autoIncrement: boolean;
      notNull: boolean;
      defaultMode: string;
      defaultValue: string;
    }>;
  }) => {
    if (!me?.csrfToken) return;
    setBusy(true);
    try {
      await apiMutate(manageUrl, 'POST', me.csrfToken, {
        op: 'table.create',
        tableName: payload.tableName,
        columns: payload.columns,
      });
      setCreateTableOpen(false);
      setSelectedTable(payload.tableName);
      setTab('data');
      setBanner({ ok: true, text: `Created table "${payload.tableName}".` });
      await mutateSchema();
    } finally {
      setBusy(false);
    }
  };

  const executeSqlScript = async (allowDangerous = false) => {
    if (!me?.csrfToken || !sqlText.trim()) return;
    setBusy(true);
    setSqlError(null);
    if (allowDangerous) {
      setConfirmState(null);
    }
    try {
      const res = await apiMutate<{ result: DbScriptResponse }>(
        manageUrl,
        'POST',
        me.csrfToken,
        {
          op: 'script.exec',
          sql: sqlText,
          useTransaction,
          allowDangerous,
        }
      );
      if (res.result.requiresConfirmation) {
        setConfirmState({
          kind: 'dangerousSql',
          sql: sqlText,
          warnings: res.result.warnings ?? [],
        });
        return;
      }
      setSqlResult(res.result);
      setConfirmState(null);
      setBanner({
        ok: true,
        text: `Executed ${res.result.results.length} SQL statement(s).`,
      });
      await refreshAll();
    } catch (err) {
      setSqlError(err instanceof Error ? err.message : 'SQL execution failed');
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmedAction = async () => {
    if (!me?.csrfToken || !confirmState) return;
    setBusy(true);
    try {
      if (confirmState.kind === 'dropTable') {
        await apiMutate(manageUrl, 'POST', me.csrfToken, {
          op: 'table.drop',
          tableName: confirmState.table.name,
        });
        setBanner({
          ok: true,
          text: `Dropped ${confirmState.table.type} "${confirmState.table.name}".`,
        });
        if (selectedTable === confirmState.table.name) {
          setSelectedTable('');
        }
        setConfirmState(null);
        await mutateSchema();
      } else if (confirmState.kind === 'dropColumn') {
        await apiMutate(manageUrl, 'POST', me.csrfToken, {
          op: 'columns.drop',
          table: confirmState.table,
          columnName: confirmState.column,
        });
        setBanner({
          ok: true,
          text: `Dropped column "${confirmState.column}" from "${confirmState.table}".`,
        });
        setConfirmState(null);
        await refreshAll();
      } else if (confirmState.kind === 'deleteRows') {
        await apiMutate(manageUrl, 'POST', me.csrfToken, {
          op: 'rows.delete',
          table: confirmState.table,
          rowKeys: confirmState.rowKeys,
        });
        setSelectedRowKeys({});
        setBanner({
          ok: true,
          text: `Deleted ${confirmState.rowKeys.length} row(s) from "${confirmState.table}".`,
        });
        setConfirmState(null);
        await refreshAll();
      } else if (confirmState.kind === 'dangerousSql') {
        setBusy(false);
        await executeSqlScript(true);
        return;
      }
    } finally {
      setBusy(false);
    }
  };

  const totalRows = rowsData?.totalRows ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentCols = rowsData?.columns ?? activeTableInfo?.columns ?? [];
  const rowsList = rowsData?.rows ?? [];
  const hasSingleIntPk = (activeTableInfo?.primaryKey.length ?? 0) === 1;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-400 mb-1">
            <Link href="/databases" className="hover:text-accent transition">
              Databases
            </Link>
            <span>/</span>
            <span className="font-mono text-slate-200">{dbName}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight font-mono text-slate-100">
              {dbName}
            </h1>
            {schemaData?.sqliteVersion && (
              <StatusBadge tone="blue" label={`SQLite ${schemaData.sqliteVersion}`} />
            )}
            <StatusBadge
              tone="slate"
              label={`${tables.length} ${tables.length === 1 ? 'table' : 'tables'}`}
            />
          </div>
          <p className="mt-1 text-xs font-mono text-slate-400">
            /srv/db/{dbName}/data.sqlite · Managed safely via PDO SQLite (WAL) as www-data
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void refreshAll()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-borderline bg-surface px-3 py-2 text-xs font-medium text-slate-200 hover:border-slate-500 transition"
          >
            <IconRefresh className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('sql')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-borderline bg-surface px-3 py-2 text-xs font-medium text-slate-200 hover:border-slate-500 transition"
          >
            <IconTerminal className="w-3.5 h-3.5 text-sky-400" />
            <span>SQL Script</span>
          </button>
          <button
            type="button"
            onClick={() => setCreateTableOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover transition"
          >
            <IconPlus className="w-3.5 h-3.5" />
            <span>New Table</span>
          </button>
        </div>
      </div>

      {banner && (
        <div
          className={`flex items-center justify-between gap-4 rounded-xl border px-4 py-3 text-xs ${
            banner.ok
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
              : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
          }`}
        >
          <span>{banner.text}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="text-slate-400 hover:text-white shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {schemaError ? (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-5 py-4 text-sm text-rose-200 flex flex-wrap items-center justify-between gap-3">
          <span>{schemaError.message}</span>
          <Link
            href="/databases"
            className="rounded-lg border border-borderline bg-surface px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500"
          >
            Back to Databases
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Left: Tables Sidebar */}
          <aside className="lg:col-span-3 rounded-xl border border-borderline bg-surface overflow-hidden flex flex-col self-start">
            <div className="flex items-center justify-between border-b border-borderline bg-canvas/50 px-4 py-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                <IconDatabase className="w-3.5 h-3.5 text-accent" />
                <span>Tables &amp; Views</span>
              </div>
              <button
                type="button"
                onClick={() => setCreateTableOpen(true)}
                className="rounded border border-borderline bg-elevated px-2 py-0.5 text-[11px] text-slate-200 hover:border-slate-500"
              >
                + Table
              </button>
            </div>

            {tables.length > 5 && (
              <div className="border-b border-borderline bg-canvas/30 px-3 py-2">
                <div className="relative">
                  <IconSearch className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="search"
                    placeholder="Filter tables..."
                    value={tableFilter}
                    onChange={(e) => setTableFilter(e.target.value)}
                    className="w-full rounded-md border border-borderline bg-canvas pl-8 pr-2.5 py-1 text-xs text-slate-100 placeholder-slate-500 focus:border-accent focus:outline-none"
                  />
                </div>
              </div>
            )}

            <div className="divide-y divide-borderline max-h-[60vh] overflow-y-auto">
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
                      className={`flex items-center justify-between gap-2 px-3.5 py-2.5 transition ${
                        active ? 'bg-accent/10 border-l-2 border-l-accent' : 'hover:bg-elevated/40'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          selectTable(t.name);
                          if (tab === 'sql') setTab('data');
                        }}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-mono text-xs font-medium text-slate-100">
                            {t.name}
                          </span>
                          {t.type === 'view' && (
                            <span className="rounded bg-sky-500/15 px-1 text-[9px] font-mono text-sky-300 uppercase">
                              view
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] font-mono text-slate-500">
                          {t.rowCount} row(s) · {t.columns.length} col(s)
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => setConfirmState({ kind: 'dropTable', table: t })}
                        title={`Drop ${t.type} ${t.name}`}
                        className="rounded p-1 text-slate-500 hover:bg-rose-500/15 hover:text-rose-400 shrink-0"
                      >
                        <IconTrash className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </aside>

          {/* Right: Main Workspace */}
          <div className="lg:col-span-9 space-y-4 min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-borderline pb-3">
              <div className="flex items-center gap-2">
                {(
                  [
                    { id: 'data', label: 'Rows & Data' },
                    { id: 'structure', label: 'Columns & Structure' },
                    { id: 'sql', label: 'SQL Script Runner' },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setTab(item.id)}
                    className={`rounded-lg px-3.5 py-1.5 text-xs font-medium transition ${
                      tab === item.id
                        ? 'bg-accent/15 text-accent border border-accent/40'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {activeTableInfo && tab !== 'sql' && (
                <div className="font-mono text-xs text-slate-400">
                  Selected: <span className="text-slate-100">{activeTableInfo.name}</span>
                </div>
              )}
            </div>

            {tab === 'sql' ? (
              <DatabaseSqlTab
                selectedTable={selectedTable}
                sqlText={sqlText}
                useTransaction={useTransaction}
                busy={busy}
                scriptError={sqlError}
                scriptResult={sqlResult}
                onChangeSql={setSqlText}
                onChangeUseTransaction={setUseTransaction}
                onExecute={() => void executeSqlScript(false)}
              />
            ) : !activeTableInfo ? (
              <div className="rounded-xl border border-borderline bg-surface p-10 text-center space-y-3">
                <p className="text-sm text-slate-300">No table selected or created yet.</p>
                <div className="flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCreateTableOpen(true)}
                    className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover"
                  >
                    + Create First Table
                  </button>
                  <button
                    type="button"
                    onClick={() => setTab('sql')}
                    className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs text-slate-200 hover:border-slate-500"
                  >
                    Open SQL Script Runner
                  </button>
                </div>
              </div>
            ) : tab === 'data' ? (
              <section className="rounded-xl border border-borderline bg-surface overflow-hidden">
                {/* Data Toolbar */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-borderline bg-canvas/50 px-4 py-3">
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      setPage(1);
                      setAppliedSearch(searchInput.trim());
                    }}
                    className="flex flex-wrap items-center gap-2 flex-1 min-w-[220px]"
                  >
                    <div className="relative flex-1 max-w-xs">
                      <IconSearch className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="search"
                        placeholder="Search any column..."
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        className="w-full rounded-lg border border-borderline bg-canvas pl-8 pr-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:border-accent focus:outline-none"
                      />
                    </div>
                    <button
                      type="submit"
                      className="rounded-lg border border-borderline bg-elevated px-3 py-1.5 text-xs text-slate-200 hover:border-slate-500"
                    >
                      Filter
                    </button>
                    {appliedSearch && (
                      <button
                        type="button"
                        onClick={() => {
                          setSearchInput('');
                          setAppliedSearch('');
                          setPage(1);
                        }}
                        className="text-xs text-slate-400 hover:text-slate-200"
                      >
                        Clear
                      </button>
                    )}
                  </form>

                  <div className="flex flex-wrap items-center gap-2">
                    {activeTableInfo.type === 'table' && selectedKeysList.length > 0 && (
                      <button
                        type="button"
                        onClick={() =>
                          setConfirmState({
                            kind: 'deleteRows',
                            table: activeTableInfo.name,
                            rowKeys: selectedKeysList,
                          })
                        }
                        className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-200 hover:bg-rose-500/20"
                      >
                        <IconTrash className="w-3.5 h-3.5" />
                        <span>Delete Selected ({selectedKeysList.length})</span>
                      </button>
                    )}
                    {activeTableInfo.type === 'table' && (
                      <button
                        type="button"
                        onClick={() =>
                          setRowModal({ open: true, mode: 'insert', row: null })
                        }
                        className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-accent-hover"
                      >
                        <IconPlus className="w-3.5 h-3.5" />
                        <span>Add Row</span>
                      </button>
                    )}
                  </div>
                </div>

                {rowsError && (
                  <div className="border-b border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-200">
                    {rowsError.message}
                  </div>
                )}

                <div className="overflow-x-auto max-h-[58vh]">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-borderline bg-canvas/40 font-mono text-[11px] text-slate-400 sticky top-0">
                      <tr>
                        {activeTableInfo.hasEditableKey && (
                          <th className="px-3 py-2.5 w-8">
                            <input
                              type="checkbox"
                              checked={
                                rowsList.length > 0 &&
                                rowsList.every(
                                  (r) =>
                                    r.rowKey &&
                                    Boolean(selectedRowKeys[JSON.stringify(r.rowKey)])
                                )
                              }
                              onChange={(e) => {
                                if (!e.target.checked) {
                                  setSelectedRowKeys({});
                                } else {
                                  const next: Record<string, DbRowKey> = {};
                                  for (const r of rowsList) {
                                    if (r.rowKey) next[JSON.stringify(r.rowKey)] = r.rowKey;
                                  }
                                  setSelectedRowKeys(next);
                                }
                              }}
                              className="rounded border-borderline bg-canvas text-accent"
                            />
                          </th>
                        )}
                        {currentCols.map((c) => (
                          <th key={c.name} className="px-3.5 py-2.5 font-medium whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => toggleSort(c.name)}
                              className="inline-flex items-center gap-1 hover:text-slate-100"
                            >
                              <span>{c.name}</span>
                              {c.pk > 0 && <span className="text-amber-400">*</span>}
                              {sortBy === c.name && (
                                <span className="text-accent">
                                  {sortDir === 'ASC' ? '↑' : '↓'}
                                </span>
                              )}
                            </button>
                          </th>
                        ))}
                        {activeTableInfo.hasEditableKey && (
                          <th className="px-3.5 py-2.5 text-right whitespace-nowrap">
                            Actions
                          </th>
                        )}
                      </tr>
                    </thead>

                    <tbody className="divide-y divide-borderline font-mono">
                      {rowsList.length === 0 ? (
                        <tr>
                          <td
                            colSpan={
                              currentCols.length + (activeTableInfo.hasEditableKey ? 2 : 0)
                            }
                            className="px-5 py-10 text-center font-sans text-xs text-slate-500"
                          >
                            {loadingRows ? 'Loading rows...' : 'No rows found.'}
                          </td>
                        </tr>
                      ) : (
                        rowsList.map((row, rIdx) => {
                          const rkStr = row.rowKey ? JSON.stringify(row.rowKey) : String(rIdx);
                          const isChecked = row.rowKey ? Boolean(selectedRowKeys[rkStr]) : false;
                          return (
                            <tr
                              key={rkStr}
                              className={`hover:bg-elevated/35 ${isChecked ? 'bg-accent/5' : ''}`}
                            >
                              {activeTableInfo.hasEditableKey && (
                                <td className="px-3 py-2">
                                  {row.rowKey && (
                                    <input
                                      type="checkbox"
                                      checked={isChecked}
                                      onChange={() => row.rowKey && toggleRowCheck(row.rowKey)}
                                      className="rounded border-borderline bg-canvas text-accent"
                                    />
                                  )}
                                </td>
                              )}
                              {currentCols.map((c) => {
                                const disp = formatDbCellDisplay(row.cells[c.name] ?? null);
                                return (
                                  <td
                                    key={c.name}
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
                              {activeTableInfo.hasEditableKey && (
                                <td className="px-3.5 py-2 text-right whitespace-nowrap space-x-2">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setRowModal({ open: true, mode: 'update', row })
                                    }
                                    className="rounded border border-borderline bg-elevated px-2 py-0.5 text-[11px] font-sans text-slate-200 hover:border-slate-500"
                                  >
                                    Edit
                                  </button>
                                  {row.rowKey && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        row.rowKey &&
                                        setConfirmState({
                                          kind: 'deleteRows',
                                          table: activeTableInfo.name,
                                          rowKeys: [row.rowKey],
                                        })
                                      }
                                      className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[11px] font-sans text-rose-300 hover:bg-rose-500/20"
                                    >
                                      Delete
                                    </button>
                                  )}
                                </td>
                              )}
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Pagination Bar */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-borderline bg-canvas/50 px-4 py-2.5 text-xs text-slate-400">
                  <div>
                    Total: <span className="font-mono text-slate-200">{totalRows}</span> row(s) ·
                    Page <span className="font-mono text-slate-200">{page}</span> of{' '}
                    <span className="font-mono text-slate-200">{totalPages}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={pageSize}
                      onChange={(e) => {
                        setPageSize(Number.parseInt(e.target.value, 10));
                        setPage(1);
                      }}
                      className="rounded-md border border-borderline bg-canvas px-2 py-1 text-xs text-slate-200"
                    >
                      {[25, 50, 100, 200].map((ps) => (
                        <option key={ps} value={ps}>
                          {ps} / page
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={page <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      className="rounded-md border border-borderline bg-elevated px-2.5 py-1 text-xs text-slate-200 disabled:opacity-40"
                    >
                      Prev
                    </button>
                    <button
                      type="button"
                      disabled={page >= totalPages}
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      className="rounded-md border border-borderline bg-elevated px-2.5 py-1 text-xs text-slate-200 disabled:opacity-40"
                    >
                      Next
                    </button>
                  </div>
                </div>
              </section>
            ) : (
              /* Structure & Columns Tab */
              <div className="space-y-4">
                <section className="rounded-xl border border-borderline bg-surface overflow-hidden">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-borderline px-5 py-3.5">
                    <div>
                      <h2 className="text-sm font-semibold text-slate-100">
                        Columns ({activeTableInfo.columns.length})
                      </h2>
                      <p className="text-xs text-slate-400">
                        Add, rename, re-type, or drop columns on{' '}
                        <span className="font-mono">{activeTableInfo.name}</span>.
                      </p>
                    </div>
                    {activeTableInfo.type === 'table' && (
                      <button
                        type="button"
                        onClick={() =>
                          setColModal({ open: true, mode: 'add', column: null })
                        }
                        className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-accent-hover"
                      >
                        <IconPlus className="w-3.5 h-3.5" />
                        <span>Add Column</span>
                      </button>
                    )}
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-borderline bg-canvas/50 uppercase text-[11px] text-slate-400">
                        <tr>
                          <th className="px-4 py-2.5 font-medium">#</th>
                          <th className="px-4 py-2.5 font-medium">Column</th>
                          <th className="px-4 py-2.5 font-medium">Type</th>
                          <th className="px-4 py-2.5 font-medium">Constraints</th>
                          <th className="px-4 py-2.5 font-medium">Default</th>
                          {activeTableInfo.type === 'table' && (
                            <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                          )}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-borderline font-mono">
                        {activeTableInfo.columns.map((col) => (
                          <tr key={col.name} className="hover:bg-elevated/35">
                            <td className="px-4 py-2.5 text-slate-500">{col.cid}</td>
                            <td className="px-4 py-2.5 font-semibold text-slate-100">
                              {col.name}
                            </td>
                            <td className="px-4 py-2.5 text-sky-300">
                              {col.type || 'ANY'}
                            </td>
                            <td className="px-4 py-2.5">
                              <div className="flex flex-wrap gap-1.5 font-sans">
                                {col.pk > 0 && (
                                  <StatusBadge tone="amber" label={`PK #${col.pk}`} />
                                )}
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
                            {activeTableInfo.type === 'table' && (
                              <td className="px-4 py-2.5 text-right whitespace-nowrap space-x-2 font-sans">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setColModal({ open: true, mode: 'update', column: col })
                                  }
                                  className="rounded border border-borderline bg-elevated px-2.5 py-1 text-[11px] text-slate-200 hover:border-slate-500"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  disabled={
                                    col.pk > 0 || activeTableInfo.columns.length <= 1
                                  }
                                  onClick={() =>
                                    setConfirmState({
                                      kind: 'dropColumn',
                                      table: activeTableInfo.name,
                                      column: col.name,
                                    })
                                  }
                                  className="rounded border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-[11px] text-rose-300 hover:bg-rose-500/20 disabled:opacity-30"
                                >
                                  Drop
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                {activeTableInfo.sql && (
                  <section className="rounded-xl border border-borderline bg-surface p-4 space-y-2">
                    <div className="text-xs font-semibold text-slate-300">
                      DDL Definition
                    </div>
                    <pre className="overflow-x-auto rounded-lg border border-borderline bg-[#080b10] p-3 font-mono text-[11px] text-slate-300 whitespace-pre-wrap">
                      {activeTableInfo.sql}
                    </pre>
                  </section>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modals */}
      <RowEditorModal
        open={rowModal.open}
        mode={rowModal.mode}
        tableName={selectedTable}
        columns={currentCols}
        row={rowModal.row}
        hasSingleIntPk={hasSingleIntPk}
        busy={busy}
        onClose={() => setRowModal({ open: false, mode: 'insert', row: null })}
        onSubmit={handleSaveRow}
      />

      <ColumnEditorModal
        open={colModal.open}
        mode={colModal.mode}
        tableName={selectedTable}
        existingColumn={colModal.column}
        busy={busy}
        onClose={() => setColModal({ open: false, mode: 'add', column: null })}
        onSubmit={handleSaveColumn}
      />

      <CreateTableModal
        open={createTableOpen}
        busy={busy}
        onClose={() => setCreateTableOpen(false)}
        onSubmit={handleCreateTable}
      />

      <ConfirmDbActionModal
        open={Boolean(confirmState)}
        title={
          confirmState?.kind === 'dropTable'
            ? `Drop ${confirmState.table.type} "${confirmState.table.name}"`
            : confirmState?.kind === 'dropColumn'
              ? `Drop Column "${confirmState.column}"`
              : confirmState?.kind === 'deleteRows'
                ? `Delete ${confirmState.rowKeys.length} Row(s)`
                : 'Confirm Destructive SQL Script'
        }
        message={
          confirmState?.kind === 'dropTable'
            ? `Permanently drop "${confirmState.table.name}" and all ${confirmState.table.rowCount} row(s)?`
            : confirmState?.kind === 'dropColumn'
              ? `Permanently drop column "${confirmState.column}" from "${confirmState.table}"?`
              : confirmState?.kind === 'deleteRows'
                ? `Permanently delete ${confirmState.rowKeys.length} selected row(s) from "${confirmState.table}"?`
                : 'The SQL script contains potentially destructive operations. Review before executing:'
        }
        confirmLabel={
          confirmState?.kind === 'dangerousSql' ? 'Run Destructive Script' : 'Confirm Delete'
        }
        warnings={confirmState?.kind === 'dangerousSql' ? confirmState.warnings : undefined}
        busy={busy}
        onClose={() => setConfirmState(null)}
        onConfirm={handleConfirmedAction}
      />
    </div>
  );
}
