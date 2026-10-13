"""The member EOB Maria gets in the mail from her insurer ("This is not a bill")."""
import io
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.utils import ImageReader
from common import *
from data import *

NAVY = HexColor("#16365c")
TEAL = HexColor("#2b7a8c")
PALE = HexColor("#eef3f7")


def tidewater_logo(c, x, y, scale=1.0):
    c.saveState()
    c.setStrokeColor(TEAL)
    c.setLineWidth(2.2 * scale)
    for i in range(3):
        p = c.beginPath()
        yy = y + 6 + i * 6
        p.moveTo(x, T(yy))
        p.curveTo(x + 6 * scale, T(yy - 5), x + 10 * scale, T(yy - 5), x + 15 * scale, T(yy))
        p.curveTo(x + 20 * scale, T(yy + 5), x + 24 * scale, T(yy + 5), x + 30 * scale, T(yy))
        c.drawPath(p, stroke=1, fill=0)
    c.restoreState()
    text(c, x + 38 * scale, y + 13, "Tidewater", "Sans-Bold", 15 * scale, NAVY)
    text(c, x + 38 * scale, y + 23, "HEALTH PLAN", "Sans", 6.5 * scale, TEAL)


def cjk_line(s, size_pt=6.2, width_pt=540):
    """CJK taglines rendered as an image (ReportLab can't embed the CFF Noto CJK fonts)."""
    scale = 6
    font = ImageFont.truetype("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", int(size_pt * scale), index=0)
    img = Image.new("RGBA", (int(width_pt * scale), int(size_pt * 1.5 * scale)), (255, 255, 255, 0))
    d = ImageDraw.Draw(img)
    d.text((0, 0), s, font=font, fill=(60, 64, 68, 255))
    bbox = img.getbbox()
    img = img.crop((0, 0, bbox[2] + 4, img.height))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    buf.seek(0)
    return ImageReader(buf), img.width / scale, img.height / scale


