import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import apiOperador from '../../services/apiOperador';
import Spinner from '../../components/ui/Spinner';
import Icon from '../../components/ui/Icon';
import FaturaStatusBadge from '../../components/ui/FaturaStatusBadge';
import { formatarCentavos, formatarData } from '../../utils/dinheiro';

// Ficha financeira do cliente (FIL-80) — "dentro do tenant já existente":
// junta contrato, implementação, consumo e faturas de UM cliente. Só
// combina o que FIL-76/77/79 já expõem (GET /tenants/:id/contrato,
// /implementacao, /consumo, /faturas) — nenhuma rota nova de tenant, nenhum
// cálculo novo de negócio.

const IMPLEMENTACAO_STATUS = { a_iniciar: 'A iniciar', em_andamento: 'Em andamento', entregue: 'Entregue' };

function FaturaLinha({ tenantId, fatura }) {
  const [aberta, setAberta] = useState(false);
  const detalhe = useQuery({
    queryKey: ['operador', 'fatura-detalhe', tenantId, fatura.id],
    queryFn: () => apiOperador.get(`/tenants/${tenantId}/faturas/${fatura.id}`).then((r) => r.data),
    enabled: aberta,
  });
  return (
    <>
      <tr className="hover:bg-paper-50 cursor-pointer" onClick={() => setAberta((v) => !v)}>
        <td className="px-4 py-2.5 font-mono text-stone-600">{fatura.competencia}</td>
        <td className="px-4 py-2.5"><FaturaStatusBadge value={fatura.status} /></td>
        <td className="px-4 py-2.5 text-stone-600">{formatarData(fatura.vencimento)}</td>
        <td className="px-4 py-2.5 text-right font-semibold text-ink-950 tabular">{formatarCentavos(fatura.valorTotalCentavos)}</td>
        <td className="px-4 py-2.5 text-stone-400">
          <Icon name="arrow" size={13} className={`transition-transform ${aberta ? 'rotate-90' : ''}`} />
        </td>
      </tr>
      {aberta && (
        <tr>
          <td colSpan={5} className="px-4 pb-3 bg-paper-50">
            {detalhe.isLoading ? (
              <div className="py-3 flex justify-center"><Spinner size="sm" /></div>
            ) : detalhe.data && (
              <div className="py-2 space-y-2">
                {fatura.custoIncerto && (
                  <p className="text-[11px] text-amber-700">Consumo do período tem custo desconhecido — valor pode mudar antes de emitir.</p>
                )}
                <div className="text-xs text-stone-600">
                  Saldo em aberto: <strong className="text-ink-950 tabular">{formatarCentavos(detalhe.data.saldoCentavos)}</strong>
                </div>
                {detalhe.data.pagamentos.length > 0 ? (
                  <ul className="text-xs text-stone-600 space-y-1">
                    {detalhe.data.pagamentos.map((p) => (
                      <li key={p.id}>{formatarData(p.dataPagamento)} · {p.meio} · <span className="tabular">{formatarCentavos(p.valorCentavos)}</span></li>
                    ))}
                  </ul>
                ) : <p className="text-xs text-stone-500">Nenhum pagamento registrado ainda.</p>}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export default function FichaFinanceiraModal({ tenant, onClose }) {
  const contratos = useQuery({
    queryKey: ['operador', 'contrato', tenant.id],
    queryFn: () => apiOperador.get(`/tenants/${tenant.id}/contrato`).then((r) => r.data),
  });
  const implementacao = useQuery({
    queryKey: ['operador', 'implementacao', tenant.id],
    queryFn: () => apiOperador.get(`/tenants/${tenant.id}/implementacao`).then((r) => r.data),
  });
  const consumo = useQuery({
    queryKey: ['operador', 'consumo', tenant.id],
    queryFn: () => apiOperador.get(`/tenants/${tenant.id}/consumo`).then((r) => r.data),
  });
  const faturas = useQuery({
    queryKey: ['operador', 'faturas', tenant.id],
    queryFn: () => apiOperador.get(`/tenants/${tenant.id}/faturas`).then((r) => r.data),
  });

  const contratoAtivo = (contratos.data || []).find((c) => c.ativo);
  const itensContrato = useQuery({
    queryKey: ['operador', 'contrato-itens', tenant.id, contratoAtivo?.id],
    queryFn: () => apiOperador.get(`/tenants/${tenant.id}/contrato/${contratoAtivo.id}/itens`).then((r) => r.data),
    enabled: !!contratoAtivo,
  });

  const custoTotalMes = (consumo.data?.serie || []).reduce((soma, item) => soma + item.custoCentavos, 0);
  const carregando = contratos.isLoading || implementacao.isLoading || consumo.isLoading || faturas.isLoading;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-ink-950/60 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative w-full sm:max-w-2xl bg-white border border-paper-400 rounded-t-[10px] sm:rounded-[10px] shadow-2xl overflow-hidden max-h-[92vh] flex flex-col">
        <div className="px-5 py-4 border-b border-paper-300 flex items-center gap-3">
          <span className="w-9 h-9 rounded-lg bg-brand-100 text-brand-800 flex items-center justify-center shrink-0">
            <Icon name="chart" size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-ink-950 truncate">Ficha financeira</h2>
            <p className="text-xs text-stone-500 truncate">{tenant.nome}</p>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-lg border border-paper-400 text-stone-500 hover:bg-paper-100 hover:text-ink-950" aria-label="Fechar">✕</button>
        </div>

        <div className="modal-body space-y-5">
          {carregando ? <div className="p-8 flex justify-center"><Spinner /></div> : (
            <>
              <section>
                <h3 className="text-xs font-semibold text-stone-600 uppercase tracking-wide">Contrato vigente</h3>
                {contratoAtivo ? (
                  <div className="mt-2 p-3 rounded-lg border border-paper-300 bg-paper-50">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-semibold text-sm text-ink-950">{contratoAtivo.planoNome}</p>
                      <p className="font-semibold text-sm text-ink-950 tabular">
                        {formatarCentavos(contratoAtivo.valorRecorrenteCentavos)}<span className="text-stone-500 font-normal">/{contratoAtivo.ciclo}</span>
                      </p>
                    </div>
                    <p className="mt-1 text-xs text-stone-500">
                      Cobrança desde {formatarData(contratoAtivo.inicioCobranca)} · vence todo dia {contratoAtivo.diaVencimento}
                    </p>
                    {(itensContrato.data || []).length > 0 && (
                      <ul className="mt-2 space-y-1 text-xs text-stone-600">
                        {itensContrato.data.map((item) => (
                          <li key={item.id} className="flex items-center justify-between">
                            <span>{item.descricao}{item.recorrente ? ' · recorrente' : ''}</span>
                            <span className="tabular">{formatarCentavos(item.valorUnitarioCentavos * item.quantidade)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : <p className="mt-2 text-sm text-stone-500">Nenhum contrato ativo.</p>}
              </section>

              <section>
                <h3 className="text-xs font-semibold text-stone-600 uppercase tracking-wide">Implementação</h3>
                {implementacao.data ? (
                  <div className="mt-2 p-3 rounded-lg border border-paper-300 bg-paper-50 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-ink-950">{IMPLEMENTACAO_STATUS[implementacao.data.status] || implementacao.data.status}</p>
                      <p className="text-xs text-stone-500">
                        {implementacao.data.formaPagamento === 'parcelado' ? `Parcelado em ${implementacao.data.numeroParcelas}x` : 'À vista'}
                        {implementacao.data.dataPrevista && ` · previsto para ${formatarData(implementacao.data.dataPrevista)}`}
                      </p>
                    </div>
                    <p className="font-semibold text-sm text-ink-950 tabular">{formatarCentavos(implementacao.data.valorCentavos)}</p>
                  </div>
                ) : <p className="mt-2 text-sm text-stone-500">Nenhuma implementação registrada.</p>}
              </section>

              <section>
                <h3 className="text-xs font-semibold text-stone-600 uppercase tracking-wide">Consumo do mês (visível só ao operador)</h3>
                {(consumo.data?.serie || []).length > 0 ? (
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="text-stone-500">
                        <tr>
                          <th className="text-left font-medium py-1">Tipo</th>
                          <th className="text-right font-medium py-1">Quantidade</th>
                          <th className="text-right font-medium py-1">Custo</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-paper-200">
                        {consumo.data.serie.map((item) => (
                          <tr key={item.tipo}>
                            <td className="py-1.5">{item.tipo}</td>
                            <td className="py-1.5 text-right tabular">{item.quantidade}</td>
                            <td className="py-1.5 text-right tabular">{formatarCentavos(item.custoCentavos)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t border-paper-300 font-semibold text-ink-950">
                          <td className="py-1.5">Total</td><td /><td className="py-1.5 text-right tabular">{formatarCentavos(custoTotalMes)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                ) : <p className="mt-2 text-sm text-stone-500">Sem consumo registrado no período.</p>}
              </section>

              <section>
                <h3 className="text-xs font-semibold text-stone-600 uppercase tracking-wide">Faturas</h3>
                {(faturas.data || []).length > 0 ? (
                  <div className="mt-2 overflow-x-auto rounded-lg border border-paper-300">
                    <table className="w-full min-w-[420px] text-xs">
                      <thead className="bg-paper-100 text-stone-600">
                        <tr>
                          <th className="px-4 py-2 text-left font-semibold">Competência</th>
                          <th className="px-4 py-2 text-left font-semibold">Status</th>
                          <th className="px-4 py-2 text-left font-semibold">Vencimento</th>
                          <th className="px-4 py-2 text-right font-semibold">Valor</th>
                          <th className="px-4 py-2" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-paper-200">
                        {faturas.data.map((f) => <FaturaLinha key={f.id} tenantId={tenant.id} fatura={f} />)}
                      </tbody>
                    </table>
                  </div>
                ) : <p className="mt-2 text-sm text-stone-500">Nenhuma fatura gerada ainda.</p>}
              </section>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button onClick={onClose} className="flex-1 min-h-10 rounded-lg border border-paper-400 bg-white hover:bg-paper-100 text-stone-700 font-semibold text-sm">Fechar</button>
        </div>
      </div>
    </div>
  );
}
