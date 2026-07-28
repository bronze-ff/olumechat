import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiOperador from '../../services/apiOperador';
import Spinner from '../../components/ui/Spinner';
import Icon from '../../components/ui/Icon';
import FaturaStatusBadge from '../../components/ui/FaturaStatusBadge';
import ContratoModal from './ContratoModal';
import RegistrarPagamentoModal from './RegistrarPagamentoModal';
import { formatarCentavos, formatarData, paraCentavos } from '../../utils/dinheiro';

// Ficha financeira do cliente (FIL-80 leitura, FIL-82 escrita) — junta
// contrato, implementação, consumo e faturas de UM cliente e agora também
// EDITA cada um deles, chamando as rotas que já existem em
// server/operador/routes.js (contrato, itens, implementação, faturas,
// emitir, pagamento): nenhuma regra de negócio nova neste arquivo, só o
// formulário em cima do que FIL-76/77/79 já validam e auditam no backend.

const IMPLEMENTACAO_STATUS = { a_iniciar: 'A iniciar', em_andamento: 'Em andamento', entregue: 'Entregue' };
const TIPOS_ITEM_CONTRATO = [
  { id: 'implementacao', label: 'Implementação' },
  { id: 'addon_ia', label: 'Add-on de IA' },
  { id: 'numero_extra', label: 'Número extra' },
  { id: 'excedente_mensagem', label: 'Excedente de mensagem' },
  { id: 'desconto', label: 'Desconto' },
  { id: 'avulso', label: 'Avulso' },
];
const TIPOS_ITEM_FATURA = [{ id: 'avulso', label: 'Avulso' }, { id: 'desconto', label: 'Desconto' }];
const FORMAS_PAGAMENTO = [{ id: 'a_vista', label: 'À vista' }, { id: 'parcelado', label: 'Parcelado' }];
// Mesma allowlist de server/operador/fatura.js::registrarPagamento — uma
// fatura `prevista` ainda não foi emitida (nada a cobrar do cliente ainda);
// oferecer "Registrar pagamento" nesse status sempre resultava em 409.
const STATUS_FATURA_ACEITA_PAGAMENTO = ['emitida', 'atrasada', 'em_negociacao'];

function CampoLabel({ children }) {
  return <label className="block text-[11px] font-semibold text-stone-600 mb-1">{children}</label>;
}

