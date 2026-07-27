export function formatDateTime(isoOrDate) {
  if (!isoOrDate) return '—';
  const d = new Date(isoOrDate);
  if (isNaN(d.getTime())) return isoOrDate;
  return d.toLocaleString('pt-BR');
}

export function formatTime(isoOrDate) {
  if (!isoOrDate) return '';
  const d = new Date(isoOrDate);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// Mesma data de calendário (ignora a hora)?
function mesmoDia(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

// Rótulo do divisor de dia no thread: "Hoje", "Ontem" ou a data (10/06/2026).
export function formatDiaSeparador(isoOrDate) {
  if (!isoOrDate) return '';
  const d = new Date(isoOrDate);
  if (isNaN(d.getTime())) return '';
  const hoje = new Date();
  const ontem = new Date();
  ontem.setDate(hoje.getDate() - 1);
  if (mesmoDia(d, hoje)) return 'Hoje';
  if (mesmoDia(d, ontem)) return 'Ontem';
  return d.toLocaleDateString('pt-BR');
}

// Mudou o dia entre duas mensagens consecutivas? (abre um divisor antes da 1ª de cada dia;
// a primeira mensagem do thread também abre). Espera a thread em ordem cronológica.
export function diaMudou(isoAtual, isoAnterior) {
  if (!isoAtual) return false;
  const a = new Date(isoAtual);
  if (isNaN(a.getTime())) return false;
  if (!isoAnterior) return true;
  const b = new Date(isoAnterior);
  if (isNaN(b.getTime())) return true;
  return !mesmoDia(a, b);
}

// Para a lista de conversas: hora se for hoje; "ontem"; senão a data curta (dd/mm).
export function formatHoraOuDia(isoOrDate) {
  if (!isoOrDate) return '';
  const d = new Date(isoOrDate);
  if (isNaN(d.getTime())) return '';
  const hoje = new Date();
  const ontem = new Date();
  ontem.setDate(hoje.getDate() - 1);
  if (mesmoDia(d, hoje)) return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (mesmoDia(d, ontem)) return 'ontem';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export function formatPhone(e164) {
  if (!e164) return '—';
  const s = String(e164).replace(/\D/g, '');
  // 55 + DDD + numero
  const m = s.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
  return e164;
}

// Janela de 24h: minutos restantes a partir do ISO de expiração.
export function janelaRestante(expiraIso) {
  if (!expiraIso) return null;
  const ms = new Date(expiraIso).getTime() - Date.now();
  if (isNaN(ms)) return null;
  return Math.max(0, Math.round(ms / 60000));
}
