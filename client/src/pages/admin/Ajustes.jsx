import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../services/api';
import Spinner from '../../components/ui/Spinner';
import { useAuth } from '../../context/AuthContext';

const CAMPOS = [
  {
    chave: 'despedida_padrao',
    titulo: 'Mensagem de despedida padrão',
    desc: 'Vem pré-preenchida no modal de encerrar atendimento — o atendente pode editar ou apagar antes de enviar. Use {{protocolo}} para incluir o protocolo.',
    tipo: 'textarea',
    placeholder: 'Ex.: Atendimento encerrado. Guarde seu protocolo: {{protocolo}}.',
  },
  {
    chave: 'comando_encerrar',
    titulo: 'Comando de encerramento pelo cliente',
    desc: 'Quando o CLIENTE digitar exatamente essa palavra/frase no WhatsApp, o atendimento é encerrado na hora (funciona no bot, na fila e no atendimento humano). Acentos e maiúsculas são ignorados. Deixe vazio para desativar.',
    tipo: 'input',
    placeholder: 'Ex.: ENCERRAR',
  },
  {
    chave: 'msg_encerrar_cliente',
    titulo: 'Confirmação enviada ao cliente que encerrou',
    desc: 'Mensagem enviada quando o cliente usa o comando acima. Use {{protocolo}}. Deixe vazio para encerrar em silêncio.',
    tipo: 'textarea',
    placeholder: 'Ex.: Atendimento encerrado a seu pedido. Protocolo: {{protocolo}}. Até a próxima!',
  },
];

const DIAS = [
  ['dom', 'Domingo'], ['seg', 'Segunda'], ['ter', 'Terça'], ['qua', 'Quarta'],
  ['qui', 'Quinta'], ['sex', 'Sexta'], ['sab', 'Sábado'],
];

function parseHorario(json) {
  let h = {};
  try { h = JSON.parse(json || '{}'); } catch { h = {}; }
  const out = {};
  for (const [k] of DIAS) {
    const d = h[k];
    out[k] = (d && d.inicio && d.fim)
      ? { on: true, inicio: d.inicio, fim: d.fim }
      : { on: false, inicio: (d && d.inicio) || '08:00', fim: (d && d.fim) || '18:00' };
  }
  return out;
}
function serializeHorario(state) {
  const out = {};
  for (const [k] of DIAS) out[k] = state[k].on ? { inicio: state[k].inicio, fim: state[k].fim } : null;
  return JSON.stringify(out);
}

