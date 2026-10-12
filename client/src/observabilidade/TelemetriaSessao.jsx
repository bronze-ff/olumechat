import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { CHAVE_TOKEN } from '../services/apiOperador';
import { definirSessao } from './posthog';

function idOperador() {
  try {
    const token = localStorage.getItem(CHAVE_TOKEN);
    if (!token) return null;
    const payload = JSON.parse(atob(token.split('.')[1]));
    if (!payload || payload.operadorId == null || payload.operadorId === '') return null;
    if (payload.exp && payload.exp * 1000 <= Date.now()) return null;
    return `o:${payload.operadorId}`;
  } catch {
    return null;
  }
}

function idCliente(user) {
  if (!user) return null;
  if (user.usuarioId != null && user.usuarioId !== '') return `u:${user.usuarioId}`;
  if (user.suporte && user.operadorId != null && user.operadorId !== '') return `o:${user.operadorId}`;
  return null;
}

export default function TelemetriaSessao() {
  const { user } = useAuth();
  const { pathname } = useLocation();

  useEffect(() => {
    const painelOperador = pathname.startsWith('/operador') && pathname !== '/operador/login';
    if (painelOperador) {
      definirSessao(idOperador());
      return;
    }
    definirSessao(idCliente(user));
  }, [user, pathname]);

  return null;
}
