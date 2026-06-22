import { Loader2 } from 'lucide-react';

const VARIANTS = {
  primary: 'bg-navy-600 text-white hover:bg-navy-700 focus-visible:outline-navy-600 disabled:bg-navy-300',
  gold: 'bg-gold-500 text-white hover:bg-gold-600 focus-visible:outline-gold-500 disabled:bg-gold-300',
  danger: 'bg-red-600 text-white hover:bg-red-700 focus-visible:outline-red-600 disabled:bg-red-300',
  outline:
    'bg-white text-navy-700 border border-navy-200 hover:bg-navy-50 focus-visible:outline-navy-400 disabled:text-slate-400',
  ghost: 'bg-transparent text-navy-700 hover:bg-navy-50 focus-visible:outline-navy-400 disabled:text-slate-400',
};

const SIZES = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm',
  lg: 'px-5 py-2.5 text-base',
};

export default function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon: Icon,
  className = '',
  children,
  disabled,
  ...props
}) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-md font-medium shadow-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:shadow-none ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 size={16} className="animate-spin" /> : Icon ? <Icon size={16} /> : null}
      {children}
    </button>
  );
}
