import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import Brand from '../../components/ui/Brand';
import Icon from '../../components/ui/Icon';
import ThemeMenu from '../../components/ui/ThemeMenu';
import Departamentos from './Departamentos';
import Atendentes from './Atendentes';
import Numeros from './Numeros';
import Monitor from './Monitor';
import Fluxos from './Fluxos';
import Dashboard from './Dashboard';
import Historico from './Historico';
import Campanhas from './Campanhas';
import Ajustes from './Ajustes';
import IaConfig from './IaConfig';
import IaAutorizados from './IaAutorizados';
import Clientes from './Clientes';

const ABAS = [
  { id: 'monitor', rotulo: 'Operação ao vivo', descricao: 'Acompanhe filas, carga e disponibilidade da equipe em tempo real.', icon: 'pulse', grupo: 'Operação', el: Monitor },
  { id: 'dashboard', rotulo: 'Indicadores', descricao: 'Entenda volume, tempos e desempenho do atendimento.', icon: 'chart', grupo: 'Operação', el: Dashboard },
  { id: 'historico', rotulo: 'Histórico', descricao: 'Consulte atendimentos, mensagens e registros anteriores.', icon: 'history', grupo: 'Operação', el: Historico },
  { id: 'campanhas', rotulo: 'Campanhas', descricao: 'Planeje e acompanhe comunicações ativas pelo WhatsApp.', icon: 'campaign', grupo: 'Automação', el: Campanhas, adminOnly: true },
  { id: 'fluxos', rotulo: 'Fluxos de atendimento', descricao: 'Organize triagens, respostas e transferências automáticas.', icon: 'flow', grupo: 'Automação', el: Fluxos },
  { id: 'ia', rotulo: 'Agente de IA', descricao: 'Configure o provedor, as instruções e o comportamento da IA.', icon: 'bot', grupo: 'Automação', el: IaConfig, adminOnly: true },
  { id: 'ia-acesso', rotulo: 'Permissões da IA', descricao: 'Defina quais contatos podem interagir com o agente de IA.', icon: 'shield', grupo: 'Automação', el: IaAutorizados, adminOnly: true },
  { id: 'clientes', rotulo: 'Clientes', descricao: 'Centralize contatos, dados cadastrais e atendentes de referência.', icon: 'contact', grupo: 'Relacionamento', el: Clientes },
  { id: 'departamentos', rotulo: 'Departamentos', descricao: 'Estruture filas e responsabilidades por área.', icon: 'building', grupo: 'Equipe e canais', el: Departamentos },
  { id: 'atendentes', rotulo: 'Atendentes', descricao: 'Gerencie pessoas, papéis e acesso aos canais.', icon: 'users', grupo: 'Equipe e canais', el: Atendentes },
  { id: 'numeros', rotulo: 'Canais do WhatsApp', descricao: 'Conecte e gerencie os números usados pela empresa.', icon: 'phone', grupo: 'Equipe e canais', el: Numeros },
  { id: 'ajustes', rotulo: 'Configurações', descricao: 'Defina regras gerais, horários e preferências da operação.', icon: 'sliders', grupo: 'Sistema', el: Ajustes },
];

