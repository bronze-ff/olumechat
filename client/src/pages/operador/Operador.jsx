import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiOperador, { CHAVE_TOKEN } from '../../services/apiOperador';
import Spinner from '../../components/ui/Spinner';
import Confirmar from '../../components/ui/Confirmar';

// Painel do OPERADOR (FIL-70): provisionar e administrar os clientes do
// Falatta. Fora do RBAC de tenant — nada aqui usa o AuthContext do painel do
// cliente; a sessão vive em services/apiOperador.js.

const STATUS_COR = {
  ativo:     'bg-emerald-50 text-emerald-700',
  suspenso:  'bg-amber-50 text-amber-700',
  encerrado: 'bg-stone-100 text-stone-500',
};

function Metrica({ valor, label }) {
  return (
    <div className="text-center px-2">
      <p className="font-mono text-sm text-stone-800 tabular">{valor ?? 0}</p>
      <p className="text-[10px] uppercase tracking-wide text-stone-400">{label}</p>
    </div>
  );
}

/** Caixa do convite: aparece UMA vez, logo depois de provisionar. */
function Convite({ dados, onFechar }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <div className="col-span-12 bg-amber-50 border border-amber-300 rounded-2xl p-4">
      <div className="flex items-start gap-2">
        <span className="section-bar mt-1" />
        <div className="min-w-0 flex-1">
          <p className="font-display font-bold text-sm text-stone-800">
            Convite de {dados.usuario.email} — copie agora
          </p>
          <p className="text-xs text-stone-600 mt-1">
            Ainda não há envio de e-mail: repasse este link ao cliente. Ele vale
            uma vez só e expira em {new Date(dados.convite.expiraEm).toLocaleString('pt-BR')}.
            Fechando esta caixa, o link não é exibido de novo.
          </p>
          <p className="mt-2 font-mono text-[11px] break-all bg-white border border-amber-200 rounded p-2">
            {dados.convite.link}
          </p>
        </div>
      </div>
      <div className="flex gap-2 mt-3">
        <button
          onClick={() => { navigator.clipboard?.writeText(dados.convite.link); setCopiado(true); }}
          className="px-3 py-2 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold">
          {copiado ? 'Copiado ✓' : 'Copiar link'}
        </button>
        <button onClick={onFechar}
          className="px-3 py-2 rounded-xl border border-black/20 text-stone-700 text-xs font-semibold">
          Já copiei, fechar
        </button>
      </div>
    </div>
  );
}

