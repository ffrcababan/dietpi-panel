'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import {
  IconColumns,
  IconPlus,
  IconRefresh,
  IconTable,
  IconTerminal,
} from '@/components/Icons';
import { usePanel } from '@/components/PanelContext';
import { StatusBadge } from '@/components/StatusBadge';
import { DatabaseDataTab } from '@/components/databases/DatabaseDataTab';
import {
  ColumnEditorModal,
  ConfirmDbActionModal,
  CreateTableModal,
  RowEditorModal,
  RowInspectorModal,
} from '@/components/databases/DatabaseModals';
import { DatabaseSidebar } from '@/components/databases/DatabaseSidebar';
import { DatabaseSqlTab } from '@/components/databases/DatabaseSqlTab';
import { DatabaseStructureTab } from '@/components/databases/DatabaseStructureTab';
import { apiFetcher, apiMutate } from '@/lib/client-api';
import { formatBytes } from '@/lib/format';
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

const MAX_SQL_HISTORY = 8;

export default function DatabaseStudioPage({
  params,
}: {
  params: { name: string };
}) {
  const dbName = decodeURIComponent(params.name);
  const { me } = usePanel();
  const sqlHistoryKey = `dp_sql_hist_${dbName}`;

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
  const [inspectRow, setInspectRow] = useState<DbRowItem | null>(null);
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
  const [sqlText, setSqlText] = useState(
    "SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name;"
  );
  const [useTransaction, setUseTransaction] = useState(true);
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [sqlResult, setSqlResult] = useState<DbScriptResponse | null>(null);
  const [sqlHistory, setSqlHistory] = useState<string[]>([]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(sqlHistoryKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setSqlHistory(parsed.filter((v): v is string => typeof v === 'string').slice(0, MAX_SQL_HISTORY));
        }
      }
    } catch {
      // ignore storage errors
    }
  }, [sqlHistoryKey]);

  const recordSqlHistory = useCallback(
    (sql: string) => {
      const clean = sql.trim();
      if (!clean) return;
      setSqlHistory((prev) => {
        const next = [clean, ...prev.filter((item) => item !== clean)].slice(0, MAX_SQL_HISTORY);
        try {
          window.localStorage.setItem(sqlHistoryKey, JSON.stringify(next));
        } catch {
          // ignore storage errors
        }
        return next;
      });
    },
    [sqlHistoryKey]
  );

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

  // Reset stale sortBy if column was dropped or renamed
  useEffect(() => {
    if (
      activeTableInfo &&
      sortBy &&
      !activeTableInfo.columns.some((c) => c.name === sortBy)
    ) {
      setSortBy('');
    }
  }, [activeTableInfo, sortBy]);

  // Debounce live table search nicely without manual Enter requirement
  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === appliedSearch) return;
    const timer = window.setTimeout(() => {
      setPage(1);
      setAppliedSearch(trimmed);
    }, 320);
    return () => window.clearTimeout(timer);
  }, [searchInput, appliedSearch]);

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

  const rowsMatchesTable = Boolean(rowsData && rowsData.table === selectedTable);
  const totalRows = rowsMatchesTable ? (rowsData?.totalRows ?? 0) : (activeTableInfo?.rowCount ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));

  // Clamp page cleanly if deleting rows shrunk totalPages below current page
  useEffect(() => {
    if (rowsMatchesTable && page > totalPages) {
      setPage(totalPages);
    }
  }, [rowsMatchesTable, page, totalPages]);

  const filteredTables = useMemo(() => {
    const q = tableFilter.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter((t) => t.name.toLowerCase().includes(q));
  }, [tables, tableFilter]);

  const selectTable = useCallback(
    (tName: string) => {
      setSelectedTable(tName);
      setPage(1);
      setSearchInput('');
      setAppliedSearch('');
      setSortBy('');
      setSortDir('ASC');
      setSelectedRowKeys({});
      if (tab === 'sql') setTab('data');
    },
    [tab]
  );

  const refreshAll = useCallback(async () => {
    await Promise.all([mutateSchema(), rowsUrl ? mutateRows() : Promise.resolve()]);
  }, [mutateSchema, mutateRows, rowsUrl]);

  const toggleSort = useCallback(
    (colName: string) => {
      if (sortBy === colName) {
        setSortDir((d) => (d === 'ASC' ? 'DESC' : 'ASC'));
      } else {
        setSortBy(colName);
        setSortDir('ASC');
      }
      setPage(1);
    },
    [sortBy]
  );

  const toggleRowCheck = useCallback((keyObj: DbRowKey) => {
    const id = JSON.stringify(keyObj);
    setSelectedRowKeys((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = keyObj;
      return next;
    });
  }, []);

  const handleToggleAllPageRows = useCallback(
    (checked: boolean) => {
      if (!checked || !rowsData || rowsData.table !== selectedTable) {
        setSelectedRowKeys({});
        return;
      }
      const next: Record<string, DbRowKey> = {};
      for (const r of rowsData.rows) {
        if (r.rowKey) next[JSON.stringify(r.rowKey)] = r.rowKey;
      }
      setSelectedRowKeys(next);
    },
    [rowsData, selectedTable]
  );

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
      setPage(1);
      setSearchInput('');
      setAppliedSearch('');
      setSortBy('');
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
      recordSqlHistory(sqlText);
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
          setSelectedRowKeys({});
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

  const currentCols =
    activeTableInfo?.columns ?? (rowsMatchesTable ? rowsData?.columns : undefined) ?? [];
  const rowsList = rowsMatchesTable ? (rowsData?.rows ?? []) : [];
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
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight font-mono text-slate-100">
              {dbName}
            </h1>
            {schemaData?.sqliteVersion && (
              <StatusBadge tone="blue" label={`SQLite ${schemaData.sqliteVersion}`} />
            )}
            {schemaData?.journalMode && (
              <StatusBadge tone="green" label={schemaData.journalMode} />
            )}
            <StatusBadge
              tone="slate"
              label={`${tables.length} ${tables.length === 1 ? 'object' : 'objects'}`}
            />
            {typeof schemaData?.dbSizeBytes === 'number' && (
              <StatusBadge tone="slate" label={formatBytes(schemaData.dbSizeBytes)} />
            )}
          </div>
          <p className="mt-1 text-xs font-mono text-slate-400">
            /srv/db/{dbName}/data.sqlite · Managed via PDO SQLite as {me?.webUser || 'www-data'}
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
          <span className="break-all">{schemaError.message}</span>
          <Link
            href="/databases"
            className="rounded-lg border border-borderline bg-surface px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500 shrink-0"
          >
            Back to Databases
          </Link>
        </div>
      ) : (
        <div className="flex flex-col lg:flex-row gap-5 items-start">
          {/* Tables & Views Explorer */}
          <DatabaseSidebar
            tables={tables}
            filteredTables={filteredTables}
            selectedTable={selectedTable}
            tableFilter={tableFilter}
            onChangeFilter={setTableFilter}
            onSelectTable={selectTable}
            onCreateTable={() => setCreateTableOpen(true)}
            onDropTable={(t) => setConfirmState({ kind: 'dropTable', table: t })}
          />

          {/* Main Studio Workspace */}
          <div className="flex-1 w-full min-w-0 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-borderline bg-surface/70 px-3 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setTab('data')}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    tab === 'data'
                      ? 'bg-accent/15 text-accent border border-accent/40'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-elevated/60 border border-transparent'
                  }`}
                >
                  <IconTable className="w-3.5 h-3.5" />
                  <span>Rows &amp; Data</span>
                </button>
                <button
                  type="button"
                  onClick={() => setTab('structure')}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    tab === 'structure'
                      ? 'bg-accent/15 text-accent border border-accent/40'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-elevated/60 border border-transparent'
                  }`}
                >
                  <IconColumns className="w-3.5 h-3.5" />
                  <span>Columns &amp; Structure</span>
                </button>
                <button
                  type="button"
                  onClick={() => setTab('sql')}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    tab === 'sql'
                      ? 'bg-accent/15 text-accent border border-accent/40'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-elevated/60 border border-transparent'
                  }`}
                >
                  <IconTerminal className="w-3.5 h-3.5" />
                  <span>SQL Script Workbench</span>
                </button>
              </div>

              {activeTableInfo && tab !== 'sql' && (
                <div className="flex items-center gap-2 font-mono text-xs text-slate-400 px-1">
                  <span>Active:</span>
                  <span className="rounded bg-canvas px-2 py-0.5 text-slate-100 border border-borderline">
                    {activeTableInfo.name}
                  </span>
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
                history={sqlHistory}
                onChangeSql={setSqlText}
                onChangeUseTransaction={setUseTransaction}
                onClearHistory={() => {
                  setSqlHistory([]);
                  try {
                    window.localStorage.removeItem(sqlHistoryKey);
                  } catch {
                    // ignore
                  }
                }}
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
                    Open SQL Script Workbench
                  </button>
                </div>
              </div>
            ) : tab === 'data' ? (
              <DatabaseDataTab
                tableInfo={activeTableInfo}
                columns={currentCols}
                rows={rowsList}
                rowsMatchesTable={rowsMatchesTable}
                loadingRows={loadingRows}
                rowsError={rowsError ? rowsError.message : null}
                searchInput={searchInput}
                appliedSearch={appliedSearch}
                sortBy={sortBy}
                sortDir={sortDir}
                page={page}
                pageSize={pageSize}
                totalRows={totalRows}
                totalPages={totalPages}
                selectedRowKeys={selectedRowKeys}
                onChangeSearchInput={setSearchInput}
                onApplySearch={() => {
                  setPage(1);
                  setAppliedSearch(searchInput.trim());
                }}
                onClearSearch={() => {
                  setSearchInput('');
                  setAppliedSearch('');
                  setPage(1);
                }}
                onToggleSort={toggleSort}
                onToggleRowCheck={toggleRowCheck}
                onToggleAllPageRows={handleToggleAllPageRows}
                onOpenInsertRow={() => setRowModal({ open: true, mode: 'insert', row: null })}
                onOpenInspectRow={(r) => setInspectRow(r)}
                onOpenEditRow={(r) => setRowModal({ open: true, mode: 'update', row: r })}
                onRequestDeleteRows={(rowKeys) =>
                  setConfirmState({
                    kind: 'deleteRows',
                    table: activeTableInfo.name,
                    rowKeys,
                  })
                }
                onChangePage={setPage}
                onChangePageSize={(nextSize) => {
                  setPageSize(nextSize);
                  setPage(1);
                }}
              />
            ) : (
              <DatabaseStructureTab
                tableInfo={activeTableInfo}
                onAddColumn={() => setColModal({ open: true, mode: 'add', column: null })}
                onEditColumn={(col) =>
                  setColModal({ open: true, mode: 'update', column: col })
                }
                onDropColumn={(colName) =>
                  setConfirmState({
                    kind: 'dropColumn',
                    table: activeTableInfo.name,
                    column: colName,
                  })
                }
              />
            )}
          </div>
        </div>
      )}

      {/* Modals */}
      <RowInspectorModal
        open={Boolean(inspectRow)}
        tableName={selectedTable}
        columns={currentCols}
        row={inspectRow}
        hasEditableKey={Boolean(activeTableInfo?.hasEditableKey)}
        onClose={() => setInspectRow(null)}
        onEdit={(r) => setRowModal({ open: true, mode: 'update', row: r })}
      />

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
