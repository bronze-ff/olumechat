import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../services/api';
import Spinner from '../../components/ui/Spinner';
import useEventStream from '../../hooks/useEventStream';
import { formatPhone } from '../../utils/formatters';

const STATUS_ITEM = {
  pendente: { rotulo: 'pendente', cls: 'text-stone-400' },
  enviado: { rotulo: '✓ enviado', cls: 'text-stone-600' },
  entregue: { rotulo: '✓✓ entregue', cls: 'text-brand-700' },
  lido: { rotulo: '✓✓ lido', cls: 'text-emerald-600 font-semibold' },
  falha: { rotulo: '✕ falha', cls: 'text-red-600' },
  optout: { rotulo: 'opt-out', cls: 'text-amber-600' },
};
const FILTROS = ['', 'enviado', 'entregue', 'lido', 'falha', 'optout', 'pendente'];

export default function CampanhaMonitor({ campanhaId, onClose }) {
  const [filtro, setFiltro] = useState('');
  const [busca, setBusca] = useState('');
  const [pagina, setPagina] = useState(1);
  const qc = useQueryClient();

  const prog = useQuery({
    queryKey: ['campanha-prog', campanhaId],
    queryFn: () => api.get(`/campanhas/${campanhaId}/progresso`).then((r) => r.data),
    refetchInterval: 8000,
  });
  const itens = useQuery({
    queryKey: ['campanha-itens', campanhaId, filtro, busca, pagina],
    queryFn: () => api.get(`/campanhas/${campanhaId}/itens`, { params: { status: filtro || undefined, q: busca || undefined, pagina } }).then((r) => r.data),
    keepPreviousData: true,
  });

  useEventStream((evt) => {
    if (evt.tipo === 'campanha' && evt.campanhaId === campanhaId) {
      qc.invalidateQueries({ queryKey: ['campanha-prog', campanhaId] });
      qc.invalidateQueries({ queryKey: ['campanha-itens', campanhaId] });
    }
  });

  const pausar = useMutation({ mutationFn: () => api.post(`/campanhas/${campanhaId}/pausar`), onSuccess: () => qc.invalidateQueries({ queryKey: ['campanha-prog', campanhaId] }) });
  const retomar = useMutation({ mutationFn: () => api.post(`/campanhas/${campanhaId}/retomar`), onSuccess: () => qc.invalidateQueries({ queryKey: ['campanha-prog', campanhaId] }) });

  const ps = prog.data?.porStatus || {};
  const camp = prog.data?.campanha || {};
  const status = camp.status;
  const totalPaginas = itens.data ? Math.max(1, Math.ceil(itens.data.total / itens.data.porPagina)) : 1;

  async function exportar() {
    try {
      const { data } = await api.get(`/campanhas/${campanhaId}/itens/export.csv`,
        { params: { status: filtro || undefined, q: busca || undefined }, responseType: 'blob' });
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = `comprovante-campanha-${campanhaId}.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert('Falha ao exportar.');
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-paper-100 flex flex-col">
      <div className="bg-ink-950 text-white px-4 py-2.5 flex items-center gap-3 shrink-0">
        <span className="section-bar" />
        <h2 className="font-display font-bold text-[15px] flex-1 truncate">Campanha — comprovante de envio</h2>
        {status === 'enviando' && <button onClick={() => pausar.mutate()} className="px-3 py-1.5 rounded-lg bg-amber-500/20 text-amber-200 text-xs font-medium hover:bg-amber-500/30">⏸ Pausar</button>}
        {status === 'pausada' && <button onClick={() => retomar.mutate()} className="px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-200 text-xs font-medium hover:bg-emerald-500/30">▶ Retomar</button>}
        <button onClick={onClose} className="text-white/60 hover:text-white px-1 text-lg leading-none">✕</button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <div className="max-w-screen-lg mx-auto space-y-4">
          {prog.isLoading ? <div className="p-8 flex justify-center"><Spinner /></div> : (
            <>
              {/* KPIs */}
              <div className="navy-gradient rounded-2xl text-white grid grid-cols-3 sm:grid-cols-6 divide-x divide-white/[0.08] px-2 py-4">
                {[['enviado', 'Enviados'], ['entregue', 'Entregues'], ['lido', 'Lidos'], ['falha', 'Falhas'], ['optout', 'Opt-out'], ['pendente', 'Pendentes']].map(([k, r]) => (
                  <div key={k} className="px-3">
                    <p className="font-display font-bold text-2xl tabular leading-none">{ps[k] || 0}</p>
                    <p className="font-mono text-[9px] uppercase tracking-widest text-white/50 mt-1">{r}</p>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-stone-500">
                <span>Total: <b className="text-stone-800">{camp.total || 0}</b></span>
                <span>Custo acumulado: <b className="text-stone-800">R$ {(prog.data?.custo || 0).toFixed(2)}</b></span>
                {camp.pausaMotivo && <span className="text-amber-700">⏸ {camp.pausaMotivo}</span>}
              </div>

              {/* Comprovante por destinatário */}
              <div className="bg-white rounded-2xl border border-black/[0.06] overflow-hidden">
                <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-black/[0.05]">
                  <span className="font-display font-bold text-sm text-stone-800">Comprovante por cliente</span>
                  <div className="flex-1" />
                  <input value={busca} onChange={(e) => { setBusca(e.target.value); setPagina(1); }} placeholder="Buscar telefone"
                    className="text-xs px-2.5 py-1.5 rounded-lg bg-paper-50 border border-black/10 outline-none focus:border-brand-700 font-mono" />
                  <select value={filtro} onChange={(e) => { setFiltro(e.target.value); setPagina(1); }}
                    className="text-xs px-2 py-1.5 rounded-lg bg-paper-50 border border-black/10 outline-none">
                    {FILTROS.map((f) => <option key={f} value={f}>{f ? STATUS_ITEM[f]?.rotulo : 'Todos'}</option>)}
                  </select>
                  <button onClick={exportar} className="text-xs px-3 py-1.5 rounded-lg border border-black/15 text-stone-600 hover:bg-paper-50 font-medium">⬇ CSV</button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-[10px] uppercase tracking-wide text-stone-400 border-b border-black/[0.05]">
                      <th className="px-4 py-2 font-semibold">Cliente</th>
                      <th className="px-2 py-2 font-semibold">Telefone</th>
                      <th className="px-2 py-2 font-semibold">Status</th>
                      <th className="px-2 py-2 font-semibold">Enviado em</th>
                    </tr></thead>
                    <tbody>
                      {itens.isLoading && <tr><td colSpan={4} className="p-6 text-center"><Spinner /></td></tr>}
                      {(itens.data?.itens || []).map((it) => {
                        const s = STATUS_ITEM[it.status] || { rotulo: it.status, cls: 'text-stone-500' };
                        return (
                          <tr key={it.id} className="border-b border-black/[0.03]">
                            <td className="px-4 py-2 text-stone-700">{it.nomePerfil || '—'}</td>
                            <td className="px-2 py-2 font-mono text-xs text-stone-500">{formatPhone(it.telefone)}</td>
                            <td className={`px-2 py-2 text-xs font-mono ${s.cls}`}>{s.rotulo}{it.erroCodigo ? ` (${it.erroCodigo})` : ''}</td>
                            <td className="px-2 py-2 text-xs text-stone-400">{it.enviadoEm ? new Date(it.enviadoEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                          </tr>
                        );
                      })}
                      {itens.data?.itens?.length === 0 && <tr><td colSpan={4} className="p-6 text-center text-sm text-stone-400">Nenhum destinatário com esse filtro.</td></tr>}
                    </tbody>
                  </table>
                </div>
                {totalPaginas > 1 && (
                  <div className="flex items-center justify-center gap-3 px-4 py-2.5 border-t border-black/[0.05]">
                    <button onClick={() => setPagina((p) => Math.max(1, p - 1))} disabled={pagina <= 1} className="text-xs px-2.5 py-1 rounded border border-black/15 disabled:opacity-30">←</button>
                    <span className="text-xs font-mono text-stone-500">{pagina}/{totalPaginas}</span>
                    <button onClick={() => setPagina((p) => Math.min(totalPaginas, p + 1))} disabled={pagina >= totalPaginas} className="text-xs px-2.5 py-1 rounded border border-black/15 disabled:opacity-30">→</button>
                  </div>
                )}
              </div>
              <p className="font-mono text-[10px] text-stone-400">
                "entregue" = chegou no aparelho do cliente (prova de contato). "lido" = cliente abriu (se ele tiver confirmação de leitura ligada).
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
