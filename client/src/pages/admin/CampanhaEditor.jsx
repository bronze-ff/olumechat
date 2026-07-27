import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../../services/api';
import Spinner from '../../components/ui/Spinner';
import Confirmar from '../../components/ui/Confirmar';
import { formatPhone } from '../../utils/formatters';

export default function CampanhaEditor({ campanhaId, onClose, onSaved }) {
  const [nome, setNome] = useState('');
  const [numeroId, setNumeroId] = useState('');
  const [templateNome, setTemplateNome] = useState('');
  const [lang, setLang] = useState('pt_BR');
  const [tipoSegmento, setTipoSegmento] = useState('csv');
  const [arquivo, setArquivo] = useState(null);
  const [filtros, setFiltros] = useState({ optin: 'S' });
  const [variaveis, setVariaveis] = useState([]); // coluna por {{n}}
  const [ratePorSeg, setRatePorSeg] = useState(10);
  const [janelaInicio, setJanelaInicio] = useState('08:00');
  const [janelaFim, setJanelaFim] = useState('20:00');
  const [carregando, setCarregando] = useState(!!campanhaId);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [preview, setPreview] = useState(null);
  const [prevLoading, setPrevLoading] = useState(false);
  const [prepInfo, setPrepInfo] = useState(null);
  const [confirmaDisparo, setConfirmaDisparo] = useState(0); // 0 nada · 1 custo · 2 final
  const [disparando, setDisparando] = useState(false);
  const [id, setId] = useState(campanhaId);

  const numeros = useQuery({ queryKey: ['numeros'], queryFn: () => api.get('/numeros').then((r) => r.data) });
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api.get('/templates').then((r) => r.data) });

  const tpl = (templates.data || []).find((t) => t.name === templateNome);

  useEffect(() => {
    if (!campanhaId) return;
    api.get(`/campanhas/${campanhaId}`).then(({ data }) => {
      setNome(data.nome); setNumeroId(data.numeroId || ''); setTemplateNome(data.templateNome || '');
      setLang(data.lang || 'pt_BR'); setRatePorSeg(data.ratePorSeg || 10);
      setJanelaInicio(data.janelaInicio || '08:00'); setJanelaFim(data.janelaFim || '20:00');
      const seg = data.segmento || {};
      setTipoSegmento(seg.tipo || 'csv'); setFiltros(seg.filtros || { optin: 'S' }); setVariaveis(seg.variaveis || []);
      setId(data.id); setCarregando(false);
    }).catch(() => setCarregando(false));
  }, [campanhaId]);

  // Ajusta o nº de mapeamentos ao varCount do template.
  useEffect(() => {
    if (!tpl) return;
    setVariaveis((v) => {
      const n = [...v]; n.length = tpl.varCount; return Array.from(n, (x) => x || '');
    });
  }, [templateNome, tpl?.varCount]);

  const corpo = () => ({
    nome: nome.trim(), numeroId: numeroId || null, templateNome, lang,
    ratePorSeg: Number(ratePorSeg), janelaInicio, janelaFim,
    segmento: { tipo: tipoSegmento, filtros, variaveis },
  });

  async function salvar() {
    setSalvando(true); setErro('');
    try {
      if (id) { await api.put(`/campanhas/${id}`, corpo()); }
      else { const { data } = await api.post('/campanhas', corpo()); setId(data.id); }
      return true;
    } catch (e) { setErro(e.response?.data?.error || 'Falha ao salvar.'); return false; }
    finally { setSalvando(false); }
  }

  async function previsualizar() {
    if (!(await salvar())) return;
    setPrevLoading(true); setPreview(null); setErro('');
    try {
      const { data } = await api.post(`/campanhas/${id || ''}/preview`);
      setPreview(data);
    } catch (e) { setErro(e.response?.data?.error || 'Erro no preview.'); }
    finally { setPrevLoading(false); }
  }

  async function importar() {
    if (!arquivo || !(await salvar())) return;
    const form = new FormData(); form.append('arquivo', arquivo);
    try { const { data } = await api.post(`/campanhas/${id}/import`, form); setPrepInfo({ inseridos: data.aceitas, invalidos: data.rejeitadas, duplicados: data.relatorio.filter((x) => x.motivo === 'duplicado').length, relatorio: data.relatorio }); }
    catch (e) { setErro(e.response?.data?.error || 'Falha ao importar CSV.'); }
  }

  async function preparar() {
    if (!(await salvar())) return;
    setPrepInfo(null); setErro('');
    try {
      const { data } = await api.post(`/campanhas/${id}/preparar`);
      setPrepInfo(data);
    } catch (e) { setErro(e.response?.data?.error || 'Falha ao preparar.'); }
  }

  function disparar() {
    if (!prepInfo?.total) { setErro('Clique em "Preparar destinatários" antes de disparar.'); return; }
    setConfirmaDisparo(1);
  }

  async function executarDisparo() {
    setDisparando(true);
    try {
      const { data } = await api.post(`/campanhas/${id}/disparar`);
      setConfirmaDisparo(0);
      if (data.avisos?.length) alert(data.avisos.join('\n'));
      onSaved();
    } catch (e) {
      setConfirmaDisparo(0);
      setErro(e.response?.data?.error || 'Falha ao disparar.');
    } finally { setDisparando(false); }
  }

  if (carregando) return <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"><Spinner /></div>;

  return (
    <div className="fixed inset-0 z-50 bg-paper-100 flex flex-col">
      <div className="bg-ink-950 text-white px-4 py-2.5 flex items-center gap-3 shrink-0">
        <span className="section-bar" />
        <h2 className="font-display font-bold text-[15px] shrink-0">{id ? 'Editar campanha' : 'Nova campanha'}</h2>
        <input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Nome da campanha (ex.: Cobrança vencidos jun/26)"
          className="flex-1 max-w-sm bg-white/10 border border-white/15 rounded-lg px-3 py-1.5 text-sm placeholder-white/35 outline-none focus:border-white/50" />
        <div className="flex-1" />
        <button onClick={() => salvar().then((ok) => ok && onSaved())} disabled={!nome.trim() || salvando}
          className="px-4 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-white text-sm font-semibold disabled:opacity-50">
          {salvando ? 'Salvando…' : 'Salvar rascunho'}
        </button>
        <button onClick={onClose} className="text-white/60 hover:text-white px-1 text-lg leading-none">✕</button>
      </div>

      {erro && <div className="shrink-0 bg-red-50 border-b border-red-200 px-4 py-2 text-xs text-red-700">{erro}</div>}

      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <div className="max-w-3xl mx-auto space-y-4">
          {/* Config */}
          <div className="bg-white rounded-2xl border border-black/[0.06] p-4 grid grid-cols-2 md:grid-cols-12 gap-3">
            <div className="md:col-span-3">
              <Rotulo>Número de origem</Rotulo>
              <select className="input-field !py-2 !text-sm" value={numeroId} onChange={(e) => setNumeroId(e.target.value)}>
                <option value="">Selecione…</option>
                {(numeros.data || []).filter((n) => n.permiteAtivo !== 'N' && n.ativo !== 'N')
                  .map((n) => <option key={n.id} value={n.id}>{n.nomeExibicao || formatPhone(n.displayPhone) || n.phoneNumberId}</option>)}
              </select>
              <p className="font-mono text-[9px] text-stone-400 mt-0.5">Só números com "permite ativa" (Admin → Números).</p>
            </div>
            <div className="md:col-span-3">
              <Rotulo>Template aprovado</Rotulo>
              <select className="input-field !py-2 !text-sm" value={templateNome} onChange={(e) => { setTemplateNome(e.target.value); setLang((templates.data || []).find((t) => t.name === e.target.value)?.language || 'pt_BR'); }}>
                <option value="">Selecione…</option>
                {(templates.data || []).map((t) => <option key={t.name} value={t.name}>{t.name} ({t.varCount} var)</option>)}
              </select>
            </div>
            <div className="md:col-span-2">
              <Rotulo>Envios/seg</Rotulo>
              <input type="number" min="1" max="50" className="input-field !py-2 !text-sm" value={ratePorSeg} onChange={(e) => setRatePorSeg(e.target.value)} />
            </div>
            <div className="col-span-2 md:col-span-4">
              <Rotulo>Janela (horário comercial)</Rotulo>
              <div className="flex items-center gap-1.5">
                <input type="time" className="input-field !py-2 !text-sm flex-1 min-w-0" value={janelaInicio} onChange={(e) => setJanelaInicio(e.target.value)} />
                <span className="text-stone-400 text-xs shrink-0">–</span>
                <input type="time" className="input-field !py-2 !text-sm flex-1 min-w-0" value={janelaFim} onChange={(e) => setJanelaFim(e.target.value)} />
              </div>
            </div>
          </div>

          {/* Segmento */}
          <div className="bg-white rounded-2xl border border-black/[0.06] p-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className="section-bar" />
              <h3 className="font-display font-bold text-sm text-stone-800 flex-1">Segmento — quem recebe</h3>
            </div>
            <div className="flex gap-2">
              <button type="button" className={`px-3 py-1.5 rounded-lg text-sm ${tipoSegmento === 'csv' ? 'bg-brand-100 text-brand-800' : 'bg-paper-50'}`} onClick={() => setTipoSegmento('csv')}>Importar CSV</button>
              <button type="button" className={`px-3 py-1.5 rounded-lg text-sm ${tipoSegmento === 'atributos' ? 'bg-brand-100 text-brand-800' : 'bg-paper-50'}`} onClick={() => setTipoSegmento('atributos')}>Filtros de contato</button>
            </div>
            {tipoSegmento === 'csv' ? <div>
              <Rotulo>CSV (telefone + colunas das variáveis)</Rotulo>
              <input type="file" accept=".csv,text/csv" className="input-field !py-2 text-sm" onChange={(e) => setArquivo(e.target.files?.[0] || null)} />
              <p className="font-mono text-[9px] text-stone-400 mt-0.5">A validação rejeita linhas inválidas e duplicadas individualmente, sem abortar o arquivo.</p>
            </div> : <div className="grid grid-cols-2 gap-3">
              <div><Rotulo>Opt-in</Rotulo><select className="input-field !py-2 !text-sm" value={filtros.optin || ''} onChange={(e) => setFiltros({ ...filtros, optin: e.target.value || undefined })}><option value="S">Com opt-in</option><option value="N">Sem opt-in</option><option value="">Qualquer</option></select></div>
              <div><Rotulo>Tag</Rotulo><input className="input-field !py-2 !text-sm" value={filtros.tag || ''} onChange={(e) => setFiltros({ ...filtros, tag: e.target.value })} placeholder="ex.: vip" /></div>
            </div>}
            {/* Mapeamento das variáveis do template */}
            {tpl && tpl.varCount > 0 && (
              <div>
                <Rotulo>Variáveis do template (qual coluna em cada {'{{n}}'})</Rotulo>
                <div className="space-y-1.5">
                  {Array.from({ length: tpl.varCount }).map((_, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="font-mono text-xs text-stone-500 w-10">{`{{${i + 1}}}`}</span>
                      <input className="input-field !py-1.5 !text-sm font-mono flex-1" value={variaveis[i] || ''}
                        onChange={(e) => setVariaveis((v) => { const n = [...v]; n[i] = e.target.value; return n; })}
                        placeholder="nome da coluna do CSV (ex.: nome)" />
                    </div>
                  ))}
                </div>
                {tpl.body && <p className="text-[11px] text-stone-500 mt-2 bg-paper-50 rounded p-2 whitespace-pre-wrap">{tpl.body}</p>}
              </div>
            )}
          </div>

          {/* Ações */}
          <div className="flex flex-wrap gap-2">
            <button onClick={previsualizar} disabled={prevLoading}
              className="px-4 py-2 rounded-xl border border-black/15 text-stone-700 text-sm font-semibold hover:bg-paper-50 disabled:opacity-50">
              {prevLoading ? 'Rodando…' : '🔍 Pré-visualizar'}
            </button>
            {tipoSegmento === 'csv' && <button onClick={importar}
              className="px-4 py-2 rounded-xl border border-brand-300 text-brand-700 text-sm font-semibold hover:bg-brand-50">📥 Importar e validar CSV</button>}
            <button onClick={preparar}
              className="px-4 py-2 rounded-xl border border-brand-300 text-brand-700 text-sm font-semibold hover:bg-brand-50">
              📋 Preparar destinatários
            </button>
            <div className="flex-1" />
            <button onClick={disparar} disabled={!prepInfo?.total}
              className="px-5 py-2 rounded-xl bg-bordeaux-700 hover:bg-bordeaux-800 text-white text-sm font-semibold disabled:opacity-40">
              📣 Disparar
            </button>
          </div>

          {prepInfo && prepInfo.inseridos > 0 && (
            <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
              ✓ {prepInfo.inseridos} destinatário(s) preparado(s)
              {prepInfo.invalidos ? ` · ${prepInfo.invalidos} telefone(s) inválido(s)` : ''}
              {prepInfo.duplicados ? ` · ${prepInfo.duplicados} duplicado(s)` : ''}. Pronto para disparar.
            </p>
          )}
          {prepInfo && prepInfo.inseridos === 0 && (
            <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 space-y-1">
              <p>⚠ Nenhum destinatário aproveitável: {prepInfo.invalidos || 0} telefone(s) inválido(s) e {prepInfo.duplicados || 0} duplicado(s).</p>
              {prepInfo.exemplosInvalidos?.length > 0 && (
                <p className="font-mono text-xs">
                  Exemplos rejeitados: {prepInfo.exemplosInvalidos.join(' · ')}
                </p>
              )}
              <p className="text-xs">Telefone válido precisa de DDD (10-11 dígitos) ou DDI completo.</p>
            </div>
          )}

          {/* Preview */}
          {preview && (
            <div className="bg-white rounded-2xl border border-black/[0.06] overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-2.5 border-b border-black/[0.05]">
                <span className="font-display font-bold text-sm text-stone-800">Amostra do segmento</span>
                <span className="font-mono text-xs text-stone-500">{preview.total} destinatário(s) · custo estimado ~R$ {preview.custoEstimado?.toFixed(2)}</span>
              </div>
              {preview.avisos?.map((a, i) => <p key={i} className="px-4 py-1.5 text-xs text-amber-700 bg-amber-50">⚠ {a}</p>)}
              <div className="overflow-x-auto max-h-72">
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-stone-400 border-b border-black/[0.05]">
                    {(preview.colunas || []).map((c) => <th key={c} className="px-3 py-2 font-mono">{c}</th>)}
                  </tr></thead>
                  <tbody>
                    {preview.amostra.map((row, i) => (
                      <tr key={i} className="border-b border-black/[0.03]">
                        {preview.colunas.map((c) => <td key={c} className="px-3 py-1.5 text-stone-700">{row[c]}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {confirmaDisparo === 1 && (
        <Confirmar
          titulo="Disparar campanha"
          mensagem={`Disparar para ${prepInfo?.total ?? 0} cliente(s)?\n\nCusto estimado: ~R$ ${((prepInfo?.total ?? 0) * 0.04).toFixed(2)}.\nEsta ação envia mensagens pagas pelo WhatsApp.`}
          dica="O envio respeita o limite diário do número, o horário comercial e os opt-outs."
          confirmarTexto="Continuar"
          onConfirmar={() => setConfirmaDisparo(2)}
          onCancelar={() => setConfirmaDisparo(0)}
        />
      )}
      {confirmaDisparo === 2 && (
        <Confirmar
          titulo="Confirmar o disparo"
          mensagem="As mensagens começam a sair AGORA para os clientes. Confirma o disparo?"
          confirmarTexto="📣 Disparar agora"
          perigo
          pendente={disparando}
          onConfirmar={executarDisparo}
          onCancelar={() => setConfirmaDisparo(0)}
        />
      )}
    </div>
  );
}

function Rotulo({ children }) {
  return <label className="block font-mono text-[10px] uppercase tracking-widest text-stone-400 mb-1">{children}</label>;
}
