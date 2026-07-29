import { useAuth } from '../../context/AuthContext';
import Icon from '../ui/Icon';

// Affordance único de "sessão de suporte ativa" (FIL-90): mesmo visual âmbar
// e a mesma ação (encerrarSuporte) no Header do atendente e no Admin — antes
// cada tela tinha seu próprio badge/handler duplicado.
export default function SuporteBadge({ compact = false, className = 'inline-flex' }) {
  const { encerrarSuporte } = useAuth();

  return (
    <button
      type="button"
      onClick={encerrarSuporte}
      title="Administração temporária e auditada. Voltar ao painel do operador."
      className={`${className} shrink-0 items-center gap-1.5 bg-amber-50 text-amber-900 border border-amber-200 font-semibold rounded-lg hover:bg-amber-100 ${
        compact ? 'text-[11px] px-2.5 py-1' : 'text-xs px-2.5 py-1.5'
      }`}
    >
      <Icon name="support" size={compact ? 13 : 14} />
      Implantação Olume · sair do cliente
    </button>
  );
}
