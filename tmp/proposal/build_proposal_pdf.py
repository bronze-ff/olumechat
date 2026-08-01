from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    Image,
    KeepTogether,
    ListFlowable,
    ListItem,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "output" / "pdf" / "Proposta_Comercial_Olume_Chat_Pro_Distribuidora.pdf"
LOGO = ROOT / "docs" / "brand" / "assets" / "olume-chat-logo.png"

INK = colors.HexColor("#071A15")
INK_MUTED = colors.HexColor("#4D625C")
PRIMARY = colors.HexColor("#1F7A60")
PRIMARY_DARK = colors.HexColor("#17664F")
PRIMARY_SOFT = colors.HexColor("#EAFBF5")
SIGNAL = colors.HexColor("#5BD6AE")
CANVAS = colors.HexColor("#F3F8F6")
SURFACE_SUBTLE = colors.HexColor("#E9EFEA")
BORDER = colors.HexColor("#D3E0DB")
BORDER_STRONG = colors.HexColor("#BFD0CA")
WARNING = colors.HexColor("#B76A11")
WARNING_SOFT = colors.HexColor("#FFF7E8")
WHITE = colors.white


def register_fonts():
    fonts_dir = Path(r"C:\Windows\Fonts")
    files = {
        "Olume": "segoeui.ttf",
        "Olume-Bold": "segoeuib.ttf",
        "Olume-Semibold": "seguisb.ttf",
        "Olume-Italic": "segoeuii.ttf",
    }
    if all((fonts_dir / filename).exists() for filename in files.values()):
        for name, filename in files.items():
            pdfmetrics.registerFont(TTFont(name, str(fonts_dir / filename)))
        pdfmetrics.registerFontFamily(
            "Olume",
            normal="Olume",
            bold="Olume-Bold",
            italic="Olume-Italic",
            boldItalic="Olume-Bold",
        )
        return {
            "regular": "Olume",
            "bold": "Olume-Bold",
            "semibold": "Olume-Semibold",
            "italic": "Olume-Italic",
        }
    return {
        "regular": "Helvetica",
        "bold": "Helvetica-Bold",
        "semibold": "Helvetica-Bold",
        "italic": "Helvetica-Oblique",
    }


FONTS = register_fonts()


def style(name, **kwargs):
    base = {
        "fontName": FONTS["regular"],
        "fontSize": 9.5,
        "leading": 13,
        "textColor": INK,
        "spaceAfter": 7,
    }
    base.update(kwargs)
    return ParagraphStyle(name, **base)


STYLES = {
    "body": style("Body", fontSize=9.5, leading=13, spaceAfter=7),
    "body_muted": style("BodyMuted", fontSize=9.5, leading=13, textColor=INK_MUTED, spaceAfter=7),
    "small": style("Small", fontSize=8.2, leading=10.5, textColor=INK_MUTED, spaceAfter=4),
    "kicker": style(
        "Kicker", fontName=FONTS["bold"], fontSize=8.6, leading=10,
        textColor=PRIMARY, alignment=TA_CENTER, spaceAfter=6,
    ),
    "title": style(
        "Title", fontName=FONTS["bold"], fontSize=24, leading=28,
        textColor=INK, alignment=TA_CENTER, spaceAfter=7,
    ),
    "subtitle": style(
        "Subtitle", fontSize=11.2, leading=14, textColor=INK_MUTED,
        alignment=TA_CENTER, spaceAfter=16,
    ),
    "h1": style(
        "H1", fontName=FONTS["bold"], fontSize=14.2, leading=17,
        textColor=PRIMARY, spaceBefore=5, spaceAfter=7, keepWithNext=True,
    ),
    "h2": style(
        "H2", fontName=FONTS["semibold"], fontSize=11.4, leading=14,
        textColor=PRIMARY_DARK, spaceBefore=7, spaceAfter=5, keepWithNext=True,
    ),
    "center_lead": style(
        "CenterLead", fontName=FONTS["semibold"], fontSize=13.2, leading=16,
        textColor=INK, alignment=TA_CENTER, spaceBefore=10, spaceAfter=5,
    ),
    "center_body": style(
        "CenterBody", fontSize=9.6, leading=13.2, textColor=INK_MUTED,
        alignment=TA_CENTER, spaceAfter=13,
    ),
    "table": style("Table", fontSize=8.4, leading=10.5, spaceAfter=0),
    "table_bold": style(
        "TableBold", fontName=FONTS["semibold"], fontSize=8.4,
        leading=10.5, spaceAfter=0,
    ),
    "table_header": style(
        "TableHeader", fontName=FONTS["bold"], fontSize=7.8,
        leading=9.2, textColor=PRIMARY_DARK, spaceAfter=0,
    ),
    "metric_label": style(
        "MetricLabel", fontName=FONTS["bold"], fontSize=7.2, leading=8.5,
        textColor=PRIMARY, alignment=TA_CENTER, spaceAfter=3,
    ),
    "metric_value": style(
        "MetricValue", fontName=FONTS["bold"], fontSize=13.2, leading=15,
        textColor=INK, alignment=TA_CENTER, spaceAfter=0,
    ),
    "metric_value_small": style(
        "MetricValueSmall", fontName=FONTS["bold"], fontSize=10.4, leading=13,
        textColor=INK, alignment=TA_CENTER, spaceAfter=0,
    ),
    "signature": style("Signature", fontSize=8.2, leading=10.2, textColor=INK_MUTED, spaceAfter=0),
}


