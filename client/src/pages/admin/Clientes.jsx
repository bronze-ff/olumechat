import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../services/api';
import Icon from '../../components/ui/Icon';
import Spinner from '../../components/ui/Spinner';
import { formatPhone } from '../../utils/formatters';
import { useAuth } from '../../context/AuthContext';

const VAZIO = {
  telefone: '',
  nomeInterno: '',
  nomeCompleto: '',
  razaoSocial: '',
  nomeFantasia: '',
  documento: '',
  email: '',
  telefoneAlternativo: '',
  vinculosAtendimento: [],
  endereco: {
    cep: '',
    logradouro: '',
    numero: '',
    complemento: '',
    bairro: '',
    cidade: '',
    uf: '',
  },
  observacoes: '',
};

function valorFormulario(cliente) {
  if (!cliente) return structuredClone(VAZIO);
  return {
    telefone: cliente.telefone || '',
    nomeInterno: cliente.nomeInterno || '',
    nomeCompleto: cliente.nomeCompleto || '',
    razaoSocial: cliente.razaoSocial || '',
    nomeFantasia: cliente.nomeFantasia || '',
    documento: cliente.documento || '',
    email: cliente.email || '',
    telefoneAlternativo: cliente.telefoneAlternativo || '',
    vinculosAtendimento: Array.isArray(cliente.vinculosAtendimento)
      ? cliente.vinculosAtendimento.map((item) => ({
          departamentoId: item.departamentoId || '',
          atendenteId: item.atendenteId || '',
        }))
      : [],
    endereco: {
      cep: cliente.endereco?.cep || '',
      logradouro: cliente.endereco?.logradouro || '',
      numero: cliente.endereco?.numero || '',
      complemento: cliente.endereco?.complemento || '',
      bairro: cliente.endereco?.bairro || '',
      cidade: cliente.endereco?.cidade || '',
      uf: cliente.endereco?.uf || '',
    },
    observacoes: cliente.observacoes || '',
  };
}

function nomeCliente(cliente) {
  return cliente.nomeInterno
    || cliente.nomeCompleto
    || cliente.nomeFantasia
    || cliente.razaoSocial
    || cliente.nomePerfil
    || formatPhone(cliente.telefone);
}

function Campo({ label, className = '', children, ajuda }) {
  return (
    <label className={className}>
      <span className="field-label">{label}</span>
      {children}
      {ajuda && <span className="mt-1 block text-[11px] leading-4 text-stone-500">{ajuda}</span>}
    </label>
  );
}

