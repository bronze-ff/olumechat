import { useState, useEffect, useCallback } from 'react';

// Detecta se um contêiner com overflow horizontal está encostado no início/fim
// do scroll — usado pra mostrar/esconder o gradiente que sinaliza "tem mais
// aba pra esse lado" (FIL-89, adendo: abas do operador pareciam só 3 opções).
export default function useScrollEdges(ref, deps = []) {
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  const medir = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setAtStart(el.scrollLeft <= 1);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
  }, [ref]);

  useEffect(() => {
    medir();
    const el = ref.current;
    if (!el) return undefined;
    el.addEventListener('scroll', medir, { passive: true });
    window.addEventListener('resize', medir);
    return () => {
      el.removeEventListener('scroll', medir);
      window.removeEventListener('resize', medir);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [medir, ...deps]);

  return { atStart, atEnd };
}
