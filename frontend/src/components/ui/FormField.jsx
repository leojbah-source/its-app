function FieldShell({ label, hint, error, required, children, htmlFor }) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={htmlFor} className="text-sm font-medium text-navy-800">
          {label}
          {required && <span className="ml-0.5 text-gold-500">*</span>}
        </label>
      )}
      {children}
      {hint && !error && <p className="text-xs text-slate-500">{hint}</p>}
      {error && <p className="text-xs font-medium text-red-600">{error}</p>}
    </div>
  );
}

export function Input({ label, hint, error, required, id, className = '', ...props }) {
  return (
    <FieldShell label={label} hint={hint} error={error} required={required} htmlFor={id}>
      <input
        id={id}
        className={`w-full rounded-md border px-3 py-2 text-sm text-slate-800 shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-navy-300 ${
          error ? 'border-red-400' : 'border-slate-300 focus:border-navy-500'
        } ${className}`}
        {...props}
      />
    </FieldShell>
  );
}

export function Select({ label, hint, error, required, id, className = '', children, ...props }) {
  return (
    <FieldShell label={label} hint={hint} error={error} required={required} htmlFor={id}>
      <select
        id={id}
        className={`w-full rounded-md border bg-white px-3 py-2 text-sm text-slate-800 shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-navy-300 ${
          error ? 'border-red-400' : 'border-slate-300 focus:border-navy-500'
        } ${className}`}
        {...props}
      >
        {children}
      </select>
    </FieldShell>
  );
}

export function Textarea({ label, hint, error, required, id, className = '', ...props }) {
  return (
    <FieldShell label={label} hint={hint} error={error} required={required} htmlFor={id}>
      <textarea
        id={id}
        className={`w-full rounded-md border px-3 py-2 text-sm text-slate-800 shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-navy-300 ${
          error ? 'border-red-400' : 'border-slate-300 focus:border-navy-500'
        } ${className}`}
        {...props}
      />
    </FieldShell>
  );
}

export { FieldShell };