function EditorCliente({ cliente, atendentes, departamentos, podeEditar, onCriado }) {
  const novo = !cliente;
  const [form, setForm] = useState(() => valorFormulario(cliente));
  const [erro, setErro] = useState('');
  const qc = useQueryClient();

  useEffect(() => {
    setForm(valorFormulario(cliente));
    setErro('');
  }, [cliente?.id]);

  function campo(nome, valor) {
    setForm((anterior) => ({ ...anterior, [nome]: valor }));
  }

  function endereco(nome, valor) {
    setForm((anterior) => ({
      ...anterior,
      endereco: { ...anterior.endereco, [nome]: valor },
    }));
  }

  function adicionarVinculo() {
    const usados = new Set(form.vinculosAtendimento.map((item) => Number(item.departamentoId)));
    const primeiroLivre = (departamentos || []).find(
      (item) => item.ativo === 'S' && !usados.has(Number(item.id))
    );
    setForm((anterior) => ({
      ...anterior,
      vinculosAtendimento: [
        ...anterior.vinculosAtendimento,
        { departamentoId: primeiroLivre?.id || '', atendenteId: '' },
      ],
    }));
  }

  function alterarVinculo(indice, campo, valor) {
    setForm((anterior) => ({
      ...anterior,
      vinculosAtendimento: anterior.vinculosAtendimento.map((item, posicao) => {
        if (posicao !== indice) return item;
        if (campo === 'departamentoId') return { departamentoId: valor, atendenteId: '' };
        return { ...item, [campo]: valor };
      }),
    }));
  }

  function removerVinculo(indice) {
    setForm((anterior) => ({
      ...anterior,
      vinculosAtendimento: anterior.vinculosAtendimento.filter((_, posicao) => posicao !== indice),
    }));
  }

  const salvar = useMutation({
    mutationFn: () => novo
      ? api.post('/contatos', form)
      : api.put(`/contatos/${cliente.id}`, form),
    onSuccess: async (response) => {
      setErro('');
      await qc.invalidateQueries({ queryKey: ['clientes-gestao'] });
      if (novo) onCriado(response.data.id);
    },
    onError: (error) => setErro(error.response?.data?.error || 'Não foi possível salvar o cliente.'),
  });

  return (
    <form
      className="min-w-0"
      onSubmit={(event) => {
        event.preventDefault();
        setErro('');
        salvar.mutate();
      }}
    >
      <div className="panel-header justify-between">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-ink-950">
            {novo ? 'Novo cliente' : nomeCliente(cliente)}
          </h2>
          <p className="mt-0.5 text-[11px] text-stone-500">
            {novo ? 'Crie a ficha antes do primeiro contato.' : `${formatPhone(cliente.telefone)} · ${cliente.conversas || 0} atendimento(s)`}
          </p>
        </div>
        {!novo && cliente.atualizadoEm && (
          <span className="hidden text-[10px] text-stone-500 xl:block">
            Atualizado em {new Date(cliente.atualizadoEm).toLocaleDateString('pt-BR')}
          </span>
        )}
      </div>

      <div className="max-h-[calc(100vh-250px)] space-y-6 overflow-y-auto px-5 py-5">
        <section>
          <div className="mb-3 flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-50 text-brand-800">
              <Icon name="contact" size={15} />
            </span>
            <div>
              <h3 className="text-xs font-semibold text-ink-950">Identificação</h3>
              <p className="text-[11px] text-stone-500">Dados usados pela equipe para reconhecer esta pessoa ou empresa.</p>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <Campo label="Nome de exibição">
              <input className="input-field" disabled={!podeEditar} value={form.nomeInterno} onChange={(e) => campo('nomeInterno', e.target.value)} placeholder="Como aparece no atendimento" />
            </Campo>
            <Campo label="Nome completo">
              <input className="input-field" disabled={!podeEditar} value={form.nomeCompleto} onChange={(e) => campo('nomeCompleto', e.target.value)} placeholder="Nome da pessoa" />
            </Campo>
            <Campo label="Razão social">
              <input className="input-field" disabled={!podeEditar} value={form.razaoSocial} onChange={(e) => campo('razaoSocial', e.target.value)} placeholder="Empresa LTDA" />
            </Campo>
            <Campo label="Nome fantasia">
              <input className="input-field" disabled={!podeEditar} value={form.nomeFantasia} onChange={(e) => campo('nomeFantasia', e.target.value)} placeholder="Nome comercial" />
            </Campo>
            <Campo label="CPF ou CNPJ">
              <input className="input-field" disabled={!podeEditar} value={form.documento} onChange={(e) => campo('documento', e.target.value)} inputMode="numeric" placeholder="Somente números" />
            </Campo>
            <Campo label="E-mail">
              <input className="input-field" disabled={!podeEditar} type="email" value={form.email} onChange={(e) => campo('email', e.target.value)} placeholder="cliente@empresa.com.br" />
            </Campo>
          </div>
        </section>

        <section className="border-t border-paper-300 pt-5">
          <div className="mb-3 flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-50 text-brand-800">
              <Icon name="phone" size={15} />
            </span>
            <div>
              <h3 className="text-xs font-semibold text-ink-950">Contato</h3>
              <p className="text-[11px] text-stone-500">Telefones usados para identificar e iniciar conversas.</p>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <Campo label="WhatsApp principal">
              <input className="input-field font-mono" required disabled={!podeEditar} value={form.telefone} onChange={(e) => campo('telefone', e.target.value)} inputMode="tel" placeholder="55 62 99999-9999" />
            </Campo>
            <Campo label="Telefone alternativo">
              <input className="input-field font-mono" disabled={!podeEditar} value={form.telefoneAlternativo} onChange={(e) => campo('telefoneAlternativo', e.target.value)} inputMode="tel" placeholder="Opcional" />
            </Campo>
          </div>
        </section>

        <section className="border-t border-paper-300 pt-5">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-50 text-brand-800">
                <Icon name="users" size={15} />
              </span>
              <div>
                <h3 className="text-xs font-semibold text-ink-950">Responsáveis por departamento</h3>
                <p className="max-w-xl text-[11px] leading-4 text-stone-500">
                  O vínculo vale somente no setor escolhido. Nos demais, a fila distribui para quem estiver online e com menos atendimentos.
                </p>
              </div>
            </div>
            {podeEditar && (
              <button
                type="button"
                onClick={adicionarVinculo}
                disabled={form.vinculosAtendimento.length >= (departamentos || []).filter((item) => item.ativo === 'S').length}
                className="flex min-h-8 items-center gap-1.5 rounded-md border border-paper-400 bg-white px-3 text-[11px] font-semibold text-ink-900 hover:border-brand-500 hover:text-brand-800 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Icon name="plus" size={13} />
                Adicionar vínculo
              </button>
            )}
          </div>

          {form.vinculosAtendimento.length ? (
            <div className="space-y-2">
              {form.vinculosAtendimento.map((vinculo, indice) => {
                const departamentoId = Number(vinculo.departamentoId);
                const usados = new Set(
                  form.vinculosAtendimento
                    .filter((_, posicao) => posicao !== indice)
                    .map((item) => Number(item.departamentoId))
                );
                const elegiveis = (atendentes || []).filter(
                  (item) => item.ativo === 'S'
                    && (item.deptoIds || []).map(Number).includes(departamentoId)
                );
                return (
                  <div
                    key={`${vinculo.departamentoId || 'novo'}-${indice}`}
                    className="grid gap-2 rounded-md border border-paper-300 bg-paper-50 p-3 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)_auto]"
                  >
                    <Campo label="Departamento">
                      <select
                        className="input-field bg-white"
                        disabled={!podeEditar}
                        required
                        value={vinculo.departamentoId}
                        onChange={(event) => alterarVinculo(indice, 'departamentoId', event.target.value)}
                      >
                        <option value="">Selecione o setor</option>
                        {(departamentos || []).filter((item) => item.ativo === 'S').map((item) => (
                          <option key={item.id} value={item.id} disabled={usados.has(Number(item.id))}>
                            {item.nome}
                          </option>
                        ))}
                      </select>
                    </Campo>
                    <Campo
                      label="Atendente responsável"
                      ajuda={departamentoId && !elegiveis.length ? 'Este departamento ainda não possui atendentes ativos.' : undefined}
                    >
                      <select
                        className="input-field bg-white"
                        disabled={!podeEditar || !departamentoId}
                        required
                        value={vinculo.atendenteId}
                        onChange={(event) => alterarVinculo(indice, 'atendenteId', event.target.value)}
                      >
                        <option value="">Selecione quem recebe primeiro</option>
                        {elegiveis.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.nome || item.email || `Atendente #${item.id}`}
                          </option>
                        ))}
                      </select>
                    </Campo>
                    {podeEditar && (
                      <button
                        type="button"
                        onClick={() => removerVinculo(indice)}
                        className="min-h-10 self-end rounded-md border border-paper-400 bg-white px-3 text-[11px] font-semibold text-stone-600 hover:border-red-300 hover:text-red-700"
                        aria-label={`Remover vínculo ${indice + 1}`}
                      >
                        Remover
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-paper-400 bg-paper-50 px-4 py-4">
              <p className="text-xs font-medium text-ink-900">Distribuição automática em todos os departamentos</p>
              <p className="mt-1 text-[11px] leading-4 text-stone-500">
                Sem vínculo, cada setor encaminha o cliente para o atendente online com menor carga. Se ninguém estiver online, a conversa aguarda na fila.
              </p>
            </div>
          )}
        </section>

        <section className="border-t border-paper-300 pt-5">
          <div className="mb-3 flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-50 text-brand-800">
              <Icon name="building" size={15} />
            </span>
            <div>
              <h3 className="text-xs font-semibold text-ink-950">Endereço</h3>
              <p className="text-[11px] text-stone-500">Informação operacional para cadastro, entrega ou cobrança.</p>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-6">
            <Campo label="CEP" className="md:col-span-2">
              <input className="input-field font-mono" disabled={!podeEditar} value={form.endereco.cep} onChange={(e) => endereco('cep', e.target.value)} placeholder="00000-000" />
            </Campo>
            <Campo label="Logradouro" className="md:col-span-4">
              <input className="input-field" disabled={!podeEditar} value={form.endereco.logradouro} onChange={(e) => endereco('logradouro', e.target.value)} placeholder="Rua, avenida..." />
            </Campo>
            <Campo label="Número" className="md:col-span-2">
              <input className="input-field" disabled={!podeEditar} value={form.endereco.numero} onChange={(e) => endereco('numero', e.target.value)} />
            </Campo>
            <Campo label="Complemento" className="md:col-span-4">
              <input className="input-field" disabled={!podeEditar} value={form.endereco.complemento} onChange={(e) => endereco('complemento', e.target.value)} />
            </Campo>
            <Campo label="Bairro" className="md:col-span-2">
              <input className="input-field" disabled={!podeEditar} value={form.endereco.bairro} onChange={(e) => endereco('bairro', e.target.value)} />
            </Campo>
            <Campo label="Cidade" className="md:col-span-3">
              <input className="input-field" disabled={!podeEditar} value={form.endereco.cidade} onChange={(e) => endereco('cidade', e.target.value)} />
            </Campo>
            <Campo label="UF" className="md:col-span-1">
              <input className="input-field uppercase" maxLength={2} disabled={!podeEditar} value={form.endereco.uf} onChange={(e) => endereco('uf', e.target.value)} placeholder="GO" />
            </Campo>
          </div>
        </section>

        <section className="border-t border-paper-300 pt-5">
          <Campo label="Observações internas">
            <textarea className="input-field min-h-24 resize-y" disabled={!podeEditar} value={form.observacoes} onChange={(e) => campo('observacoes', e.target.value)} placeholder="Preferências, contexto comercial ou instruções para a equipe." />
          </Campo>
        </section>

        {erro && (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {erro}
          </p>
        )}
      </div>

      <div className="flex min-h-[68px] items-center justify-between gap-3 border-t border-paper-300 bg-white px-5 py-3">
        <p className="text-[11px] text-stone-500">
          {podeEditar ? 'As alterações passam a valer no próximo roteamento.' : 'Acesso de consulta.'}
        </p>
        {podeEditar && (
          <button type="submit" disabled={salvar.isPending} className="min-h-10 rounded-md bg-brand-700 px-5 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-50">
            {salvar.isPending ? 'Salvando…' : (novo ? 'Criar cliente' : 'Salvar alterações')}
          </button>
        )}
      </div>
    </form>
  );
}

export default function Clientes() {
  const { isGestor } = useAuth();
  const podeEditar = isGestor;
  const [busca, setBusca] = useState('');
  const [selecionado, setSelecionado] = useState(null);
  const [novo, setNovo] = useState(false);

  const clientes = useQuery({
    queryKey: ['clientes-gestao', busca],
    queryFn: () => api.get('/contatos', { params: { q: busca, limite: 50 } }).then((r) => r.data),
  });
  const atendentes = useQuery({
    queryKey: ['atendentes'],
    queryFn: () => api.get('/atendentes').then((r) => r.data),
  });
  const departamentos = useQuery({
    queryKey: ['departamentos'],
    queryFn: () => api.get('/departamentos').then((r) => r.data),
  });
  const itens = clientes.data?.itens || [];

  useEffect(() => {
    if (!novo && selecionado && !itens.some((item) => item.id === selecionado)) {
      setSelecionado(itens[0]?.id || null);
    } else if (!novo && !selecionado && itens.length) {
      setSelecionado(itens[0].id);
    }
  }, [itens, novo, selecionado]);

  const clienteAtual = useMemo(
    () => itens.find((item) => item.id === selecionado) || null,
    [itens, selecionado]
  );

  function abrirCliente(id) {
    setNovo(false);
    setSelecionado(id);
  }

  return (
    <div className="grid min-h-[650px] gap-4 xl:grid-cols-[minmax(360px,0.8fr)_minmax(560px,1.2fr)]">
      <section className="app-panel min-w-0 overflow-hidden">
        <div className="panel-header">
          <div className="relative min-w-0 flex-1">
            <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
            <input
              className="input-field !min-h-9 !py-1.5 !pl-9"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar nome, telefone, CPF/CNPJ ou e-mail"
              aria-label="Buscar clientes"
            />
          </div>
          {podeEditar && (
            <button
              type="button"
              onClick={() => { setNovo(true); setSelecionado(null); }}
              className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-md bg-brand-700 px-3 text-xs font-semibold text-white hover:bg-brand-800"
            >
              <Icon name="plus" size={14} />
              Novo
            </button>
          )}
        </div>

        <div className="flex min-h-10 items-center justify-between border-b border-paper-300 px-4 text-[11px] text-stone-500">
          <span>{clientes.data?.total || 0} cliente(s)</span>
          <span>Última atividade</span>
        </div>

        <div className="max-h-[calc(100vh-270px)] overflow-y-auto">
          {clientes.isLoading && <div className="flex justify-center py-12"><Spinner /></div>}
          {clientes.isError && (
            <p className="m-4 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">
              {clientes.error.response?.data?.error || 'Não foi possível carregar os clientes.'}
            </p>
          )}
          {itens.map((cliente) => (
            <button
              key={cliente.id}
              type="button"
              onClick={() => abrirCliente(cliente.id)}
              aria-current={!novo && selecionado === cliente.id ? 'true' : undefined}
              className={`grid w-full grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 border-b border-paper-300 px-4 py-3 text-left transition-colors ${
                !novo && selecionado === cliente.id ? 'bg-brand-50' : 'hover:bg-paper-50'
              }`}
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-ink-950 text-xs font-semibold text-white">
                {nomeCliente(cliente).slice(0, 2).toUpperCase()}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-ink-950">{nomeCliente(cliente)}</span>
                <span className="mt-0.5 block truncate text-[11px] text-stone-500">
                  {formatPhone(cliente.telefone)}
                  {cliente.vinculosAtendimento?.length
                    ? ` · ${cliente.vinculosAtendimento.length} vínculo(s)`
                    : ''}
                </span>
              </span>
              <span className="text-right">
                <span className="block text-[10px] text-stone-500">
                  {cliente.ultimaInteracao
                    ? new Date(cliente.ultimaInteracao).toLocaleDateString('pt-BR')
                    : 'Sem conversa'}
                </span>
                <span className="mt-1 block text-[10px] text-stone-400">{cliente.conversas || 0} atendimento(s)</span>
              </span>
            </button>
          ))}
          {!clientes.isLoading && !itens.length && (
            <div className="px-6 py-14 text-center">
              <Icon name="contact" size={28} className="mx-auto text-stone-300" />
              <p className="mt-3 text-sm font-semibold text-ink-950">Nenhum cliente encontrado</p>
              <p className="mt-1 text-xs leading-5 text-stone-500">
                Contatos receptivos e ativos aparecem aqui automaticamente.
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="app-panel min-w-0 overflow-hidden">
        {novo ? (
          <EditorCliente
            cliente={null}
            atendentes={atendentes.data}
            departamentos={departamentos.data}
            podeEditar={podeEditar}
            onCriado={(id) => { setNovo(false); setSelecionado(id); }}
          />
        ) : clienteAtual ? (
          <EditorCliente
            key={clienteAtual.id}
            cliente={clienteAtual}
            atendentes={atendentes.data}
            departamentos={departamentos.data}
            podeEditar={podeEditar}
            onCriado={() => {}}
          />
        ) : (
          <div className="flex min-h-[540px] items-center justify-center px-8 text-center">
            <div>
              <Icon name="contact" size={30} className="mx-auto text-stone-300" />
              <p className="mt-3 text-sm font-semibold text-ink-950">Selecione um cliente</p>
              <p className="mt-1 max-w-sm text-xs leading-5 text-stone-500">
                Abra uma ficha para completar os dados e definir responsáveis por departamento.
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
