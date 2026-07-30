import { useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import Brand from '../ui/Brand';
import Icon from '../ui/Icon';
import ThemeMenu from '../ui/ThemeMenu';
import useScrollEdges from '../../hooks/useScrollEdges';
import apiOperador from '../../services/apiOperador';

// Casco visual do painel do operador (FIL-70): sidebar + cabeçalho mobile +
// breadcrumb desktop. Extraído de Operador.jsx (FIL-80) para o painel
// financeiro usar o MESMO padrão visual (temas claro/escuro, navegação,
// identidade) sem duplicar o layout inteiro em cada página nova.
export default function OperadorShell({ secoes, grupos, atual, eu, onSair, titulo, descricao, acao, erro, onFecharErro, children }) {
  const inicial = (eu.data?.nome || eu.data?.email || '?').slice(0, 1).toUpperCase();
  const navMobileRef = useRef(null);
  const navMobile = useScrollEdges(navMobileRef, [secoes.length]);

  // Badge de "leads novos" (FIL-96) no item de menu marcado com `badge: true`
  // — buscado aqui, e não na página de Leads, porque o shell aparece em toda
  // tela do operador e o número precisa ficar visível mesmo fora dela.
  const temBadge = secoes.some((item) => item.badge);
  const contagemNovos = useQuery({
    queryKey: ['operador', 'leads', 'contagem-novos'],
    queryFn: () => apiOperador.get('/leads/contagem-novos').then((r) => r.data.novos),
    enabled: temBadge,
    refetchInterval: 60_000,
  });
  const novos = contagemNovos.data || 0;

  return (
    <div className="admin-surface min-h-screen bg-paper-50 lg:flex">
      <aside className="product-sidebar hidden lg:flex w-[264px] h-screen sticky top-0 self-start bg-ink-950 border-r border-white/10 flex-col shrink-0">
        <div className="h-[72px] px-5 flex items-center border-b border-white/10">
          <Brand inverse product={false} />
        </div>

        <div className="px-3 pt-4">
          <div className="px-3 py-2.5 rounded-lg border border-white/10 bg-white/[0.05] flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-lg bg-brand-400 text-ink-950 flex items-center justify-center shrink-0">
              <Icon name="pulse" size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] text-white/45">Área interna Olume</p>
              <p className="text-[13px] font-semibold text-white truncate">Central de operações</p>
            </div>
            <span className="w-2 h-2 rounded-full bg-emerald-500" title="Ambiente operacional" />
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-4" aria-label="Painel do operador">
          {grupos.map((grupo) => (
            <div key={grupo} className="mt-5 first:mt-4">
              <p className="px-2.5 mb-1.5 text-[10px] font-semibold text-white/40">{grupo}</p>
              <div className="space-y-0.5">
                {secoes.filter((item) => item.grupo === grupo).map((item) => (
                  <NavLink
                    key={item.id}
                    to={item.to}
                    end
                    aria-current={item.id === atual.id ? 'page' : undefined}
                    className={({ isActive }) => `min-h-10 px-2.5 rounded-lg border flex items-center gap-2.5 text-[13px] font-medium ${
                      isActive
                        ? 'bg-brand-400/15 border-brand-400/20 text-brand-300'
                        : 'border-transparent text-white/70 hover:bg-white/[0.07] hover:text-white'
                    }`}
                  >
                    {({ isActive }) => (
                      <>
                        <Icon name={item.icon} size={16} className={isActive ? 'text-brand-300' : 'text-white/45'} />
                        <span className="truncate flex-1">{item.label}</span>
                        {item.badge && novos > 0 && (
                          <span className="ml-auto min-w-[18px] h-[18px] px-1 rounded-full bg-brand-400 text-ink-950 text-[10px] font-bold flex items-center justify-center" aria-label={`${novos} novos`}>
                            {novos}
                          </span>
                        )}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="p-3 border-t border-white/10">
          <div className="px-2 py-2 flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-full bg-white/[0.08] border border-white/10 text-white flex items-center justify-center text-xs font-semibold">{inicial}</span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-white truncate">{eu.data?.nome || eu.data?.email || 'Operador'}</p>
              <p className="text-[10px] text-white/45 truncate">{eu.data?.email}</p>
            </div>
            <button onClick={onSair} className="w-9 h-9 rounded-lg flex items-center justify-center text-white/50 hover:bg-white/[0.08] hover:text-white" aria-label="Sair">
              <Icon name="logout" size={17} />
            </button>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="lg:hidden sticky top-0 z-30 bg-white border-b border-paper-300">
          <div className="h-16 px-4 flex items-center gap-3">
            <Brand compact product={false} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink-950 truncate">Central de operações</p>
              <p className="text-[11px] text-stone-500 truncate">{atual.label}</p>
            </div>
            <ThemeMenu />
            <button onClick={onSair} className="w-10 h-10 rounded-lg flex items-center justify-center text-stone-500 hover:bg-paper-100 hover:text-ink-950" aria-label="Sair">
              <Icon name="logout" />
            </button>
          </div>
          <div className="relative">
            <nav ref={navMobileRef} className="flex gap-1 px-3 pb-2 overflow-x-auto" aria-label="Seções do operador">
              {secoes.map((item) => (
                <NavLink
                  key={item.id}
                  to={item.to}
                  end
                  className={({ isActive }) => `shrink-0 min-h-9 px-3 rounded-lg border flex items-center gap-2 text-xs font-medium ${
                    isActive
                      ? 'bg-brand-50 border-brand-100 text-brand-800'
                      : 'border-transparent text-stone-600 hover:bg-paper-100'
                  }`}
                >
                  <Icon name={item.icon} size={15} />
                  {item.label}
                  {item.badge && novos > 0 && (
                    <span className="min-w-[16px] h-4 px-1 rounded-full bg-brand-600 text-white text-[10px] font-bold flex items-center justify-center" aria-label={`${novos} novos`}>
                      {novos}
                    </span>
                  )}
                </NavLink>
              ))}
            </nav>
            {/* Sinaliza que a barra continua além da borda (sem isso, no
                celular parece que só existem as primeiras seções visíveis). */}
            <div className={`pointer-events-none absolute inset-y-0 bottom-2 left-0 w-6 bg-gradient-to-r from-[rgb(var(--color-surface))] to-transparent transition-opacity ${navMobile.atStart ? 'opacity-0' : 'opacity-100'}`} aria-hidden="true" />
            <div className={`pointer-events-none absolute inset-y-0 bottom-2 right-0 w-6 bg-gradient-to-l from-[rgb(var(--color-surface))] to-transparent transition-opacity ${navMobile.atEnd ? 'opacity-0' : 'opacity-100'}`} aria-hidden="true" />
          </div>
        </header>

        <header className="hidden lg:flex h-[56px] px-6 items-center justify-between bg-white border-b border-paper-300 sticky top-0 z-20">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="text-stone-500">Central de operações</span>
            <Icon name="arrow" size={13} className="text-stone-400" />
            <span className="text-stone-500">{atual.grupo}</span>
            <Icon name="arrow" size={13} className="text-stone-400" />
            <span className="font-semibold text-ink-950">{atual.label}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-2 text-xs font-medium text-stone-600">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              Ambiente operacional
            </span>
            <ThemeMenu />
          </div>
        </header>

        <main key={atual.id} className="px-4 py-5 md:px-6 lg:px-6 lg:py-5 animate-slide-up">
          <div className="max-w-screen-2xl mx-auto">
            <div className="page-heading">
              <div>
                <h1 className="page-title">{titulo}</h1>
                <p className="page-description">{descricao}</p>
              </div>
              {acao}
            </div>

            {erro && (
              <div className="mb-5 p-3.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 flex items-start gap-3" role="alert">
                <Icon name="alert" size={18} className="mt-0.5 shrink-0" />
                <span className="flex-1">{erro}</span>
                <button onClick={onFecharErro} className="font-semibold" aria-label="Fechar aviso">Fechar</button>
              </div>
            )}

            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
