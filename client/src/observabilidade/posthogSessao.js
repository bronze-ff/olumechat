// Troca de pessoa no PostHog.
// identify() sem reset() alia o id anterior ao novo. reset() também limpa o
// consentimento, então o opt-in vem depois do reset, nunca antes.

export function aplicarIdentidade(posthog, idAtual, id) {
  if (!id) {
    posthog.reset();
    posthog.opt_out_capturing();
    return '';
  }
  if (idAtual && idAtual !== id) posthog.reset();
  if (posthog.has_opted_out_capturing()) posthog.opt_in_capturing();
  posthog.identify(id);
  return id;
}
