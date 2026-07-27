import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';

const IDLE_MS = 30 * 60 * 1000; // 30 min sem interação -> pausa automática.
// (10 min pausava quem estava em ligação/lendo conversa/no ERP; 30 min separa
//  bem o "ausente de verdade" do "trabalhando sem clicar na aba do MC".)

// Presença + auto-pausa por inatividade. Ativo só na visão operacional (fora do admin).
// Sem mouse/teclado por IDLE_MS, o atendente entra em pausa sozinho (deixa de receber
// novas conversas) e vê um aviso para voltar. Fechar a aba já o tira da distribuição
// (a conexão SSE cai e a presença vira offline após a graça), então aqui cobrimos o
// caso da aba aberta sem ninguém na frente — exatamente o que derrubava conversas.
function usePresenca(ativo) {
  const [pausado, setPausado] = useState(null);
  const [autoPausa, setAutoPausa] = useState(false);
  const pausadoRef = useRef(false);
  const ultimaAtividade = useRef(Date.now());

  useEffect(() => { pausadoRef.current = !!pausado; }, [pausado]);

  useEffect(() => {
    if (!ativo) return undefined;
    let vivo = true;
    api.get('/auth/perfil')
      .then(({ data }) => { if (vivo) setPausado(!!data.pausado); })
      .catch(() => { if (vivo) setPausado(false); });
    return () => { vivo = false; };
  }, [ativo]);

  const definir = useCallback((novo, porInatividade = false) => {
    const anterior = pausadoRef.current; // para desfazer se a chamada falhar
    setPausado(novo);
    setAutoPausa(porInatividade && novo);
    api.put('/presenca', { estado: novo ? 'pausa' : 'online' }).catch(() => {
      setPausado(anterior); // rollback: não deixa a UI divergir do servidor
      if (porInatividade) setAutoPausa(false);
    });
  }, []);

  // Detecta inatividade e auto-pausa quem está disponível.
  useEffect(() => {
    if (!ativo) return undefined;
    const marcar = () => { ultimaAtividade.current = Date.now(); };
    // 'focus' = voltar para a janela do navegador conta como atividade (cobre o
    // caso de quem estava trabalhando em outro app/janela e volta pro MC).
    const eventos = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'focus'];
    eventos.forEach((e) => window.addEventListener(e, marcar, { passive: true }));
    const aoVoltar = () => { if (!document.hidden) marcar(); };
    document.addEventListener('visibilitychange', aoVoltar);
    const timer = setInterval(() => {
      if (pausadoRef.current) return; // já em pausa
      if (Date.now() - ultimaAtividade.current >= IDLE_MS) definir(true, true);
    }, 30_000);
    return () => {
      eventos.forEach((e) => window.removeEventListener(e, marcar));
      document.removeEventListener('visibilitychange', aoVoltar);
      clearInterval(timer);
    };
  }, [ativo, definir]);

  return {
    pausado,
    autoPausa,
    alternar: () => definir(!pausadoRef.current),
    voltar: () => definir(false),
  };
}

export default function Header({ title }) {
  const { logout, user, isGestor } = useAuth();
  const { pathname } = useLocation();
  const emAdmin = pathname.startsWith('/admin');
  const pres = usePresenca(!emAdmin);

  return (
    <>
      <header className="navy-gradient text-white sticky top-0 z-30">
        <div className="flex items-center h-14 px-4 md:px-6 gap-2 min-w-0">
          <span className="section-bar" />
          <h1 className="min-w-0 flex-1 font-display font-bold text-base tracking-tight truncate">{title}</h1>
          <div className="flex items-center gap-2">
            {!emAdmin && pres.pausado !== null && (
              <button onClick={pres.alternar}
                title={pres.pausado ? 'Em pausa — não recebe novas conversas' : 'Disponível — recebendo conversas'}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
                  ${pres.pausado ? 'bg-amber-500/20 text-amber-200 hover:bg-amber-500/30' : 'text-white/60 hover:bg-black/20 hover:text-white'}`}>
                <span className={`w-2 h-2 rounded-full ${pres.pausado ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                {pres.pausado ? 'Em pausa' : 'Disponível'}
              </button>
            )}
            {isGestor && (
              <Link to={emAdmin ? '/conversas' : '/admin'}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                           text-white/60 hover:bg-black/20 hover:text-white transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  {emAdmin ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  )}
                </svg>
                {emAdmin ? 'Conversas' : 'Admin'}
              </Link>
            )}
            {user && (
              <span className="hidden sm:block flex-none whitespace-nowrap font-mono text-xs text-white/40">
                {user.nome}
              </span>
            )}
            <button
              onClick={logout}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                         text-white/60 hover:bg-black/20 hover:text-white transition-colors"
              aria-label="Sair"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h6a2 2 0 012 2v1" />
              </svg>
              Sair
            </button>
          </div>
        </div>
      </header>

      {!emAdmin && pres.autoPausa && pres.pausado && (
        <div className="bg-amber-100 border-b border-amber-300 text-amber-900 text-[13px] px-4 md:px-6 py-2 flex items-center gap-3">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3m0 4h.01M10.29 3.86l-7.4 12.82A1.5 1.5 0 004.18 19h15.64a1.5 1.5 0 001.29-2.32L13.71 3.86a1.5 1.5 0 00-2.42 0z" />
          </svg>
          <span>Você foi colocado <strong>em pausa por inatividade</strong> e não está recebendo novas conversas.</span>
          <button onClick={pres.voltar}
            className="ml-auto shrink-0 px-3 py-1 rounded-lg bg-amber-600 text-white text-xs font-semibold hover:bg-amber-700">
            Voltar a Disponível
          </button>
        </div>
      )}
    </>
  );
}