export default function Ajustes() {
  const { isAdmin } = useAuth();
  const [valores, setValores] = useState({});
  const [fhAtivo, setFhAtivo] = useState(false);
  const [horario, setHorario] = useState(() => parseHorario('{}'));
  const [fhMsg, setFhMsg] = useState('');
  const [salvo, setSalvo] = useState(false);
  const [erro, setErro] = useState('');
  const qc = useQueryClient();

  const config = useQuery({
    queryKey: ['config'],
    queryFn: () => api.get('/config').then((r) => r.data),
  });

  useEffect(() => {
    if (config.data) {
      const v = {};
      for (const c of CAMPOS) v[c.chave] = config.data[c.chave] || '';
      setValores(v);
      setFhAtivo(config.data.fora_horario_ativo === 'S');
      setHorario(parseHorario(config.data.horario_atendimento));
      setFhMsg(config.data.fora_horario_msg || '');
    }
  }, [config.data]);

  const salvar = useMutation({
    mutationFn: () => api.put('/config', {
      ...valores,
      fora_horario_ativo: fhAtivo ? 'S' : 'N',
      horario_atendimento: serializeHorario(horario),
      fora_horario_msg: fhMsg,
    }),
    onSuccess: () => {
      setErro(''); setSalvo(true);
      qc.invalidateQueries({ queryKey: ['config'] });
      setTimeout(() => setSalvo(false), 2500);
    },
    onError: (e) => setErro(e.response?.data?.error || 'Falha ao salvar.'),
  });

  const setDia = (k, campo, valor) => setHorario((h) => ({ ...h, [k]: { ...h[k], [campo]: valor } }));

  if (config.isLoading) return <div className="p-10 flex justify-center"><Spinner /></div>;

  return (
    <div className="max-w-screen-md mx-auto space-y-4">
      {/* Horário de funcionamento */}
      <section className="bg-white rounded-2xl border border-black/[0.06]">
        <header className="flex items-center gap-2 px-4 pt-3.5 pb-2.5 border-b border-black/[0.05]">
          <span className="section-bar" />
          <h2 className="font-display font-bold text-sm text-stone-800 flex-1">Horário de funcionamento</h2>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={fhAtivo} disabled={!isAdmin}
              onChange={(e) => setFhAtivo(e.target.checked)} className="w-4 h-4 accent-brand-700" />
            <span className="text-xs font-medium text-stone-600">Avisar fora de horário</span>
          </label>
        </header>
        <div className="p-4 space-y-3">
          <p className="text-xs text-stone-500">
            Quando o cliente mandar mensagem fora do horário/dia marcado, o sistema responde <b>uma vez por conversa</b> com o aviso abaixo. Desmarque um dia para não atender nele (ex.: domingo).
          </p>
          <div className="space-y-1.5">
            {DIAS.map(([k, rotulo]) => (
              <div key={k} className="flex items-center gap-3">
                <label className="flex items-center gap-2 w-28 cursor-pointer">
                  <input type="checkbox" checked={horario[k].on} disabled={!isAdmin}
                    onChange={(e) => setDia(k, 'on', e.target.checked)} className="w-4 h-4 accent-brand-700" />
                  <span className="text-sm text-stone-700">{rotulo}</span>
                </label>
                {horario[k].on ? (
                  <div className="flex items-center gap-1.5 text-sm">
                    <input type="time" value={horario[k].inicio} disabled={!isAdmin}
                      onChange={(e) => setDia(k, 'inicio', e.target.value)}
                      className="input-field !py-1 !w-28" />
                    <span className="text-stone-400">às</span>
                    <input type="time" value={horario[k].fim} disabled={!isAdmin}
                      onChange={(e) => setDia(k, 'fim', e.target.value)}
                      className="input-field !py-1 !w-28" />
                  </div>
                ) : (
                  <span className="text-xs text-stone-400">não atende</span>
                )}
              </div>
            ))}
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Mensagem de fora de horário</label>
            <textarea rows={3} value={fhMsg} disabled={!isAdmin}
              onChange={(e) => setFhMsg(e.target.value)}
              className="input-field resize-y disabled:opacity-60"
              placeholder="Ex.: Olá! Estamos fora do horário de atendimento. Nosso horário é seg a sex 08h–18h, sáb 08h–12h. Sua mensagem já está registrada." />
          </div>
        </div>
      </section>

      {CAMPOS.map((c) => (
        <section key={c.chave} className="bg-white rounded-2xl border border-black/[0.06]">
          <header className="flex items-center gap-2 px-4 pt-3.5 pb-2.5 border-b border-black/[0.05]">
            <span className="section-bar" />
            <h2 className="font-display font-bold text-sm text-stone-800 flex-1">{c.titulo}</h2>
          </header>
          <div className="p-4 space-y-2.5">
            <p className="text-xs text-stone-500">{c.desc}</p>
            {c.tipo === 'textarea' ? (
              <textarea rows={3} value={valores[c.chave] || ''} disabled={!isAdmin}
                onChange={(e) => setValores((v) => ({ ...v, [c.chave]: e.target.value }))}
                className="input-field resize-y disabled:opacity-60" placeholder={c.placeholder} />
            ) : (
              <input value={valores[c.chave] || ''} disabled={!isAdmin}
                onChange={(e) => setValores((v) => ({ ...v, [c.chave]: e.target.value }))}
                className="input-field font-mono disabled:opacity-60" placeholder={c.placeholder} />
            )}
          </div>
        </section>
      ))}

      {erro && <p className="text-xs text-red-600">{erro}</p>}
      {isAdmin ? (
        <div className="flex items-center gap-3">
          <button onClick={() => salvar.mutate()} disabled={salvar.isPending}
            className="px-6 py-2.5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold disabled:opacity-40">
            {salvar.isPending ? 'Salvando…' : 'Salvar ajustes'}
          </button>
          {salvo && <span className="text-xs text-emerald-600 font-medium">✓ Salvo — vale na hora</span>}
        </div>
      ) : (
        <p className="font-mono text-[10px] text-stone-400">somente ADMIN edita</p>
      )}
    </div>
  );
}
