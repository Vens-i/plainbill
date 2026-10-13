"""Provider remittance advices: what the clinic receives from the payer."""
from common import *
from data import *

# ---------------------------------------------------------------------------
# Tidewater: old-school fixed-width "paper ERA" printout
# ---------------------------------------------------------------------------
MONO_SIZE = 6.7
LEAD = 9.2
X0 = 34

ROW = "{rend:<11} {dos:<10} {pos:>3} {nos:>3} {proc:<6} {mods:<5} {billed:>10} {allowed:>10} {ded:>10} {coins:>10} {copay:>10}  {grp:<7} {amt:>10} {paid:>10}"


def mline(c, y, s, bold=False):
    c.setFont("Mono-Bold" if bold else "Mono", MONO_SIZE)
    c.setFillColor(INK)
    c.drawString(X0, T(y), s)
    return y + LEAD


def tidewater_header(c, page, pages, pay_date, trace, amount):
    y = 40
    text(c, X0, y, "TIDEWATER HEALTH PLAN", "Mono-Bold", 11)
    text(c, W - X0, y, "PROVIDER REMITTANCE ADVICE", "Mono-Bold", 9, align="right")
    y += 12
    text(c, X0, y, "PO BOX 4400", "Mono", 7.5)
    text(c, W - X0, y, f"PAGE {page} OF {pages}", "Mono", 7.5, align="right")
    y += 9.5
    text(c, X0, y, "HARBORVIEW CA 94001", "Mono", 7.5)
    text(c, W - X0, y, f"REMIT DATE: {pay_date}", "Mono", 7.5, align="right")
    y += 9.5
    text(c, X0, y, f"PROVIDER SERVICES {TIDEWATER['provider_phone']}", "Mono", 7.5)
    y += 20
    y = mline(c, y, "PAYEE NAME: HARBORVIEW FAMILY MEDICINE              PAYEE NPI: 1999999984      TAX ID: XX-XXX9999")
    y = mline(c, y, "           220 HARBOR ST STE 4                     PAYMENT METHOD: ACH        PAYMENT DATE: " + pay_date)
    y = mline(c, y, f"           HARBORVIEW CA 94000                     EFT TRACE #: {trace}   PAYMENT AMOUNT: ${amount:,.2f}")
    y += 4
    y = mline(c, y, "=" * 129)
    return y


