import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../services/api';
import Spinner from '../../components/ui/Spinner';
import Portal from '../../components/ui/Portal';
import { useAuth } from '../../context/AuthContext';
import { formatPhone } from '../../utils/formatters';

// Rótulos amigáveis dos status que a Meta devolve.
const NAME_STATUS = {
  APPROVED: { txt: 'Aprovado', cls: 'text-emerald-700 bg-emerald-50' },
  AVAILABLE_WITHOUT_REVIEW: { txt: 'Disponível (sem revisão)', cls: 'text-emerald-700 bg-emerald-50' },
  PENDING_REVIEW: { txt: 'Em análise na Meta — aguarde a aprovação', cls: 'text-amber-700 bg-amber-50' },
  DECLINED: { txt: 'Recusado pelas diretrizes da Meta', cls: 'text-red-700 bg-red-50' },
  EXPIRED: { txt: 'Expirado', cls: 'text-stone-600 bg-stone-100' },
  NONE: { txt: 'Sem nome definido', cls: 'text-stone-600 bg-stone-100' },
};
const QUALIDADE = { GREEN: 'Alta', YELLOW: 'Média', RED: 'Baixa' };
const VERIF = { VERIFIED: 'Verificado', NOT_VERIFIED: 'Não verificado', EXPIRED: 'Expirado' };

function Linha({ rotulo, children }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-black/[0.04] last:border-0">
      <span className="text-xs text-stone-500">{rotulo}</span>
      <span className="text-sm text-stone-800 text-right">{children}</span>
    </div>
  );
}

