import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import apiOperador, { CHAVE_TOKEN } from '../../services/apiOperador';
import Spinner from '../../components/ui/Spinner';
import Icon from '../../components/ui/Icon';
import FaturaStatusBadge from '../../components/ui/FaturaStatusBadge';
import OperadorShell from '../../components/layout/OperadorShell';
import RegistrarPagamentoModal from './RegistrarPagamentoModal';
import { SECOES, GRUPOS } from './nav';
import { formatarCentavos, formatarData } from '../../utils/dinheiro';

// Painel financeiro do operador (FIL-80) — transforma o que FIL-76/77/78/79
// já gravam em decisão comercial. Camada só de LEITURA: cada número aqui vem
// de server/financeiro/painel.js, que por sua vez reusa contrato, consumo e
// fatura já existentes — nenhum cálculo de negócio novo neste arquivo.

function Kpi({ label, value, detail, tom }) {
  const cor = { alerta: 'text-red-700', atencao: 'text-amber-700' }[tom] || 'text-ink-950';
  return (
    <div className="px-4 py-4 md:px-5">
      <p className="text-xs font-medium text-stone-600">{label}</p>
      <div className="mt-2 flex items-baseline gap-2">
        <strong className={`text-2xl font-semibold tracking-[-0.03em] tabular ${cor}`}>{value}</strong>
      </div>
      {detail && <p className="mt-1 text-[11px] text-stone-500">{detail}</p>}
    </div>
  );
}

