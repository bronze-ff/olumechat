// Paleta categórica pra identificar tags e departamentos (não é estado
// semântico — não usa os tokens success/warning/danger/info do DESIGN.md).
// Fonte única: era duplicada em components/TagsConversa.jsx e
// admin/Departamentos.jsx, extraída aqui no FIL-112.
//
// A paleta é usada como fundo de chip com texto branco por cima
// (TagsConversa, admin/Atendentes, Conversas): toda cor daqui precisa medir
// ≥ 4,5:1 de contraste com branco (WCAG AA). Foi por isso que #47A987
// (2,88:1) virou #0E8354 (4,78:1) no FIL-112 — confira o contraste antes de
// mexer numa cor.
export const CORES = ['#1F7A60', '#0E8354', '#B55343', '#9A6700', '#3E756C', '#65766F'];
