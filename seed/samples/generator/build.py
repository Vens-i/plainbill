import os, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from remits import tidewater_remit, granite_remit
from member_eob import member_eob
from statements import maria_statement, aisha_statement

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
p = lambda n: os.path.join(OUT, n)

# Inbound to the clinic
tidewater_remit(p("inbound_tidewater_remit_2026-10-08.pdf"), "10/08/2026", "BC1008120117", ["maria", "samuel"])
tidewater_remit(p("inbound_tidewater_remit_2026-09-30_denial.pdf"), "09/30/2026", "BC0930118842", ["james"],
                note=["*** NON-PAYMENT REMITTANCE. NO FUNDS TRANSFERRED FOR THIS ADVICE. ***"])
granite_remit(p("inbound_granite_remit_2026-09-14.pdf"), "09/14/2026", "AE0914553872", ["marcus", "linda"])
# What the patient gets from her insurer
member_eob(p("patient_tidewater_eob_delgado.pdf"))
# What the clinic sends the patient today
maria_statement(p("outbound_harborview_statement_delgado.pdf"))
aisha_statement(p("outbound_harborview_statement_bello_past_due.pdf"))


# A phone photo of Maria's paper statement, folded in thirds, on a kitchen table
def coeffs(dst, src):
    A, B = [], []
    for (x, y), (u, v) in zip(dst, src):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); B.append(v)
    return np.linalg.solve(np.array(A, float), np.array(B, float)).tolist()


tmp = p("_page")
subprocess.run(["pdftoppm", "-r", "140", "-png", "-singlefile", p("outbound_harborview_statement_delgado.pdf"), tmp], check=True)
page = Image.open(tmp + ".png").convert("RGB")
os.remove(tmp + ".png")
pw, ph = page.size
# fold creases (letter folded in thirds) + slight warm paper tone
d = ImageDraw.Draw(page)
for f in (ph / 3, 2 * ph / 3):
    d.line([(0, f), (pw, f)], fill=(205, 203, 196), width=2)
    d.line([(0, f + 2), (pw, f + 2)], fill=(250, 250, 247), width=1)
page = Image.blend(page, Image.new("RGB", page.size, (246, 240, 226)), 0.10)

OW, OH = 1500, 2000
rng = np.random.default_rng(7)
bg = np.zeros((OH, OW, 3), np.float32)
yy, xx = np.mgrid[0:OH, 0:OW]
base = np.array([112, 86, 62], np.float32)
grain = (np.sin(xx / 7.0 + np.sin(yy / 90.0) * 3) * 6 + rng.normal(0, 4, (OH, OW)))[..., None]
bg = np.clip(base + grain, 0, 255)
bgimg = Image.fromarray(bg.astype(np.uint8))

dst = [(150, 170), (1360, 120), (1420, 1880), (90, 1840)]  # where the page corners land
src = [(0, 0), (pw, 0), (pw, ph), (0, ph)]
warped = page.transform((OW, OH), Image.PERSPECTIVE, coeffs(dst, src), Image.BICUBIC)
mask = Image.new("L", (OW, OH), 0)
ImageDraw.Draw(mask).polygon(dst, fill=255)
shadow = Image.new("L", (OW, OH), 0)
ImageDraw.Draw(shadow).polygon([(x + 18, y + 22) for x, y in dst], fill=150)
shadow = shadow.filter(ImageFilter.GaussianBlur(22))
bgimg.paste(Image.new("RGB", (OW, OH), (20, 14, 10)), (0, 0), shadow)
bgimg.paste(warped, (0, 0), mask)
# uneven indoor light: brighter top-left, darker bottom-right
light = np.clip(1.08 - (xx / OW) * 0.16 - (yy / OH) * 0.2, 0.7, 1.1)[..., None]
out = np.clip(np.asarray(bgimg, np.float32) * light, 0, 255).astype(np.uint8)
photo = Image.fromarray(out).filter(ImageFilter.GaussianBlur(0.7))
photo.save(p("outbound_harborview_statement_delgado_phone_photo.jpg"), quality=80)
print("ok")
