export function BrandMark({ className = 'w-8 h-8', inverse = false }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <rect
        className={inverse ? '' : 'brand-mark-surface'}
        width="32"
        height="32"
        rx="9"
        fill={inverse ? '#F2F7F5' : '#0B1513'}
      />
      <path
        className={inverse ? '' : 'brand-mark-bubble'}
        d="M9 10.5h14v8.25a3.75 3.75 0 0 1-3.75 3.75H16l-4.5 3v-3H9V10.5Z"
        fill="none"
        stroke={inverse ? '#0B1513' : '#F7FAF9'}
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <circle cx="20.8" cy="10.8" r="3.2" fill="#47D7AE" />
    </svg>
  );
}

export default function Brand({ inverse = false, compact = false, className = '' }) {
  return (
    <div className={`flex items-center gap-2.5 min-w-0 ${className}`}>
      <BrandMark inverse={inverse} className="w-8 h-8 shrink-0" />
      {!compact && (
        <div className="min-w-0">
          <span className={`block text-[17px] font-semibold tracking-[-0.02em] leading-none ${inverse ? 'text-white' : 'text-ink-950'}`}>
            falatta
          </span>
          <span className={`block text-[10px] leading-none mt-1 ${inverse ? 'text-white/65' : 'text-stone-500'}`}>
            central de atendimento
          </span>
        </div>
      )}
    </div>
  );
}
