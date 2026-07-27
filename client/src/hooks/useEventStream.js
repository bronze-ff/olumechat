import { useEffect, useRef } from 'react';
import api from '../services/api';

// Conecta no SSE do backend (/api/stream) e chama onEvent a cada evento.
// O EventSource não envia o header Authorization, então pegamos um ticket de
// uso único (/api/stream/ticket) e o usamos na URL. Como o ticket é consumido
// na conexão, em caso de queda reconectamos buscando OUTRO ticket (backoff).
export default function useEventStream(onEvent) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let es = null;
    let parado = false;
    let tentativa = 0;
    let timer = null;

    async function conectar() {
      if (parado) return;
      try {
        const { data } = await api.post('/stream/ticket');
        if (parado) return;
        const base = api.defaults.baseURL || '/api';
        es = new EventSource(`${base}/stream?ticket=${encodeURIComponent(data.ticket)}`);
        es.onopen = () => { tentativa = 0; };
        es.onmessage = (ev) => {
          try { onEventRef.current?.(JSON.parse(ev.data)); } catch { /* ignora ping/inválido */ }
        };
        es.onerror = () => {
          if (es) { es.close(); es = null; }
          if (parado) return;
          tentativa = Math.min(tentativa + 1, 6);
          timer = setTimeout(conectar, 1000 * tentativa);
        };
      } catch {
        if (parado) return;
        tentativa = Math.min(tentativa + 1, 6);
        timer = setTimeout(conectar, 1000 * tentativa);
      }
    }

    conectar();
    return () => { parado = true; clearTimeout(timer); if (es) es.close(); };
  }, []);
}