def p(text, style_name="body"):
    return Paragraph(text, STYLES[style_name])


def bullets(items, numbered=False):
    flow = []
    for item in items:
        flow.append(
            ListItem(
                Paragraph(item, STYLES["body"]),
                leftIndent=0,
                rightIndent=0,
                spaceAfter=2.5,
            )
        )
    return ListFlowable(
        flow,
        bulletType="1" if numbered else "bullet",
        start="1" if numbered else "•",
        leftIndent=16,
        bulletFontName=FONTS["semibold"],
        bulletFontSize=8.2,
        bulletColor=PRIMARY,
        bulletOffsetY=1.5,
        spaceAfter=7,
    )


def callout(content, background=PRIMARY_SOFT, border=BORDER_STRONG):
    return Table(
        [[Paragraph(content, style("Callout", fontSize=9.2, leading=12.5, spaceAfter=0))]],
        colWidths=[6.35 * inch],
        style=TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), background),
            ("BOX", (0, 0), (-1, -1), 0.7, border),
            ("LEFTPADDING", (0, 0), (-1, -1), 9),
            ("RIGHTPADDING", (0, 0), (-1, -1), 9),
            ("TOPPADDING", (0, 0), (-1, -1), 8),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ]),
        hAlign="LEFT",
    )


def grid_table(data, widths, header=True, row_backgrounds=None, right_cols=None):
    right_cols = set(right_cols or [])
    converted = []
    for ri, row in enumerate(data):
        converted_row = []
        for ci, value in enumerate(row):
            if isinstance(value, Paragraph):
                cell = value
            else:
                style_name = "table_header" if ri == 0 and header else "table"
                if not (ri == 0 and header) and ci in right_cols:
                    cell_style = style(
                        f"TableRight{ri}{ci}",
                        fontName=FONTS["semibold"] if ci in right_cols else FONTS["regular"],
                        fontSize=8.4,
                        leading=10.5,
                        alignment=TA_RIGHT,
                        spaceAfter=0,
                    )
                    cell = Paragraph(str(value), cell_style)
                else:
                    cell = p(str(value), style_name)
            converted_row.append(cell)
        converted.append(converted_row)
    commands = [
        ("BOX", (0, 0), (-1, -1), 0.55, BORDER_STRONG),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, BORDER),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]
    if header:
        commands.append(("BACKGROUND", (0, 0), (-1, 0), PRIMARY_SOFT))
    for row_idx, fill in (row_backgrounds or {}).items():
        commands.append(("BACKGROUND", (0, row_idx), (-1, row_idx), fill))
    return Table(converted, colWidths=widths, repeatRows=1 if header else 0,
                 style=TableStyle(commands), hAlign="LEFT")


