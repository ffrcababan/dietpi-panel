'use client';

import React, { useState } from 'react';
import { IconEye, IconEyeOff } from './Icons';

interface PasswordInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  wrapperClassName?: string;
}

export function PasswordInput({
  className = '',
  wrapperClassName = '',
  ...props
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className={`relative ${wrapperClassName}`}>
      <input
        {...props}
        type={visible ? 'text' : 'password'}
        className={`w-full rounded-lg border border-borderline bg-canvas pl-3 pr-10 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-accent focus:outline-none ${className}`}
      />
      <button
        type="button"
        onClick={() => setVisible((prev) => !prev)}
        disabled={props.disabled}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        title={visible ? 'Hide password' : 'Show password'}
        className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-200 disabled:opacity-40 transition"
      >
        {visible ? <IconEyeOff className="w-4 h-4" /> : <IconEye className="w-4 h-4" />}
      </button>
    </div>
  );
}
