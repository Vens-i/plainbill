from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import HexColor
from reportlab.pdfgen import canvas as rl_canvas

W, H = letter
LIB = "/usr/share/fonts/truetype/liberation/"
DV = "/usr/share/fonts/truetype/dejavu/"

pdfmetrics.registerFont(TTFont("Sans", LIB + "LiberationSans-Regular.ttf"))
pdfmetrics.registerFont(TTFont("Sans-Bold", LIB + "LiberationSans-Bold.ttf"))
pdfmetrics.registerFont(TTFont("Sans-Italic", LIB + "LiberationSans-Italic.ttf"))
pdfmetrics.registerFont(TTFont("Mono", LIB + "LiberationMono-Regular.ttf"))
pdfmetrics.registerFont(TTFont("Mono-Bold", LIB + "LiberationMono-Bold.ttf"))
pdfmetrics.registerFont(TTFont("DV", DV + "DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("DV-Bold", DV + "DejaVuSans-Bold.ttf"))

INK = HexColor("#1b1d1f")
GRAY = HexColor("#5a5f63")
LIGHT = HexColor("#e9eaeb")
RULE = HexColor("#9aa0a4")


def new_canvas(path, title):
    c = rl_canvas.Canvas(path, pagesize=letter)
    c.setTitle(title)
    c.setAuthor("Plainbill synthetic sample data")
    c.setCreator("Plainbill seed samples")
    c.setSubject("SYNTHETIC SAMPLE - fictional patient, practice and payer")
    return c


def T(y):
    """Convert a top-based coordinate to reportlab's bottom-based one."""
    return H - y


def synthetic_footer(c):
    c.saveState()
    c.setFont("Sans", 5.5)
    c.setFillColor(HexColor("#8a8f93"))
    c.drawCentredString(
        W / 2, 10,
        "SYNTHETIC SAMPLE · Plainbill demo data · fictional patient, practice and payer · not a real document",
    )
    c.restoreState()


def text(c, x, y, s, font="Sans", size=8, color=INK, align="left"):
    c.setFont(font, size)
    c.setFillColor(color)
    if align == "left":
        c.drawString(x, T(y), s)
    elif align == "right":
        c.drawRightString(x, T(y), s)
    else:
        c.drawCentredString(x, T(y), s)


def hrule(c, x1, x2, y, width=0.6, color=INK, dash=None):
    c.saveState()
    c.setStrokeColor(color)
    c.setLineWidth(width)
    if dash:
        c.setDash(*dash)
    c.line(x1, T(y), x2, T(y))
    c.restoreState()


def box(c, x, y, w, h, stroke=INK, fill=None, width=0.6, radius=0):
    c.saveState()
    if stroke is not None:
        c.setStrokeColor(stroke)
    c.setLineWidth(width)
    if fill is not None:
        c.setFillColor(fill)
    if radius:
        c.roundRect(x, T(y + h), w, h, radius, stroke=1 if stroke else 0, fill=1 if fill is not None else 0)
    else:
        c.rect(x, T(y + h), w, h, stroke=1 if stroke else 0, fill=1 if fill is not None else 0)
    c.restoreState()


def wrap(c, x, y, width, s, font="Sans", size=7, leading=None, color=INK):
    """Simple word wrap; returns the y after the last line."""
    leading = leading or size * 1.25
    c.setFont(font, size)
    c.setFillColor(color)
    words = s.split()
    lineacc = ""
    for w_ in words:
        trial = (lineacc + " " + w_).strip()
        if c.stringWidth(trial, font, size) > width and lineacc:
            c.drawString(x, T(y), lineacc)
            y += leading
            lineacc = w_
        else:
            lineacc = trial
    if lineacc:
        c.drawString(x, T(y), lineacc)
        y += leading
    return y
