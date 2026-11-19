'use client';

import React, { useEffect, useState } from 'react';
import {
  IconCheck,
  IconCopy,
  IconEdit,
  IconEye,
  IconPlus,
  IconShield,
  IconTrash,
} from '@/components/Icons';
import { Modal } from '@/components/Modal';
import {
  formatRawCellText,
  tryFormatPrettyJson,
} from '@/components/databases/exportUtils';
import type {
  DbCellValue,
  DbColumnInfo,
  DbRowItem,
} from '@/app/api/databases/[name]/manage/route';

const SQLITE_TYPES = [
  'TEXT',
  'INTEGER',
  'REAL',
  'NUMERIC',
  'BLOB',
  'BOOLEAN',
  'DATETIME',
  'VARCHAR(255)',
];

type DefaultMode =
  | 'keep'
  | 'none'
  | 'null'
  | 'current_timestamp'
  | 'empty_string'
  | 'number'
  | 'string';

interface RowFieldDraft {
  mode: 'value' | 'null' | 'default' | 'keep_blob';
  value: string;
  valueType: 'text' | 'integer' | 'number';
  blobBytes?: number;
}

function inferValueType(colType: string): 'text' | 'integer' | 'number' {
  const upper = colType.toUpperCase();
  if (upper.includes('INT')) return 'integer';
  if (
    upper.includes('REAL') ||
    upper.includes('FLOA') ||
    upper.includes('DOUB') ||
    upper.includes('DEC') ||
    upper.includes('NUM')
  ) {
    return 'number';
  }
  return 'text';
}

function isBlobCell(v: DbCellValue | undefined): v is { __blob: true; bytes: number; base64: string } {
  return Boolean(v && typeof v === 'object' && '__blob' in v);
}