class ProposalDocTemplate(BaseDocTemplate):
    def __init__(self, filename, **kwargs):
        super().__init__(filename, **kwargs)
        frame = Frame(
            self.leftMargin,
            self.bottomMargin,
            self.width,
            self.height,
            leftPadding=0,
            rightPadding=0,
            topPadding=0,
            bottomPadding=0,
        )
        self.addPageTemplates(PageTemplate(id="proposal", frames=[frame], onPage=self.draw_page))

    def draw_page(self, canvas, doc):
        canvas.saveState()
        canvas.setFillColor(INK_MUTED)
        canvas.setFont(FONTS["bold"], 7.2)
        canvas.drawRightString(letter[0] - 0.72 * inch, letter[1] - 0.39 * inch, "PROPOSTA OLU/PRO/2026-0731")

        y = 0.42 * inch
        canvas.setStrokeColor(BORDER)
        canvas.setLineWidth(0.55)
        canvas.line(0.72 * inch, y + 0.16 * inch, letter[0] - 0.72 * inch, y + 0.16 * inch)
        canvas.setFont(FONTS["regular"], 7.3)
        canvas.setFillColor(INK_MUTED)
        canvas.drawString(0.72 * inch, y, "olumechat.com.br  |  comercial@olumechat.com.br")
        canvas.drawRightString(letter[0] - 0.72 * inch, y, f"Página {doc.page}")
        canvas.restoreState()


