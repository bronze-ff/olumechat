import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../services/api';
import Spinner from '../../components/ui/Spinner';
import { useAuth } from '../../context/AuthContext';
import { CORES } from '../../utils/coresCategoricas';

export default function Departamentos() {
  const { isAdmin } = useAuth();
  const [novo, setNovo] = useState('');
  const [cor, setCor] = useState(CORES[0]);
  const [erro, setErro] = useState('');
  const qc = useQueryClient();

  const deptos = useQuery({
    queryKey: ['departamentos', 'todos'],
    queryFn: () => api.get('/departamentos', { params: { todos: 1 } }).then((r) => r.data),
  });

  const criar = useMutation({
    mutationFn: () => api.post('/departamentos', { nome: novo.trim(), cor }),
    onSuccess: () => { setNovo(''); setErro(''); qc.invalidateQueries({ queryKey: ['departamentos'] }); },
    onError: (e) => setErro(e.response?.data?.error || 'Falha ao criar.'),
  });

  const alternar = useMutation({
    mutationFn: (d) => api.put(`/departamentos/${d.id}`, { ativo: d.ativo === 'S' ? 'N' : 'S' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['departamentos'] }),
  });

  return (
    <div className="max-w-screen-xl mx-auto grid grid-cols-12 gap-4 items-start">
      {isAdmin && (
        <form onSubmit={(e) => { e.preventDefault(); if (novo.trim()) criar.mutate(); }}
          className="col-span-12 lg:col-span-4 lg:sticky lg:top-32 bg-white rounded-2xl border border-black/[0.06] p-4 flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-48">
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Novo departamento</label>
            <input className="input-field" value={novo} onChange={(e) => setNovo(e.target.value)} placeholder="Ex.: Financeiro - Crédito" />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Cor</label>
            <div className="flex gap-1.5">
              {CORES.map((c) => (
                <button key={c} type="button" onClick={() => setCor(c)}
                  className={`w-7 h-7 rounded-full border-2 ${cor === c ? 'border-stone-800' : 'border-transparent'}`}
                  style={{ backgroundColor: c }} aria-label={c} />
              ))}
            </div>
          </div>
          <button type="submit" disabled={!novo.trim() || criar.isPending}
            className="px-4 py-2.5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold disabled:opacity-40">
            {criar.isPending ? 'Criando…' : 'Criar'}
          </button>
          {erro && <p className="w-full text-xs text-red-600">{erro}</p>}
        </form>
      )}

      <div className={`${isAdmin ? 'col-span-12 lg:col-span-8' : 'col-span-12'} bg-white rounded-2xl border border-black/[0.06] divide-y divide-black/[0.05]`}>
        {deptos.isLoading && <div className="p-8 flex justify-center"><Spinner /></div>}
        {deptos.isError && <p className="p-4 text-sm text-red-600">Erro ao carregar.</p>}
        {(deptos.data || []).map((d) => (
          <div key={d.id} className={`flex items-center gap-3 px-4 py-3 ${d.ativo === 'N' ? 'opacity-50' : ''}`}>
            <span className="w-3.5 h-3.5 rounded-full shrink-0" style={{ backgroundColor: d.cor || '#1F7A60' }} />
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-sm text-stone-800">{d.nome}</p>
              {d.descricao && <p className="text-xs text-stone-500">{d.descricao}</p>}
            </div>
            <span className="text-xs font-mono text-stone-400">{d.qtdAtendentes} atend.</span>
            {isAdmin && (
              <button onClick={() => alternar.mutate(d)}
                className={`text-xs px-2.5 py-1 rounded-full font-medium
                  ${d.ativo === 'S' ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' : 'bg-paper-200 text-ink-900 hover:bg-paper-300'}`}>
                {d.ativo === 'S' ? 'Ativo' : 'Inativo'}
              </button>
            )}
          </div>
        ))}
        {deptos.data?.length === 0 && <p className="p-6 text-sm text-stone-500 text-center">Nenhum departamento. Rode o script SQL 02_fase5a ou crie acima.</p>}
      </div>
    </div>
  );
}
