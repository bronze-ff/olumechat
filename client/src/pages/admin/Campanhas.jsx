import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../services/api';
import Spinner from '../../components/ui/Spinner';
import Portal from '../../components/ui/Portal';
import { useAuth } from '../../context/AuthContext';
import { formatPhone } from '../../utils/formatters';
import CampanhaEditor from './CampanhaEditor';
import CampanhaMonitor from './CampanhaMonitor';

const STATUS_COR = {
  rascunho: 'bg-stone-100 text-stone-500',
  enviando: 'bg-emerald-100 text-emerald-700 animate-pulse',
  pausada: 'bg-amber-100 text-amber-700',
  concluida: 'bg-brand-50 text-brand-700',
};

export default function Campanhas() {
  const { isGestor } = useAuth();
  const [editando, setEditando] = useState(null); // null | 'nova' | id
  const [monitorando, setMonitorando] = useState(null); // id
  const qc = useQueryClient();

  const campanhas = useQuery({
    queryKey: ['campanhas'],
    queryFn: () => api.get('/campanhas').then((r) => r.data),
    refetchInterval: 15000,
  });

  return (
    <div className="max-w-screen-xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-stone-500 flex-1">
          Dispare o lembrete de pagamento em lote para os devedores. O envio respeita opt-out,
          limite diário da Meta e horário comercial — e você acompanha entrega/leitura por cliente.
        </p>
        {isGestor && (
          <button onClick={() => setEditando('nova')}
            className="shrink-0 px-4 py-2 rounded-xl bg-bordeaux-700 hover:bg-bordeaux-800 text-white text-sm font-semibold">
            + Nova campanha
          </button>
        )}
      </div>

      {campanhas.isLoading && <div className="p-10 flex justify-center"><Spinner /></div>}
      {campanhas.isError && <p className="p-4 text-sm text-red-600">{campanhas.error.response?.data?.error || 'Erro ao carregar.'}</p>}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {(campanhas.data || []).map((c) => {
          const pct = c.total ? Math.round((c.enviados / c.total) * 100) : 0;
          return (
            <div key={c.id} className="bg-white rounded-2xl border border-black/[0.06] p-4">
              <div className="flex items-start gap-2 mb-2">
                <span className="text-lg leading-none mt-0.5">📣</span>
                <div className="min-w-0 flex-1">
                  <p className="font-display font-bold text-[15px] text-stone-800 truncate">{c.nome}</p>
                  <p className="font-mono text-[10px] text-stone-400 mt-0.5">
                    {c.templateNome || 'sem template'} · {c.nomeExibicao || formatPhone(c.displayPhone) || 'sem número'}
                  </p>
                </div>
                <span className={`shrink-0 font-mono text-[9px] uppercase tracking-widest px-2 py-1 rounded-full ${STATUS_COR[c.status] || 'bg-stone-100 text-stone-500'}`}>
                  {c.status}
                </span>
              </div>
              {c.total > 0 && (
                <div className="mb-3">
                  <div className="h-2 rounded-full bg-paper-200 overflow-hidden">
                    <div className="h-full rounded-full bg-brand-700" style={{ width: `${pct}%` }} />
                  </div>
                  <p className="font-mono text-[10px] text-stone-400 mt-0.5">{c.enviados}/{c.total} enviados ({pct}%)</p>
                </div>
              )}
              <div className="flex gap-2">
                <button onClick={() => setMonitorando(c.id)}
                  className="flex-1 text-xs py-2 rounded-lg bg-brand-700 hover:bg-brand-800 text-white font-medium">
                  Acompanhar
                </button>
                {c.status === 'rascunho' && isGestor && (
                  <button onClick={() => setEditando(c.id)}
                    className="flex-1 text-xs py-2 rounded-lg border border-black/15 text-stone-600 hover:bg-paper-50 font-medium">
                    Editar
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {campanhas.data?.length === 0 && (
          <div className="col-span-full bg-white rounded-2xl border border-dashed border-black/15 p-10 text-center">
            <p className="text-3xl mb-2">📣</p>
            <p className="text-sm text-stone-500">Nenhuma campanha ainda — crie a primeira para cobrar os devedores em lote.</p>
          </div>
        )}
      </div>

      {editando !== null && (
        <Portal>
          <CampanhaEditor campanhaId={editando === 'nova' ? null : editando}
            onClose={() => setEditando(null)}
            onSaved={() => { setEditando(null); qc.invalidateQueries({ queryKey: ['campanhas'] }); }} />
        </Portal>
      )}
      {monitorando !== null && (
        <Portal>
          <CampanhaMonitor campanhaId={monitorando}
            onClose={() => { setMonitorando(null); qc.invalidateQueries({ queryKey: ['campanhas'] }); }} />
        </Portal>
      )}
    </div>
  );
}