def tidewater_remit(path, pay_date, trace, claim_keys, note=None):
    claims = [CLAIMS[k] for k in claim_keys]
    tot = {k: sum(totals(cl)[k] for cl in claims) for k in ["billed", "allowed", "co", "ded", "coins", "copay", "paid", "pr"]}
    c = new_canvas(path, f"Tidewater Health Plan remittance {trace}")
    y = tidewater_header(c, 1, 2, pay_date, trace, tot["paid"])
    hdr = ROW.format(rend="REND-PROV", dos="SERV-DATE", pos="POS", nos="NOS", proc="PROC", mods="MODS",
                     billed="BILLED", allowed="ALLOWED", ded="DEDUCT", coins="COINS", copay="COPAY",
                     grp="GRP-RC", amt="AMT", paid="PROV-PD")
    y = mline(c, y, hdr, bold=True)
    y = mline(c, y, "-" * 129)
    for cl in claims:
        t = totals(cl)
        rend = PROVIDERS[cl["provider"]][2]
        y += 3
        y = mline(c, y, f"NAME {cl['last']}, {cl['first']:<22} MID {cl['member']:<14} ACNT {cl['acnt']:<12} ICN {cl['icn']:<15} ASG Y   CLM STATUS {'4 DENIED' if t['paid'] == 0 else '1 PROCESSED AS PRIMARY'}", bold=True)
        for ln in cl["lines"]:
            adjs = []
            if ln["co"]:
                adjs.append(("CO-" + ln["co_code"], ln["co"]))
            if ln["ded"]:
                adjs.append(("PR-1", ln["ded"]))
            if ln["coins"]:
                adjs.append(("PR-2", ln["coins"]))
            if ln["copay"]:
                adjs.append(("PR-3", ln["copay"]))
            first = adjs[0] if adjs else ("", 0)
            dos = cl["dos"][:2] + cl["dos"][3:5] + " " + cl["dos"][:2] + cl["dos"][3:5] + cl["dos"][8:10]
            y = mline(c, y, ROW.format(rend=rend, dos=dos, pos="11", nos="1", proc=ln["proc"], mods="",
                                       billed=money(ln["billed"]), allowed=money(ln["allowed"]),
                                       ded=money(ln["ded"]), coins=money(ln["coins"]), copay=money(ln["copay"]),
                                       grp=first[0], amt=money(first[1]), paid=money(ln["paid"])))
            for g, a in adjs[1:]:
                y = mline(c, y, ROW.format(rend="", dos="", pos="", nos="", proc="", mods="", billed="", allowed="",
                                           ded="", coins="", copay="", grp=g, amt=money(a), paid=""))
            if cl.get("remarks"):
                y = mline(c, y, " " * 30 + "REM: " + " ".join(cl["remarks"]))
        y = mline(c, y, ROW.format(rend=f"PT RESP", dos=money(t["pr"]), pos="", nos="", proc="", mods="CLAIM",
                                   billed=money(t["billed"]), allowed=money(t["allowed"]), ded=money(t["ded"]),
                                   coins=money(t["coins"]), copay=money(t["copay"]), grp="", amt=money(t["co"] + t["pr"]),
                                   paid=money(t["paid"])), bold=True)
        y = mline(c, y, " " * 41 + "ADJ TO TOTALS:  PREV PD 0.00   INTEREST 0.00   LATE FILING CHARGE 0.00" + " " * 5 + f"NET {money(t['paid']):>10}")
        y = mline(c, y, "-" * 129)
    y += 8
    y = mline(c, y, "TOTALS:  # OF    BILLED     ALLOWED      DEDUCT       COINS       COPAY      TOTAL     PROV-PD    PROV ADJ       CHECK", bold=True)
    y = mline(c, y, "         CLAIMS  AMT        AMT          AMT          AMT         AMT        RC-AMT    AMT        AMT            AMT", bold=True)
    y = mline(c, y, f"         {len(claims):<6}  {money(tot['billed']):<10} {money(tot['allowed']):<12} {money(tot['ded']):<12} {money(tot['coins']):<11} {money(tot['copay']):<10} {money(tot['co'] + tot['pr']):<9} {money(tot['paid']):<10} {'0.00':<14} {money(tot['paid'])}")
    y += 8
    y = mline(c, y, "PROVIDER ADJ DETAILS:  PLB REASON CODE    FCN    HIC    AMOUNT")
    y = mline(c, y, "                       NONE")
    if note:
        y += 10
        for n in note:
            y = mline(c, y, n, bold=True)
    synthetic_footer(c)
    c.showPage()

    # Page 2: the code glossary every remit carries
    y = tidewater_header(c, 2, 2, pay_date, trace, tot["paid"])
    y += 4
    y = mline(c, y, "GLOSSARY: GROUP, REASON, AND REMARK CODES", bold=True)
    y += 3
    gl = [
        ("CO", "CONTRACTUAL OBLIGATION. AMOUNT FOR WHICH THE PROVIDER IS FINANCIALLY LIABLE. THE PATIENT MAY NOT BE BILLED FOR THIS AMOUNT."),
        ("PR", "PATIENT RESPONSIBILITY. AMOUNT THAT MAY BE BILLED TO THE PATIENT OR ANOTHER PAYER."),
        ("OA", "OTHER ADJUSTMENT."),
        ("1", "DEDUCTIBLE AMOUNT."),
        ("2", "COINSURANCE AMOUNT."),
        ("3", "CO-PAYMENT AMOUNT."),
        ("45", "CHARGE EXCEEDS FEE SCHEDULE/MAXIMUM ALLOWABLE OR CONTRACTED/LEGISLATED FEE ARRANGEMENT. USE GROUP CODE CO."),
        ("197", "PRECERTIFICATION/AUTHORIZATION/NOTIFICATION/PRE-TREATMENT ABSENT."),
        ("M62", "MISSING/INCOMPLETE/INVALID TREATMENT AUTHORIZATION CODE."),
        ("N/A", "NOT APPLICABLE."),
        ("ASG", "ASSIGNMENT OF BENEFITS INDICATOR. Y = PAYMENT MADE TO PROVIDER."),
        ("ICN", "INTERNAL CONTROL NUMBER ASSIGNED BY TIDEWATER HEALTH PLAN TO THIS CLAIM."),
        ("NOS", "NUMBER OF SERVICES (UNITS)."),
        ("POS", "PLACE OF SERVICE. 11 = OFFICE."),
    ]
    for code, desc in gl:
        y = mline(c, y, f"{code:<6} {desc}")
    y += 12
    for s in [
        "THIS REMITTANCE ADVICE REFLECTS CLAIMS ADJUDICATED UNDER THE TERMS OF THE MEMBER'S BENEFIT PLAN AND YOUR PARTICIPATION AGREEMENT.",
        "AMOUNTS SHOWN UNDER GROUP CODE PR MAY BE COLLECTED FROM THE MEMBER. AMOUNTS UNDER GROUP CODE CO MAY NOT BE COLLECTED FROM THE MEMBER.",
        "TO REQUEST A RECONSIDERATION, SUBMIT A CORRECTED CLAIM OR WRITTEN APPEAL WITHIN 180 DAYS OF THE REMIT DATE TO THE ADDRESS ABOVE.",
        "REFERENCE THE ICN ON ALL CORRESPONDENCE.",
    ]:
        y = mline(c, y, s)
    synthetic_footer(c)
    c.showPage()
    c.save()


