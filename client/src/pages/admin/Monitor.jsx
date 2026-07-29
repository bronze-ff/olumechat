import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import api from '../../services/api';
import Spinner from '../../components/ui/Spinner';
import Icon from '../../components/ui/Icon';
import useEventStream from '../../hooks/useEventStream';

const ESTADOS = {
  online: { cor: 'bg-emerald-500', rotulo: 'online' },
  pausa: { cor: 'bg-amber-400', rotulo: 'em pausa' },
  offline: { cor: 'bg-stone-300', rotulo: 'offline' },
};

export default function Monitor({ onIrPara }) {
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
  const onlineDoDepto = (depId) => (presenca.data || []).filter((p) => p.estado === 'online' && (p.deptoIds || []).includes(depId)).length;
  // Departamento com gente esperando e ninguém online pra atender — o tipo de
  // buraco operacional que passa despercebido até o cliente reclamar.
  const deptosDesguarnecidos = (deptos.data || []).filter((d) => filaDe(d.id) > 0 && onlineDoDepto(d.id) === 0);

  const listaPresenca = [...(presenca.data || [])].sort((a, b) => {
    const ordem = { online: 0, pausa: 1, offline: 2 };
    return (ordem[a.estado] ?? 3) - (ordem[b.estado] ?? 3) || cargaDe(b.atendenteId) - cargaDe(a.atendenteId);
  });
  const onlines = listaPresenca.filter((a) => a.estado === 'online').length;

  return (
    <div className="max-w-screen-2xl mx-auto space-y-4">
      <section className="app-panel overflow-hidden">
        <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-y md:divide-y-0 divide-paper-300">
          <div className="px-4 py-3.5">
            <p className="text-[11px] text-stone-500">Aguardando</p>
            <p className={`mt-1 text-xl font-semibold tabular ${totalFila > 0 ? 'text-amber-700' : 'text-ink-950'}`}>{totalFila}</p>
          </div>
          <div className="px-4 py-3.5">
            <p className="text-[11px] text-stone-500">Em atendimento</p>
            <p className="mt-1 text-xl font-semibold tabular text-ink-950">
              {Object.values(cont.porDepartamento || {}).reduce((s, item) => s + (item.em_atendimento || 0), 0)}
            </p>
          </div>
          <div className="px-4 py-3.5">
            <p className="text-[11px] text-stone-500">Atendentes online</p>
            <p className="mt-1 text-xl font-semibold tabular text-ink-950">{onlines}</p>
          </div>
          <div className="px-4 py-3.5">
            <p className="text-[11px] text-stone-500">Filas sem cobertura</p>
            <p className={`mt-1 text-xl font-semibold tabular ${deptosDesguarnecidos.length > 0 ? 'text-red-700' : 'text-ink-950'}`}>
              {deptosDesguarnecidos.length}
            </p>
          </div>
        </div>
      </section>

      {deptosDesguarnecidos.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-[10px] px-4 py-3 flex flex-wrap items-center gap-3">
          <Icon name="alert" size={17} className="text-red-700 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-red-800">
              {deptosDesguarnecidos.length === 1
                ? `${deptosDesguarnecidos[0].nome} está sem atendente online.`
                : `${deptosDesguarnecidos.length} departamentos estão sem atendente online.`}
            </p>
            <p className="mt-0.5 text-xs text-red-700">{deptosDesguarnecidos.map((d) => d.nome).join(' · ')}</p>
          </div>
          {onIrPara && (
            <button type="button" onClick={() => onIrPara('atendentes')}
              className="shrink-0 min-h-9 px-3 rounded-md bg-white border border-red-300 text-red-700 text-xs font-semibold hover:bg-red-100">
              Ver atendentes
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-12 gap-4">
        <section className="col-span-12 xl:col-span-8 app-panel overflow-hidden self-start">
          <header className="panel-header">
            <h2 className="text-sm font-semibold text-ink-950 flex-1">Filas por departamento</h2>
            <span className="text-[11px] text-stone-500">{(deptos.data || []).length} departamentos</span>
          </header>
          {deptos.isLoading && <div className="p-10 flex justify-center"><Spinner /></div>}
          {!deptos.isLoading && (deptos.data || []).length === 0 && (
            <div className="px-5 py-10 flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink-950">A operação ainda não tem filas configuradas</p>
                <p className="mt-1 text-[13px] leading-5 text-stone-600 max-w-xl">
                  Crie um departamento para organizar a distribuição das conversas e acompanhar quem está aguardando ou em atendimento.
                </p>
              </div>
              {onIrPara && (
                <button type="button" onClick={() => onIrPara('departamentos')}
                  className="shrink-0 min-h-10 px-3.5 rounded-md bg-brand-700 text-white text-xs font-semibold hover:bg-brand-800">
                  Configurar departamentos
                </button>
              )}
            </div>
          )}
          {(deptos.data || []).length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-[13px]">
                <thead>
                  <tr className="bg-paper-50 border-b border-paper-300 text-left text-[11px] font-medium text-stone-500">
                    <th className="px-4 py-2.5">Departamento</th>
                    <th className="px-4 py-2.5 text-right">Online</th>
                    <th className="px-4 py-2.5 text-right">Aguardando</th>
                    <th className="px-4 py-2.5 text-right">Em atendimento</th>
                    <th className="px-4 py-2.5">Cobertura</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-paper-300">
                  {(deptos.data || []).map((d) => {
                    const fila = filaDe(d.id);
                    const atendendo = atendendoDe(d.id);
                    const online = onlineDoDepto(d.id);
                    const semAtendente = fila > 0 && online === 0;
                    return (
                      <tr key={d.id} className="hover:bg-paper-50">
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-2 font-medium text-ink-950">
                            <span aria-hidden className="w-2 h-2 rounded-full" style={{ backgroundColor: d.cor || '#1F7A60' }} />
                            {d.nome}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right tabular text-stone-700">{online}</td>
                        <td className={`px-4 py-3 text-right tabular font-semibold ${fila > 0 ? 'text-amber-700' : 'text-stone-700'}`}>{fila}</td>
                        <td className="px-4 py-3 text-right tabular font-semibold text-stone-700">{atendendo}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${semAtendente ? 'text-red-700' : 'text-emerald-700'}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${semAtendente ? 'bg-red-500' : 'bg-emerald-500'}`} />
                            {semAtendente ? 'Sem cobertura' : 'Coberta'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {totalFila > 0 && (
            <p className="text-[11px] text-amber-800 bg-amber-50 border-t border-amber-200 px-4 py-2.5">
              A distribuição automática atribui as conversas assim que houver um atendente disponível na fila.
            </p>
          )}
        </section>

        <section className="col-span-12 xl:col-span-4 app-panel overflow-hidden self-start">
          <header className="panel-header">
            <h2 className="text-sm font-semibold text-ink-950 flex-1">Equipe agora</h2>
            <span className="text-[11px] text-stone-500">{onlines} online</span>
          </header>
          {erro && (
            <p className="m-3 text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">{erro}</p>
          )}
          <div className="divide-y divide-paper-300">
            {presenca.isLoading && <div className="p-8 flex justify-center"><Spinner /></div>}
            {presenca.isError && <p className="p-4 text-sm text-red-600">{presenca.error.response?.data?.error || 'Erro ao carregar.'}</p>}
            {listaPresenca.map((a) => {
              const est = ESTADOS[a.estado] || ESTADOS.offline;
              const carga = cargaDe(a.atendenteId);
              const alterando = forcarPresenca.isPending && forcarPresenca.variables?.atendenteId === a.atendenteId;
              return (
                <div key={a.atendenteId} className={`flex items-center gap-2.5 px-4 py-2.5 ${a.estado === 'offline' ? 'opacity-55' : ''}`}>
                  <span className={`w-2 h-2 rounded-full shrink-0 ${est.cor}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-ink-950 truncate">{a.nome || `Matrícula ${a.matricula}`}</p>
                    <p className="text-[10px] text-stone-500">{est.rotulo}{carga > 0 ? ` · ${carga} conversa${carga > 1 ? 's' : ''}` : ''}</p>
                  </div>
                  {a.estado === 'pausa' ? (
                    <button type="button"
                      onClick={() => forcarPresenca.mutate({ atendenteId: a.atendenteId, estado: 'online' })}
                      disabled={alterando}
                      title="Tirar da pausa agora"
                      className="min-h-8 px-2.5 rounded-md bg-white text-emerald-700 border border-emerald-300 hover:bg-emerald-50 disabled:opacity-40 text-[11px] font-medium shrink-0">
                      {alterando ? 'Alterando…' : 'Disponibilizar'}
                    </button>
                  ) : a.estado === 'online' ? (
                    <button type="button"
                      onClick={() => forcarPresenca.mutate({ atendenteId: a.atendenteId, estado: 'pausa' })}
                      disabled={alterando}
                      title="Colocar em pausa agora"
                      className="min-h-8 px-2.5 rounded-md bg-white text-amber-700 border border-amber-300 hover:bg-amber-50 disabled:opacity-40 text-[11px] font-medium shrink-0">
                      {alterando ? 'Alterando…' : 'Pausar'}
                    </button>
                  ) : null}
                </div>
              );
            })}
            {presenca.data?.length === 0 && (
              <div className="px-4 py-8">
                <p className="text-sm font-medium text-ink-950">Nenhum atendente conectado</p>
                <p className="mt-1 text-[12px] leading-5 text-stone-600">
                  A presença é atualizada quando alguém entra no painel de conversas.
                </p>
              </div>
            )}
          </div>
          <p className="text-[10px] leading-4 text-stone-500 px-4 py-2.5 bg-paper-50 border-t border-paper-300">
            Em pausa, o atendente conclui as conversas atuais, mas não recebe novas.
          </p>
        </section>
      </div>
    </div>
  );
}