// Modal "Status na Meta" — a consulta sai do servidor (que alcança a Graph API).
function StatusMeta({ num, onClose }) {
  const { isAdmin } = useAuth();
  const [pin, setPin] = useState('');
  const [okMsg, setOkMsg] = useState('');
  const q = useQuery({
    queryKey: ['meta-status', num.id],
    queryFn: () => api.get(`/numeros/${num.id}/meta-status`).then((r) => r.data),
    retry: false,
  });
  const d = q.data || {};
  const ns = NAME_STATUS[d.name_status] || (d.name_status ? { txt: d.name_status, cls: 'text-stone-600 bg-stone-100' } : null);
  const nns = NAME_STATUS[d.new_name_status];
  const pendente = d.status === 'PENDING' || d.platform_type === 'NOT_APPLICABLE';

  const registrar = useMutation({
    mutationFn: () => api.post(`/numeros/${num.id}/registrar`, { pin }),
    onSuccess: () => { setOkMsg('Registro enviado! Em alguns minutos o status deve virar "Conectado". Clique em Atualizar.'); setPin(''); q.refetch(); },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl overflow-hidden">
        <div className="navy-gradient text-white px-4 py-3 flex items-center gap-2">
          <span className="section-bar" />
          <h2 className="font-display font-bold text-base flex-1">Status na Meta</h2>
          <button onClick={onClose} className="text-white/70 hover:text-white" aria-label="Fechar">✕</button>
        </div>
        <div className="p-4">
          {q.isLoading && <div className="py-6 flex justify-center"><Spinner /></div>}
          {q.isError && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
              {q.error.response?.data?.error || 'Falha ao consultar a Meta.'}
            </p>
          )}
          {q.data && (
            <div className="space-y-0.5">
              <Linha rotulo="Telefone">{formatPhone(d.display_phone_number) || num.phoneNumberId}</Linha>
              <Linha rotulo="Nome aprovado">{d.verified_name || '—'}</Linha>
              {ns && (
                <Linha rotulo="Situação do nome">
                  <span className={`inline-block text-xs px-2 py-0.5 rounded-full ${ns.cls}`}>{ns.txt}</span>
                </Linha>
              )}
              {nns && (
                <Linha rotulo="Nome solicitado">
                  <span className={`inline-block text-xs px-2 py-0.5 rounded-full ${nns.cls}`}>{nns.txt}</span>
                </Linha>
              )}
              <Linha rotulo="Qualidade">{QUALIDADE[d.quality_rating] || d.quality_rating || '—'}</Linha>
              <Linha rotulo="Verificação">{VERIF[d.code_verification_status] || d.code_verification_status || '—'}</Linha>
            </div>
          )}
          {d.name_status === 'PENDING_REVIEW' && (
            <p className="text-[11px] text-stone-500 mt-3">
              O nome novo está na fila de revisão da Meta. Até aprovar, o WhatsApp segue mostrando o nome antigo.
              Não reenvie — só aguarde (de minutos a alguns dias).
            </p>
          )}

          {q.data && isAdmin && (
            <div className="mt-4 pt-3 border-t border-black/[0.06]">
              <p className="text-sm font-semibold text-stone-800">Mudar o nome de exibição</p>
              <p className="text-[11px] text-stone-500 mt-0.5 mb-2">
                A Meta <b>não permite trocar o nome por API</b> — só pelo <b>WhatsApp Manager</b>, e o novo nome
                passa por <b>revisão</b> (de minutos a ~2 dias). O status acima atualiza sozinho quando a Meta decidir.
              </p>
              <a href="https://business.facebook.com/wa/manage/phone-numbers/" target="_blank" rel="noopener noreferrer"
                className="inline-block text-xs px-3 py-1.5 rounded-lg bg-brand-700 hover:bg-brand-800 text-white font-semibold">
                Abrir no WhatsApp Manager ↗
              </a>
              <p className="text-[11px] text-stone-400 mt-2">
                No Manager: <b>Números de telefone → ícone de lápis no Nome</b>. Use o <b>nome da empresa</b>
                (ex.: "Farmácia Central" ou "Farmácia Central - Cobrança") — nome de <b>pessoa</b> ou só número
                costuma ser recusado pelas diretrizes. Limite: até <b>10 trocas a cada 30 dias</b>.
              </p>
            </div>
          )}

          {q.data && pendente && isAdmin && (
            <div className="mt-4 pt-3 border-t border-black/[0.06]">
              <p className="text-sm font-semibold text-stone-800">Conectar número (registrar no Cloud API)</p>
              <p className="text-[11px] text-stone-500 mt-0.5 mb-2">
                Este número está pendente. Escolha um <b>PIN de 6 dígitos</b> (verificação em duas etapas) e registre —
                isso conecta o número direto, sem depender do botão "Ativar" da Meta. <b>Anote o PIN</b>: você vai precisar
                dele se reinstalar o número.
              </p>
              <div className="flex gap-2">
                <input value={pin} onChange={(e) => { setPin(e.target.value.replace(/\D/g, '').slice(0, 6)); setOkMsg(''); }}
                  inputMode="numeric" placeholder="••••••" maxLength={6}
                  className="input-field !py-2 font-mono tracking-widest w-32 text-center" />
                <button onClick={() => registrar.mutate()} disabled={pin.length !== 6 || registrar.isPending}
                  className="flex-1 py-2 rounded-xl bg-bordeaux-700 hover:bg-bordeaux-800 text-white font-semibold text-sm disabled:opacity-40">
                  {registrar.isPending ? 'Conectando…' : 'Conectar número'}
                </button>
              </div>
              {registrar.isError && (
                <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2 mt-2">
                  {registrar.error.response?.data?.error || 'Falha ao registrar.'}
                </p>
              )}
              {okMsg && <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-2 mt-2">{okMsg}</p>}
            </div>
          )}
        </div>
        <div className="p-3 border-t border-black/[0.06] flex gap-2 safe-bottom">
          <button onClick={() => q.refetch()} disabled={q.isFetching}
            className="flex-1 py-2.5 rounded-xl border border-black/20 text-stone-700 font-semibold text-sm disabled:opacity-40">
            {q.isFetching ? 'Consultando…' : 'Atualizar'}
          </button>
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm">Fechar</button>
        </div>
      </div>
    </div>
  );
}

function EditarNumero({ num, deptos, onClose }) {
  const [nome, setNome] = useState(num.nomeExibicao || '');
  const [dep, setDep] = useState(num.departamentoPadraoId || '');
  const [limite, setLimite] = useState(num.limiteDiario || 250);
  const [permiteAtivo, setPermiteAtivo] = useState(num.permiteAtivo !== 'N');
  const [modo, setModo] = useState(num.modo || 'padrao');
  const [ativo, setAtivo] = useState(num.ativo !== 'N');
  const [erro, setErro] = useState('');
  const qc = useQueryClient();

  const salvar = useMutation({
    mutationFn: () => api.put(`/numeros/${num.id}`, {
      nomeExibicao: nome.trim() || undefined,
      departamentoPadraoId: dep === '' ? null : Number(dep),
      limiteDiario: Number(limite) || undefined,
      permiteAtivo: permiteAtivo ? 'S' : 'N',
      modo,
      ativo: ativo ? 'S' : 'N',
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['numeros'] }); onClose(); },
    onError: (e) => setErro(e.response?.data?.error || 'Falha ao salvar.'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col">
        <div className="navy-gradient text-white px-4 py-3 flex items-center gap-2">
          <span className="section-bar" />
          <h2 className="font-display font-bold text-base flex-1">{formatPhone(num.displayPhone) || `Número #${num.id}`}</h2>
          <button onClick={onClose} className="text-white/70 hover:text-white" aria-label="Fechar">✕</button>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Nome de exibição (interno)</label>
            <input className="input-field" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Cobrança 1090" />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Departamento padrão</label>
            <select className="input-field" value={dep} onChange={(e) => setDep(e.target.value)}>
              <option value="">— Nenhum (inbox geral) —</option>
              {(deptos || []).filter((d) => d.ativo === 'S').map((d) => (
                <option key={d.id} value={d.id}>{d.nome}</option>
              ))}
            </select>
            <p className="text-[11px] text-stone-400 mt-1">
              Conversas novas deste número entram direto na fila desse departamento (Fase 5B).
            </p>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Limite diário de campanha</label>
            <input type="number" min="1" className="input-field" value={limite} onChange={(e) => setLimite(e.target.value)} />
            <p className="text-[11px] text-stone-400 mt-1">
              Teto de destinatários/dia em disparos de campanha. Número novo na Meta começa em ~250/dia;
              aumente aqui quando a Meta elevar o tier do número.
            </p>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Modo do número</label>
            <select className="input-field" value={modo} onChange={(e) => setModo(e.target.value)}>
              <option value="padrao">Padrão — fluxo / atendimento humano</option>
              <option value="ia">🤖 Bot de IA</option>
            </select>
            {modo === 'ia' && (
              <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2 mt-1.5">
                Neste modo, <b>só telefones autorizados</b> (aba "Acesso IA") são respondidos pelo bot;
                os demais ficam <b>sem resposta</b>. Use um número <b>dedicado</b> — nunca a linha
                principal de atendimento. Autorize os telefones no MESMO número.
              </p>
            )}
          </div>
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input type="checkbox" checked={permiteAtivo} onChange={(e) => setPermiteAtivo(e.target.checked)} className="w-4 h-4 mt-0.5 accent-brand-700" />
            <span className="text-sm text-stone-700">
              Permite conversa ativa
              <span className="block text-[11px] text-stone-400">
                Habilita este número como origem de campanhas e da "Nova conversa".
                Desmarque no número receptivo (com fluxo) para os disparos saírem só pelo número certo.
              </span>
            </span>
          </label>
          <label className="flex items-center gap-2.5 cursor-pointer">
            <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} className="w-4 h-4 accent-brand-700" />
            <span className="text-sm text-stone-700">Número ativo</span>
          </label>
          {erro && <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{erro}</div>}
        </div>
        <div className="p-3 border-t border-black/[0.06] flex gap-2 safe-bottom">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-black/20 text-stone-700 font-semibold text-sm">Cancelar</button>
          <button onClick={() => salvar.mutate()} disabled={salvar.isPending}
            className="flex-1 py-2.5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm disabled:opacity-40">
            {salvar.isPending ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Pré-cadastro manual: necessário p/ usar um número NOVO como origem de campanha
// antes dele receber a primeira mensagem (o webhook só cria a linha no 1º evento).
function CadastrarNumero({ deptos, onClose }) {
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [displayPhone, setDisplayPhone] = useState('');
  const [nome, setNome] = useState('');
  const [dep, setDep] = useState('');
  const [erro, setErro] = useState('');
  const qc = useQueryClient();

  const criar = useMutation({
    mutationFn: () => api.post('/numeros', {
      phoneNumberId: phoneNumberId.trim(),
      displayPhone: displayPhone.trim() || undefined,
      nomeExibicao: nome.trim() || undefined,
      departamentoPadraoId: dep === '' ? undefined : Number(dep),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['numeros'] }); onClose(); },
    onError: (e) => setErro(e.response?.data?.error || 'Falha ao cadastrar.'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col">
        <div className="navy-gradient text-white px-4 py-3 flex items-center gap-2">
          <span className="section-bar" />
          <h2 className="font-display font-bold text-base flex-1">Cadastrar número</h2>
          <button onClick={onClose} className="text-white/70 hover:text-white" aria-label="Fechar">✕</button>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">ID do número (Phone Number ID)</label>
            <input className="input-field font-mono" value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)}
              placeholder="Ex.: 123456789012345" />
            <p className="text-[11px] text-stone-400 mt-1">
              Está no painel da Meta: WhatsApp Manager → Números de telefone → engrenagem do número → "Identificação do número de telefone".
            </p>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Telefone (com DDI)</label>
            <input className="input-field font-mono" value={displayPhone} onChange={(e) => setDisplayPhone(e.target.value)} placeholder="Ex.: 556237731061" />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Nome de exibição (interno)</label>
            <input className="input-field" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Cobrança - 1061" />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Departamento padrão</label>
            <select className="input-field" value={dep} onChange={(e) => setDep(e.target.value)}>
              <option value="">— Nenhum (inbox geral) —</option>
              {(deptos || []).filter((d) => d.ativo === 'S').map((d) => (
                <option key={d.id} value={d.id}>{d.nome}</option>
              ))}
            </select>
            <p className="text-[11px] text-stone-400 mt-1">
              Para o número de cobrança: escolha o departamento Cobrança e NÃO ative fluxo nele —
              as respostas dos clientes caem direto nessa fila.
            </p>
          </div>
          {erro && <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{erro}</div>}
        </div>
        <div className="p-3 border-t border-black/[0.06] flex gap-2 safe-bottom">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-black/20 text-stone-700 font-semibold text-sm">Cancelar</button>
          <button onClick={() => criar.mutate()} disabled={!phoneNumberId.trim() || criar.isPending}
            className="flex-1 py-2.5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm disabled:opacity-40">
            {criar.isPending ? 'Cadastrando…' : 'Cadastrar'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Numeros() {
  const { isAdmin } = useAuth();
  const [editando, setEditando] = useState(null);
  const [statusDe, setStatusDe] = useState(null);
  const [cadastrando, setCadastrando] = useState(false);

  const numeros = useQuery({
    queryKey: ['numeros'],
    queryFn: () => api.get('/numeros').then((r) => r.data),
  });
  const deptos = useQuery({
    queryKey: ['departamentos', 'todos'],
    queryFn: () => api.get('/departamentos', { params: { todos: 1 } }).then((r) => r.data),
  });
  const meta = useQuery({
    queryKey: ['meta-connection-status'],
    queryFn: () => api.get('/meta/status').then((r) => r.data),
    retry: false,
  });

  return (
    <div className="max-w-screen-xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <p className="text-xs text-stone-500 flex-1">
          Números aparecem aqui automaticamente quando recebem a primeira mensagem (via webhook).
          Para usar um número novo como ORIGEM de campanha antes da primeira mensagem, cadastre-o aqui
          com o Phone Number ID do painel da Meta.
        </p>
        {isAdmin && (
          <button onClick={() => setCadastrando(true)}
            className="shrink-0 px-4 py-2 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold">
            + Cadastrar número
          </button>
        )}
      </div>
      <div className="bg-white rounded-2xl border border-black/[0.06] px-4 py-3 flex items-center gap-3">
        <span className={`w-2.5 h-2.5 rounded-full ${meta.data?.some((x) => x.status === 'conectada') ? 'bg-emerald-500' : 'bg-amber-400'}`} />
        <div className="flex-1">
          <p className="text-sm font-semibold text-stone-800">Conexão Meta</p>
          <p className="text-xs text-stone-500">
            {meta.data?.some((x) => x.status === 'conectada')
              ? `${meta.data.filter((x) => x.status === 'conectada').length} número(s) conectado(s)`
              : 'Nenhuma conta Meta conectada. Use o Embedded Signup para começar.'}
          </p>
        </div>
        {meta.data?.some((x) => x.pending) && <span className="text-xs text-amber-700 bg-amber-50 px-2 py-1 rounded-full">Há pendências</span>}
      </div>
      <div className="bg-white rounded-2xl border border-black/[0.06] divide-y divide-black/[0.05]">
        {numeros.isLoading && <div className="p-8 flex justify-center"><Spinner /></div>}
        {numeros.isError && <p className="p-4 text-sm text-red-600">{numeros.error.response?.data?.error || 'Erro ao carregar.'}</p>}
        {(numeros.data || []).map((n) => (
          <div key={n.id} className={`flex items-center gap-3 px-4 py-3 ${n.ativo === 'N' ? 'opacity-50' : ''}`}>
            <div className="w-9 h-9 shrink-0 rounded-full bg-emerald-600 text-white flex items-center justify-center">
              <svg className="w-4.5 h-4.5 w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6.62 10.79a15.05 15.05 0 006.59 6.59l2.2-2.2a1 1 0 011.01-.24c1.12.37 2.33.57 3.58.57a1 1 0 011 1V20a1 1 0 01-1 1C10.4 21 3 13.6 3 4.5A1 1 0 014 3.5h3.5a1 1 0 011 1c0 1.25.2 2.46.57 3.58a1 1 0 01-.24 1.01l-2.21 2.2z" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-sm text-stone-800 truncate">
                {n.nomeExibicao || formatPhone(n.displayPhone) || n.phoneNumberId}
              </p>
              <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                {n.displayPhone && <span className="text-[10px] font-mono text-stone-400">{formatPhone(n.displayPhone)}</span>}
                {n.departamentoPadraoNome && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-brand-50 text-brand-700">→ {n.departamentoPadraoNome}</span>
                )}
                {n.qualityRating && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-stone-100 text-stone-500">qualidade: {n.qualityRating}</span>
                )}
                {n.limiteDiario && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-stone-100 text-stone-500">campanha: {n.limiteDiario}/dia</span>
                )}
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${n.permiteAtivo !== 'N'
                  ? 'bg-bordeaux-700/10 text-bordeaux-700' : 'bg-stone-100 text-stone-400'}`}>
                  {n.permiteAtivo !== 'N' ? '📣 permite ativa' : 'só receptivo'}
                </span>
                {n.modo === 'ia' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-brand-50 text-brand-700">🤖 Bot IA</span>
                )}
              </div>
            </div>
            <button onClick={() => setStatusDe(n)}
              className="text-xs px-3 py-1.5 rounded-lg border border-black/15 text-stone-600 hover:bg-paper-50 font-medium"
              title="Consultar nome/qualidade/verificação na Meta">
              Status Meta
            </button>
            {isAdmin && (
              <button onClick={() => setEditando(n)}
                className="text-xs px-3 py-1.5 rounded-lg border border-black/15 text-stone-600 hover:bg-paper-50 font-medium">
                Editar
              </button>
            )}
          </div>
        ))}
        {numeros.data?.length === 0 && (
          <p className="p-6 text-sm text-stone-500 text-center">Nenhum número ainda. Ele aparece ao receber a primeira mensagem.</p>
        )}
      </div>
      {editando && <Portal><EditarNumero num={editando} deptos={deptos.data} onClose={() => setEditando(null)} /></Portal>}
      {cadastrando && <Portal><CadastrarNumero deptos={deptos.data} onClose={() => setCadastrando(false)} /></Portal>}
      {statusDe && <Portal><StatusMeta num={statusDe} onClose={() => setStatusDe(null)} /></Portal>}
    </div>
  );
}
