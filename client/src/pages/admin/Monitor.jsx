import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import api from '../../services/api';
import Spinner from '../../components/ui/Spinner';
import useEventStream from '../../hooks/useEventStream';

const ESTADOS = {
  online: { cor: 'bg-emerald-500', rotulo: 'online' },
  pausa: { cor: 'bg-amber-400', rotulo: 'em pausa' },
  offline: { cor: 'bg-stone-300', rotulo: 'offline' },
};

export default function Monitor() {
  const qc = useQueryClient();
  const [erro, setErro] = useState('');

  const presenca = useQuery({
    queryKey: ['presenca'],
    queryFn: () => api.get('/presenca').then((r) => r.data),
    refetchInterval: 30000,
  });
  const deptos = useQuery({
    queryKey: ['departamentos'],
    queryFn: () => api.get('/departamentos').then((r) => r.data),
  });
  // Contagem REAL (COUNT no banco) por departamento e por atendente. Substitui a
  // leitura antiga, que contava em cima da listagem de conversas — limitada a 100
  // linhas e por isso subcontava (mostrava 100 quando havia 118 em atendimento).
  const contagens = useQuery({
    queryKey: ['conversas', 'contagens'],
    queryFn: () => api.get('/conversas/contagens').then((r) => r.data),
    refetchInterval: 30000,
  });

  useEventStream(() => {
    qc.invalidateQueries({ queryKey: ['presenca'] });
    qc.invalidateQueries({ queryKey: ['conversas', 'contagens'] });
  });

  // Gestor força a presença de um atendente (pausar ou tirar da pausa, sem F5 dele).
  const forcarPresenca = useMutation({
    mutationFn: ({ atendenteId, estado }) => api.put(`/presenca/${atendenteId}`, { estado }),
    onSuccess: () => { setErro(''); qc.invalidateQueries({ queryKey: ['presenca'] }); },
    onError: (e) => {
      setErro(e.response?.data?.error || 'Não foi possível alterar a presença.');
      qc.invalidateQueries({ queryKey: ['presenca'] });
    },
  });

  const cont = contagens.data || { porDepartamento: {}, porAtendente: {} };
  const filaDe = (depId) => cont.porDepartamento?.[depId]?.aguardando || 0;
  const atendendoDe = (depId) => cont.porDepartamento?.[depId]?.em_atendimento || 0;
  const cargaDe = (atdId) => cont.porAtendente?.[atdId] || 0;
  // Soma só os departamentos exibidos (cards), pra o aviso bater com o que aparece
  // na tela — evita mostrar "N aguardando" sem um card correspondente.
  const totalFila = (deptos.data || []).reduce((s, d) => s + filaDe(d.id), 0);

  const listaPresenca = [...(presenca.data || [])].sort((a, b) => {
    const ordem = { online: 0, pausa: 1, offline: 2 };
    return (ordem[a.estado] ?? 3) - (ordem[b.estado] ?? 3) || cargaDe(b.atendenteId) - cargaDe(a.atendenteId);
  });
  const onlines = listaPresenca.filter((a) => a.estado === 'online').length;

  return (
    <div className="max-w-screen-2xl mx-auto grid grid-cols-12 gap-4">
      {/* Filas por departamento */}
      <div className="col-span-12 lg:col-span-8 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {deptos.isLoading && <div className="col-span-full p-10 flex justify-center"><Spinner /></div>}
          {(deptos.data || []).map((d) => {
            const fila = filaDe(d.id);
            const atendendo = atendendoDe(d.id);
            return (
              <div key={d.id}
                className={`relative bg-white rounded-2xl border border-black/[0.06] p-4 overflow-hidden
                  ${fila > 0 ? 'ring-1 ring-amber-300' : ''}`}>
                <span aria-hidden className="absolute left-0 top-0 bottom-0 w-1.5" style={{ backgroundColor: d.cor || '#1B5E7B' }} />
                <div className="flex items-center gap-2 mb-3">
                  <p className="font-display font-bold text-[15px] text-stone-800 truncate flex-1">{d.nome}</p>
                  {fila > 0 && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />}
                </div>
                <div className="flex items-end gap-6">
                  <div>
                    <p className={`font-display font-bold text-4xl tabular leading-none ${fila > 0 ? 'text-amber-600' : 'text-stone-200'}`}>{fila}</p>
                    <p className="font-mono text-[9px] uppercase tracking-widest text-stone-400 mt-1">na fila</p>
                  </div>
                  <div>
                    <p className="font-display font-bold text-4xl tabular leading-none text-brand-700">{atendendo}</p>
                    <p className="font-mono text-[9px] uppercase tracking-widest text-stone-400 mt-1">atendendo</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {totalFila > 0 && (
          <p className="font-mono text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
            ⚠ {totalFila} conversa(s) aguardando — a distribuição automática atribui assim que houver atendente disponível na fila.
          </p>
        )}
      </div>

      {/* Atendentes */}
      <section className="col-span-12 lg:col-span-4 bg-white rounded-2xl border border-black/[0.06] self-start">
        <header className="flex items-center gap-2 px-4 pt-3.5 pb-2.5 border-b border-black/[0.05]">
          <span className="section-bar" />
          <h2 className="font-display font-bold text-sm text-stone-800 flex-1">Equipe agora</h2>
          <span className="font-mono text-[10px] text-stone-400">{onlines} online</span>
        </header>
        {erro && (
          <p className="m-3 text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{erro}</p>
        )}
        <div className="divide-y divide-black/[0.04]">
          {presenca.isLoading && <div className="p-8 flex justify-center"><Spinner /></div>}
          {presenca.isError && <p className="p-4 text-sm text-red-600">{presenca.error.response?.data?.error || 'Erro ao carregar.'}</p>}
          {listaPresenca.map((a) => {
            const est = ESTADOS[a.estado] || ESTADOS.offline;
            const carga = cargaDe(a.atendenteId);
            const alterando = forcarPresenca.isPending && forcarPresenca.variables?.atendenteId === a.atendenteId;
            return (
              <div key={a.atendenteId} className={`flex items-center gap-2.5 px-4 py-2.5 ${a.estado === 'offline' ? 'opacity-45' : ''}`}>
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${est.cor} ${a.estado === 'online' ? 'shadow-[0_0_0_3px_rgba(16,185,129,0.15)]' : ''}`} />
                <p className="text-[13px] font-medium text-stone-800 truncate flex-1">{a.nome || `Matrícula ${a.matricula}`}</p>
                {carga > 0 && (
                  <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-brand-50 text-brand-700">{carga} conv.</span>
                )}
                {a.estado === 'pausa' ? (
                  <button type="button"
                    onClick={() => forcarPresenca.mutate({ atendenteId: a.atendenteId, estado: 'online' })}
                    disabled={alterando}
                    title="Tirar da pausa agora (vale na hora, sem F5 do atendente)"
                    className="font-mono text-[10px] px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 disabled:opacity-40 shrink-0">
                    {alterando ? '…' : 'tornar disponível'}
                  </button>
                ) : a.estado === 'online' ? (
                  <button type="button"
                    onClick={() => forcarPresenca.mutate({ atendenteId: a.atendenteId, estado: 'pausa' })}
                    disabled={alterando}
                    title="Colocar em pausa agora (para de receber novas conversas)"
                    className="font-mono text-[10px] px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 disabled:opacity-40 shrink-0">
                    {alterando ? '…' : 'pausar'}
                  </button>
                ) : (
                  <span className="font-mono text-[10px] text-stone-400 w-14 text-right">{est.rotulo}</span>
                )}
              </div>
            );
          })}
          {presenca.data?.length === 0 && (
            <p className="p-6 text-sm text-stone-500 text-center">
              Ninguém conectou ainda nesta sessão do serviço — quem logar no sistema aparece aqui na hora.
            </p>
          )}
        </div>
        <p className="font-mono text-[10px] text-stone-400 px-4 py-2.5 border-t border-black/[0.04]">
          pausa = não recebe novas conversas · o atendente controla, ou o gestor força aqui
        </p>
      </section>
    </div>
  );
}
