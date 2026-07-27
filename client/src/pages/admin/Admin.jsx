import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import Header from '../../components/layout/Header';
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

const ABAS = [
  { id: 'monitor', rotulo: 'Monitor', el: Monitor },
  { id: 'dashboard', rotulo: 'Dashboard', el: Dashboard },
  { id: 'historico', rotulo: 'Histórico', el: Historico },
  { id: 'campanhas', rotulo: 'Campanhas', el: Campanhas, adminOnly: true },
  { id: 'fluxos', rotulo: 'Fluxos', el: Fluxos },
  { id: 'departamentos', rotulo: 'Departamentos', el: Departamentos },
  { id: 'atendentes', rotulo: 'Atendentes', el: Atendentes },
  { id: 'numeros', rotulo: 'Números', el: Numeros },
  { id: 'ia', rotulo: 'IA', el: IaConfig, adminOnly: true },
  { id: 'ia-acesso', rotulo: 'Acesso IA', el: IaAutorizados, adminOnly: true },
  { id: 'ajustes', rotulo: 'Ajustes', el: Ajustes },
];

export default function Admin() {
  const { isGestor, isAdmin, loading } = useAuth();
  const [aba, setAba] = useState('monitor');

  if (loading) return null;
  if (!isGestor) return <Navigate to="/conversas" replace />;

  // Abas ADMIN-only (Campanhas: disparo pago + PII; IA/Acesso IA: provedor,
  // chave cifrada e telefones autorizados) somem para o supervisor.
  const abas = ABAS.filter((a) => !a.adminOnly || isAdmin);
  const atual = abas.find((a) => a.id === aba) || abas[0];
  const Conteudo = atual.el;

  return (
    <div className="min-h-screen flex flex-col bg-paper-100">
      <Header title="Administração" />

      {/* Faixa de navegação: tabs editoriais com sublinhado bordô */}
      <div className="sticky top-14 z-20 bg-ink-950 text-white shadow-md">
        <div className="px-4 md:px-6 flex items-end gap-0.5 overflow-x-auto">
          {abas.map((a) => (
            <button key={a.id} onClick={() => setAba(a.id)}
              className={`relative shrink-0 px-3.5 pt-3 pb-2.5 text-[13px] font-medium tracking-wide transition-colors
                ${aba === a.id ? 'text-white' : 'text-white/45 hover:text-white/80'}`}>
              {a.rotulo}
              <span className={`absolute left-3 right-3 bottom-0 h-[3px] rounded-t transition-all
                ${aba === a.id ? 'bg-bordeaux-700' : 'bg-transparent'}`} />
            </button>
          ))}
        </div>
      </div>

      <main key={aba} className="flex-1 p-4 md:p-6 animate-slide-up">
        <Conteudo />
      </main>
    </div>
  );
}
