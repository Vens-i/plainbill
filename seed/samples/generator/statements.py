"""Harborview's paper patient statements: what the clinic sends out today (the 'before')."""
from common import *
from data import *

RED = HexColor("#b3261e")


def checkbox(c, x, y, label):
    box(c, x, y - 6, 6, 6, width=0.5)
    text(c, x + 9, y, label, "Sans", 6.2)


def statement(path, *, patient, address, account, stmt_date, rows, aging, message, notice=None, stmt_id):
    amount_due = rows[-1][-1]
    c = new_canvas(path, f"Harborview Family Medicine statement {account}")
    L, R = 30, W - 30

    # ---------------- Remittance coupon (top third) ----------------
    text(c, L, 34, "HARBORVIEW FAMILY MEDICINE", "Sans-Bold", 8.5)
    text(c, L, 44, "220 HARBOR ST STE 4", "Sans", 7.5)
    text(c, L, 53, "HARBORVIEW CA 94000-1022", "Sans", 7.5)
    text(c, L, 66, "ADDRESS SERVICE REQUESTED", "Sans-Bold", 6.2)

    # card box
    cx, cy = 318, 26
    box(c, cx, cy, R - cx, 88, width=0.6)
    text(c, cx + 6, cy + 10, "IF PAYING BY CREDIT CARD, FILL OUT BELOW.", "Sans-Bold", 6.3)
    for i, lab in enumerate(["VISA", "MASTERCARD", "DISCOVER", "AMEX"]):
        checkbox(c, cx + 6 + [0, 52, 130, 200][i], cy + 22, lab)
    for i, lab in enumerate(["CARD NUMBER", "SIGNATURE", "EXP. DATE", "CVV", "AMOUNT"]):
        pass
    text(c, cx + 6, cy + 38, "CARD NUMBER", "Sans", 5.8)
    hrule(c, cx + 52, R - 6, cy + 38, 0.4)
    text(c, cx + 6, cy + 52, "SIGNATURE", "Sans", 5.8)
    hrule(c, cx + 52, cx + 160, cy + 52, 0.4)
    text(c, cx + 166, cy + 52, "EXP. DATE", "Sans", 5.8)
    hrule(c, cx + 200, R - 6, cy + 52, 0.4)
    text(c, cx + 6, cy + 66, "BILLING ZIP", "Sans", 5.8)
    hrule(c, cx + 52, cx + 160, cy + 66, 0.4)
    text(c, cx + 166, cy + 66, "AMOUNT", "Sans", 5.8)
    hrule(c, cx + 200, R - 6, cy + 66, 0.4)
    text(c, cx + 6, cy + 81, "OR PAY ONLINE AT " + PRACTICE["pay_url"].upper() + "  ·  STATEMENT ID " + stmt_id, "Sans", 5.8)

    # amount box
    ay = 122
    hx = [318, 392, 474, R]
    heads = ["STATEMENT DATE", "PAY THIS AMOUNT", "ACCT. #"]
    vals = [stmt_date, f"${amount_due:,.2f}", account]
    for i in range(3):
        box(c, hx[i], ay, hx[i + 1] - hx[i], 12, fill=LIGHT, width=0.6)
        box(c, hx[i], ay + 12, hx[i + 1] - hx[i], 18, width=0.6)
        text(c, (hx[i] + hx[i + 1]) / 2, ay + 9, heads[i], "Sans-Bold", 5.8, align="center")
        text(c, (hx[i] + hx[i + 1]) / 2, ay + 25, vals[i], "Sans-Bold" if i == 1 else "Sans", 9 if i == 1 else 8, align="center")
    box(c, 318, ay + 30, 156, 12, fill=LIGHT, width=0.6)
    text(c, 396, ay + 39, "SHOW AMOUNT PAID HERE", "Sans-Bold", 5.8, align="center")
    box(c, 474, ay + 30, R - 474, 12, width=0.6)
    text(c, 480, ay + 39, "$", "Sans", 7)

    if notice:
        box(c, L, 82, 170, 20, stroke=RED, width=1.4)
        text(c, L + 85, 96, notice, "Sans-Bold", 10, RED, align="center")

    # window address
    wy = 128
    text(c, L + 18, wy, "▪▪ ▪▪▪ ▪ ▪▪▪▪ ▪▪ ▪▪▪ ▪▪ ▪ ▪▪▪ ▪▪▪▪ ▪ ▪▪", "DV", 6)
    for i, s in enumerate([patient.upper()] + address):
        text(c, L + 18, wy + 12 + i * 10, s, "Sans", 8.5)

    text(c, 318, 186, "MAKE CHECKS PAYABLE TO / REMIT TO:", "Sans-Bold", 6)
    for i, s in enumerate(["HARBORVIEW FAMILY MEDICINE", "220 HARBOR ST STE 4", "HARBORVIEW CA 94000-1022"]):
        text(c, 330, 198 + i * 10, s, "Sans", 8.5)
    text(c, 318, 240, f"{account}  {stmt_id}  {int(amount_due * 100):09d}  4", "Mono", 8)

    # perforation
    py = 262
    hrule(c, L - 10, R + 10, py, 0.7, dash=(3, 2))
    text(c, W / 2, py + 9, "▲  PLEASE DETACH AND RETURN TOP PORTION WITH YOUR PAYMENT  ▲", "DV", 6.2, align="center")

    # ---------------- Statement body ----------------
    y = py + 28
    text(c, L, y, "HARBORVIEW FAMILY MEDICINE", "Sans-Bold", 11)
    text(c, R, y, "PATIENT STATEMENT", "Sans-Bold", 11, align="right")
    y += 10
    text(c, L, y, f"220 HARBOR ST STE 4 · HARBORVIEW CA 94000 · {PRACTICE['phone']}", "Sans", 7)
    y += 10
    bx = [L, 150, 290, 450, R]
    bh = ["ACCOUNT #", "STATEMENT DATE", "PATIENT NAME", "PAGE"]
    bv = [account, stmt_date, patient.upper(), "1 OF 1"]
    for i in range(4):
        box(c, bx[i], y, bx[i + 1] - bx[i], 11, fill=LIGHT, width=0.6)
        box(c, bx[i], y + 11, bx[i + 1] - bx[i], 15, width=0.6)
        text(c, (bx[i] + bx[i + 1]) / 2, y + 8, bh[i], "Sans-Bold", 5.8, align="center")
        text(c, (bx[i] + bx[i + 1]) / 2, y + 22, bv[i], "Sans", 7.8, align="center")
    y += 36

    cols = [("DATE", L + 4, "l"), ("PATIENT", L + 50, "l"), ("CODE", L + 128, "l"), ("DESCRIPTION", L + 170, "l"),
            ("CHARGES", L + 418, "r"), ("CREDITS", L + 478, "r"), ("BALANCE", R - 4, "r")]
    box(c, L, y, R - L, 12, fill=LIGHT, width=0.6)
    for lab, x, a in cols:
        text(c, x, y + 9, lab, "Sans-Bold", 6.2, align="left" if a == "l" else "right")
    y += 22
    table_top = y - 22
    for r in rows:
        date, pt, code, desc, chg, cred, bal = r
        vals = [date, pt, code, desc, money(chg, True) if chg else "", f"-{money(cred)}" if cred else "", money(bal) if bal is not None else ""]
        for (lab, x, a), v in zip(cols, vals):
            text(c, x, y, v, "Mono", 7.2, align="left" if a == "l" else "right")
        y += 11
    y += 30
    box(c, L, table_top, R - L, y - table_top - 8, width=0.6)

    # aging
    y += 0
    ah = ["CURRENT", "31–60 DAYS", "61–90 DAYS", "91–120 DAYS", "OVER 120 DAYS", "AMOUNT DUE"]
    aw = (R - L) / 6
    for i, lab in enumerate(ah):
        x = L + i * aw
        box(c, x, y, aw, 11, fill=LIGHT if i < 5 else INK, width=0.6)
        box(c, x, y + 11, aw, 16, width=0.6 if i < 5 else 1.4)
        text(c, x + aw / 2, y + 8, lab, "Sans-Bold", 5.8, HexColor("#ffffff") if i == 5 else INK, align="center")
        v = aging[i] if i < 5 else amount_due
        text(c, x + aw / 2, y + 23, f"${v:,.2f}" if i == 5 else money(v), "Sans-Bold" if i == 5 else "Mono", 8.5 if i == 5 else 7.5, align="center")
    y += 40

    # message
    box(c, L, y, R - L, 54, width=0.6)
    text(c, L + 6, y + 10, "MESSAGES", "Sans-Bold", 6.2)
    wrap(c, L + 6, y + 21, R - L - 12, message, "Mono", 7, leading=9)
    y += 64
    text(c, L, y, f"BILLING QUESTIONS? CALL {PRACTICE['phone']} · {PRACTICE['hours'].upper()} · PLEASE HAVE YOUR ACCOUNT # READY.", "Sans-Bold", 6.6)
    y += 9
    text(c, L, y, f"PAY ONLINE 24/7 AT {PRACTICE['pay_url'].upper()} · ENTER ACCOUNT # AND STATEMENT ID {stmt_id}. WE ACCEPT VISA, MC, DISCOVER AND AMEX.", "Sans", 6.6)
    y += 9
    text(c, L, y, "BALANCES NOT PAID WITHIN 30 DAYS OF THE STATEMENT DATE ARE CONSIDERED PAST DUE. A $25.00 FEE APPLIES TO RETURNED CHECKS.", "Sans", 6.6)
    synthetic_footer(c)
    c.showPage()
    c.save()


