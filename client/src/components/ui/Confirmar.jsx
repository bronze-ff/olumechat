// Modal de confirmação padrão MC — substitui o window.confirm nativo.
// z-[60] para flutuar acima dos editores em tela cheia (que usam z-50).
import Portal from './Portal';

export default function Confirmar({
  titulo,
  mensagem,
  dica,
  confirmarTexto = 'Confirmar',
  cancelarTexto = 'Cancelar',
  perigo = false,
  pendente = false,
  onConfirmar,
  onCancelar,
}) {
  return (
    <Portal>
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onCancelar} />
      <div className="relative w-full sm:max-w-sm bg-white rounded-t-2xl sm:rounded-2xl overflow-hidden animate-slide-up">
        <div className="navy-gradient text-white px-4 py-3 flex items-center gap-2">
          <span className="section-bar" />
          <h2 className="font-display font-bold text-base flex-1">{titulo}</h2>
          <button onClick={onCancelar} className="text-white/70 hover:text-white" aria-label="Fechar">✕</button>
        </div>
        <div className="modal-body space-y-2">
          <p className="text-sm text-stone-700 whitespace-pre-wrap">{mensagem}</p>
          {dica && <p className="text-[11px] text-stone-400">{dica}</p>}
        </div>
        <div className="modal-footer">
          <button onClick={onCancelar}
            className="flex-1 py-2.5 rounded-xl border border-black/20 text-stone-700 font-semibold text-sm">
            {cancelarTexto}
          </button>
          <button onClick={onConfirmar} disabled={pendente}
            className={`flex-1 py-2.5 rounded-xl text-white font-semibold text-sm disabled:opacity-40
              ${perigo ? 'bg-red-700 hover:bg-red-800' : 'bg-brand-700 hover:bg-brand-800'}`}>
            {pendente ? 'Aguarde…' : confirmarTexto}
          </button>
        </div>
      </div>
    </div>
    </Portal>
  );
}
