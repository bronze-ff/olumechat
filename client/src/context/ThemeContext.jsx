import { createContext, useContext, useLayoutEffect, useMemo, useState } from 'react';

const ThemeContext = createContext(null);
const STORAGE_KEY = 'olume:tema';
const LEGACY_STORAGE_KEY = 'falatta:tema';

export const THEMES = [
  { id: 'light', nome: 'Claro', descricao: 'Mineral, preciso e confortável', amostra: ['#f3f8f6', '#e9efea', '#1f7a60'] },
  { id: 'dark', nome: 'Escuro', descricao: 'Carvão esverdeado e menta', amostra: ['#071a15', '#111d1a', '#5bd6ae'] },
];

function temaSalvo() {
  const atual = localStorage.getItem(STORAGE_KEY);
  const valor = atual || localStorage.getItem(LEGACY_STORAGE_KEY);
  if (valor === 'light' || valor === 'dark') {
    if (!atual) localStorage.setItem(STORAGE_KEY, valor);
    return valor;
  }

  // Normaliza preferências das versões anteriores. "Sistema" é resolvido uma
  // única vez; Drácula e Nord são migrados para o tema escuro equivalente.
  const normalizado = valor === 'dracula' || valor === 'nord'
    ? 'dark'
    : valor === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  localStorage.setItem(STORAGE_KEY, normalizado);
  return normalizado;
}

export function aplicarTemaInicial() {
  const theme = temaSalvo();
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = theme;
  document.documentElement.style.colorScheme = theme;
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(temaSalvo);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themePreference = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  function selecionarTheme(novoTema) {
    if (!THEMES.some((item) => item.id === novoTema)) return;
    localStorage.setItem(STORAGE_KEY, novoTema);
    setThemeState(novoTema);
  }

  const value = useMemo(() => ({
    preference: theme,
    theme,
    themes: THEMES,
    setTheme: selecionarTheme,
  }), [theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme deve ser usado dentro de ThemeProvider');
  return context;
}