def maria_statement(path):
    cl = CLAIMS["maria"]
    t = totals(cl)
    rows = []
    bal = 0
    for ln in cl["lines"]:
        bal += ln["billed"]
        rows.append(("10/03/26", "MARIA", ln["proc"], CPT_DESC[ln["proc"]], ln["billed"], 0, bal))
    rows.append(("10/04/26", "MARIA", "", "CLAIM FILED TO TIDEWATER HEALTH PLAN", 0, 0, None))
    bal -= t["paid"]
    rows.append(("10/08/26", "MARIA", "INSPMT", "INS PMT TIDEWATER HP EFT BC1008120117", 0, t["paid"], bal))
    bal -= t["co"]
    rows.append(("10/08/26", "MARIA", "CO45", "CONTRACTUAL ADJ - TIDEWATER HP", 0, t["co"], bal))
    rows.append(("10/08/26", "MARIA", "PR1 PR2", f"PT RESP: DED {t['ded']:.2f} COINS {t['coins']:.2f}", 0, 0, bal))
    assert bal == t["pr"] == 240
    statement(
        path, patient="Maria Delgado", address=["418 SEACLIFF AVE APT 2B", "HARBORVIEW CA 94000-2213"],
        account="004417", stmt_date="10/10/2026", rows=rows, aging=[240, 0, 0, 0, 0], stmt_id="S7741802",
        message="YOUR INSURANCE HAS PROCESSED THIS CLAIM. THE REMAINING BALANCE IS YOUR RESPONSIBILITY AND IS DUE UPON "
                "RECEIPT. IF YOU HAVE QUESTIONS ABOUT YOUR BALANCE OR WISH TO MAKE PAYMENT ARRANGEMENTS, PLEASE CALL OUR "
                "BILLING OFFICE. THANK YOU FOR CHOOSING HARBORVIEW FAMILY MEDICINE.",
    )