function DesktopNav({ abas, atual, onChange }) {
  const grupos = [...new Set(abas.map((aba) => aba.grupo))];
  return (
    <nav className="flex-1 overflow-y-auto px-3 pb-4" aria-label="Administração">
      {grupos.map((grupo) => (
        <div key={grupo} className="mt-5 first:mt-4">
          <p className="px-2.5 mb-1.5 text-[10px] font-semibold text-white/40">{grupo}</p>
          <div className="space-y-0.5">
            {abas.filter((aba) => aba.grupo === grupo).map((aba) => (
              <button
                key={aba.id}
                onClick={() => onChange(aba.id)}
                aria-current={atual.id === aba.id ? 'page' : undefined}
                className={`w-full min-h-10 px-2.5 rounded-lg border flex items-center gap-2.5 text-left text-[13px] font-medium ${
                  atual.id === aba.id
                    ? 'bg-brand-400/15 border-brand-400/20 text-brand-300'
                    : 'border-transparent text-white/70 hover:bg-white/[0.07] hover:text-white'
                }`}
              >
                <Icon name={aba.icon} size={16} className={atual.id === aba.id ? 'text-brand-300' : 'text-white/45'} />
                <span className="truncate">{aba.rotulo}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

export default function Admin() {
  const { isGestor, isAdmin, loading, user, logout, encerrarSuporte } = useAuth();
  const [aba, setAba] = useState('monitor');
  // Sessão de implantação do operador (FIL-70): perfil ADMIN temporário, sem
  // criar um atendente fictício dentro do cliente.
  const podeVerAdmin = isGestor || user?.suporte;

  if (loading) return null;
  if (!podeVerAdmin) return <Navigate to="/conversas" replace />;

  const abas = ABAS.filter((item) => !item.adminOnly || isAdmin);
  const atual = abas.find((item) => item.id === aba) || abas[0];
  const Conteudo = atual.el;
  const empresa = localStorage.getItem('empresa') || 'sua empresa';
  const inicial = (user?.nome || user?.email || '?').trim().slice(0, 1).toUpperCase();
  const abasDoGrupo = abas.filter((item) => item.grupo === atual.grupo);

  return (
    <div className="admin-surface min-h-screen bg-paper-50 lg:flex">
      <aside className="product-sidebar hidden lg:flex w-[264px] h-screen sticky top-0 self-start bg-ink-950 border-r border-white/10 flex-col shrink-0">
        <div className="h-[72px] px-5 flex items-center border-b border-white/10">
          <Brand inverse />
        </div>

        <div className="px-3 pt-4">
          <div className="px-3 py-2.5 rounded-lg border border-white/10 bg-white/[0.05] flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-lg bg-brand-400 text-ink-950 flex items-center justify-center shrink-0">
              <Icon name="building" size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] text-white/45">Workspace</p>
              <p className="text-[13px] font-semibold text-white truncate">{empresa}</p>
            </div>
            <Icon name="arrow" size={14} className="text-white/35 rotate-90" />
          </div>
          <Link
            to="/conversas"
            className="mt-3 min-h-10 px-3 rounded-lg bg-brand-400 text-ink-950 flex items-center justify-center gap-2 text-[13px] font-semibold hover:bg-brand-300"
          >
            <Icon name="inbox" size={16} />
            Abrir conversas
          </Link>
        </div>

        <DesktopNav abas={abas} atual={atual} onChange={setAba} />

        <div className="p-3 border-t border-white/10">
          <div className="px-2 py-2 flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-full bg-white/[0.08] border border-white/10 text-white flex items-center justify-center text-xs font-semibold">{inicial}</span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-white truncate">{user?.nome || user?.email}</p>
              <p className="text-[10px] text-white/45">{user?.papel?.toLowerCase()}</p>
            </div>
            <button onClick={user?.suporte ? encerrarSuporte : logout} className="w-9 h-9 rounded-lg flex items-center justify-center text-white/50 hover:bg-white/[0.08] hover:text-white" aria-label={user?.suporte ? 'Voltar ao painel do operador' : 'Sair'}>
              <Icon name="logout" size={17} />
            </button>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="lg:hidden sticky top-0 z-30 bg-white border-b border-paper-300">
          <div className="h-16 px-4 flex items-center gap-3">
            <Brand compact />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink-950 truncate">Administração</p>
              <p className="text-[11px] text-stone-500 truncate">{empresa}</p>
            </div>
            <ThemeMenu />
            <Link to="/conversas" className="w-10 h-10 rounded-lg border border-paper-400 flex items-center justify-center text-stone-600 hover:bg-paper-100" aria-label="Abrir conversas">
              <Icon name="inbox" />
            </Link>
          </div>
          {user?.suporte && (
            <p className="mx-4 mb-2 inline-flex items-center gap-1.5 bg-amber-50 text-amber-800 border border-amber-200 text-[11px] font-medium px-2.5 py-1 rounded-md">
              <Icon name="support" size={13} />
              Implantação Falatta · acesso administrativo
            </p>
          )}
          <nav className="flex gap-1 px-3 pb-2 overflow-x-auto" aria-label="Seções administrativas">
            {abas.map((item) => (
              <button
                key={item.id}
                onClick={() => setAba(item.id)}
                className={`shrink-0 min-h-9 px-3 rounded-lg border flex items-center gap-2 text-xs font-medium ${
                  atual.id === item.id
                    ? 'bg-brand-50 border-brand-100 text-brand-800'
                    : 'border-transparent text-stone-600 hover:bg-paper-100'
                }`}
              >
                <Icon name={item.icon} size={15} />
                {item.rotulo}
              </button>
            ))}
          </nav>
        </header>

        <header className="hidden lg:flex h-[56px] px-6 items-center justify-between bg-white border-b border-paper-300 sticky top-0 z-20">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="text-stone-500">Administração</span>
            <Icon name="arrow" size={13} className="text-stone-400" />
            <span className="text-stone-500">{atual.grupo}</span>
            <Icon name="arrow" size={13} className="text-stone-400" />
            <span className="font-semibold text-ink-950">{atual.rotulo}</span>
          </div>
          <div className="flex items-center gap-2">
            {user?.suporte && (
              <span className="inline-flex items-center gap-2 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-1.5">
                <Icon name="support" size={15} />
                Implantação Falatta · alterações auditadas
              </span>
            )}
            <ThemeMenu />
          </div>
        </header>

        <main key={atual.id} className="px-4 py-5 md:px-6 lg:px-6 lg:py-5 animate-slide-up">
          <div className="max-w-screen-2xl mx-auto">
            <nav className="mb-5 flex gap-1 overflow-x-auto bg-white border border-paper-300 rounded-[10px] p-1" aria-label={atual.grupo}>
              {abasDoGrupo.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setAba(item.id)}
                  aria-current={item.id === atual.id ? 'page' : undefined}
                  className={`shrink-0 min-h-9 px-3 rounded-md flex items-center gap-2 text-xs font-medium ${
                    item.id === atual.id
                      ? 'bg-brand-700 text-white'
                      : 'text-stone-600 hover:bg-paper-100 hover:text-ink-950'
                  }`}
                >
                  <Icon name={item.icon} size={15} />
                  {item.rotulo}
                </button>
              ))}
            </nav>
            <div className="page-heading">
              <div>
                <h1 className="page-title">{atual.rotulo}</h1>
                <p className="page-description">{atual.descricao}</p>
              </div>
            </div>
            <Conteudo onIrPara={setAba} />
          </div>
        </main>
      </div>
    </div>
  );
}