def member_eob(path):
    cl = CLAIMS["maria"]
    t = totals(cl)
    c = new_canvas(path, "Tidewater Health Plan - Explanation of Benefits - Maria Delgado")
    L, R = 40, W - 40

    # ---------------- Page 1 ----------------
    tidewater_logo(c, L, 32)
    text(c, R, 42, "Explanation of Benefits", "Sans-Bold", 15, NAVY, align="right")
    text(c, R, 54, "Statement date: October 9, 2026", "Sans", 7.5, GRAY, align="right")

    # mailing block (window envelope position)
    y = 92
    text(c, L, y, "TIDEWATER HEALTH PLAN · PO BOX 4400 · HARBORVIEW CA 94001", "Sans", 5.8, GRAY)
    for i, s in enumerate(["MARIA DELGADO", "418 SEACLIFF AVE APT 2B", "HARBORVIEW CA 94000-2213"]):
        text(c, L, y + 14 + i * 10, s, "Sans", 8.5)
    # member block
    bx = 330
    box(c, bx, 80, R - bx, 62, stroke=None, fill=PALE, radius=3)
    rows = [("Member", "Maria Delgado"), ("Member ID", "XBC•••••0377"), ("Group", "0048812 · Seawall Logistics Inc."),
            ("Plan", "Tidewater Choice PPO 1500"), ("Benefit year", "01/01/2026 – 12/31/2026")]
    for i, (k, v) in enumerate(rows):
        text(c, bx + 8, 92 + i * 10.5, k, "Sans-Bold", 7, NAVY)
        text(c, bx + 72, 92 + i * 10.5, v, "Sans", 7)

    y = 160
    box(c, L, y, R - L, 26, stroke=NAVY, width=1.2)
    text(c, W / 2, y + 17, "THIS IS NOT A BILL", "Sans-Bold", 13, NAVY, align="center")
    y += 40
    y = wrap(c, L, y, R - L,
             "This statement explains how your health plan processed a claim submitted for you or a covered family member. "
             "Please keep it with your records. If you owe a balance, your provider will send you a separate bill. "
             "Compare this statement with any bill you receive. Questions? See page 2.", size=7.4, color=GRAY)

    # summary strip
    y += 8
    text(c, L, y, "Claim summary", "Sans-Bold", 9.5, NAVY)
    y += 8
    cells = [("Amount billed", t["billed"]), ("Plan discount", t["co"]), ("Plan paid", t["paid"]), ("You may owe the provider*", t["pr"])]
    cw = (R - L) / 4
    for i, (k, v) in enumerate(cells):
        x = L + i * cw
        box(c, x + (0 if i == 0 else 3), y, cw - 3, 40, stroke=None, fill=PALE if i < 3 else NAVY, radius=3)
        col = NAVY if i < 3 else HexColor("#ffffff")
        text(c, x + 12, y + 14, k.upper(), "Sans-Bold", 6, col)
        text(c, x + 12, y + 32, f"${v:,.2f}", "Sans-Bold", 13, col)
    y += 50
    text(c, L, y, "*This amount is your share under your plan. Your provider may bill you for it. Amounts shown as plan discount are not your responsibility.", "Sans-Italic", 6.4, GRAY)

    # claim detail
    y += 22
    text(c, L, y, "Claim detail", "Sans-Bold", 9.5, NAVY)
    y += 12
    pf, pl, _ = PROVIDERS["patel"]
    text(c, L, y, f"Patient: MARIA   ·   Provider: {pf} {pl} MD / HARBORVIEW FAMILY MEDICINE   ·   Network status: IN-NETWORK", "Sans", 7)
    y += 10
    text(c, L, y, f"Claim number: {cl['icn']}   ·   Received: {cl['received']}   ·   Processed: {cl['processed']}   ·   Paid to: PROVIDER", "Sans", 7)
    y += 12

    heads = ["Date of\nservice", "Type of\nservice", "Amount\nbilled", "Plan\ndiscount", "Amount\nallowed", "Not\ncovered",
             "Deductible", "Copay", "Coinsurance", "Plan\npaid", "Your\nshare", "Remark\ncode"]
    xs = [L + 4, L + 46, L + 130, L + 172, L + 214, L + 254, L + 298, L + 334, L + 380, L + 420, L + 460, L + 498]
    rights = {2, 3, 4, 5, 6, 7, 8, 9, 10}
    box(c, L, y, R - L, 22, stroke=None, fill=NAVY)
    for i, h_ in enumerate(heads):
        parts = h_.split("\n")
        for j, p in enumerate(parts):
            yy = y + 9 + j * 8 + (4 if len(parts) == 1 else 0)
            if i in rights:
                text(c, xs[i] + 30, yy, p, "Sans-Bold", 6.2, HexColor("#ffffff"), align="right")
            elif i == 11:
                text(c, xs[i] + 4, yy, p, "Sans-Bold", 6.2, HexColor("#ffffff"))
            else:
                text(c, xs[i], yy, p, "Sans-Bold", 6.2, HexColor("#ffffff"))
    y += 34
    svc = {"99214": "MEDICAL CARE", "80053": "LABORATORY", "93000": "DIAGNOSTIC SVCS"}
    remark = {"99214": "PD D1", "80053": "PD L4", "93000": "PD D1 C2"}
    for n, ln in enumerate(cl["lines"]):
        if n % 2 == 1:
            box(c, L, y - 9, R - L, 13, stroke=None, fill=HexColor("#f6f8fa"))
        share = ln["ded"] + ln["coins"] + ln["copay"]
        vals = ["10/03/26", svc[ln["proc"]], ln["billed"], ln["co"], ln["allowed"], 0, ln["ded"], ln["copay"], ln["coins"], ln["paid"], share, remark[ln["proc"]]]
        for i, v in enumerate(vals):
            if i in rights:
                text(c, xs[i] + 30, y, money(v), "Sans", 7.2, align="right")
            elif i == 11:
                text(c, xs[i] + 4, y, v, "Sans", 6.6)
            else:
                text(c, xs[i], y, v, "Sans", 7.2)
        y += 13
    hrule(c, L, R, y - 7, 0.8, NAVY)
    y += 4
    tv = ["", "CLAIM TOTAL", t["billed"], t["co"], t["allowed"], 0, t["ded"], t["copay"], t["coins"], t["paid"], t["pr"], ""]
    for i, v in enumerate(tv):
        if i in rights:
            text(c, xs[i] + 30, y, money(v), "Sans-Bold", 7.2, align="right")
        elif v:
            text(c, xs[i], y, v, "Sans-Bold", 7.2)
    y += 22

    text(c, L, y, "Remark codes", "Sans-Bold", 8, NAVY)
    y += 11
    for code, d in [
        ("PD", "The plan discount reflects the negotiated rate with this in-network provider. You are not responsible for this amount."),
        ("D1", "This amount was applied to the member's in-network deductible under the terms of the plan."),
        ("L4", "Covered at 100% of the allowed amount under the in-network independent laboratory benefit; deductible waived."),
        ("C2", "Coinsurance applies after deductible. Member coinsurance for in-network diagnostic services is 20% of the allowed amount."),
    ]:
        text(c, L, y, code, "Sans-Bold", 7)
        y = wrap(c, L + 22, y, R - L - 22, d, size=7, color=INK) + 1

    # accumulators
    y += 10
    text(c, L, y, "Your plan year to date (as of 10/08/2026)", "Sans-Bold", 9.5, NAVY)
    y += 10
    acc_heads = ["", "Plan amount", "Applied to date", "Remaining"]
    ax = [L + 4, L + 260, L + 360, L + 460]
    box(c, L, y, R - L, 14, stroke=None, fill=PALE)
    for i, h_ in enumerate(acc_heads):
        if i:
            text(c, ax[i] + 60, y + 10, h_, "Sans-Bold", 6.6, NAVY, align="right")
    y += 25
    for label, plan, met in [("In-network deductible — individual", 1500, 1350),
                             ("In-network deductible — family", 3000, 1965),
                             ("In-network out-of-pocket maximum — individual", 4500, 1612.40),
                             ("In-network out-of-pocket maximum — family", 9000, 2391.15)]:
        text(c, ax[0], y, label, "Sans", 7.2)
        text(c, ax[1] + 60, y, f"${plan:,.2f}", "Sans", 7.2, align="right")
        text(c, ax[2] + 60, y, f"${met:,.2f}", "Sans", 7.2, align="right")
        text(c, ax[3] + 60, y, f"${plan - met:,.2f}", "Sans", 7.2, align="right")
        y += 11
    y += 4
    wrap(c, L, y, R - L,
         "Amounts applied to date may not include claims that are still being processed. Out-of-network amounts accumulate separately.",
         "Sans-Italic", 6.4, color=GRAY)

    text(c, R, H - 26, "Page 1 of 2", "Sans", 6.5, GRAY, align="right")
    text(c, L, H - 26, f"Member services {TIDEWATER['member_phone']} (TTY 711) · tidewaterhp.example", "Sans", 6.5, GRAY)
    synthetic_footer(c)
    c.showPage()

    # ---------------- Page 2: the fine print ----------------
    tidewater_logo(c, L, 32, 0.8)
    text(c, R, 44, "Important information about your rights", "Sans-Bold", 11, NAVY, align="right")
    y = 78
    sections = [
        ("Questions about this statement",
         f"Call Member Services at {TIDEWATER['member_phone']} (TTY 711), Monday through Friday, 8 a.m. to 8 p.m. local time. Have your member ID "
         "and the claim number shown on page 1 available. For questions about a bill you received from a provider, contact the provider's billing office."),
        ("Your right to appeal",
         "If a claim was denied in whole or in part, or if you disagree with how a claim was processed, you or your authorized representative may "
         "request an internal appeal within 180 calendar days of receipt of this notice. Your request should be made in writing and include the "
         "member's name, member ID, claim number, and the reason you believe the determination should be changed, together with any supporting "
         "documentation. Upon request and free of charge, you are entitled to reasonable access to, and copies of, all documents, records, and other "
         "information relevant to your claim, including the identity of any medical or vocational experts consulted and any internal rule, guideline, "
         "protocol, or similar criterion relied upon in making the determination. A decision on a post-service appeal will be issued within 60 days "
         "of receipt of the request. In urgent situations you may request an expedited appeal."),
        ("External review",
         "If, after exhausting the internal appeals process, the plan's decision involved medical judgment or a rescission of coverage, you may have "
         "the right to request an external review by an independent review organization. Requests for external review must be filed within four "
         "months after the date of receipt of a notice of final internal adverse benefit determination. In certain circumstances you may request "
         "external review at the same time as the internal appeal."),
        ("If your plan is subject to ERISA",
         "You have the right to bring a civil action under section 502(a) of the Employee Retirement Income Security Act of 1974 following an adverse "
         "benefit determination on review. You and your plan may have other voluntary alternative dispute resolution options, such as mediation. One "
         "way to find out what may be available is to contact your local U.S. Department of Labor office and your state insurance regulatory agency."),
        ("Coordination of benefits",
         "If you or a covered family member has coverage under another health plan, please contact Member Services so that benefits can be coordinated "
         "correctly. Failure to report other coverage may result in a delay or reprocessing of claims."),
        ("Fraud warning",
         "Any person who knowingly and with intent to defraud any insurance company or other person files a statement of claim containing any materially "
         "false information, or conceals for the purpose of misleading information concerning any fact material thereto, commits a fraudulent insurance "
         "act, which is a crime and subjects such person to criminal and civil penalties. To report suspected fraud, call 1-800-555-0177."),
        ("Nondiscrimination notice",
         "Tidewater Health Plan complies with applicable federal civil rights laws and does not discriminate on the basis of race, color, national origin, "
         "age, disability, or sex. Tidewater Health Plan provides free aids and services to people with disabilities to communicate effectively with us, "
         "and free language services to people whose primary language is not English, such as qualified interpreters and information written in other "
         f"languages. If you need these services, call {TIDEWATER['member_phone']} (TTY 711)."),
    ]
    for head, body in sections:
        text(c, L, y, head, "Sans-Bold", 8, NAVY)
        y = wrap(c, L, y + 11, R - L, body, size=6.8, color=INK) + 7

    # Language taglines — the only non-English help on the whole document
    y += 2
    hrule(c, L, R, y, 0.4, RULE)
    y += 11
    text(c, L, y, "Language assistance", "Sans-Bold", 7, NAVY)
    y += 10
    ph = TIDEWATER["member_phone"]
    taglines = [
        f"ATENCIÓN: si habla español, tiene a su disposición servicios gratuitos de asistencia lingüística. Llame al {ph} (TTY: 711).",
        f"ATANSYON: Si w pale Kreyòl Ayisyen, gen sèvis èd pou lang ki disponib gratis pou ou. Rele {ph} (TTY: 711).",
        ("cjk", f"注意：如果您使用繁體中文，您可以免費獲得語言援助服務。請致電 {ph}（TTY：711）。"),
        f"CHÚ Ý: Nếu bạn nói Tiếng Việt, có các dịch vụ hỗ trợ ngôn ngữ miễn phí dành cho bạn. Gọi số {ph} (TTY: 711).",
        ("cjk", f"주의: 한국어를 사용하시는 경우, 언어 지원 서비스를 무료로 이용하실 수 있습니다. {ph} (TTY: 711)번으로 전화해 주십시오."),
        f"ВНИМАНИЕ: Если вы говорите на русском языке, то вам доступны бесплатные услуги перевода. Звоните {ph} (телетайп: 711).",
        f"PAUNAWA: Kung nagsasalita ka ng Tagalog, maaari kang gumamit ng mga serbisyo ng tulong sa wika nang walang bayad. Tumawag sa {ph} (TTY: 711).",
        f"ATTENTION : Si vous parlez français, des services d'aide linguistique vous sont proposés gratuitement. Appelez le {ph} (ATS : 711).",
        f"ATENÇÃO: Se fala português, encontram-se disponíveis serviços linguísticos, grátis. Ligue para {ph} (TTY: 711).",
        f"UWAGA: Jeżeli mówisz po polsku, możesz skorzystać z bezpłatnej pomocy językowej. Zadzwoń pod numer {ph} (TTY: 711).",
        f"ATTENZIONE: In caso la lingua parlata sia l'italiano, sono disponibili servizi di assistenza linguistica gratuiti. Chiamare il numero {ph} (TTY: 711).",
    ]
    for tl in taglines:
        if isinstance(tl, tuple):
            img, w_, h_ = cjk_line(tl[1])
            c.drawImage(img, L, T(y + 2.2), width=w_, height=h_, mask="auto")
            y += 9
        else:
            text(c, L, y, tl, "DV", 5.9, HexColor("#3c4044"))
            y += 9
    text(c, R, H - 26, "Page 2 of 2", "Sans", 6.5, GRAY, align="right")
    synthetic_footer(c)
    c.showPage()
    c.save()
