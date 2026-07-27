export default function Spinner({ size = 'md' }) {
  const sz = { sm: 'w-4 h-4', md: 'w-6 h-6', lg: 'w-10 h-10' }[size] || 'w-6 h-6';
  return (
    <div className={`${sz} border-2 border-brand-500 border-t-transparent rounded-full animate-spin`} />
  );
}