// ---------------------------------------------------------------------------
// Item de contrato (adicionar/editar) — POST/PATCH .../contrato/:id/itens
// ---------------------------------------------------------------------------
function ItemContratoForm({ tenantId, contratoId, item, onDone, onCancel }) {
  const qc = useQueryClient();
  const [tipo, setTipo] = useState(item?.tipo || 'avulso');
  const [descricao, setDescricao] = useState(item?.descricao || '');
  const [valor, setValor] = useState(item ? (item.valorUnitarioCentavos / 100).toFixed(2).replace('.', ',') : '');
  const [quantidade, setQuantidade] = useState(item ? String(item.quantidade) : '1');
  const [recorrente, setRecorrente] = useState(item?.recorrente || false);
  const [erro, setErro] = useState('');

  const valorCentavos = paraCentavos(valor);
  const podeSalvar = descricao.trim() && valorCentavos !== null && Number(quantidade) >= 1;

  const salvar = useMutation({
    mutationFn: () => {
      const payload = { tipo, descricao: descricao.trim(), valorUnitarioCentavos: valorCentavos, quantidade: Number(quantidade), recorrente };
      return item
        ? apiOperador.patch(`/tenants/${tenantId}/contrato/${contratoId}/itens/${item.id}`, payload)
        : apiOperador.post(`/tenants/${tenantId}/contrato/${contratoId}/itens`, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['operador', 'contrato-itens', tenantId, contratoId] });
      onDone();
    },
    onError: (error) => setErro(error.response?.data?.error || 'Não foi possível salvar o item.'),
  });

  return (
    <div className="p-3 rounded-lg border border-brand-200 bg-brand-50/40 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <select className="input-field !min-h-9 !py-1.5 text-xs" value={tipo} onChange={(e) => setTipo(e.target.value)}>
          {TIPOS_ITEM_CONTRATO.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <label className="flex items-center gap-2 text-xs text-stone-700">
          <input type="checkbox" checked={recorrente} onChange={(e) => setRecorrente(e.target.checked)} className="w-4 h-4 accent-brand-700" />
          Recorrente
        </label>
      </div>
      <input className="input-field !min-h-9 !py-1.5 text-xs" placeholder="Descrição" value={descricao} onChange={(e) => { setDescricao(e.target.value); setErro(''); }} />
      <div className="grid grid-cols-2 gap-2">
        <input className="input-field !min-h-9 !py-1.5 text-xs tabular" placeholder="Valor unitário (R$)" value={valor} onChange={(e) => { setValor(e.target.value); setErro(''); }} />
        <input type="number" min="1" className="input-field !min-h-9 !py-1.5 text-xs tabular" placeholder="Quantidade" value={quantidade} onChange={(e) => setQuantidade(e.target.value)} />
      </div>
      {erro && <p className="text-[11px] text-red-600">{erro}</p>}
      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 min-h-8 rounded-lg border border-paper-400 bg-white text-stone-700 text-xs font-semibold">Cancelar</button>
        <button onClick={() => salvar.mutate()} disabled={!podeSalvar || salvar.isPending} className="flex-1 min-h-8 rounded-lg bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold disabled:opacity-40">
          {salvar.isPending ? 'Salvando…' : 'Salvar item'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Implementação (registrar/editar) — POST/PATCH .../implementacao[/:id]
// ---------------------------------------------------------------------------
function ImplementacaoForm({ tenantId, existente, onDone, onCancel }) {
  const qc = useQueryClient();
  const [valor, setValor] = useState(existente ? (existente.valorCentavos / 100).toFixed(2).replace('.', ',') : '');
  const [formaPagamento, setFormaPagamento] = useState(existente?.formaPagamento || 'a_vista');
  const [numeroParcelas, setNumeroParcelas] = useState(existente?.numeroParcelas ? String(existente.numeroParcelas) : '2');
  const [status, setStatus] = useState(existente?.status || 'a_iniciar');
  const [dataPrevista, setDataPrevista] = useState(existente?.dataPrevista ? String(existente.dataPrevista).slice(0, 10) : '');
  const [dataEntrega, setDataEntrega] = useState(existente?.dataEntrega ? String(existente.dataEntrega).slice(0, 10) : '');
  const [responsavel, setResponsavel] = useState(existente?.responsavel || '');
  const [erro, setErro] = useState('');

  const valorCentavos = paraCentavos(valor);
  const podeSalvar = valorCentavos !== null && valorCentavos >= 0 && (status !== 'entregue' || !!dataEntrega);

  const salvar = useMutation({
    mutationFn: () => {
      // Achado [P2] de review do PR #28: `undefined` some do JSON (o Axios
      // omite a chave), e atualizarImplementacao() interpreta CAMPO AUSENTE
      // como "preserve o valor atual" (merge parcial) — limpar um campo
      // opcional reportava sucesso mas não limpava nada. `null` explícito é o
      // que de fato apaga o campo, tanto no PATCH (merge) quanto no POST.
      const payload = {
        valorCentavos, formaPagamento,
        numeroParcelas: formaPagamento === 'parcelado' ? Number(numeroParcelas) : null,
        status, dataPrevista: dataPrevista || null, dataEntrega: dataEntrega || null,
        responsavel: responsavel.trim() || null,
      };
      return existente
        ? apiOperador.patch(`/tenants/${tenantId}/implementacao/${existente.id}`, payload)
        : apiOperador.post(`/tenants/${tenantId}/implementacao`, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['operador', 'implementacao', tenantId] });
      onDone();
    },
    onError: (error) => setErro(error.response?.data?.error || 'Não foi possível salvar a implementação.'),
  });

  return (
    <div className="mt-2 p-3 rounded-lg border border-brand-200 bg-brand-50/40 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <CampoLabel>Valor (R$)</CampoLabel>
          <input className="input-field !min-h-9 !py-1.5 text-xs tabular" value={valor} onChange={(e) => { setValor(e.target.value); setErro(''); }} />
        </div>
        <div>
          <CampoLabel>Forma de pagamento</CampoLabel>
          <select className="input-field !min-h-9 !py-1.5 text-xs" value={formaPagamento} onChange={(e) => setFormaPagamento(e.target.value)}>
            {FORMAS_PAGAMENTO.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </div>
      </div>
      {formaPagamento === 'parcelado' && (
        <div>
          <CampoLabel>Número de parcelas</CampoLabel>
          <input type="number" min="2" className="input-field !min-h-9 !py-1.5 text-xs tabular" value={numeroParcelas} onChange={(e) => setNumeroParcelas(e.target.value)} />
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <CampoLabel>Status</CampoLabel>
          <select className="input-field !min-h-9 !py-1.5 text-xs" value={status} onChange={(e) => setStatus(e.target.value)}>
            {Object.entries(IMPLEMENTACAO_STATUS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </div>
        <div>
          <CampoLabel>Responsável</CampoLabel>
          <input className="input-field !min-h-9 !py-1.5 text-xs" value={responsavel} onChange={(e) => setResponsavel(e.target.value)} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <CampoLabel>Previsão de entrega</CampoLabel>
          <input type="date" className="input-field !min-h-9 !py-1.5 text-xs" value={dataPrevista} onChange={(e) => setDataPrevista(e.target.value)} />
        </div>
        <div>
          <CampoLabel>Data de entrega {status === 'entregue' && <span className="text-red-600">*</span>}</CampoLabel>
          <input type="date" className="input-field !min-h-9 !py-1.5 text-xs" value={dataEntrega} onChange={(e) => setDataEntrega(e.target.value)} />
        </div>
      </div>
      {erro && <p className="text-[11px] text-red-600">{erro}</p>}
      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 min-h-8 rounded-lg border border-paper-400 bg-white text-stone-700 text-xs font-semibold">Cancelar</button>
        <button onClick={() => salvar.mutate()} disabled={!podeSalvar || salvar.isPending} className="flex-1 min-h-8 rounded-lg bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold disabled:opacity-40">
          {salvar.isPending ? 'Salvando…' : existente ? 'Salvar alterações' : 'Registrar implementação'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item avulso/desconto de uma fatura `prevista` — POST .../faturas/:id/itens
// ---------------------------------------------------------------------------
function ItemFaturaForm({ tenantId, faturaId, onDone, onCancel }) {
  const qc = useQueryClient();
  const [tipo, setTipo] = useState('avulso');
  const [descricao, setDescricao] = useState('');
  const [valor, setValor] = useState('');
  const [quantidade, setQuantidade] = useState('1');
  const [erro, setErro] = useState('');

  const valorCentavos = paraCentavos(valor);
  const podeSalvar = descricao.trim() && valorCentavos !== null && Number(quantidade) >= 1;

  const salvar = useMutation({
    mutationFn: () => apiOperador.post(`/tenants/${tenantId}/faturas/${faturaId}/itens`, {
      tipo, descricao: descricao.trim(), valorUnitarioCentavos: valorCentavos, quantidade: Number(quantidade),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['operador', 'fatura-detalhe', tenantId, faturaId] });
      qc.invalidateQueries({ queryKey: ['operador', 'faturas', tenantId] });
      onDone();
    },
    onError: (error) => setErro(error.response?.data?.error || 'Não foi possível adicionar o item.'),
  });

  return (
    <div className="p-2.5 rounded-lg border border-brand-200 bg-brand-50/40 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <select className="input-field !min-h-8 !py-1 text-[11px]" value={tipo} onChange={(e) => setTipo(e.target.value)}>
          {TIPOS_ITEM_FATURA.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <input type="number" min="1" className="input-field !min-h-8 !py-1 text-[11px] tabular" placeholder="Quantidade" value={quantidade} onChange={(e) => setQuantidade(e.target.value)} />
      </div>
      <input className="input-field !min-h-8 !py-1 text-[11px]" placeholder="Descrição" value={descricao} onChange={(e) => { setDescricao(e.target.value); setErro(''); }} />
      <input className="input-field !min-h-8 !py-1 text-[11px] tabular" placeholder="Valor unitário (R$)" value={valor} onChange={(e) => { setValor(e.target.value); setErro(''); }} />
      {erro && <p className="text-[11px] text-red-600">{erro}</p>}
      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 min-h-7 rounded-md border border-paper-400 bg-white text-stone-700 text-[11px] font-semibold">Cancelar</button>
        <button onClick={() => salvar.mutate()} disabled={!podeSalvar || salvar.isPending} className="flex-1 min-h-7 rounded-md bg-brand-700 hover:bg-brand-800 text-white text-[11px] font-semibold disabled:opacity-40">
          {salvar.isPending ? 'Salvando…' : 'Adicionar item'}
        </button>
      </div>
    </div>
  );
}

function FaturaLinha({ tenantId, tenantNome, fatura }) {
  const qc = useQueryClient();
  const [aberta, setAberta] = useState(false);
  const [itemFormAberto, setItemFormAberto] = useState(false);
  const [pagamentoAberto, setPagamentoAberto] = useState(false);
  const detalhe = useQuery({
    queryKey: ['operador', 'fatura-detalhe', tenantId, fatura.id],
    queryFn: () => apiOperador.get(`/tenants/${tenantId}/faturas/${fatura.id}`).then((r) => r.data),
    enabled: aberta,
  });

  const emitir = useMutation({
    mutationFn: () => apiOperador.post(`/tenants/${tenantId}/faturas/${fatura.id}/emitir`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['operador', 'faturas', tenantId] });
      qc.invalidateQueries({ queryKey: ['operador', 'fatura-detalhe', tenantId, fatura.id] });
    },
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
              <div className="py-2 space-y-2.5">
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

                <div className="flex flex-wrap items-center gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
                  {fatura.status === 'prevista' && (
                    <>
                      <button onClick={() => setItemFormAberto((v) => !v)} className="min-h-7 px-2.5 rounded-md border border-paper-400 bg-white text-stone-700 text-[11px] font-semibold">
                        {itemFormAberto ? 'Fechar' : '+ Item avulso'}
                      </button>
                      <button onClick={() => emitir.mutate()} disabled={emitir.isPending} className="min-h-7 px-2.5 rounded-md bg-ink-900 hover:bg-ink-950 text-white text-[11px] font-semibold disabled:opacity-40">
                        {emitir.isPending ? 'Emitindo…' : 'Emitir fatura'}
                      </button>
                    </>
                  )}
                  {detalhe.data.saldoCentavos > 0 && STATUS_FATURA_ACEITA_PAGAMENTO.includes(fatura.status) && (
                    <button onClick={() => setPagamentoAberto(true)} className="min-h-7 px-2.5 rounded-md border border-paper-400 bg-white text-stone-700 hover:border-brand-300 hover:text-brand-800 text-[11px] font-semibold">
                      Registrar pagamento
                    </button>
                  )}
                  {emitir.isError && <p className="text-[11px] text-red-600 w-full">{emitir.error.response?.data?.error || 'Não foi possível emitir a fatura.'}</p>}
                </div>

                {itemFormAberto && (
                  <div onClick={(e) => e.stopPropagation()}>
                    <ItemFaturaForm tenantId={tenantId} faturaId={fatura.id} onDone={() => setItemFormAberto(false)} onCancel={() => setItemFormAberto(false)} />
                  </div>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
      {pagamentoAberto && detalhe.data && (
        <RegistrarPagamentoModal
          fatura={{ ...fatura, tenantId, tenantNome, saldoCentavos: detalhe.data.saldoCentavos }}
          onClose={() => setPagamentoAberto(false)}
        />
      )}
    </>
  );
}

export default function FichaFinanceiraModal({ tenant, onClose }) {
  const qc = useQueryClient();
  const [contratoModalAberto, setContratoModalAberto] = useState(false);
  const [novoItemAberto, setNovoItemAberto] = useState(false);
  const [itemEditando, setItemEditando] = useState(null);
  const [implementacaoEditando, setImplementacaoEditando] = useState(false);

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

  const gerarFatura = useMutation({
    mutationFn: () => apiOperador.post('/faturas/gerar', { tenantId: tenant.id }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['operador', 'faturas', tenant.id] }),
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
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-xs font-semibold text-stone-600 uppercase tracking-wide">Contrato vigente</h3>
                  {/* Achado [P1] de review do PR #28: se a leitura do contrato
                      FALHA, contratos.data fica undefined e contratoAtivo
                      parece "não existe" — o botão oferecia "Criar contrato"
                      mesmo quando há um ativo de verdade, e o POST então
                      ENCERRA esse contrato como troca de plano sem o operador
                      saber que ele existia. Só habilita após leitura OK. */}
                  <button
                    onClick={() => setContratoModalAberto(true)}
                    disabled={!contratos.isSuccess}
                    className="min-h-7 px-2.5 rounded-md border border-paper-400 bg-white hover:border-brand-300 hover:text-brand-800 text-stone-700 text-[11px] font-semibold inline-flex items-center gap-1 disabled:opacity-40 disabled:pointer-events-none"
                  >
                    <Icon name="edit" size={12} />
                    {contratoAtivo ? 'Trocar de plano' : 'Criar contrato'}
                  </button>
                </div>
                {contratos.isError ? (
                  <p className="mt-2 text-sm text-red-700">Não foi possível carregar o contrato deste cliente — recarregue antes de criar ou trocar de plano.</p>
                ) : contratoAtivo ? (
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
                          <li key={item.id}>
                            {itemEditando?.id === item.id ? (
                              <div className="py-1">
                                <ItemContratoForm
                                  tenantId={tenant.id} contratoId={contratoAtivo.id} item={item}
                                  onDone={() => setItemEditando(null)} onCancel={() => setItemEditando(null)}
                                />
                              </div>
                            ) : (
                              <div className="flex items-center justify-between gap-2 group">
                                <span>{item.descricao}{item.recorrente ? ' · recorrente' : ''}</span>
                                <span className="flex items-center gap-2">
                                  <span className="tabular">{formatarCentavos(item.valorUnitarioCentavos * item.quantidade)}</span>
                                  <button onClick={() => setItemEditando(item)} className="text-stone-400 hover:text-brand-700" aria-label="Editar item">
                                    <Icon name="edit" size={12} />
                                  </button>
                                </span>
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {novoItemAberto ? (
                      <div className="mt-2">
                        <ItemContratoForm
                          tenantId={tenant.id} contratoId={contratoAtivo.id} item={null}
                          onDone={() => setNovoItemAberto(false)} onCancel={() => setNovoItemAberto(false)}
                        />
                      </div>
                    ) : (
                      <button onClick={() => setNovoItemAberto(true)} className="mt-2 text-[11px] font-semibold text-brand-800 hover:text-brand-900">
                        + Adicionar item
                      </button>
                    )}
                  </div>
                ) : <p className="mt-2 text-sm text-stone-500">Nenhum contrato ativo.</p>}
              </section>

              <section>
                <h3 className="text-xs font-semibold text-stone-600 uppercase tracking-wide">Implementação</h3>
                {implementacaoEditando ? (
                  <ImplementacaoForm
                    tenantId={tenant.id} existente={implementacao.data}
                    onDone={() => setImplementacaoEditando(false)} onCancel={() => setImplementacaoEditando(false)}
                  />
                ) : implementacao.data ? (
                  <div className="mt-2 p-3 rounded-lg border border-paper-300 bg-paper-50 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-ink-950">{IMPLEMENTACAO_STATUS[implementacao.data.status] || implementacao.data.status}</p>
                      <p className="text-xs text-stone-500">
                        {implementacao.data.formaPagamento === 'parcelado' ? `Parcelado em ${implementacao.data.numeroParcelas}x` : 'À vista'}
                        {implementacao.data.dataPrevista && ` · previsto para ${formatarData(implementacao.data.dataPrevista)}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <p className="font-semibold text-sm text-ink-950 tabular">{formatarCentavos(implementacao.data.valorCentavos)}</p>
                      <button onClick={() => setImplementacaoEditando(true)} className="min-h-7 px-2.5 rounded-md border border-paper-400 bg-white hover:border-brand-300 hover:text-brand-800 text-stone-700 text-[11px] font-semibold">
                        Editar
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <p className="text-sm text-stone-500">Nenhuma implementação registrada.</p>
                    <button onClick={() => setImplementacaoEditando(true)} className="min-h-8 px-3 rounded-lg border border-paper-400 bg-white hover:border-brand-300 hover:text-brand-800 text-stone-700 text-xs font-semibold">
                      Registrar implementação
                    </button>
                  </div>
                )}
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
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-xs font-semibold text-stone-600 uppercase tracking-wide">Faturas</h3>
                  <button
                    onClick={() => gerarFatura.mutate()}
                    disabled={gerarFatura.isPending}
                    className="min-h-7 px-2.5 rounded-md border border-paper-400 bg-white hover:border-brand-300 hover:text-brand-800 text-stone-700 text-[11px] font-semibold disabled:opacity-40"
                  >
                    {gerarFatura.isPending ? 'Gerando…' : 'Gerar fatura do período'}
                  </button>
                </div>
                {gerarFatura.isError && <p className="mt-1.5 text-[11px] text-red-600">{gerarFatura.error.response?.data?.error || 'Não foi possível gerar a fatura.'}</p>}
                {gerarFatura.isSuccess && gerarFatura.data.faturasGeradas === 0 && (
                  <p className="mt-1.5 text-[11px] text-stone-500">Nenhuma fatura nova — a competência {gerarFatura.data.competencia} já foi gerada, ou o cliente não tem contrato ativo.</p>
                )}
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
                        {faturas.data.map((f) => <FaturaLinha key={f.id} tenantId={tenant.id} tenantNome={tenant.nome} fatura={f} />)}
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

      {contratoModalAberto && (
        <ContratoModal tenant={tenant} contratoAtual={contratoAtivo} onClose={() => setContratoModalAberto(false)} />
      )}
    </div>
  );
}