def build_story():
    story = []

    # PAGE 1
    logo = Image(str(LOGO), width=2.05 * inch, height=0.469 * inch)
    logo.hAlign = "CENTER"
    story += [Spacer(1, 0.11 * inch), logo, Spacer(1, 0.22 * inch)]
    story += [
        p("PROPOSTA COMERCIAL", "kicker"),
        p("Atendimento no WhatsApp com operação centralizada e custo previsível", "title"),
        p("Proposta preparada para a Pro Distribuidora", "subtitle"),
    ]

    metadata = [
        [
            p("AOS CUIDADOS DE<br/><font name='%s' color='#071A15' size='9.5'><b>Iure</b></font>" % FONTS["regular"], "small"),
            p("DATA<br/><font name='%s' color='#071A15' size='9.5'><b>31 de julho de 2026</b></font>" % FONTS["regular"], "small"),
        ],
        [
            p("PROPOSTA<br/><font name='%s' color='#071A15' size='9.5'><b>OLU/PRO/2026-0731</b></font>" % FONTS["regular"], "small"),
            p("VALIDADE<br/><font name='%s' color='#071A15' size='9.5'><b>15 dias</b></font>" % FONTS["regular"], "small"),
        ],
    ]
    story.append(Table(
        metadata,
        colWidths=[3.175 * inch, 3.175 * inch],
        style=TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), CANVAS),
            ("BOX", (0, 0), (-1, -1), 0.55, BORDER),
            ("INNERGRID", (0, 0), (-1, -1), 0.45, BORDER),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 10),
            ("RIGHTPADDING", (0, 0), (-1, -1), 10),
            ("TOPPADDING", (0, 0), (-1, -1), 8),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ]),
        hAlign="CENTER",
    ))

    story += [
        p("Uma proposta simples de contratar e simples de acompanhar", "center_lead"),
        p(
            "A Olume Chat reúne atendimento, equipe e automações no WhatsApp oficial. "
            "A Pro Distribuidora paga uma única mensalidade pela plataforma; integrações com o "
            "Winthor entram somente na implantação, de acordo com a dificuldade de cada item.",
            "center_body",
        ),
    ]

    metrics = [
        [p("IMPLANTAÇÃO BASE", "metric_label"), p("MENSALIDADE", "metric_label"), p("API OFICIAL DA META", "metric_label")],
        [p("R$ 500", "metric_value"), p("R$ 500/mês", "metric_value"), p("Conforme consumo", "metric_value_small")],
    ]
    story.append(Table(
        metrics,
        colWidths=[2.116 * inch] * 3,
        style=TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), PRIMARY_SOFT),
            ("BOX", (0, 0), (-1, -1), 0.7, BORDER_STRONG),
            ("INNERGRID", (0, 0), (-1, -1), 0.5, BORDER_STRONG),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
            ("TOPPADDING", (0, 0), (-1, 0), 7),
            ("BOTTOMPADDING", (0, 0), (-1, 0), 1),
            ("TOPPADDING", (0, 1), (-1, 1), 2),
            ("BOTTOMPADDING", (0, 1), (-1, 1), 9),
        ]),
        hAlign="CENTER",
    ))
    story += [
        Spacer(1, 0.14 * inch),
        callout(
            "<b><font color='#17664F'>Ponto central:</font></b> as integrações com o Winthor não geram "
            "mensalidade adicional. <b>O recorrente permanece R$ 500 + custo da API oficial da Meta.</b>"
        ),
        Spacer(1, 0.11 * inch),
        p("Conversas que permanecem acesas.", "kicker"),
        PageBreak(),
    ]

    # PAGE 2
    story += [
        p("1. O que a Pro Distribuidora recebe", "h1"),
        p(
            "Uma operação de WhatsApp baseada na Cloud API oficial da Meta, pronta para organizar "
            "o atendimento da equipe e automatizar etapas repetitivas sem perder o contexto da conversa.",
            "body_muted",
        ),
        bullets([
            "<b>Caixa de entrada compartilhada</b> para centralizar conversas e histórico.",
            "<b>Distribuição do atendimento</b> por filas, departamentos e responsáveis.",
            "<b>Fluxos automáticos</b> de recepção, triagem, menus e regras de encaminhamento.",
            "<b>Campanhas e comunicação ativa</b> conforme as políticas da Meta e o consentimento dos contatos.",
            "<b>Gestão de contatos</b>, tags, acompanhamento operacional e visão de métricas.",
            "<b>Suporte à configuração</b> e às rotinas da plataforma durante a vigência.",
        ]),
        p("2. Implantação base", "h1"),
        p(
            "A implantação base custa <b>R$ 500</b> e prepara a operação para o primeiro uso. "
            "O trabalho começa após o aceite e a liberação dos acessos necessários."
        ),
        bullets([
            "<b>Kickoff.</b> Alinhamento do responsável, número de WhatsApp e prioridades da operação.",
            "<b>Conexão oficial.</b> Orientação e configuração dos ativos necessários na Meta.",
            "<b>Configuração.</b> Estrutura inicial de equipe, filas e fluxo de entrada.",
            "<b>Go-live.</b> Validação com o cliente e início do acompanhamento assistido.",
        ], numbered=True),
        callout(
            "<b><font color='#17664F'>Prazo estimado:</font></b> até 30 dias a partir do aceite, "
            "da aprovação do escopo e da entrega dos acessos. <b>Após o go-live, a Olume acompanha "
            "os ajustes iniciais por 30 dias.</b>",
            background=CANVAS,
            border=BORDER,
        ),
        Spacer(1, 0.09 * inch),
        p("3. Responsabilidades para começar", "h1"),
        bullets([
            "A Pro Distribuidora indica um responsável para decisões, validações e treinamento.",
            "O cliente disponibiliza número, conta Meta e acessos necessários ao ambiente Winthor quando houver integração.",
            "Cada item de integração é descrito, classificado e aprovado antes do desenvolvimento.",
            "Dependências ou aprovações externas da Meta e do Winthor podem alterar o cronograma.",
        ]),
        PageBreak(),
    ]

    # PAGE 3
    story += [
        p("4. Investimento", "h1"),
        p(
            "A cobrança foi estruturada para separar claramente o custo inicial do custo mensal. "
            "A integração é investimento de implantação; ela não vira recorrência.",
            "body_muted",
        ),
    ]
    story.append(grid_table(
        [
            ["Item", "Cobrança", "Valor"],
            ["Implantação da plataforma", "Pagamento único", "R$ 500"],
            ["Assinatura Olume Chat", "Mensal", "R$ 500/mês"],
            ["API oficial do WhatsApp", "Conforme consumo", "Tabela vigente da Meta"],
        ],
        [2.85 * inch, 1.55 * inch, 1.95 * inch],
        right_cols=[2],
    ))
    story += [
        p("Integrações opcionais com o Winthor", "h2"),
        p(
            "Cada automação ou troca de dados é tratada como um item de integração. O valor é "
            "somado à implantação conforme o nível de dificuldade validado com o cliente."
        ),
    ]
    story.append(grid_table(
        [
            ["Nível", "Referência para classificação", "Valor por item"],
            ["Baixa", "Consulta simples, uma fonte principal e resposta direta", "R$ 300"],
            ["Média", "Mais de uma validação, regra condicional ou combinação de dados", "R$ 600"],
            ["Alta", "Fluxo em várias etapas, gravação de dados ou regra crítica de negócio", "R$ 1.000"],
        ],
        [1.2 * inch, 3.8 * inch, 1.35 * inch],
        right_cols=[2],
    ))
    story += [p("Exemplos de composição", "h2")]
    story.append(grid_table(
        [
            ["Cenário", "Cálculo", "Implantação total"],
            ["Sem integração com Winthor", "R$ 500", "R$ 500"],
            ["3 integrações de baixa dificuldade", "R$ 500 + 3 x R$ 300", "R$ 1.400"],
            ["1 baixa + 1 alta", "R$ 500 + R$ 300 + R$ 1.000", "R$ 1.800"],
        ],
        [3.0 * inch, 1.95 * inch, 1.4 * inch],
        row_backgrounds={2: PRIMARY_SOFT},
        right_cols=[2],
    ))
    story += [
        Spacer(1, 0.11 * inch),
        callout(
            "<b><font color='#B76A11'>Outros sistemas:</font></b> integrações fora do Winthor passam "
            "por validação técnica e recebem orçamento específico antes do início.",
            background=WARNING_SOFT,
            border=colors.HexColor("#E8D4AA"),
        ),
        Spacer(1, 0.11 * inch),
        callout(
            "<b><font color='#17664F'>Recorrência:</font></b> qualquer que seja a composição de "
            "integrações escolhida, o mensal permanece <b>R$ 500 + custo da API oficial da Meta.</b>"
        ),
        PageBreak(),
    ]

    # PAGE 4
    story += [
        p("5. Condições comerciais", "h1"),
        bullets([
            "Valores apresentados em reais (R$).",
            "Implantação e integrações: cobrança única após o aceite comercial e a aprovação do escopo técnico.",
            "Mensalidade: R$ 500, com início no go-live da plataforma.",
            "Consumo da API oficial: não incluído na mensalidade; calculado conforme a política e a tabela vigentes da Meta.",
            "Integrações Winthor: cobradas por item e apenas na implantação, sem recorrência adicional.",
            "Mudanças de escopo e novas integrações após a aprovação recebem estimativa separada.",
            "Validade desta proposta: 15 dias a partir de 31 de julho de 2026.",
        ]),
        p("6. Próximos passos", "h1"),
        bullets([
            "<b>Aceite comercial.</b> Confirmação desta proposta pela Pro Distribuidora.",
            "<b>Levantamento técnico.</b> Lista dos itens Winthor e classificação de dificuldade.",
            "<b>Ordem de serviço.</b> Registro do escopo final, valores e dados de faturamento.",
            "<b>Kickoff.</b> Agendamento do início e compartilhamento dos acessos.",
        ], numbered=True),
        callout(
            "<b><font color='#17664F'>Resumo para decisão:</font></b> R$ 500 de implantação base + "
            "integrações escolhidas. Depois do go-live, <b>R$ 500 por mês + custo da API oficial da Meta.</b>"
        ),
        Spacer(1, 0.12 * inch),
        p("7. Aceite", "h1"),
        p(
            "Ao assinar, o cliente confirma o interesse nas condições comerciais acima. O escopo "
            "técnico detalhado das integrações será anexado à ordem de serviço antes do desenvolvimento.",
            "body_muted",
        ),
    ]

    signature = [
        [p("<b><font color='#17664F'>Pro Distribuidora</font></b>", "signature"), p("<b><font color='#17664F'>Olume</font></b>", "signature")],
        [p("<br/><br/>Nome e cargo", "signature"), p("<br/><br/>Responsável comercial", "signature")],
        [p("<br/><br/>Data e assinatura", "signature"), p("<br/><br/>Data e assinatura", "signature")],
    ]
    story.append(Table(
        signature,
        colWidths=[3.175 * inch, 3.175 * inch],
        rowHeights=[0.35 * inch, 0.62 * inch, 0.62 * inch],
        style=TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), PRIMARY_SOFT),
            ("BOX", (0, 0), (-1, -1), 0.55, BORDER_STRONG),
            ("INNERGRID", (0, 0), (-1, -1), 0.45, BORDER),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
            ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ]),
        hAlign="LEFT",
    ))
    story += [
        Spacer(1, 0.18 * inch),
        p("Conversas que permanecem acesas.", "center_lead"),
        p("Olume Chat  |  olumechat.com.br", "center_body"),
    ]
    return story


def build():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc = ProposalDocTemplate(
        str(OUTPUT),
        pagesize=letter,
        leftMargin=0.72 * inch,
        rightMargin=0.72 * inch,
        topMargin=0.64 * inch,
        bottomMargin=0.69 * inch,
        title="Proposta Comercial Olume Chat para Pro Distribuidora",
        author="Olume",
        subject="Implantação da plataforma Olume Chat e integrações opcionais com Winthor",
    )
    doc.build(build_story())
    print(OUTPUT)


if __name__ == "__main__":
    build()
