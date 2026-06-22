import { useEffect } from 'react';
import { X } from 'lucide-react';

export default function Drawer({ open, title, subtitle, onClose, children, footer, width = 'max-w-2xl' }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-navy-900/40" onClick={onClose} />
      <div className={`relative flex h-full w-full ${width} flex-col bg-white shadow-2xl animate-fade-in`}>
        <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-navy-900">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close panel"
          >
            <X size={20} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto scroll-thin px-6 py-5">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-slate-100 px-6 py-4">{footer}</footer>}
      </div>
    </div>
  );
}
