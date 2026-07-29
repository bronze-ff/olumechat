import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../../services/api';
import Spinner from '../../components/ui/Spinner';

function fmtSeg(s) {
  if (s === null || s === undefined) return '—';
  const n = Number(s);
  if (n < 60) return `${n}s`;
  if (n < 3600) return `${Math.floor(n / 60)}m ${n % 60}s`;
  return `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`;
}

function isoDiasAtras(dias) {
  const d = new Date(Date.now() - dias * 86400000);
  return d.toISOString().slice(0, 10);
}

const PERIODOS = [
  { id: '7', rotulo: '7 dias' },
  { id: '30', rotulo: '30 dias' },
  { id: '90', rotulo: '90 dias' },
];

function Secao({ titulo, extra, children, className = '' }) {
  return (
    <section className={`bg-white rounded-2xl border border-black/[0.06] ${className}`}>
      <header className="flex items-center gap-2 px-4 pt-3.5 pb-2.5 border-b border-black/[0.05]">
        <span className="section-bar" />
        <h2 className="font-display font-bold text-sm text-stone-800 flex-1">{titulo}</h2>
        {extra}
      </header>
      {children}
    </section>
  );
}

export default function Dashboard() {
  const [periodo, setPeriodo] = useState('30');
  const de = isoDiasAtras(Number(periodo));

  const resumo = useQuery({
    queryKey: ['metricas', de],
    queryFn: () => api.get('/metricas/resumo', { params: { de } }).then((r) => r.data),
  });

  if (resumo.isLoading) return <div className="p-12 flex justify-center"><Spinner /></div>;
  if (resumo.isError) {
    return <p className="p-4 text-sm text-red-600">{resumo.error.response?.data?.error || 'Erro ao carregar métricas.'}</p>;
  }

  const { totais = {}, porDia = [], porDiaAtendente = [], porDepto = [], porAtendente = [] } = resumo.data || {};
  const maxDia = Math.max(1, ...porDia.map((d) => d.qtd));
  const maxDepto = Math.max(1, ...porDepto.map((d) => d.qtd));

  // dia -> [{ nome, qtd }] (já ordenado por qtd desc na query) p/ o tooltip do gráfico.
  const breakdownDia = {};
  for (const r of porDiaAtendente) (breakdownDia[r.dia] ||= []).push(r);

  const KPIS = [
    { rotulo: 'Atendimentos', valor: totais.total ?? 0 },
    { rotulo: 'Receptivas', valor: totais.receptivas ?? 0, cor: 'text-emerald-300' },
    { rotulo: 'Ativas', valor: totais.ativas ?? 0, cor: 'text-amber-200' },
    { rotulo: 'Resolvidos', valor: totais.resolvidas ?? 0 },
    { rotulo: 'Na fila agora', valor: totais.aguardando ?? 0, cor: totais.aguardando > 0 ? 'text-amber-300' : '' },
    { rotulo: 'Espera média', valor: fmtSeg(totais.esperaMediaSeg) },
    { rotulo: 'Resp. média (TMR)', valor: fmtSeg(totais.tmrMedioSeg) },
    { rotulo: 'Duração média', valor: fmtSeg(totais.duracaoMediaSeg) },
  ];

  return (
    <div className="max-w-screen-2xl mx-auto space-y-4">
      {/* Faixa de KPIs — sala de controle */}
      <section className="app-panel overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-paper-300">
          <h2 className="font-display font-bold text-sm flex-1">Visão geral</h2>
          <div className="flex gap-0.5 bg-paper-200 rounded-lg p-1">
            {PERIODOS.map((p) => (
              <button key={p.id} onClick={() => setPeriodo(p.id)}
                className={`min-h-8 px-3 text-[11px] rounded-md font-semibold
                  ${periodo === p.id ? 'bg-white text-brand-800' : 'text-stone-500 hover:text-stone-800'}`}>
                {p.rotulo}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 divide-x divide-y xl:divide-y-0 divide-paper-300">
          {KPIS.map((k) => (
            <div key={k.rotulo} className="px-4 py-4">
              <p className="text-[11px] font-medium text-stone-500">{k.rotulo}</p>
              <p className="mt-1.5 font-semibold text-xl tabular leading-none text-ink-950">{k.valor}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-12 gap-4">
        {/* Por dia */}
        <Secao titulo="Atendimentos por dia" className="col-span-12 xl:col-span-8">
          {porDia.length === 0 ? (
            <p className="text-sm text-stone-400 text-center py-14">
              Sem atendimentos no período — eles aparecem aqui assim que o número receber conversas.
            </p>
          ) : (
            <div className="px-4 pb-4 pt-3">
              <div className="relative flex items-end gap-[3px] h-44">
                {[0.25, 0.5, 0.75].map((f) => (
                  <div key={f} aria-hidden className="absolute left-0 right-0 border-t border-dashed border-black/[0.05]"
                    style={{ bottom: `${f * 100}%` }} />
                ))}
                {porDia.map((d) => (
                  <div key={d.dia} className="group relative flex-1 flex flex-col justify-end h-full min-w-0">
                    <div className="rounded-t-[3px] bg-brand-700 group-hover:bg-bordeaux-700 transition-colors"
                      style={{ height: `${Math.max(3, (d.qtd / maxDia) * 100)}%` }} />
                    <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-20
                                    w-max max-w-[230px] rounded-lg bg-ink-950 text-white shadow-lg px-3 py-2
                                    opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="font-mono text-[10px] text-white/60 border-b border-white/10 pb-1 mb-1 whitespace-nowrap">
                        {d.dia.slice(8)}/{d.dia.slice(5, 7)} · {d.qtd} atendimentos
                      </div>
                      <ul className="space-y-0.5 text-[11px]">
                        {(breakdownDia[d.dia] || []).slice(0, 6).map((b) => (
                          <li key={b.nome} className="flex justify-between gap-3">
                            <span className="truncate">{b.nome}</span>
                            <span className="font-mono tabular text-white/80">{b.qtd}</span>
                          </li>
                        ))}
                        {(breakdownDia[d.dia] || []).length > 6 && (
                          <li className="text-white/70 text-[10px] pt-0.5">+{breakdownDia[d.dia].length - 6} outros</li>
                        )}
                      </ul>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex justify-between mt-1.5 font-mono text-[9px] text-stone-400">
                <span>{porDia[0]?.dia.slice(8)}/{porDia[0]?.dia.slice(5, 7)}</span>
                <span>pico {maxDia}</span>
                <span>{porDia.at(-1)?.dia.slice(8)}/{porDia.at(-1)?.dia.slice(5, 7)}</span>
              </div>
            </div>
          )}
        </Secao>

        {/* Por departamento */}
        <Secao titulo="Por departamento" className="col-span-12 xl:col-span-4">
          <div className="p-4 space-y-3">
            {porDepto.length === 0 && <p className="text-sm text-stone-400 py-6 text-center">Sem dados no período.</p>}
            {porDepto.map((d) => (
              <div key={d.id}>
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <span className="text-[13px] font-medium text-stone-700 truncate">{d.nome}</span>
                  <span className="font-display font-bold text-base tabular text-stone-800">{d.qtd}</span>
                </div>
                <div className="h-2 rounded-full bg-paper-200 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${(d.qtd / maxDepto) * 100}%`, backgroundColor: d.cor || '#1F7A60' }} />
                </div>
                <p className="font-mono text-[10px] text-stone-400 mt-0.5">
                  {d.resolvidas} resolvidos · espera {fmtSeg(d.esperaMediaSeg)}
                </p>
              </div>
            ))}
          </div>
        </Secao>

        {/* Por atendente */}
        <Secao titulo="Desempenho por atendente" className="col-span-12">
          {porAtendente.length === 0 ? (
            <p className="text-sm text-stone-400 py-8 text-center">
              Sem atendimentos atribuídos no período — os indicadores por atendente nascem quando as conversas começarem a ser assumidas.
            </p>
          ) : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead>
                <tr className="font-mono text-[10px] uppercase tracking-widest text-stone-400 border-b border-black/[0.05]">
                  <th className="text-left px-4 py-2 font-medium">Atendente</th>
                  <th className="text-right px-4 py-2 font-medium">Atendimentos</th>
                  <th className="text-right px-4 py-2 font-medium">Ativas</th>
                  <th className="text-right px-4 py-2 font-medium">Receptivas</th>
                  <th className="text-right px-4 py-2 font-medium">Resolvidos</th>
                  <th className="text-right px-4 py-2 font-medium" title="Tempo médio até a 1ª resposta">TMR</th>
                  <th className="text-right px-4 py-2 font-medium">Duração média</th>
                </tr>
              </thead>
              <tbody>
                {porAtendente.map((a, i) => (
                  <tr key={a.id} className={`border-b border-black/[0.04] last:border-0 ${i === 0 ? 'bg-brand-50/40' : ''}`}>
                    <td className="px-4 py-2.5">
                      <span className="font-medium text-stone-800">{a.nome || `#${a.matricula}`}</span>
                      {i === 0 && <span className="ml-2 font-mono text-[9px] uppercase px-1.5 py-0.5 rounded bg-brand-700 text-white">top</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right font-display font-bold tabular">{a.qtd}</td>
                    <td className="px-4 py-2.5 text-right tabular text-amber-700">{a.ativas ?? 0}</td>
                    <td className="px-4 py-2.5 text-right tabular text-brand-700">{a.receptivas ?? 0}</td>
                    <td className="px-4 py-2.5 text-right tabular text-emerald-700">{a.resolvidas}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-stone-500">{fmtSeg(a.tmrMedioSeg)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-stone-500">{fmtSeg(a.duracaoMediaSeg)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Secao>
      </div>
    </div>
  );
}
