import React from 'react';

type Tone = 'green' | 'red' | 'amber' | 'blue' | 'slate';

const TONE_CLASSES: Record<Tone, string> = {
  green: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  red: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  blue: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  slate: 'border-slate-600/40 bg-slate-700/20 text-slate-300',
};

const DOT_CLASSES: Record<Tone, string> = {
  green: 'bg-emerald-400',
  red: 'bg-rose-400',
  amber: 'bg-amber-400',
  blue: 'bg-sky-400',
  slate: 'bg-slate-400',
};

export function StatusBadge({
  tone,
  label,
  dot = false,
}: {
  tone: Tone;
  label: string;
  dot?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]}`}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${DOT_CLASSES[tone]}`} />}
      {label}
    </span>
  );
}
