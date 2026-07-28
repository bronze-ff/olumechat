import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import apiOperador, { CHAVE_TOKEN } from '../../services/apiOperador';
import Spinner from '../../components/ui/Spinner';
import Icon from '../../components/ui/Icon';
import OperadorShell from '../../components/layout/OperadorShell';
import ContratoModal from './ContratoModal';
import { SECOES, GRUPOS } from './nav';
import { formatarCentavos, formatarData } from '../../utils/dinheiro';

// "Contratos" (FIL-82, complemento do dono do produto): o operador via a
// carteira só através da ficha de UM cliente por vez — não havia tela
// dedicada para olhar todos os contratos vigentes lado a lado. Reusa
// GET /operador/contratos (server/operador/contrato.js::listarContratosVigentes)
// e o MESMO ContratoModal usado pela ficha financeira do cliente para
// criar/editar/trocar plano — nenhuma lógica de negócio nova aqui.
const STATUS_TENANT = {
  ativo: { label: 'Ativo', className: 'bg-emerald-50 text-emerald-800 border-emerald-200', dot: 'bg-emerald-500' },
  suspenso: { label: 'Suspenso', className: 'bg-amber-50 text-amber-800 border-amber-200', dot: 'bg-amber-500' },
};

function StatusTenant({ value }) {
  const s = STATUS_TENANT[value] || STATUS_TENANT.ativo;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] font-semibold ${s.className}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

export default function Contratos() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [modalDe, setModalDe] = useState(null);
  const eu = useQuery({ queryKey: ['operador', 'eu'], queryFn: () => apiOperador.get('/eu').then((r) => r.data) });
  const contratos = useQuery({
    queryKey: ['operador', 'contratos'],
    queryFn: () => apiOperador.get('/contratos').then((r) => r.data),
  });

  async function sair() {
    try { await apiOperador.post('/logout'); } catch { /* encerra a sessão local mesmo sem resposta */ }
    localStorage.removeItem(CHAVE_TOKEN);
    navigate('/operador/login', { replace: true });
  }

  const lista = contratos.data || [];
  const atual = SECOES.find((item) => item.id === 'contratos');

  return (
    <OperadorShell
      secoes={SECOES}
      grupos={GRUPOS}
      atual={atual}
      eu={eu}
      onSair={sair}
      titulo="Contratos"
      descricao="Plano vigente de cada cliente da carteira — crie, edite ou troque de plano aqui, além da ficha do cliente."
      acao={
        <button
          onClick={() => qc.invalidateQueries({ queryKey: ['operador', 'contratos'] })}
          className="min-h-10 px-4 rounded-lg border border-paper-400 bg-white hover:bg-paper-100 text-stone-700 text-sm font-semibold inline-flex items-center gap-2"
        >
          <Icon name="history" size={16} />
          Atualizar
        </button>
      }
    >
      <section className="app-panel overflow-hidden">
        <header className="px-5 py-4 flex flex-wrap items-center gap-3 border-b border-paper-300">
          <div className="flex-1">
            <h2 className="font-semibold text-ink-950">Contratos vigentes</h2>
            <p className="mt-0.5 text-xs text-stone-500">{lista.length} {lista.length === 1 ? 'cliente' : 'clientes'}</p>
          </div>
        </header>

        {contratos.isLoading && <div className="p-12 flex justify-center"><Spinner /></div>}
        {contratos.isError && <p className="p-5 text-sm text-red-700">Não foi possível carregar os contratos.</p>}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-xs">
            <thead className="bg-paper-100 text-stone-600">
              <tr>
                <th className="px-5 py-2.5 text-left font-semibold">Cliente</th>
                <th className="px-5 py-2.5 text-left font-semibold">Status</th>
                <th className="px-5 py-2.5 text-left font-semibold">Plano</th>
                <th className="px-5 py-2.5 text-right font-semibold">Valor</th>
                <th className="px-5 py-2.5 text-left font-semibold">Ciclo</th>
                <th className="px-5 py-2.5 text-left font-semibold">Vencimento</th>
                <th className="px-5 py-2.5 text-left font-semibold">Início da cobrança</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-300">
              {lista.map((c) => (
                <tr key={c.tenantId} className="hover:bg-paper-50">
                  <td className="px-5 py-3">
                    <p className="font-semibold text-ink-950">{c.tenantNome}</p>
                    <p className="font-mono text-[11px] text-stone-500">{c.tenantSlug}</p>
                  </td>
                  <td className="px-5 py-3"><StatusTenant value={c.tenantStatus} /></td>
                  <td className="px-5 py-3 text-stone-600">{c.planoNome || '—'}</td>
                  <td className="px-5 py-3 text-right tabular text-ink-950">{c.valorRecorrenteCentavos !== null ? formatarCentavos(c.valorRecorrenteCentavos) : '—'}</td>
                  <td className="px-5 py-3 text-stone-600">{c.ciclo || '—'}</td>
                  <td className="px-5 py-3 text-stone-600">{c.diaVencimento ? `todo dia ${c.diaVencimento}` : '—'}</td>
                  <td className="px-5 py-3 text-stone-600">{c.inicioCobranca ? formatarData(c.inicioCobranca) : '—'}</td>
                  <td className="px-5 py-3 text-right">
                    <button
                      onClick={() => setModalDe(c)}
                      className="min-h-8 px-3 rounded-lg border border-paper-400 bg-white text-stone-700 hover:border-brand-300 hover:text-brand-800 text-[11px] font-semibold inline-flex items-center gap-1.5"
                    >
                      <Icon name="edit" size={13} />
                      {c.contratoId ? 'Trocar de plano' : 'Criar contrato'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!contratos.isLoading && lista.length === 0 && (
            <p className="p-8 text-sm text-stone-600 text-center">Nenhum cliente na carteira ainda.</p>
          )}
        </div>
      </section>

      {modalDe && (
        <ContratoModal
          tenant={{ id: modalDe.tenantId, nome: modalDe.tenantNome }}
          contratoAtual={modalDe.contratoId ? {
            id: modalDe.contratoId, planoNome: modalDe.planoNome, valorRecorrenteCentavos: modalDe.valorRecorrenteCentavos,
            ciclo: modalDe.ciclo, diaVencimento: modalDe.diaVencimento, inicioCobranca: modalDe.inicioCobranca,
            reajusteIndice: modalDe.reajusteIndice, reajusteMes: modalDe.reajusteMes, observacoes: modalDe.observacoes,
          } : null}
          onClose={() => setModalDe(null)}
        />
      )}
    </OperadorShell>
  );
}
