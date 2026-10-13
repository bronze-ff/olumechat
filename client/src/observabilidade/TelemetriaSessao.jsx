import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import apiOperador from '../services/apiOperador';
import { idDaSessao } from './idSessao.js';
import { definirSessao } from './posthog';

export default function TelemetriaSessao() {
  const { user } = useAuth();
  const { pathname } = useLocation();

  useEffect(() => {
    const painelOperador = pathname.startsWith('/operador') && pathname !== '/operador/login';
    let vivo = true;

    if (painelOperador) {
      apiOperador.get('/eu')
        .then(({ data }) => {
          if (vivo) definirSessao(idDaSessao({ resposta: data, prefixo: 'o' }));
        })
        .catch(() => {
          if (vivo) definirSessao(null);
        });
      return () => { vivo = false; };
    }

    if (!user) {
      definirSessao(null);
      return undefined;
    }

    api.get('/auth/perfil')
      .then(({ data }) => {
        if (!vivo) return;
        const prefixo = data && data.suporte === true ? 'o' : 'u';
        definirSessao(idDaSessao({ resposta: data, prefixo }));
      })
      .catch(() => {
        if (vivo) definirSessao(null);
      });
    return () => { vivo = false; };
  }, [user, pathname]);

  return null;
}
