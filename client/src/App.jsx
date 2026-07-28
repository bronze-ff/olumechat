import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import ProtectedRoute from './components/layout/ProtectedRoute';
import RotaOperador from './components/layout/RotaOperador';

const Landing = lazy(() => import('./pages/Landing'));
const Login = lazy(() => import('./pages/Login'));
const DefinirSenha = lazy(() => import('./pages/DefinirSenha'));
const Conversas = lazy(() => import('./pages/Conversas'));
const Admin = lazy(() => import('./pages/admin/Admin'));
const LoginOperador = lazy(() => import('./pages/operador/LoginOperador'));
const Operador = lazy(() => import('./pages/operador/Operador'));
const Financeiro = lazy(() => import('./pages/operador/Financeiro'));

function RouteFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper-100" role="status" aria-label="Carregando página">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-paper-400 border-t-brand-700" aria-hidden="true" />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <ThemeProvider>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/login" element={<Login />} />
              {/* Primeiro acesso: rota pública, chega por link com token. */}
              <Route path="/definir-senha" element={<DefinirSenha />} />
              {/* Painel do operador (FIL-70) — sessão própria, fora do RBAC do
                  tenant e fora do AuthContext do painel do cliente. */}
              <Route path="/operador/login" element={<LoginOperador />} />
              <Route element={<RotaOperador />}>
                <Route path="/operador" element={<Navigate to="/operador/clientes" replace />} />
                <Route path="/operador/clientes" element={<Operador secao="clientes" />} />
                <Route path="/operador/novo-cliente" element={<Operador secao="novo-cliente" />} />
                {/* Painel financeiro (FIL-80) — só o operador vê MRR, a receber,
                    atrasados e margem; nenhuma sessão de tenant/suporte chega aqui
                    (ver docs/SEGURANCA.md e server/operador/routes.js). */}
                <Route path="/operador/financeiro" element={<Financeiro secao="financeiro" />} />
                <Route path="/operador/financeiro/cobranca" element={<Financeiro secao="financeiro-cobranca" />} />
                <Route path="/operador/financeiro/alertas" element={<Financeiro secao="financeiro-alertas" />} />
                <Route path="/operador/auditoria" element={<Operador secao="auditoria" />} />
              </Route>
              <Route element={<ProtectedRoute />}>
                <Route path="/conversas" element={<Conversas />} />
                <Route path="/admin"     element={<Admin />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </ThemeProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
