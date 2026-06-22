import { Loader2, AlertCircle, Inbox } from 'lucide-react';

export function PageLoader({ label = 'Loading…' }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-slate-500">
      <Loader2 size={28} className="animate-spin text-navy-400" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

export function ErrorBanner({ message, onRetry }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      <AlertCircle size={18} className="mt-0.5 shrink-0" />
      <div className="flex-1">
        <p className="font-medium">Something went wrong</p>
        <p className="mt-0.5 text-red-600">{message}</p>
      </div>
      {onRetry && (
        <button onClick={onRetry} className="shrink-0 font-medium text-red-700 underline-offset-2 hover:underline">
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({ icon: Icon = Inbox, title, description }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-slate-500">
      <Icon size={28} className="text-slate-300" />
      <p className="font-medium text-slate-600">{title}</p>
      {description && <p className="max-w-sm text-sm text-slate-400">{description}</p>}
    </div>
  );
}