# ---------------------------------------------------------------------------
# Granite: modern, boxed commercial-payer PDF remit
# ---------------------------------------------------------------------------
PURPLE = HexColor("#3f3a6b")
PURPLE_L = HexColor("#ecebf3")


def granite_logo(c, x, y):
    c.saveState()
    c.setFillColor(PURPLE)
    p = c.beginPath()
    p.moveTo(x, T(y + 22))
    p.lineTo(x + 13, T(y))
    p.lineTo(x + 20, T(y + 11))
    p.lineTo(x + 25, T(y + 5))
    p.lineTo(x + 34, T(y + 22))
    p.close()
    c.drawPath(p, fill=1, stroke=0)
    c.restoreState()
    text(c, x + 42, y + 12, "Granite Mutual", "Sans-Bold", 14, PURPLE)
    text(c, x + 42, y + 22, "H E A L T H", "Sans", 6.5, PURPLE)


def granite_remit(path, pay_date, trace, claim_keys):
    claims = [CLAIMS[k] for k in claim_keys]
    tot = {k: sum(totals(cl)[k] for cl in claims) for k in ["billed", "allowed", "co", "ded", "coins", "copay", "paid", "pr"]}
    c = new_canvas(path, f"Granite Mutual Health payment summary {trace}")
    L, R = 36, W - 36
    granite_logo(c, L, 30)
    text(c, R, 40, "Provider Explanation of Payment", "Sans-Bold", 12, align="right")
    text(c, R, 52, "Remittance advice · This is not a bill", "Sans", 7.5, GRAY, align="right")

    # Payment box
    y = 72
    box(c, L, y, R - L, 58, stroke=PURPLE, fill=PURPLE_L, width=0.8, radius=3)
    cols = [("Payee", ["HARBORVIEW FAMILY MEDICINE", "220 HARBOR ST STE 4", "HARBORVIEW CA 94000"]),
            ("Payee NPI / TIN", ["1999999984", "XX-XXX9999"]),
            ("Payment", [f"Date: {pay_date}", f"Number: {trace}", "Type: EFT (ACH CCD+)"]),
            ("Payment amount", [f"${tot['paid']:,.2f}"])]
    xs = [L + 10, L + 190, L + 300, L + 440]
    for (lab, vals), x in zip(cols, xs):
        text(c, x, y + 13, lab.upper(), "Sans-Bold", 6, PURPLE)
        for i, v in enumerate(vals):
            if lab == "Payment amount":
                text(c, x, y + 34, v, "Sans-Bold", 16)
            else:
                text(c, x, y + 24 + i * 9.5, v, "Sans", 7.5)
    y += 74

    heads = ["Line", "Service date", "Proc / mod", "Units", "Billed", "Allowed", "Not covered", "Deductible", "Coinsurance", "Copay", "Plan paid", "Codes"]
    cx = [L + 4, L + 26, L + 80, L + 128, L + 160, L + 208, L + 256, L + 306, L + 356, L + 402, L + 446, L + 494]
    right_cols = {4, 5, 6, 7, 8, 9, 10}
    widths = [22, 54, 48, 32, 48, 48, 50, 50, 46, 44, 48, 40]

    for cl in claims:
        t = totals(cl)
        pf, pl, _ = PROVIDERS[cl["provider"]]
        box(c, L, y, R - L, 26, stroke=None, fill=LIGHT)
        text(c, L + 6, y + 10, f"Patient: {cl['last']}, {cl['first']}", "Sans-Bold", 8)
        text(c, L + 170, y + 10, f"Member ID: {cl['member']}", "Sans", 7.5)
        text(c, L + 300, y + 10, f"Patient acct: {cl['acnt']}", "Sans", 7.5)
        text(c, R - 6, y + 10, f"Claim #: {cl['icn']}", "Sans-Bold", 7.5, align="right")
        text(c, L + 6, y + 21, f"Rendering provider: {pf} {pl}   ·   Network: In-network   ·   Received {cl['received']}   ·   Processed {cl['processed']}   ·   Claim status: Paid", "Sans", 6.8, GRAY)
        y += 38
        for i, h_ in enumerate(heads):
            if i in right_cols:
                text(c, cx[i] + widths[i] - 4, y, h_, "Sans-Bold", 6.3, GRAY, align="right")
            else:
                text(c, cx[i], y, h_, "Sans-Bold", 6.3, GRAY)
        hrule(c, L, R, y + 4, 0.5, RULE)
        y += 14
        for n, ln in enumerate(cl["lines"], 1):
            codes = []
            if ln["co"]:
                codes.append(f"CO{ln['co_code']}")
            if ln["ded"]:
                codes.append("PR1")
            if ln["coins"]:
                codes.append("PR2")
            if ln["copay"]:
                codes.append("PR3")
            vals = [str(n), cl["dos"], ln["proc"], "1", money(ln["billed"]), money(ln["allowed"]), money(ln["co"]),
                    money(ln["ded"]), money(ln["coins"]), money(ln["copay"]), money(ln["paid"]), " ".join(codes)]
            for i, v in enumerate(vals):
                font = "Mono" if i in (2,) else "Sans"
                if i in right_cols:
                    text(c, cx[i] + widths[i] - 4, y, v, font, 7.3, align="right")
                else:
                    text(c, cx[i], y, v, font, 7.3 if i != 11 else 6.3)
            y += 12
        hrule(c, L, R, y - 7, 0.5, RULE)
        y += 3
        tv = ["", "Claim totals", "", "", money(t["billed"]), money(t["allowed"]), money(t["co"]), money(t["ded"]),
              money(t["coins"]), money(t["copay"]), money(t["paid"]), ""]
        for i, v in enumerate(tv):
            if not v:
                continue
            if i in right_cols:
                text(c, cx[i] + widths[i] - 4, y, v, "Sans-Bold", 7.3, align="right")
            else:
                text(c, cx[i], y, v, "Sans-Bold", 7.3)
        y += 13
        text(c, L + 26, y, f"Patient responsibility: ${t['pr']:,.2f}   (deductible ${t['ded']:,.2f} + coinsurance ${t['coins']:,.2f} + copay ${t['copay']:,.2f})", "Sans-Bold", 7.3, PURPLE)
        y += 22

    # Totals
    box(c, L, y, R - L, 40, stroke=PURPLE, width=0.8, radius=3)
    labels = [("Claims", str(len(claims))), ("Total billed", money(tot["billed"])), ("Total allowed", money(tot["allowed"])),
              ("Not covered (CO)", money(tot["co"])), ("Patient resp. (PR)", money(tot["pr"])),
              ("Provider adj.", "0.00"), ("Payment amount", f"${tot['paid']:,.2f}")]
    for i, (lab, v) in enumerate(labels):
        x = L + 10 + i * 77
        text(c, x, y + 14, lab.upper(), "Sans-Bold", 5.6, PURPLE)
        text(c, x, y + 29, v, "Sans-Bold" if i == 6 else "Sans", 9 if i == 6 else 8.5)
    y += 58

    text(c, L, y, "CODE KEY", "Sans-Bold", 7, PURPLE)
    y += 11
    for code, d in [
        ("CO45", "Charges exceed the contracted fee arrangement. Provider write-off; do not bill the member."),
        ("PR1", "Deductible amount — member responsibility."),
        ("PR2", "Coinsurance amount — member responsibility."),
        ("PR3", "Copayment amount — member responsibility."),
    ]:
        text(c, L, y, code, "Mono-Bold", 7)
        text(c, L + 36, y, d, "Sans", 7)
        y += 10
    y += 8
    y = wrap(c, L, y, R - L,
             "Amounts listed as Not covered (CO) are adjustments under your participation agreement with Granite Mutual Health and may not be "
             "billed to the member. Amounts listed as patient responsibility may be billed to the member. Corrected claims and reconsideration "
             f"requests must be received within 180 days of the payment date. Provider Services: {GRANITE['provider_phone']}, Mon–Fri 7am–7pm PT.",
             size=6.6, color=GRAY)
    synthetic_footer(c)
    c.showPage()
    c.save()
