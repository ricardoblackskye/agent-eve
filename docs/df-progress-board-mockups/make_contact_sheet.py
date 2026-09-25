from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent
RENDERS = ROOT / "renders"
OUT = RENDERS / "contact-sheet.png"
variants = [
    ("01 · Compact dark console", "01-compact-dark"),
    ("02 · Airy editorial", "02-airy-editorial"),
    ("03 · Operator split-pane", "03-operator-split"),
]
screens = [("Overview", "overview"), ("Run table", "table"), ("Run detail", "detail")]
font_path = Path("C:/Windows/Fonts/segoeui.ttf")
font_bold_path = Path("C:/Windows/Fonts/segoeuib.ttf")
font = ImageFont.truetype(str(font_path), 17) if font_path.exists() else ImageFont.load_default()
font_bold = ImageFont.truetype(str(font_bold_path), 22) if font_bold_path.exists() else font
font_small = ImageFont.truetype(str(font_path), 13) if font_path.exists() else ImageFont.load_default()

W = 1480
MARGIN = 24
GAP = 18
CARD_W = (W - 2 * MARGIN - 2 * GAP) // 3
IMAGE_W = CARD_W - 18
IMAGE_H = 270
ROW_HEAD = 33
ROW_GAP = 20
ROW_H = ROW_HEAD + IMAGE_H + ROW_GAP
HEADER_H = 86
H = HEADER_H + len(variants) * ROW_H + 24

canvas = Image.new("RGB", (W, H), "#0b1220")
draw = ImageDraw.Draw(canvas)
draw.text((MARGIN, 19), "DARK FACTORY · PROGRESS BOARD", font=font_bold, fill="#e5edf8")
draw.text((MARGIN, 50), "Issue #178 · Three layout directions · Illustrative sample data only", font=font_small, fill="#93a4bb")
for col, (label, _) in enumerate(screens):
    x = MARGIN + col * (CARD_W + GAP)
    draw.text((x + 8, 69), label.upper(), font=font_small, fill="#71c8e8")

for row, (variant_label, variant_prefix) in enumerate(variants):
    y0 = HEADER_H + row * ROW_H
    draw.text((MARGIN, y0), variant_label, font=font, fill="#fbbf6a")
    image_y = y0 + ROW_HEAD
    for col, (_, screen_name) in enumerate(screens):
        x = MARGIN + col * (CARD_W + GAP)
        file = RENDERS / f"{variant_prefix}-{screen_name}.png"
        if not file.exists():
            raise FileNotFoundError(file)
        source = Image.open(file).convert("RGB")
        thumb = ImageOps.contain(source, (IMAGE_W, IMAGE_H), method=Image.Resampling.LANCZOS)
        frame = Image.new("RGB", (IMAGE_W, IMAGE_H), "#111827")
        frame.paste(thumb, ((IMAGE_W - thumb.width) // 2, (IMAGE_H - thumb.height) // 2))
        card = Image.new("RGB", (CARD_W, IMAGE_H + 12), "#111827")
        card.paste(frame, (9, 6))
        canvas.paste(card, (x, image_y))
        draw.rectangle((x, image_y, x + CARD_W - 1, image_y + IMAGE_H + 11), outline="#2b3b50", width=1)

canvas.save(OUT, optimize=True)
print(f"created {OUT} ({canvas.width}x{canvas.height})")