export default function Operador() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({ nome: '', slug: '', adminNome: '', adminEmail: '' });
  const [erro, setErro] = useState('');
  const [convite, setConvite] = useState(null);
  const [confirmacao, setConfirmacao] = useState(null); // { titulo, mensagem, perigo, acao }
  const [renomeando, setRenomeando] = useState(null);   // { id, nome }
  const [filtroAuditoria, setFiltroAuditoria] = useState('');

  const eu = useQuery({ queryKey: ['operador', 'eu'], queryFn: () => apiOperador.get('/eu').then((r) => r.data) });
  const tenants = useQuery({ queryKey: ['operador', 'tenants'], queryFn: () => apiOperador.get('/tenants').then((r) => r.data) });
  const auditoria = useQuery({
    queryKey: ['operador', 'auditoria', filtroAuditoria],
    queryFn: () => apiOperador
      .get('/auditoria', { params: filtroAuditoria ? { tenantId: filtroAuditoria } : {} })
      .then((r) => r.data),
  });

  const recarregar = () => {
    qc.invalidateQueries({ queryKey: ['operador', 'tenants'] });
    qc.invalidateQueries({ queryKey: ['operador', 'auditoria'] });
  };

  const provisionar = useMutation({
    mutationFn: () => apiOperador.post('/tenants', {
      nome: form.nome.trim(),
      slug: form.slug.trim().toLowerCase(),
      admin: { nome: form.adminNome.trim() || undefined, email: form.adminEmail.trim().toLowerCase() },
    }).then((r) => r.data),
    onSuccess: (data) => {
      setErro('');
      setConvite(data);
      setForm({ nome: '', slug: '', adminNome: '', adminEmail: '' });
      recarregar();
    },
    onError: (e) => setErro(e.response?.data?.error || 'Não foi possível provisionar.'),
  });

  const alterarStatus = useMutation({
    mutationFn: ({ id, acao }) => apiOperador.post(`/tenants/${id}/${acao}`),
    onSuccess: () => { setConfirmacao(null); recarregar(); },
    onError: (e) => { setConfirmacao(null); setErro(e.response?.data?.error || 'Não foi possível alterar o status.'); },
  });

  const renomear = useMutation({
    mutationFn: ({ id, nome }) => apiOperador.patch(`/tenants/${id}`, { nome }),
    onSuccess: () => { setRenomeando(null); recarregar(); },
    onError: (e) => { setRenomeando(null); setErro(e.response?.data?.error || 'Não foi possível renomear.'); },
  });

  // Acesso de suporte: troca a sessão de operador por uma sessão CURTA e
  // somente-leitura dentro do tenant, e vai para o painel do cliente. Fica
  // registrado na auditoria que o próprio cliente lê.
  //
  // ⚠️ A troca é feita com uma NAVEGAÇÃO DE VERDADE (window.location), não com
  // navigate() do router. O AuthProvider do painel do cliente lê o token do
  // localStorage UMA VEZ, na montagem: quando esta página carregou, não havia
  // sessão de tenant, então `user` é null. Um navigate() cairia no
  // ProtectedRoute com user null e jogaria o operador no /login do cliente —
  // o fluxo de suporte simplesmente não funcionaria. Recarregar remonta o app
  // com a sessão nova e ainda descarta o cache de queries da sessão anterior.
  const suporte = useMutation({
    mutationFn: ({ id }) => apiOperador.post(`/tenants/${id}/acesso-suporte`).then((r) => r.data),
    onSuccess: (data) => {
      localStorage.setItem('token', data.token);
      localStorage.setItem('empresa', data.tenant.slug);
      setConfirmacao(null);
      window.location.assign('/conversas');
    },
    onError: (e) => { setConfirmacao(null); setErro(e.response?.data?.error || 'Não foi possível abrir o suporte.'); },
  });

  async function sair() {
    try { await apiOperador.post('/logout'); } catch { /* ignora */ }
    localStorage.removeItem(CHAVE_TOKEN);
    navigate('/operador/login', { replace: true });
  }

  const podeProvisionar = form.nome.trim() && form.slug.trim() && form.adminEmail.trim();
  const lista = tenants.data || [];
  const totais = useMemo(() => ({
    clientes: lista.length,
    ativos: lista.filter((t) => t.status === 'ativo').length,
    conversas: lista.reduce((s, t) => s + (t.conversasMes || 0), 0),
  }), [lista]);

  return (
    <div className="min-h-screen bg-paper-200">
      <header className="navy-gradient text-white sticky top-0 z-20">
        <div className="max-w-screen-xl mx-auto px-4 py-3 flex items-center gap-3">
          <span className="section-bar" />
          <div className="flex-1 min-w-0">
            <h1 className="font-display font-bold text-base leading-tight">Painel do operador</h1>
            <p className="text-[11px] text-white/60 font-mono truncate">
              {eu.data?.email || '…'} · {totais.ativos}/{totais.clientes} clientes ativos · {totais.conversas} conversas no mês
            </p>
          </div>
          <button onClick={sair} className="text-xs font-semibold text-white/80 hover:text-white">Sair</button>
        </div>
      </header>

      <main className="max-w-screen-xl mx-auto p-4 grid grid-cols-12 gap-4 items-start">
        {erro && (
          <div className="col-span-12 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 flex gap-2">
            <span className="flex-1">{erro}</span>
            <button onClick={() => setErro('')} aria-label="Fechar">✕</button>
          </div>
        )}

        {convite && <Convite dados={convite} onFechar={() => setConvite(null)} />}

        {/* Provisionar */}
        <form
          onSubmit={(e) => { e.preventDefault(); if (podeProvisionar) provisionar.mutate(); }}
          className="col-span-12 lg:col-span-4 lg:sticky lg:top-20 bg-white rounded-2xl border border-black/[0.06] p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="section-bar" />
            <h2 className="font-display font-bold text-sm text-stone-800">Provisionar cliente</h2>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Empresa</label>
            <input className="input-field" value={form.nome} placeholder="Farmácia Sol"
              onChange={(e) => setForm((p) => ({ ...p, nome: e.target.value }))} />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">
              Slug <span className="normal-case font-normal text-stone-400">(é o que o cliente digita no login)</span>
            </label>
            <input className="input-field font-mono" value={form.slug} placeholder="farmacia-sol"
              autoCapitalize="none" spellCheck="false"
              onChange={(e) => setForm((p) => ({ ...p, slug: e.target.value }))} />
            <p className="text-[11px] text-stone-400 mt-1">Minúsculas, números e hífen. Não muda depois.</p>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Administrador</label>
            <input className="input-field mb-2" value={form.adminNome} placeholder="Nome (opcional)"
              onChange={(e) => setForm((p) => ({ ...p, adminNome: e.target.value }))} />
            <input className="input-field" value={form.adminEmail} placeholder="ana@farmaciasol.com.br"
              autoCapitalize="none" spellCheck="false"
              onChange={(e) => setForm((p) => ({ ...p, adminEmail: e.target.value }))} />
          </div>
          <button type="submit" disabled={!podeProvisionar || provisionar.isPending}
            className="w-full py-2.5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold disabled:opacity-40">
            {provisionar.isPending ? 'Provisionando…' : 'Provisionar'}
          </button>
          <p className="text-[11px] text-stone-400">
            Cria a empresa, o primeiro administrador e o convite de senha — tudo ou nada.
          </p>
        </form>

        {/* Clientes */}
        <section className="col-span-12 lg:col-span-8 bg-white rounded-2xl border border-black/[0.06] divide-y divide-black/[0.05]">
          {tenants.isLoading && <div className="p-8 flex justify-center"><Spinner /></div>}
          {tenants.isError && <p className="p-4 text-sm text-red-600">Erro ao carregar os clientes.</p>}
          {lista.map((t) => (
            <div key={t.id} className="p-4">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  {renomeando?.id === t.id ? (
                    <form className="flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const nome = renomeando.nome.trim();
                        if (nome && nome !== t.nome) renomear.mutate({ id: t.id, nome });
                        else setRenomeando(null);
                      }}>
                      <input autoFocus className="input-field py-1.5" value={renomeando.nome}
                        onChange={(e) => setRenomeando({ id: t.id, nome: e.target.value })} />
                      <button type="submit" disabled={renomear.isPending}
                        className="px-3 rounded-xl bg-brand-700 text-white text-xs font-semibold disabled:opacity-40">
                        Salvar
                      </button>
                      <button type="button" onClick={() => setRenomeando(null)}
                        className="px-3 rounded-xl border border-black/15 text-stone-700 text-xs font-semibold">
                        Cancelar
                      </button>
                    </form>
                  ) : (
                    <p className="font-semibold text-sm text-stone-800 truncate">{t.nome}</p>
                  )}
                  <p className="font-mono text-[11px] text-stone-400">{t.slug}</p>
                </div>
                <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${STATUS_COR[t.status] || STATUS_COR.encerrado}`}>
                  {t.status}
                </span>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex gap-1">
                  <Metrica valor={t.conversasMes} label="conversas/mês" />
                  <Metrica valor={t.mensagensMes} label="enviadas/mês" />
                  <Metrica valor={t.atendentesAtivos} label="atendentes" />
                  <Metrica valor={t.numerosConectados} label="números" />
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => setRenomeando({ id: t.id, nome: t.nome })}
                    className="text-xs px-3 py-1.5 rounded-full border border-black/15 text-stone-700 hover:bg-stone-50">
                    Renomear
                  </button>
                  <button
                    onClick={() => setConfirmacao({
                      titulo: 'Entrar como suporte',
                      mensagem: `Você vai entrar em "${t.nome}" para diagnosticar, em modo somente-leitura.`,
                      dica: 'A entrada fica registrada na auditoria que o próprio cliente enxerga. Sua sessão de operador continua válida nesta aba.',
                      confirmarTexto: 'Entrar',
                      acao: () => suporte.mutate({ id: t.id }),
                    })}
                    className="text-xs px-3 py-1.5 rounded-full border border-black/15 text-stone-700 hover:bg-stone-50">
                    Suporte
                  </button>
                  {t.status === 'ativo' ? (
                    <button
                      onClick={() => setConfirmacao({
                        titulo: 'Suspender cliente',
                        mensagem: `Suspender "${t.nome}"?`,
                        dica: 'Bloqueia o login de todos os usuários dele e pausa os disparos de campanha.',
                        confirmarTexto: 'Suspender',
                        perigo: true,
                        acao: () => alterarStatus.mutate({ id: t.id, acao: 'suspender' }),
                      })}
                      className="text-xs px-3 py-1.5 rounded-full bg-amber-50 text-amber-700 hover:bg-amber-100 font-medium">
                      Suspender
                    </button>
                  ) : (
                    <button
                      onClick={() => alterarStatus.mutate({ id: t.id, acao: 'reativar' })}
                      className="text-xs px-3 py-1.5 rounded-full bg-emerald-50 text-emerald-700 hover:bg-emerald-100 font-medium">
                      Reativar
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
          {tenants.data?.length === 0 && (
            <p className="p-6 text-sm text-stone-500 text-center">Nenhum cliente ainda. Provisione o primeiro ao lado.</p>
          )}
        </section>

        {/* Auditoria */}
        <section className="col-span-12 bg-white rounded-2xl border border-black/[0.06]">
          <div className="px-4 py-3 flex items-center gap-2 border-b border-black/[0.06]">
            <span className="section-bar" />
            <h2 className="font-display font-bold text-sm text-stone-800 flex-1">Auditoria do operador</h2>
            <select className="text-xs border border-black/15 rounded-lg px-2 py-1"
              value={filtroAuditoria} onChange={(e) => setFiltroAuditoria(e.target.value)}>
              <option value="">Todos os clientes</option>
              {lista.map((t) => <option key={t.id} value={t.id}>{t.nome}</option>)}
            </select>
          </div>
          {auditoria.isLoading && <div className="p-8 flex justify-center"><Spinner /></div>}
          <div className="divide-y divide-black/[0.05] max-h-96 overflow-y-auto">
            {(auditoria.data || []).map((a) => (
              <div key={a.id} className="px-4 py-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
                <span className="font-mono text-stone-400 tabular">
                  {new Date(a.criadoEm).toLocaleString('pt-BR')}
                </span>
                <span className="font-semibold text-stone-800">{a.acao}</span>
                <span className="text-stone-500">{a.operadorEmail}</span>
                {a.tenantSlug && <span className="font-mono text-brand-700">{a.tenantSlug}</span>}
                {a.ip && <span className="font-mono text-stone-300">{a.ip}</span>}
              </div>
            ))}
            {auditoria.data?.length === 0 && (
              <p className="p-6 text-sm text-stone-500 text-center">Nenhuma ação registrada ainda.</p>
            )}
          </div>
        </section>
      </main>

      {confirmacao && (
        <Confirmar
          titulo={confirmacao.titulo}
          mensagem={confirmacao.mensagem}
          dica={confirmacao.dica}
          confirmarTexto={confirmacao.confirmarTexto}
          perigo={confirmacao.perigo}
          pendente={alterarStatus.isPending || suporte.isPending}
          onConfirmar={confirmacao.acao}
          onCancelar={() => setConfirmacao(null)}
        />
      )}
    </div>
  );
}
