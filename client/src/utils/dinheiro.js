// Centavos → BRL formatado. O backend do financeiro (FIL-76/77/79/80) nunca
// trabalha com float — só o dígito de exibição passa por aqui.
export function formatarCentavos(centavos) {
  if (centavos === null || centavos === undefined) return '—';
  return (Number(centavos) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function formatarData(data) {
  if (!data) return '—';
  const iso = String(data).slice(0, 10);
  const [ano, mes, dia] = iso.split('-');
  if (!ano || !mes || !dia) return iso;
  return `${dia}/${mes}/${ano}`;
}
