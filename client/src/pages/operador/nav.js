// Navegação do painel do operador — compartilhada entre Operador.jsx (FIL-70)
// e Financeiro.jsx (FIL-80) para o menu lateral ser o mesmo em toda página.
export const SECOES = [
  { id: 'clientes', label: 'Clientes', descricao: 'Carteira e suporte', icon: 'building', to: '/operador/clientes', grupo: 'Carteira' },
  { id: 'novo-cliente', label: 'Novo cliente', descricao: 'Provisionar empresa', icon: 'plus', to: '/operador/novo-cliente', grupo: 'Carteira' },
  { id: 'onboarding', label: 'Onboarding Meta', descricao: 'Quem está travado em qual etapa', icon: 'support', to: '/operador/onboarding', grupo: 'Carteira' },
  { id: 'financeiro', label: 'Visão geral', descricao: 'MRR, a receber e margem', icon: 'chart', to: '/operador/financeiro', grupo: 'Financeiro' },
  { id: 'financeiro-cobranca', label: 'Cobrança', descricao: 'Faturas do mês por status', icon: 'inbox', to: '/operador/financeiro/cobranca', grupo: 'Financeiro' },
  { id: 'financeiro-alertas', label: 'Alertas', descricao: 'Atenção da carteira', icon: 'alert', to: '/operador/financeiro/alertas', grupo: 'Financeiro' },
  { id: 'auditoria', label: 'Auditoria', descricao: 'Atividade administrativa', icon: 'history', to: '/operador/auditoria', grupo: 'Governança' },
];

export const GRUPOS = ['Carteira', 'Financeiro', 'Governança'];
