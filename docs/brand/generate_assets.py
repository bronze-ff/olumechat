"""Gera os derivados raster da identidade Olume a partir da geometria aprovada.

Execute na raiz do repositório:

    python docs/brand/generate_assets.py
"""

from pathlib import Path
from shutil import copy2

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "client" / "public"
PUBLIC_BRAND = PUBLIC / "brand"
DOCS_ASSETS = ROOT / "docs" / "brand" / "assets"

FOREST = "#071A15"
GREEN = "#1F7A60"
MINT = "#5BD6AE"
FOG = "#F3F8F6"
PAPER = "#E9EFEA"
BLACK = "#0B100E"
MUTED = "#A7BBB4"

FONT_REGULAR = Path(r"C:\Windows\Fonts\segoeui.ttf")
FONT_SEMIBOLD = Path(r"C:\Windows\Fonts\seguisb.ttf")


def font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), size=size)


def draw_mark(
    draw: ImageDraw.ImageDraw,
    box: tuple[float, float, float, float],
    color: str,
    core: str | None = None,
) -> None:
    x0, y0, x1, y1 = box
    width = x1 - x0
    height = y1 - y0
    unit = min(width, height)
    cx = x0 + width * 0.5
    cy = y0 + height * 0.44
    radius = unit * 0.315
    stroke = max(2, round(unit * 0.13))

    draw.ellipse(
        (cx - radius, cy - radius, cx + radius, cy + radius),
        outline=color,
        width=stroke,
    )

    tail = [
        (cx - radius * 0.58, cy + radius * 0.76),
        (cx - radius * 0.82, cy + radius * 1.42),
        (cx + radius * 0.08, cy + radius * 1.05),
    ]
    draw.polygon(tail, fill=color)

    core_radius = unit * 0.072
    draw.ellipse(
        (
            cx - core_radius,
            cy - core_radius,
            cx + core_radius,
            cy + core_radius,
        ),
        fill=core or color,
    )


def downsample(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    return image.resize(size, Image.Resampling.LANCZOS)


def app_icon(size: int, *, maskable: bool = False) -> Image.Image:
    scale = 4
    side = size * scale
    image = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    radius = 0 if maskable else round(side * 0.22)
    draw.rounded_rectangle((0, 0, side, side), radius=radius, fill=FOREST)

    padding = side * (0.19 if maskable else 0.14)
    draw_mark(draw, (padding, padding, side - padding, side - padding), MINT)
    return downsample(image, (size, size))


def transparent_mark(size: int, *, inverse: bool = False) -> Image.Image:
    scale = 4
    side = size * scale
    image = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    padding = side * 0.08
    draw_mark(
        draw,
        (padding, padding, side - padding, side - padding),
        MINT if inverse else GREEN,
        MINT,
    )
    return downsample(image, (size, size))


def logo_lockup(*, product: bool, inverse: bool) -> Image.Image:
    width, height = (1400 if product else 1120), 320
    scale = 2
    image = Image.new("RGBA", (width * scale, height * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    mark_color = MINT if inverse else GREEN
    text_color = FOG if inverse else FOREST

    draw_mark(draw, (22 * scale, 22 * scale, 298 * scale, 298 * scale), mark_color, MINT)
    baseline_y = 63 * scale
    olume_font = font(FONT_SEMIBOLD, 172 * scale)
    chat_font = font(FONT_REGULAR, 146 * scale)

    olume_x = 340 * scale
    draw.text((olume_x, baseline_y), "olume", font=olume_font, fill=text_color)

    if product:
        olume_box = draw.textbbox((olume_x, baseline_y), "olume", font=olume_font)
        chat_x = olume_box[2] + 56 * scale
        draw.text((chat_x, 82 * scale), "chat", font=chat_font, fill=mark_color)

    return downsample(image, (width, height))


def social_card() -> Image.Image:
    width, height = 1200, 630
    image = Image.new("RGB", (width, height), FOREST)
    draw = ImageDraw.Draw(image)

    draw.rectangle((48, 48, width - 48, height - 48), outline=GREEN, width=2)
    draw.rectangle((48, 48, 62, height - 48), fill=MINT)
    draw.ellipse((915, -125, 1265, 225), outline=GREEN, width=2)
    draw.ellipse((965, -75, 1215, 175), outline=GREEN, width=2)

    draw_mark(draw, (94, 95, 220, 221), MINT)
    draw.text((248, 98), "olume", font=font(FONT_SEMIBOLD, 82), fill=FOG)
    draw.text((505, 112), "chat", font=font(FONT_REGULAR, 66), fill=MINT)

    draw.text(
        (94, 276),
        "Conversas que\npermanecem acesas.",
        font=font(FONT_SEMIBOLD, 61),
        fill=FOG,
        spacing=2,
    )
    draw.text(
        (96, 466),
        "WhatsApp, filas, equipe e automações no mesmo contexto.",
        font=font(FONT_REGULAR, 26),
        fill=MUTED,
    )
    draw.text(
        (96, 548),
        "OLUME.COM.BR",
        font=font(FONT_SEMIBOLD, 18),
        fill=MINT,
    )
    return image


def save_assets() -> None:
    PUBLIC_BRAND.mkdir(parents=True, exist_ok=True)
    DOCS_ASSETS.mkdir(parents=True, exist_ok=True)
    (PUBLIC / "marketing").mkdir(parents=True, exist_ok=True)

    app_icon(16).save(PUBLIC / "favicon-16x16.png", optimize=True)
    app_icon(32).save(PUBLIC / "favicon-32x32.png", optimize=True)
    app_icon(180).save(PUBLIC / "apple-touch-icon.png", optimize=True)
    app_icon(192).save(PUBLIC / "icon-192x192.png", optimize=True)
    app_icon(512).save(PUBLIC / "icon-512x512.png", optimize=True)
    app_icon(512, maskable=True).save(PUBLIC / "icon-maskable-512x512.png", optimize=True)

    transparent_mark(512).save(PUBLIC_BRAND / "olume-mark.png", optimize=True)
    transparent_mark(512, inverse=True).save(
        PUBLIC_BRAND / "olume-mark-inverse.png",
        optimize=True,
    )
    logo_lockup(product=False, inverse=False).save(
        PUBLIC_BRAND / "olume-logo.png",
        optimize=True,
    )
    logo_lockup(product=False, inverse=True).save(
        PUBLIC_BRAND / "olume-logo-inverse.png",
        optimize=True,
    )
    logo_lockup(product=True, inverse=False).save(
        PUBLIC_BRAND / "olume-chat-logo.png",
        optimize=True,
    )
    logo_lockup(product=True, inverse=True).save(
        PUBLIC_BRAND / "olume-chat-logo-inverse.png",
        optimize=True,
    )

    social_card().save(PUBLIC / "marketing" / "og-olume-chat.png", optimize=True)

    for asset in PUBLIC_BRAND.iterdir():
        if asset.suffix.lower() in {".svg", ".png"}:
            copy2(asset, DOCS_ASSETS / asset.name)


if __name__ == "__main__":
    save_assets()
    print(f"Ativos Olume gerados em {PUBLIC_BRAND}")
    print(f"Cópia documental salva em {DOCS_ASSETS}")
