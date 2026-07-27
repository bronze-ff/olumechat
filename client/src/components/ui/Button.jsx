import Spinner from './Spinner';

const variants = {
  primary: 'bg-brand-700 hover:bg-brand-800 active:bg-brand-900 text-white',
  accent:  'bg-[#9B1B1B] hover:bg-[#8B1A1A] active:bg-[#741616] text-white',
  outline: 'border border-black/20 hover:bg-paper-100 active:bg-paper-200 text-stone-700',
  ghost:   'hover:bg-paper-200 active:bg-paper-300 text-stone-700',
};
const sizes = { sm: 'py-1.5 px-3 text-sm', md: 'py-2.5 px-4 text-sm', lg: 'py-3.5 px-6 text-base' };

export default function Button({
  children, variant = 'primary', loading = false, disabled = false,
  fullWidth = false, size = 'md', ...props
}) {
  return (
    <button
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold
        transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed
        ${variants[variant] || variants.primary} ${sizes[size] || sizes.md} ${fullWidth ? 'w-full' : ''}`}
      {...props}
    >
      {loading && <Spinner size="sm" />}
      {children}
    </button>
  );
}
