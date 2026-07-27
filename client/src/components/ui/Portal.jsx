import { createPortal } from 'react-dom';

// Renderiza os filhos direto no <body>, fora da árvore do componente. Usado em
// modais (position:fixed) que vivem dentro de um ancestral com `transform` — ex.:
// o <main className="animate-slide-up"> do Admin. Um ancestral transformado vira o
// "containing block" do position:fixed, o que jogava o modal pro meio do conteúdo
// rolável em vez de centralizar na viewport. No body, o fixed volta a ser relativo
// à viewport, sempre.
export default function Portal({ children }) {
  if (typeof document === 'undefined') return null;
  return createPortal(children, document.body);
}
