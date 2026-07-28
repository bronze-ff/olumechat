import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import apiOperador from '../../services/apiOperador';
import Icon from '../../components/ui/Icon';
import { formatarCentavos } from '../../utils/dinheiro';

// Ação de "registrar pagamento" da lista de cobrança (FIL-80) — chama a MESMA
// rota já usada pela ficha financeira/FIL-79 (POST
// /tenants/:id/faturas/:faturaId/pagamentos); nenhuma lógica de negócio nova.
const MEIOS = [
  { id: 'pix', label: 'Pix' },
  { id: 'boleto', label: 'Boleto' },
  { id: 'transferencia', label: 'Transferência' },
  { id: 'cartao', label: 'Cartão' },
];

function paraCentavos(texto) {
  const normalizado = String(texto).trim().replace(/\./g, '').replace(',', '.');
  const valor = Number.parseFloat(normalizado);
  return Number.isFinite(valor) ? Math.round(valor * 100) : 0;
}

export default function RegistrarPagamentoModal({ fatura, onClose }) {
  const qc = useQueryClient();
  const [valor, setValor] = useState((fatura.saldoCentavos / 100).toFixed(2).replace('.', ','));
  const [data, setData] = useState(new Date().toISOString().slice(0, 10));
  const [meio, setMeio] = useState('pix');
  const [comprovante, setComprovante] = useState('');
  const [erro, setErro] = useState('');

  const valorCentavos = paraCentavos(valor);
  const podeSalvar = valorCentavos > 0 && valorCentavos <= fatura.saldoCentavos && !!data;

  const registrar = useMutation({
    mutationFn: () => apiOperador.post(`/tenants/${fatura.tenantId}/faturas/${fatura.id}/pagamentos`, {
      valorCentavos, data, meio, comprovante: comprovante.trim() || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['operador', 'financeiro'] });
      onClose();
    },
    onError: (error) => setErro(error.response?.data?.error || 'Não foi possível registrar o pagamento.'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-ink-950/60 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative w-full sm:max-w-sm bg-white border border-paper-400 rounded-t-[10px] sm:rounded-[10px] shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-paper-300 flex items-center gap-3">
          <span className="w-9 h-9 rounded-lg bg-brand-100 text-brand-800 flex items-center justify-center shrink-0">
            <Icon name="check" size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-ink-950 truncate">Registrar pagamento</h2>
            <p className="text-xs text-stone-500 truncate">{fatura.tenantNome} · {fatura.competencia}</p>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-lg border border-paper-400 text-stone-500 hover:bg-paper-100 hover:text-ink-950" aria-label="Fechar">✕</button>
        </div>
        <div className="modal-body space-y-4">
          <p className="text-xs text-stone-500">
            Saldo em aberto: <strong className="text-ink-950 tabular">{formatarCentavos(fatura.saldoCentavos)}</strong>
          </p>
          <div>
            <label className="field-label">Valor pago (R$)</label>
            <input className="input-field tabular" value={valor} onChange={(e) => { setValor(e.target.value); setErro(''); }} />
          </div>
          <div>
            <label className="field-label">Data do pagamento</label>
            <input type="date" className="input-field" value={data} onChange={(e) => setData(e.target.value)} />
          </div>
          <div>
            <label className="field-label">Meio</label>
            <select className="input-field" value={meio} onChange={(e) => setMeio(e.target.value)}>
              {MEIOS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label">Comprovante <span className="font-normal text-stone-500">(opcional)</span></label>
            <input className="input-field" value={comprovante} onChange={(e) => setComprovante(e.target.value)} placeholder="Link ou referência" />
          </div>
          {erro && <p className="text-xs text-red-600">{erro}</p>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="flex-1 min-h-10 rounded-lg border border-paper-400 bg-white hover:bg-paper-100 text-stone-700 font-semibold text-sm">Cancelar</button>
          <button
            onClick={() => registrar.mutate()}
            disabled={!podeSalvar || registrar.isPending}
            className="flex-1 min-h-10 rounded-lg bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm disabled:opacity-40"
          >
            {registrar.isPending ? 'Registrando…' : 'Registrar pagamento'}
          </button>
        </div>
      </div>
    </div>
  );
}
