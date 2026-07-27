import { useState, useEffect } from 'react';
import api from '../../services/api';

// Anexo de mídia recebida: baixa o binário com o JWT (axios) e renderiza inline
// (imagem/áudio/vídeo) ou como link de download (documentos). Compartilhado entre o
// chat (Conversas) e o histórico (modal de pré-visualizar/abrir atendimento).
export default function Anexo({ m, out }) {
  const [url, setUrl] = useState(null);
  const [erro, setErro] = useState(false);
  const nome = m.nomeArquivo || m.tipo || 'arquivo';
  const mime = m.mimeType || '';
  const isImg = mime.startsWith('image/');
  const isAudio = mime.startsWith('audio/');
  const isVideo = mime.startsWith('video/');

  useEffect(() => {
    if (!m.temArquivo) return undefined;
    let objUrl;
    let cancelado = false;
    api.get(`/midia/${m.id}`, { responseType: 'blob' })
      .then((r) => {
        if (cancelado) return;
        objUrl = URL.createObjectURL(r.data);
        setUrl(objUrl);
      })
      .catch(() => !cancelado && setErro(true));
    return () => { cancelado = true; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [m.id, m.temArquivo]);

  const Clipe = ({ children }) => (
    <span className={`flex items-center gap-1.5 text-xs ${out ? 'text-white/80' : 'text-stone-500'}`}>
      <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
      </svg>
      {children}
    </span>
  );

  if (!m.temArquivo) return <Clipe>{nome} <span className="opacity-60">(não salvo)</span></Clipe>;
  if (erro) return <Clipe>{nome} <span className="opacity-60">(erro ao abrir)</span></Clipe>;
  if (!url) return <Clipe>Carregando anexo…</Clipe>;

  if (isImg) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block">
        <img src={url} alt={nome} className="rounded-lg max-h-64 max-w-full object-contain" />
      </a>
    );
  }
  if (isAudio) return <audio controls src={url} className="max-w-full" />;
  if (isVideo) return <video controls src={url} className="rounded-lg max-h-64 max-w-full" />;
  return (
    <a href={url} download={nome}
      className={`flex items-center gap-1.5 text-xs underline ${out ? 'text-white/90' : 'text-brand-700'}`}>
      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
      </svg>
      {nome}
    </a>
  );
}
