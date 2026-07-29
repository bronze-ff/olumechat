import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import Brand from '../ui/Brand';
import Icon from '../ui/Icon';
import ThemeMenu from '../ui/ThemeMenu';
import SuporteBadge from './SuporteBadge';

const IDLE_MS = 30 * 60 * 1000;

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
    const anterior = pausadoRef.current;
    setPausado(novo);
    setAutoPausa(porInatividade && novo);
    api.put('/presenca', { estado: novo ? 'pausa' : 'online' }).catch(() => {
      setPausado(anterior);
      if (porInatividade) setAutoPausa(false);
    });
  }, []);

  useEffect(() => {
    if (!ativo) return undefined;
    const marcar = () => { ultimaAtividade.current = Date.now(); };
    const eventos = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'focus'];
    eventos.forEach((evento) => window.addEventListener(evento, marcar, { passive: true }));
    const aoVoltar = () => { if (!document.hidden) marcar(); };
    document.addEventListener('visibilitychange', aoVoltar);
    const timer = setInterval(() => {
      if (!pausadoRef.current && Date.now() - ultimaAtividade.current >= IDLE_MS) definir(true, true);
    }, 30_000);
    return () => {
      eventos.forEach((evento) => window.removeEventListener(evento, marcar));
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

export default function Header({ title, embedded = false }) {
  const { logout, encerrarSuporte, user, isGestor } = useAuth();
  const { pathname } = useLocation();
  const emAdmin = pathname.startsWith('/admin');
  const pres = usePresenca(!emAdmin && !user?.suporte);
  const empresa = localStorage.getItem('empresa') || 'workspace';
  const inicial = (user?.nome || user?.email || '?').trim().slice(0, 1).toUpperCase();

  return (
    <>
      <header className="bg-white text-stone-800 border-b border-paper-300 sticky top-0 z-30">
        <div className={`flex items-center px-3 md:px-4 gap-3 min-w-0 ${embedded ? 'h-14' : 'h-16'}`}>
          <Brand compact className={`${embedded ? 'md:hidden' : ''} pr-2 md:pr-4 md:border-r md:border-paper-300`} />
          <div className="min-w-0 flex-1">
            <h1 className="font-semibold text-[15px] leading-tight truncate">{title}</h1>
            <p className={`text-stone-500 truncate ${embedded ? 'text-[10px]' : 'text-xs'}`}>{empresa}</p>
          </div>

          {user?.suporte && <SuporteBadge className="hidden sm:inline-flex" />}

          <div className="flex items-center gap-1.5">
            {!embedded && <ThemeMenu />}
            {embedded && <div className="md:hidden"><ThemeMenu /></div>}

            {!emAdmin && pres.pausado !== null && (
              <button
                onClick={pres.alternar}
                title={pres.pausado ? 'Em pausa — não recebe novas conversas' : 'Disponível — recebendo conversas'}
                className={`min-h-10 flex items-center gap-2 px-3 rounded-lg text-xs font-semibold border ${
                  pres.pausado
                    ? 'bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100'
                    : 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
                }`}
              >
                <span className={`w-2 h-2 rounded-full ${pres.pausado ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                {pres.pausado ? 'Em pausa' : 'Disponível'}
              </button>
            )}

            {(isGestor || user?.suporte) && (
              <Link
                to={emAdmin ? '/conversas' : '/admin'}
                className={`${embedded ? 'md:hidden ' : ''}min-h-10 flex items-center gap-2 px-3 rounded-lg text-xs font-semibold text-stone-600 hover:bg-paper-200 hover:text-ink-950`}
              >
                <Icon name={emAdmin ? 'inbox' : 'settings'} size={17} />
                <span className="hidden sm:inline">{emAdmin ? 'Conversas' : 'Gestão'}</span>
              </Link>
            )}

            <div className="hidden md:flex items-center gap-2 pl-2 ml-1 border-l border-paper-300">
              <span className="w-8 h-8 rounded-lg bg-paper-200 text-stone-700 flex items-center justify-center text-xs font-semibold">
                {inicial}
              </span>
              <span className="max-w-32 truncate text-xs font-medium text-stone-700">{user?.nome || user?.email}</span>
            </div>

            <button
              onClick={user?.suporte ? encerrarSuporte : logout}
              className="w-10 h-10 rounded-lg flex items-center justify-center text-stone-500 hover:bg-paper-200 hover:text-ink-950"
              aria-label={user?.suporte ? 'Voltar ao painel do operador' : 'Sair'}
              title={user?.suporte ? 'Voltar ao painel do operador' : 'Sair'}
            >
              <Icon name="logout" size={18} />
            </button>
          </div>
        </div>
      </header>

      {!emAdmin && pres.autoPausa && pres.pausado && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-900 text-[13px] px-4 md:px-6 py-2.5 flex items-center gap-3">
          <Icon name="alert" size={17} className="shrink-0" />
          <span>
            Você foi colocado <strong>em pausa por inatividade</strong> e não está recebendo novas conversas.
          </span>
          <button
            onClick={pres.voltar}
            className="ml-auto shrink-0 min-h-9 px-3 rounded-lg bg-amber-700 text-white text-xs font-semibold hover:bg-amber-800"
          >
            Voltar a disponível
          </button>
        </div>
      )}
    </>
  );
}
