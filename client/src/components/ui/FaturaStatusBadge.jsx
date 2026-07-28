// Badge de status de fatura (FIL-79/FIL-80) — usado na ficha financeira do
// cliente e na lista de cobrança do painel financeiro.
const FATURA_STATUS = {
  prevista: { label: 'Prevista', className: 'bg-stone-100 text-stone-700 border-stone-200' },
  emitida: { label: 'Emitida', className: 'bg-blue-50 text-blue-800 border-blue-200' },
  paga: { label: 'Paga', className: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  atrasada: { label: 'Atrasada', className: 'bg-red-50 text-red-800 border-red-200' },
  em_negociacao: { label: 'Em negociação', className: 'bg-amber-50 text-amber-800 border-amber-200' },
  cancelada: { label: 'Cancelada', className: 'bg-stone-100 text-stone-500 border-stone-200 line-through' },
};

export default function FaturaStatusBadge({ value }) {
  const s = FATURA_STATUS[value] || FATURA_STATUS.prevista;
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-semibold ${s.className}`}>{s.label}</span>;
}