def aisha_statement(path):
    rows = []
    bal = 0
    for proc, amt in [("99204", 420), ("20610", 380), ("73562", 400)]:
        bal += amt
        rows.append(("06/20/26", "AISHA", proc, CPT_DESC[proc], amt, 0, bal))
    rows.append(("06/20/26", "AISHA", "SP", "SELF PAY - NO INSURANCE ON FILE", 0, 0, None))
    rows.append(("06/24/26", "AISHA", "", "STATEMENT 1 SENT", 0, 0, None))
    bal -= 300
    rows.append(("07/15/26", "AISHA", "PTPMT", "PATIENT PAYMENT - THANK YOU", 0, 300, bal))
    rows.append(("09/08/26", "AISHA", "", "STATEMENT 2 SENT", 0, 0, None))
    bal -= 300
    rows.append(("10/02/26", "AISHA", "PTPMT", "PATIENT PAYMENT - THANK YOU", 0, 300, bal))
    assert bal == 600
    statement(
        path, patient="Aisha Bello", address=["77 LINDEN CT", "HARBORVIEW CA 94000-3307"],
        account="003862", stmt_date="10/10/2026", rows=rows, aging=[0, 0, 0, 600, 0], stmt_id="S7741815",
        notice="SECOND NOTICE · PAST DUE",
        message="YOUR ACCOUNT IS PAST DUE. PLEASE REMIT THE BALANCE IN FULL WITHIN 15 DAYS OF THE DATE OF THIS NOTICE. "
                "ACCOUNTS THAT REMAIN UNPAID MAY BE REFERRED TO AN OUTSIDE COLLECTION AGENCY. IF YOU HAVE ALREADY SENT "
                "PAYMENT, PLEASE DISREGARD THIS NOTICE.",
    )
