import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../../context/ThemeContext';
import Icon from './Icon';

export default function ThemeMenu({ align = 'right', inverse = false, icon = 'palette' }) {
  const [aberto, setAberto] = useState(false);
  const raiz = useRef(null);
  const { preference, themes, setTheme } = useTheme();
  const atual = themes.find((item) => item.id === preference) || themes[0];

  useEffect(() => {
    if (!aberto) return undefined;
    const fecharFora = (event) => {
      if (!raiz.current?.contains(event.target)) setAberto(false);
    };
    const fecharEsc = (event) => {
      if (event.key === 'Escape') setAberto(false);
    };
    document.addEventListener('pointerdown', fecharFora);
    document.addEventListener('keydown', fecharEsc);
    return () => {
      document.removeEventListener('pointerdown', fecharFora);
      document.removeEventListener('keydown', fecharEsc);
    };
  }, [aberto]);

  return (
    <div ref={raiz} className="relative">
      <button
        type="button"
        onClick={() => setAberto((valor) => !valor)}
        className={`w-10 h-10 rounded-lg border flex items-center justify-center ${
          inverse
            ? 'border-white/10 text-white/65 hover:bg-white/10 hover:text-white'
            : 'border-paper-300 text-stone-500 hover:bg-paper-100 hover:text-ink-950'
        }`}
        aria-label={`Tema: ${atual.nome}`}
        aria-haspopup="menu"
        aria-expanded={aberto}
        title={`Tema: ${atual.nome}`}
      >
        <Icon name={icon} size={17} />
      </button>

      {aberto && (
        <div
          role="menu"
          aria-label="Escolher tema"
          className={`absolute top-full mt-2 z-50 w-[290px] max-w-[calc(100vw-24px)] bg-white border border-paper-400 rounded-[10px] shadow-[0_4px_8px_rgba(14,21,37,0.16)] p-1.5 ${
            align === 'left' ? 'left-0' : 'right-0'
          }`}
        >
          <div className="px-2.5 pt-2 pb-1.5">
            <p className="text-xs font-semibold text-ink-950">Aparência</p>
            <p className="mt-0.5 text-[11px] text-stone-500">
              Tema atual: {atual.nome}
            </p>
          </div>
          <div className="space-y-0.5">
            {themes.map((item) => {
              const selecionado = preference === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selecionado}
                  onClick={() => {
                    setTheme(item.id);
                    setAberto(false);
                  }}
                  className={`w-full min-h-[52px] px-2.5 rounded-md flex items-center gap-3 text-left ${
                    selecionado ? 'bg-brand-50 text-brand-800' : 'text-stone-700 hover:bg-paper-100'
                  }`}
                >
                  <span className="theme-swatch shrink-0" aria-hidden="true">
                    {item.amostra.map((cor) => <span key={cor} style={{ backgroundColor: cor }} />)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold">{item.nome}</span>
                    <span className={`block text-[10px] leading-4 ${selecionado ? 'text-brand-700' : 'text-stone-500'}`}>
                      {item.descricao}
                    </span>
                  </span>
                  {selecionado && <Icon name="check" size={16} className="text-brand-700 shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