export function RowEditorModal({
  open,
  mode,
  tableName,
  columns,
  row,
  hasSingleIntPk,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: 'insert' | 'update';
  tableName: string;
  columns: DbColumnInfo[];
  row: DbRowItem | null;
  hasSingleIntPk: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (values: Record<string, { isNull?: boolean; value?: string; valueType?: string }>) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, RowFieldDraft>>({});
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErrMsg(null);
    const next: Record<string, RowFieldDraft> = {};
    for (const col of columns) {
      const vt = inferValueType(col.type);
      if (mode === 'update' && row) {
        const cell = row.cells[col.name];
        if (isBlobCell(cell)) {
          next[col.name] = {
            mode: 'keep_blob',
            value: '',
            valueType: vt,
            blobBytes: cell.bytes,
          };
        } else if (cell === null || cell === undefined) {
          next[col.name] = { mode: 'null', value: '', valueType: vt };
        } else {
          next[col.name] = { mode: 'value', value: String(cell), valueType: vt };
        }
      } else {
        const isAutoCol =
          (col.pk === 1 && hasSingleIntPk && col.type.toUpperCase().includes('INT')) ||
          col.defaultValue !== null;
        next[col.name] = {
          mode: isAutoCol ? 'default' : col.notnull ? 'value' : 'null',
          value: '',
          valueType: vt,
        };
      }
    }
    setDrafts(next);
  }, [open, mode, row, columns, hasSingleIntPk]);

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setErrMsg(null);
    const payload: Record<string, { isNull?: boolean; value?: string; valueType?: string }> = {};
    for (const col of columns) {
      const d = drafts[col.name];
      if (!d || d.mode === 'default' || d.mode === 'keep_blob') continue;
      if (d.mode === 'null') {
        payload[col.name] = { isNull: true };
      } else {
        const origCell = mode === 'update' && row ? row.cells[col.name] : undefined;
        const preserveDynamicText = typeof origCell === 'string' && d.value === origCell;
        payload[col.name] = {
          isNull: false,
          value: d.value,
          valueType: preserveDynamicText ? 'text' : d.valueType,
        };
      }
    }
    if (mode === 'update' && Object.keys(payload).length === 0) {
      onClose();
      return;
    }
    try {
      await onSubmit(payload);
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'Failed to save row');
    }
  };

  return (
    <Modal
      open={open}
      title={mode === 'insert' ? `Insert Row into ${tableName}` : `Edit Row in ${tableName}`}
      subtitle={
        mode === 'insert'
          ? 'Use "Default / Auto" on PRIMARY KEY or defaulted columns to let SQLite auto-populate them.'
          : 'All values are bound safely via PDO prepared statements.'
      }
      onClose={() => !busy && onClose()}
      maxWidthClass="max-w-xl"
    >
      <form onSubmit={handleFormSubmit} className="space-y-4">
        {errMsg && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-200">
            {errMsg}
          </div>
        )}

        <div className="max-h-[58vh] overflow-y-auto space-y-3 pr-1">
          {columns.map((col) => {
            const d = drafts[col.name] ?? {
              mode: 'value',
              value: '',
              valueType: inferValueType(col.type),
            };
            const updateDraft = (patch: Partial<RowFieldDraft>) =>
              setDrafts((prev) => ({
                ...prev,
                [col.name]: { ...d, ...patch },
              }));

            return (
              <div
                key={col.name}
                className="rounded-lg border border-borderline bg-canvas p-3 space-y-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="font-mono font-semibold text-slate-100">
                      {col.name}
                    </span>
                    <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                      {col.type || 'ANY'}
                    </span>
                    {col.pk > 0 && (
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">
                        PK
                      </span>
                    )}
                    {col.notnull && (
                      <span className="rounded bg-sky-500/15 px-1.5 py-0.5 font-mono text-[10px] text-sky-300">
                        NOT NULL
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 text-[11px]">
                    {mode === 'insert' && (
                      <label className="flex items-center gap-1 text-slate-400 cursor-pointer">
                        <input
                          type="checkbox"
                          disabled={busy}
                          checked={d.mode === 'default'}
                          onChange={(e) =>
                            updateDraft({
                              mode: e.target.checked ? 'default' : 'value',
                            })
                          }
                          className="rounded border-borderline bg-surface text-accent"
                        />
                        <span>Default/Auto</span>
                      </label>
                    )}
                    {!col.notnull && d.mode !== 'keep_blob' && (
                      <label className="flex items-center gap-1 text-slate-400 cursor-pointer">
                        <input
                          type="checkbox"
                          disabled={busy}
                          checked={d.mode === 'null'}
                          onChange={(e) =>
                            updateDraft({
                              mode: e.target.checked ? 'null' : 'value',
                            })
                          }
                          className="rounded border-borderline bg-surface text-accent"
                        />
                        <span>NULL</span>
                      </label>
                    )}
                  </div>
                </div>

                {d.mode === 'keep_blob' ? (
                  <div className="flex items-center justify-between rounded-md border border-borderline bg-surface px-3 py-1.5 font-mono text-[11px] text-slate-400">
                    <span>Binary BLOB ({d.blobBytes ?? 0} bytes) — preserved unchanged</span>
                    <button
                      type="button"
                      onClick={() => updateDraft({ mode: 'value', value: '' })}
                      className="text-accent hover:underline"
                    >
                      Replace as Text
                    </button>
                  </div>
                ) : d.mode === 'default' ? (
                  <div className="rounded-md border border-dashed border-borderline px-3 py-1.5 font-mono text-[11px] text-slate-500">
                    {col.defaultValue !== null
                      ? `Will use DEFAULT ${col.defaultValue}`
                      : 'Will auto-generate value'}
                  </div>
                ) : d.mode === 'null' ? (
                  <div className="rounded-md border border-dashed border-borderline px-3 py-1.5 font-mono text-[11px] italic text-slate-500">
                    NULL
                  </div>
                ) : (
                  <textarea
                    rows={d.value.includes('\n') || d.value.length > 80 ? 3 : 1}
                    disabled={busy}
                    value={d.value}
                    onChange={(e) => updateDraft({ value: e.target.value })}
                    placeholder={
                      col.defaultValue !== null ? `Default: ${col.defaultValue}` : 'Enter value...'
                    }
                    className="w-full rounded-md border border-borderline bg-surface px-3 py-1.5 font-mono text-xs text-slate-100 placeholder-slate-600 focus:border-accent focus:outline-none"
                  />
                )}
              </div>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs text-slate-300"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50"
          >
            <IconCheck className="w-3.5 h-3.5" />
            <span>{busy ? 'Saving...' : mode === 'insert' ? 'Insert Row' : 'Save Changes'}</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ColumnEditorModal({
  open,
  mode,
  tableName,
  existingColumn,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: 'add' | 'update';
  tableName: string;
  existingColumn: DbColumnInfo | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (payload: {
    name: string;
    type: string;
    notNull: boolean;
    updateDefault?: boolean;
    defaultMode: string;
    defaultValue: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState('TEXT');
  const [notNull, setNotNull] = useState(false);
  const [defaultMode, setDefaultMode] = useState<DefaultMode>('none');
  const [defaultValue, setDefaultValue] = useState('');
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErrMsg(null);
    if (mode === 'update' && existingColumn) {
      setName(existingColumn.name);
      setType(existingColumn.type || 'TEXT');
      setNotNull(existingColumn.notnull);
      setDefaultMode('keep');
      const rawDefault = existingColumn.defaultValue ?? '';
      if (/^'(.*)'$/.test(rawDefault)) {
        setDefaultValue(rawDefault.slice(1, -1).replace(/''/g, "'"));
      } else {
        setDefaultValue(rawDefault);
      }
    } else {
      setName('');
      setType('TEXT');
      setNotNull(false);
      setDefaultMode('none');
      setDefaultValue('');
    }
  }, [open, mode, existingColumn]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setErrMsg(null);
    try {
      await onSubmit({
        name: name.trim(),
        type: type.trim() || 'TEXT',
        notNull,
        updateDefault: mode === 'update' ? defaultMode !== 'keep' : true,
        defaultMode: defaultMode === 'keep' ? 'none' : defaultMode,
        defaultValue,
      });
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'Column operation failed');
    }
  };

  return (
    <Modal
      open={open}
      title={mode === 'add' ? `Add Column to ${tableName}` : `Update Column "${existingColumn?.name}"`}
      subtitle={
        mode === 'add'
          ? 'Runs ALTER TABLE ADD COLUMN on SQLite.'
          : 'Name-only edits use native RENAME COLUMN; type/constraint changes rebuild the table safely in a transaction.'
      }
      onClose={() => !busy && onClose()}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {errMsg && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-200">
            {errMsg}
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1">
            Column Name
          </label>
          <input
            type="text"
            required
            autoFocus
            disabled={busy}
            placeholder="e.g. status"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-sm text-slate-100 focus:border-accent focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1">
            SQLite Data Type
          </label>
          <div className="flex gap-2">
            <select
              disabled={busy}
              value={SQLITE_TYPES.includes(type.toUpperCase()) ? type.toUpperCase() : '__custom__'}
              onChange={(e) => {
                if (e.target.value !== '__custom__') setType(e.target.value);
              }}
              className="rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-xs text-slate-100 focus:border-accent focus:outline-none"
            >
              {SQLITE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
              {!SQLITE_TYPES.includes(type.toUpperCase()) && (
                <option value="__custom__">Custom</option>
              )}
            </select>
            <input
              type="text"
              disabled={busy}
              value={type}
              onChange={(e) => setType(e.target.value.toUpperCase())}
              className="flex-1 rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-xs text-slate-100 focus:border-accent focus:outline-none"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            disabled={busy || (mode === 'update' && Boolean(existingColumn?.pk))}
            checked={notNull}
            onChange={(e) => setNotNull(e.target.checked)}
            className="rounded border-borderline bg-canvas text-accent"
          />
          <span>NOT NULL constraint</span>
        </label>

        <div className="space-y-2">
          <label className="block text-xs font-medium text-slate-300">
            Default Value
          </label>
          <select
            disabled={busy}
            value={defaultMode}
            onChange={(e) => setDefaultMode(e.target.value as DefaultMode)}
            className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 text-xs text-slate-100 focus:border-accent focus:outline-none"
          >
            {mode === 'update' && (
              <option value="keep">
                Keep existing ({existingColumn?.defaultValue ?? 'no default'})
              </option>
            )}
            <option value="none">No DEFAULT</option>
            <option value="string">Text literal (quoted string)</option>
            <option value="number">Numeric literal (integer/decimal)</option>
            <option value="empty_string">Empty string (&apos;&apos;)</option>
            <option value="current_timestamp">CURRENT_TIMESTAMP</option>
            <option value="null">NULL</option>
          </select>

          {(defaultMode === 'string' || defaultMode === 'number') && (
            <input
              type="text"
              required
              disabled={busy}
              placeholder={defaultMode === 'number' ? 'e.g. 0' : 'e.g. active'}
              value={defaultValue}
              onChange={(e) => setDefaultValue(e.target.value)}
              className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-xs text-slate-100 focus:border-accent focus:outline-none"
            />
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs text-slate-300"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? 'Applying...' : mode === 'add' ? 'Add Column' : 'Save Column'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface NewTableColDraft {
  name: string;
  type: string;
  primaryKey: boolean;
  autoIncrement: boolean;
  notNull: boolean;
  defaultMode: 'none' | 'string' | 'number' | 'current_timestamp';
  defaultValue: string;
}

export function CreateTableModal({
  open,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (payload: { tableName: string; columns: NewTableColDraft[] }) => Promise<void>;
}) {
  const [tableName, setTableName] = useState('');
  const [cols, setCols] = useState<NewTableColDraft[]>([]);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTableName('');
    setErrMsg(null);
    setCols([
      {
        name: 'id',
        type: 'INTEGER',
        primaryKey: true,
        autoIncrement: true,
        notNull: true,
        defaultMode: 'none',
        defaultValue: '',
      },
      {
        name: 'created_at',
        type: 'DATETIME',
        primaryKey: false,
        autoIncrement: false,
        notNull: true,
        defaultMode: 'current_timestamp',
        defaultValue: '',
      },
    ]);
  }, [open]);

  const updateCol = (idx: number, patch: Partial<NewTableColDraft>) => {
    setCols((prev) => {
      const updated = prev.map((c, i) => {
        if (i !== idx) return c;
        const merged = { ...c, ...patch };
        if (!merged.primaryKey || merged.type.toUpperCase() !== 'INTEGER') {
          merged.autoIncrement = false;
        }
        return merged;
      });
      const pkCount = updated.filter((c) => c.primaryKey).length;
      if (pkCount > 1) {
        return updated.map((c) => ({ ...c, autoIncrement: false }));
      }
      return updated;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !tableName.trim() || cols.length === 0) return;
    setErrMsg(null);
    try {
      await onSubmit({
        tableName: tableName.trim(),
        columns: cols.map((c) => ({ ...c, name: c.name.trim() })),
      });
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'Failed to create table');
    }
  };

  return (
    <Modal
      open={open}
      title="Create SQLite Table"
      subtitle="Define table name and columns."
      onClose={() => !busy && onClose()}
      maxWidthClass="max-w-2xl"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {errMsg && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-200">
            {errMsg}
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1">
            Table Name
          </label>
          <input
            type="text"
            required
            autoFocus
            disabled={busy}
            placeholder="e.g. posts"
            value={tableName}
            onChange={(e) => setTableName(e.target.value)}
            className="w-full rounded-lg border border-borderline bg-canvas px-3 py-2 font-mono text-sm text-slate-100 focus:border-accent focus:outline-none"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-300">Columns ({cols.length})</span>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                setCols((prev) => [
                  ...prev,
                  {
                    name: '',
                    type: 'TEXT',
                    primaryKey: false,
                    autoIncrement: false,
                    notNull: false,
                    defaultMode: 'none',
                    defaultValue: '',
                  },
                ])
              }
              className="inline-flex items-center gap-1 rounded-md border border-borderline bg-elevated px-2.5 py-1 text-[11px] text-slate-200 hover:border-slate-500"
            >
              <IconPlus className="w-3 h-3" />
              <span>Add Column</span>
            </button>
          </div>

          <div className="max-h-[45vh] overflow-y-auto space-y-2 pr-1">
            {cols.map((col, idx) => (
              <div
                key={idx}
                className="rounded-lg border border-borderline bg-canvas p-3 space-y-2"
              >
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                  <input
                    type="text"
                    required
                    disabled={busy}
                    placeholder="column_name"
                    value={col.name}
                    onChange={(e) => updateCol(idx, { name: e.target.value })}
                    className="sm:col-span-4 rounded-md border border-borderline bg-surface px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-accent focus:outline-none"
                  />
                  <select
                    disabled={busy}
                    value={col.type}
                    onChange={(e) => updateCol(idx, { type: e.target.value })}
                    className="sm:col-span-3 rounded-md border border-borderline bg-surface px-2 py-1.5 font-mono text-xs text-slate-100 focus:border-accent focus:outline-none"
                  >
                    {SQLITE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <select
                    disabled={busy}
                    value={col.defaultMode}
                    onChange={(e) =>
                      updateCol(idx, {
                        defaultMode: e.target.value as NewTableColDraft['defaultMode'],
                      })
                    }
                    className="sm:col-span-4 rounded-md border border-borderline bg-surface px-2 py-1.5 text-xs text-slate-200 focus:border-accent focus:outline-none"
                  >
                    <option value="none">No Default</option>
                    <option value="string">Text Default</option>
                    <option value="number">Number Default</option>
                    <option value="current_timestamp">CURRENT_TIMESTAMP</option>
                  </select>
                  <button
                    type="button"
                    disabled={busy || cols.length <= 1}
                    onClick={() => setCols((prev) => prev.filter((_, i) => i !== idx))}
                    className="sm:col-span-1 flex items-center justify-center rounded-md border border-borderline text-rose-400 hover:bg-rose-500/15 disabled:opacity-30"
                    title="Remove column"
                  >
                    <IconTrash className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-4 text-[11px] text-slate-400">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={col.primaryKey}
                      onChange={(e) =>
                        updateCol(idx, {
                          primaryKey: e.target.checked,
                          autoIncrement: e.target.checked ? col.autoIncrement : false,
                        })
                      }
                      className="rounded border-borderline bg-surface text-accent"
                    />
                    <span>Primary Key</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={!col.primaryKey || col.type !== 'INTEGER' || cols.filter((c) => c.primaryKey).length > 1}
                      checked={col.autoIncrement}
                      onChange={(e) => updateCol(idx, { autoIncrement: e.target.checked })}
                      className="rounded border-borderline bg-surface text-accent disabled:opacity-40"
                    />
                    <span>Auto Increment</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={col.notNull}
                      onChange={(e) => updateCol(idx, { notNull: e.target.checked })}
                      className="rounded border-borderline bg-surface text-accent"
                    />
                    <span>NOT NULL</span>
                  </label>
                  {(col.defaultMode === 'string' || col.defaultMode === 'number') && (
                    <input
                      type="text"
                      required
                      placeholder="default value"
                      value={col.defaultValue}
                      onChange={(e) => updateCol(idx, { defaultValue: e.target.value })}
                      className="flex-1 min-w-[120px] rounded border border-borderline bg-surface px-2 py-0.5 font-mono text-[11px] text-slate-100"
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs text-slate-300"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !tableName.trim()}
            className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? 'Creating...' : 'Create Table'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ConfirmDbActionModal({
  open,
  title,
  message,
  confirmLabel,
  warnings,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  warnings?: string[];
  busy: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    if (open) setErrMsg(null);
  }, [open]);

  return (
    <Modal
      open={open}
      title={title}
      subtitle="Please confirm this permanent database modification."
      onClose={() => !busy && onClose()}
      badge={<IconShield className="w-4 h-4 text-rose-400" />}
    >
      <div className="space-y-4">
        {errMsg && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-200">
            {errMsg}
          </div>
        )}
        <p className="text-xs text-slate-300 leading-relaxed">{message}</p>
        {warnings && warnings.length > 0 && (
          <ul className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 space-y-1 font-mono text-[11px] text-amber-200">
            {warnings.map((w, i) => (
              <li key={i}>• {w}</li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs text-slate-300"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setErrMsg(null);
              try {
                await onConfirm();
              } catch (err) {
                setErrMsg(err instanceof Error ? err.message : 'Action failed');
              }
            }}
            className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
          >
            {busy ? 'Executing...' : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function RowInspectorModal({
  open,
  tableName,
  columns,
  row,
  hasEditableKey,
  onClose,
  onEdit,
}: {
  open: boolean;
  tableName: string;
  columns: DbColumnInfo[];
  row: DbRowItem | null;
  hasEditableKey: boolean;
  onClose: () => void;
  onEdit: (row: DbRowItem) => void;
}) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    if (open) setCopiedKey(null);
  }, [open, row]);

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 1600);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <Modal
      open={open}
      title={`Inspect Row · ${tableName}`}
      subtitle="Full unclipped field values and automatic JSON formatting."
      onClose={onClose}
      badge={<IconEye className="w-4 h-4 text-accent" />}
      maxWidthClass="max-w-2xl"
    >
      {!row ? null : (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] text-slate-400">
              {columns.length} field(s)
            </span>
            <button
              type="button"
              onClick={() => copyText('__all__', JSON.stringify(row.cells, null, 2))}
              className="inline-flex items-center gap-1.5 rounded-lg border border-borderline bg-elevated px-2.5 py-1 text-[11px] text-slate-200 hover:border-slate-500 transition"
            >
              {copiedKey === '__all__' ? (
                <>
                  <IconCheck className="w-3 h-3 text-emerald-400" />
                  <span>Copied JSON</span>
                </>
              ) : (
                <>
                  <IconCopy className="w-3 h-3" />
                  <span>Copy Row JSON</span>
                </>
              )}
            </button>
          </div>

          <div className="max-h-[58vh] overflow-y-auto space-y-2.5 pr-1">
            {columns.map((col) => {
              const val = row.cells[col.name] ?? null;
              const isNull = val === null || val === undefined;
              const isBlob = typeof val === 'object' && val !== null && '__blob' in val;
              const prettyJson = isNull || isBlob ? null : tryFormatPrettyJson(val);
              const rawText = formatRawCellText(val);

              return (
                <div
                  key={col.name}
                  className="rounded-lg border border-borderline bg-canvas p-3 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="font-mono font-semibold text-slate-100">
                        {col.name}
                      </span>
                      <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                        {col.type || 'ANY'}
                      </span>
                      {col.pk > 0 && (
                        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">
                          PK
                        </span>
                      )}
                      {prettyJson && (
                        <span className="rounded bg-sky-500/15 px-1.5 py-0.5 font-mono text-[10px] text-sky-300">
                          JSON
                        </span>
                      )}
                    </div>

                    {!isNull && (
                      <button
                        type="button"
                        onClick={() => copyText(col.name, prettyJson ?? rawText)}
                        className="inline-flex items-center gap-1 rounded border border-borderline bg-surface px-2 py-0.5 text-[10px] text-slate-300 hover:text-white"
                      >
                        {copiedKey === col.name ? (
                          <IconCheck className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <IconCopy className="w-3 h-3" />
                        )}
                        <span>{copiedKey === col.name ? 'Copied' : 'Copy'}</span>
                      </button>
                    )}
                  </div>

                  {isNull ? (
                    <div className="font-mono text-xs italic text-slate-500">NULL</div>
                  ) : isBlob ? (
                    <div className="rounded bg-[#080b10] p-2 font-mono text-[11px] text-purple-300 break-all">
                      [Binary BLOB · {(val as { bytes: number }).bytes} bytes]
                    </div>
                  ) : (
                    <pre className="max-h-48 overflow-auto rounded bg-[#080b10] border border-borderline/60 p-2.5 font-mono text-[11px] text-slate-200 whitespace-pre-wrap break-words">
                      {prettyJson ?? rawText}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-borderline bg-elevated px-4 py-2 text-xs text-slate-300 hover:text-white"
            >
              Close
            </button>
            {hasEditableKey && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onEdit(row);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-accent-hover"
              >
                <IconEdit className="w-3.5 h-3.5" />
                <span>Edit Row</span>
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