function VisaoGeral() {
  const resumo = useQuery({
    queryKey: ['operador', 'financeiro', 'resumo'],
    queryFn: () => apiOperador.get('/financeiro/resumo').then((r) => r.data),
  });
  const clientes = useQuery({
    queryKey: ['operador', 'financeiro', 'clientes'],
    queryFn: () => apiOperador.get('/financeiro/clientes').then((r) => r.data),
  });

  if (resumo.isLoading) return <div className="p-12 flex justify-center"><Spinner /></div>;
  if (resumo.isError) return <p className="p-5 text-sm text-red-700">Não foi possível carregar o resumo financeiro.</p>;
  const r = resumo.data;

  return (
    <div className="space-y-5">
      <section className="app-panel overflow-hidden">
        <div className="grid grid-cols-2 xl:grid-cols-4 divide-x divide-y xl:divide-y-0 divide-paper-300">
          <Kpi label="MRR" value={formatarCentavos(r.mrrCentavos)} detail="clientes ativos, recorrência vigente" />
          <Kpi label="A receber no mês" value={formatarCentavos(r.aReceberCentavos)} detail={`competência ${r.competencia}`} />
          <Kpi
            label="Atrasado"
            value={formatarCentavos(r.atrasadoCentavos)}
            detail={`${r.faturasAtrasadas} ${r.faturasAtrasadas === 1 ? 'fatura' : 'faturas'}`}
            tom={r.faturasAtrasadas > 0 ? 'alerta' : undefined}
          />
          <Kpi
            label="Margem estimada"
            value={r.margemParcial ? `${formatarCentavos(r.margemCentavos)} (parcial)` : formatarCentavos(r.margemCentavos)}
            detail={r.margemParcial ? 'custo indisponível para 1+ cliente — ver tabela abaixo' : `${r.clientesComMargemCalculada} clientes considerados`}
            tom={r.margemParcial ? 'atencao' : undefined}
          />
        </div>
        <div className="grid grid-cols-3 divide-x divide-paper-300 border-t border-paper-300">
          <Kpi label="Clientes ativos" value={r.clientesAtivos} />
          <Kpi label="Suspensos" value={r.clientesSuspensos} />
          <Kpi label="Em implantação" value={r.clientesImplantacao} />
        </div>
      </section>

      <section className="app-panel overflow-hidden">
        <header className="px-5 py-4 border-b border-paper-300">
          <h2 className="font-semibold text-ink-950">Cobrado x custo x margem por cliente</h2>
          <p className="mt-0.5 text-xs text-stone-500">
            Custo vem do consumo medido (FIL-77). Quando algum evento do período ainda não tem preço cadastrado, a margem
            aparece como "indisponível" — nunca como zero.
          </p>
        </header>
        {clientes.isLoading && <div className="p-8 flex justify-center"><Spinner /></div>}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs">
            <thead className="bg-paper-100 text-stone-600">
              <tr>
                <th className="px-5 py-2.5 text-left font-semibold">Cliente</th>
                <th className="px-5 py-2.5 text-left font-semibold">Plano</th>
                <th className="px-5 py-2.5 text-right font-semibold">Cobrado</th>
                <th className="px-5 py-2.5 text-right font-semibold">Custo</th>
                <th className="px-5 py-2.5 text-right font-semibold">Margem</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-300">
              {(clientes.data || []).map((c) => (
                <tr key={c.tenantId} className="hover:bg-paper-50">
                  <td className="px-5 py-3">
                    <p className="font-semibold text-ink-950">{c.tenantNome}</p>
                    <p className="font-mono text-[11px] text-stone-500">{c.tenantSlug}</p>
                  </td>
                  <td className="px-5 py-3 text-stone-600">{c.planoNome || '—'}</td>
                  <td className="px-5 py-3 text-right tabular text-ink-950">{formatarCentavos(c.cobradoCentavos)}</td>
                  <td className="px-5 py-3 text-right tabular text-stone-600">{formatarCentavos(c.custoCentavos)}</td>
                  <td className="px-5 py-3 text-right tabular">
                    {c.custoDesconhecido ? (
                      <span className="text-amber-700 font-semibold">indisponível</span>
                    ) : c.margemCentavos === null ? (
                      <span className="text-stone-400">—</span>
                    ) : (
                      <span className={c.margemCentavos < 0 ? 'text-red-700 font-semibold' : 'text-emerald-700 font-semibold'}>
                        {formatarCentavos(c.margemCentavos)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {clientes.data?.length === 0 && <p className="p-8 text-sm text-stone-600 text-center">Nenhum cliente ativo ou suspenso.</p>}
        </div>
      </section>
    </div>
  );
}

function Cobranca() {
  const [status, setStatus] = useState('');
  const [pagamentoDe, setPagamentoDe] = useState(null);
  const faturas = useQuery({
    queryKey: ['operador', 'financeiro', 'faturas', status],
    queryFn: () => apiOperador.get('/financeiro/faturas', { params: status ? { status } : {} }).then((r) => r.data),
  });

  const lista = faturas.data || [];
  const totalSaldo = useMemo(() => lista.reduce((soma, f) => soma + f.saldoCentavos, 0), [lista]);

  return (
    <section className="app-panel overflow-hidden">
      <header className="px-5 py-4 flex flex-wrap items-center gap-3 border-b border-paper-300">
        <div className="flex-1">
          <h2 className="font-semibold text-ink-950">Cobrança do mês</h2>
          <p className="mt-0.5 text-xs text-stone-500">
            {lista.length} {lista.length === 1 ? 'fatura' : 'faturas'} · saldo em aberto {formatarCentavos(totalSaldo)}
          </p>
        </div>
        <select className="min-h-10 text-xs border border-paper-400 rounded-lg px-3 bg-white text-stone-700" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todos os status</option>
          <option value="prevista">Prevista</option>
          <option value="emitida">Emitida</option>
          <option value="atrasada">Atrasada</option>
          <option value="em_negociacao">Em negociação</option>
          <option value="paga">Paga</option>
          <option value="cancelada">Cancelada</option>
        </select>
      </header>

      {faturas.isLoading && <div className="p-8 flex justify-center"><Spinner /></div>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-xs">
          <thead className="bg-paper-100 text-stone-600">
            <tr>
              <th className="px-5 py-2.5 text-left font-semibold">Cliente</th>
              <th className="px-5 py-2.5 text-left font-semibold">Status</th>
              <th className="px-5 py-2.5 text-left font-semibold">Vencimento</th>
              <th className="px-5 py-2.5 text-right font-semibold">Valor</th>
              <th className="px-5 py-2.5 text-right font-semibold">Saldo</th>
              <th className="px-5 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-paper-300">
            {lista.map((f) => (
              <tr key={f.id} className="hover:bg-paper-50">
                <td className="px-5 py-3">
                  <p className="font-semibold text-ink-950">{f.tenantNome}</p>
                  <p className="font-mono text-[11px] text-stone-500">{f.tenantSlug}</p>
                </td>
                <td className="px-5 py-3">
                  <FaturaStatusBadge value={f.status} />
                  {f.diasVencida !== null && <span className="ml-1.5 text-[11px] text-red-700 font-semibold">{f.diasVencida}d</span>}
                </td>
                <td className="px-5 py-3 text-stone-600">{formatarData(f.vencimento)}</td>
                <td className="px-5 py-3 text-right tabular text-ink-950">{formatarCentavos(f.valorTotalCentavos)}</td>
                <td className="px-5 py-3 text-right tabular font-semibold text-ink-950">{formatarCentavos(f.saldoCentavos)}</td>
                <td className="px-5 py-3 text-right">
                  {f.saldoCentavos > 0 && !['cancelada'].includes(f.status) && (
                    <button
                      onClick={() => setPagamentoDe(f)}
                      className="min-h-8 px-3 rounded-lg border border-paper-400 bg-white text-stone-700 hover:border-brand-300 hover:text-brand-800 text-[11px] font-semibold"
                    >
                      Registrar pagamento
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {lista.length === 0 && !faturas.isLoading && <p className="p-8 text-sm text-stone-600 text-center">Nenhuma fatura corresponde a este filtro.</p>}
      </div>

      {pagamentoDe && <RegistrarPagamentoModal fatura={pagamentoDe} onClose={() => setPagamentoDe(null)} />}
    </section>
  );
}

function Alertas() {
  const alertas = useQuery({
    queryKey: ['operador', 'financeiro', 'alertas'],
    queryFn: () => apiOperador.get('/financeiro/alertas').then((r) => r.data),
  });

  if (alertas.isLoading) return <div className="p-12 flex justify-center"><Spinner /></div>;
  if (alertas.isError) return <p className="p-5 text-sm text-red-700">Não foi possível carregar os alertas.</p>;
  const { tetoIa = [], atrasados = [], implementacaoVencida = [] } = alertas.data || {};
  const total = tetoIa.length + atrasados.length + implementacaoVencida.length;

  return (
    <div className="space-y-5">
      {total === 0 && (
        <section className="app-panel p-8 text-center">
          <span className="mx-auto w-11 h-11 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center">
            <Icon name="check" size={21} />
          </span>
          <h3 className="mt-3 text-sm font-semibold text-ink-950">Nenhum alerta no momento</h3>
          <p className="mt-1 text-sm text-stone-600">Nenhum cliente perto do teto de IA, atrasado ou com implementação vencida.</p>
        </section>
      )}

      {atrasados.length > 0 && (
        <section className="app-panel overflow-hidden">
          <header className="px-5 py-4 border-b border-paper-300">
            <h2 className="font-semibold text-ink-950">Atrasados</h2>
            <p className="mt-0.5 text-xs text-stone-500">Faturas vencidas há mais dias do que o tolerado — o operador decide se suspende.</p>
          </header>
          <div className="divide-y divide-paper-300">
            {atrasados.map((a) => (
              <div key={a.id} className="px-5 py-3 flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold text-sm text-ink-950">{a.tenantNome}</p>
                  <p className="text-xs text-stone-500">Venceu em {formatarData(a.vencimento)} · {a.diasVencida} dias atrás</p>
                </div>
                <p className="font-semibold text-sm text-red-700 tabular">{formatarCentavos(a.valorTotalCentavos)}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {tetoIa.length > 0 && (
        <section className="app-panel overflow-hidden">
          <header className="px-5 py-4 border-b border-paper-300">
            <h2 className="font-semibold text-ink-950">Perto do teto de IA</h2>
            <p className="mt-0.5 text-xs text-stone-500">80% ou mais do teto de tokens do mês já consumido.</p>
          </header>
          <div className="divide-y divide-paper-300">
            {tetoIa.map((a) => (
              <div key={a.tenantId} className="px-5 py-3 flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold text-sm text-ink-950">{a.tenantNome}</p>
                  <p className="text-xs text-stone-500 tabular">{a.tokensUsadosMes.toLocaleString('pt-BR')} / {a.tetoTokensMes.toLocaleString('pt-BR')} tokens</p>
                </div>
                <p className={`font-semibold text-sm tabular ${a.tetoEstourado ? 'text-red-700' : 'text-amber-700'}`}>
                  {Math.round(a.percentual * 100)}%
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {implementacaoVencida.length > 0 && (
        <section className="app-panel overflow-hidden">
          <header className="px-5 py-4 border-b border-paper-300">
            <h2 className="font-semibold text-ink-950">Implementação vencida</h2>
            <p className="mt-0.5 text-xs text-stone-500">Data prevista de entrega já passou e o projeto ainda não foi entregue.</p>
          </header>
          <div className="divide-y divide-paper-300">
            {implementacaoVencida.map((a) => (
              <div key={a.tenantId} className="px-5 py-3 flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold text-sm text-ink-950">{a.tenantNome}</p>
                  <p className="text-xs text-stone-500">Previsto para {formatarData(a.dataPrevista)} · {a.diasVencida} dias atrás</p>
                </div>
                <span className="text-xs font-semibold text-amber-700">{a.status === 'a_iniciar' ? 'A iniciar' : 'Em andamento'}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export default function Financeiro({ secao = 'financeiro' }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const eu = useQuery({ queryKey: ['operador', 'eu'], queryFn: () => apiOperador.get('/eu').then((r) => r.data) });
  const atual = SECOES.find((item) => item.id === secao) || SECOES[2];

  async function sair() {
    try { await apiOperador.post('/logout'); } catch { /* encerra a sessão local mesmo sem resposta */ }
    localStorage.removeItem(CHAVE_TOKEN);
    navigate('/operador/login', { replace: true });
  }

  const titulo = {
    financeiro: 'Visão geral financeira',
    'financeiro-cobranca': 'Cobrança do mês',
    'financeiro-alertas': 'Alertas',
  }[secao];
  const descricao = {
    financeiro: 'MRR, a receber, atrasado e margem estimada da carteira.',
    'financeiro-cobranca': 'Faturas do mês por status, com ação de registrar pagamento.',
    'financeiro-alertas': 'Clientes que precisam de atenção: teto de IA, atraso e implementação vencida.',
  }[secao];

  return (
    <OperadorShell
      secoes={SECOES}
      grupos={GRUPOS}
      atual={atual}
      eu={eu}
      onSair={sair}
      titulo={titulo}
      descricao={descricao}
      acao={
        <button
          onClick={() => qc.invalidateQueries({ queryKey: ['operador', 'financeiro'] })}
          className="min-h-10 px-4 rounded-lg border border-paper-400 bg-white hover:bg-paper-100 text-stone-700 text-sm font-semibold inline-flex items-center gap-2"
        >
          <Icon name="history" size={16} />
          Atualizar
        </button>
      }
    >
      {secao === 'financeiro' && <VisaoGeral />}
      {secao === 'financeiro-cobranca' && <Cobranca />}
      {secao === 'financeiro-alertas' && <Alertas />}
    </OperadorShell>
  );
}
