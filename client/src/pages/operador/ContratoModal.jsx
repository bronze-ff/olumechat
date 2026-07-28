import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import apiOperador from '../../services/apiOperador';
import Icon from '../../components/ui/Icon';
import { formatarCentavos, paraCentavos } from '../../utils/dinheiro';

// Criar/trocar contrato (FIL-82) — usado tanto pela ficha financeira do
// cliente quanto pela tela "Contratos" (carteira inteira). Chama SEMPRE
// POST /tenants/:id/contrato: não existe UPDATE de contrato neste domínio —
// se já há um ativo, o backend o encerra e insere um novo na mesma transação
// (server/operador/contrato.js::criarOuTrocarContrato). O histórico do que
// foi cobrado nunca é reescrito.
const CICLOS = [
  { id: 'mensal', label: 'Mensal' },
  { id: 'trimestral', label: 'Trimestral' },
  { id: 'anual', label: 'Anual' },
];

export default function ContratoModal({ tenant, contratoAtual, onClose, onSaved }) {
  const qc = useQueryClient();
  const trocandoPlano = !!contratoAtual;
  const [planoNome, setPlanoNome] = useState(contratoAtual?.planoNome || '');
  const [valor, setValor] = useState(contratoAtual ? (contratoAtual.valorRecorrenteCentavos / 100).toFixed(2).replace('.', ',') : '');
  const [ciclo, setCiclo] = useState(contratoAtual?.ciclo || 'mensal');
  const [diaVencimento, setDiaVencimento] = useState(contratoAtual?.diaVencimento ? String(contratoAtual.diaVencimento) : '10');
  // A data efetiva do contrato SUBSTITUTO é a data da TROCA (hoje), nunca a
  // do contrato anterior — achado de review do PR #28: copiar o
  // inicioCobranca antigo faz o novo contrato cobrir competências passadas,
  // e contratoNaCompetencia() (que ordena por criação) pode escolher o plano
  // NOVO ao gerar uma fatura histórica ainda não emitida, cobrando o valor
  // errado retroativamente. Um contrato NOVO (sem trocandoPlano) já nasce
  // hoje por padrão — só o caso de troca copiava a data errada.
  const [inicioCobranca, setInicioCobranca] = useState(new Date().toISOString().slice(0, 10));
  const [reajusteIndice, setReajusteIndice] = useState(contratoAtual?.reajusteIndice || '');
  const [reajusteMes, setReajusteMes] = useState(contratoAtual?.reajusteMes ? String(contratoAtual.reajusteMes) : '');
  const [observacoes, setObservacoes] = useState(contratoAtual?.observacoes || '');
  const [erro, setErro] = useState('');

  const valorCentavos = paraCentavos(valor);
  const diaVencimentoNum = Number(diaVencimento);
  const podeSalvar = planoNome.trim()
    && valorCentavos !== null && valorCentavos >= 0
    && Number.isInteger(diaVencimentoNum) && diaVencimentoNum >= 1 && diaVencimentoNum <= 28
    && !!inicioCobranca;

  const salvar = useMutation({
    mutationFn: () => apiOperador.post(`/tenants/${tenant.id}/contrato`, {
      planoNome: planoNome.trim(),
      valorRecorrenteCentavos: valorCentavos,
      ciclo,
      diaVencimento: diaVencimentoNum,
      inicioCobranca,
      reajusteIndice: reajusteIndice.trim() || undefined,
      reajusteMes: reajusteMes ? Number(reajusteMes) : undefined,
      observacoes: observacoes.trim() || undefined,
    }).then((r) => r.data),
    onSuccess: (novoContrato) => {
      qc.invalidateQueries({ queryKey: ['operador', 'contrato', tenant.id] });
      qc.invalidateQueries({ queryKey: ['operador', 'contrato-itens', tenant.id] });
      qc.invalidateQueries({ queryKey: ['operador', 'contratos'] });
      qc.invalidateQueries({ queryKey: ['operador', 'financeiro'] });
      onSaved?.(novoContrato);
      onClose();
    },
    onError: (error) => setErro(error.response?.data?.error || 'Não foi possível salvar o contrato.'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-ink-950/60 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative w-full sm:max-w-lg bg-white border border-paper-400 rounded-t-[10px] sm:rounded-[10px] shadow-2xl overflow-hidden max-h-[92vh] flex flex-col">
        <div className="px-5 py-4 border-b border-paper-300 flex items-center gap-3">
          <span className="w-9 h-9 rounded-lg bg-brand-100 text-brand-800 flex items-center justify-center shrink-0">
            <Icon name="contract" size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-ink-950 truncate">{trocandoPlano ? 'Trocar de plano' : 'Novo contrato'}</h2>
            <p className="text-xs text-stone-500 truncate">{tenant.nome}</p>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-lg border border-paper-400 text-stone-500 hover:bg-paper-100 hover:text-ink-950" aria-label="Fechar">✕</button>
        </div>

        <div className="modal-body space-y-4">
          {trocandoPlano && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
              Isso encerra o contrato atual ({contratoAtual.planoNome}, {formatarCentavos(contratoAtual.valorRecorrenteCentavos)}/{contratoAtual.ciclo}) e cria um novo. O histórico do que já foi cobrado não muda.
            </p>
          )}
          <div>
            <label className="field-label">Nome do plano</label>
            <input className="input-field" value={planoNome} onChange={(e) => { setPlanoNome(e.target.value); setErro(''); }} placeholder="Ex.: Plano Pro" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="field-label">Valor recorrente (R$)</label>
              <input className="input-field tabular" value={valor} onChange={(e) => { setValor(e.target.value); setErro(''); }} placeholder="0,00" />
            </div>
            <div>
              <label className="field-label">Ciclo</label>
              <select className="input-field" value={ciclo} onChange={(e) => setCiclo(e.target.value)}>
                {CICLOS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="field-label">Dia de vencimento</label>
              <input type="number" min="1" max="28" className="input-field tabular" value={diaVencimento} onChange={(e) => setDiaVencimento(e.target.value)} />
            </div>
            <div>
              <label className="field-label">Início da cobrança</label>
              <input type="date" className="input-field" value={inicioCobranca} onChange={(e) => setInicioCobranca(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="field-label">Índice de reajuste <span className="font-normal text-stone-500">(opcional)</span></label>
              <input className="input-field" value={reajusteIndice} onChange={(e) => setReajusteIndice(e.target.value)} placeholder="Ex.: IPCA" />
            </div>
            <div>
              <label className="field-label">Mês de reajuste <span className="font-normal text-stone-500">(opcional)</span></label>
              <input type="number" min="1" max="12" className="input-field tabular" value={reajusteMes} onChange={(e) => setReajusteMes(e.target.value)} placeholder="1-12" />
            </div>
          </div>
          <div>
            <label className="field-label">Observações <span className="font-normal text-stone-500">(opcional)</span></label>
            <textarea className="input-field" rows={2} value={observacoes} onChange={(e) => setObservacoes(e.target.value)} />
          </div>
          {erro && <p className="text-xs text-red-600">{erro}</p>}
        </div>

        <div className="modal-footer">
          <button onClick={onClose} className="flex-1 min-h-10 rounded-lg border border-paper-400 bg-white hover:bg-paper-100 text-stone-700 font-semibold text-sm">Cancelar</button>
          <button
            onClick={() => salvar.mutate()}
            disabled={!podeSalvar || salvar.isPending}
            className="flex-1 min-h-10 rounded-lg bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm disabled:opacity-40"
          >
            {salvar.isPending ? 'Salvando…' : trocandoPlano ? 'Trocar de plano' : 'Criar contrato'}
          </button>
        </div>
      </div>
    </div>
  );
}
