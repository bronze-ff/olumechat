export function BrandMark({ className = 'w-8 h-8', inverse = false }) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true">
      {/* stroke/fill como ATRIBUTO (não `style`) de propósito: um estilo
          inline tem especificidade maior que qualquer seletor de classe e
          anularia sem chance o override html[data-theme="dark"]
          .brand-mark-stroke/.brand-mark-fill logo abaixo, que troca a marca
          não-inversa de primary pra signal no tema escuro (achado da review
          cruzada do FIL-104, PR #54). Atributo de apresentação SVG resolve
          var() normalmente, e mantém a especificidade baixa que o override
          depende pra vencer. */}
      <circle
        className={inverse ? '' : 'brand-mark-stroke'}
        cx="32"
        cy="29.5"
        r="21.5"
        fill="none"
        stroke={inverse ? 'var(--olume-signal)' : 'var(--olume-primary)'}
        strokeWidth="9"
      />
      <path
        className={inverse ? '' : 'brand-mark-fill'}
        d="M16.6 44.6 12.4 58l14.2-7.5Z"
        fill={inverse ? 'var(--olume-signal)' : 'var(--olume-primary)'}
      />
      <circle cx="32" cy="29.5" r="5" fill="var(--olume-signal)" />
    </svg>
  );
}

export default function Brand({
  inverse = false,
  compact = false,
  product = true,
  className = '',
}) {
  const label = product ? 'Olume Chat' : 'Olume';

  return (
    <div className={`flex min-w-0 items-center gap-2.5 ${className}`} aria-label={label}>
      <BrandMark inverse={inverse} className="w-8 h-8 shrink-0" />
      {!compact && (
        <div className="min-w-0">
          <span className="flex items-baseline gap-1.5 leading-none">
            <span className={`text-[17px] font-semibold tracking-[-0.025em] ${inverse ? 'text-white' : 'text-ink-950'}`}>
              olume
            </span>
            {product && (
              <span className={`text-[15px] font-normal tracking-[-0.02em] ${inverse ? 'text-brand-400' : 'text-brand-700'}`}>
                chat
              </span>
            )}
          </span>
          <span className={`block text-[10px] leading-none mt-1 ${inverse ? 'text-white/65' : 'text-stone-500'}`}>
            {product ? 'central de atendimento' : 'software'}
          </span>
        </div>
      )}
    </div>
  );
}
