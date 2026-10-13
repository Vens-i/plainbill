"""Synthetic sample-document data. Everything here is fictional.

Numbers match seed/src/spec.ts (Harborview Family Medicine, "today" = 2026-10-10).
Payers are fictional stand-ins for the seed's payer slots:
  BCBS slot  -> Tidewater Health Plan
  Aetna slot -> Granite Mutual Health
"""

PRACTICE = {
    "name": "Harborview Family Medicine",
    "addr1": "220 Harbor St, Suite 4",
    "city": "Harborview, CA 94000",
    "phone": "(555) 014-2290",
    "hours": "Mon–Fri 8–5",
    "npi": "1999999984",
    "tin": "XX-XXX9999",
    "pay_url": "pay.harborviewfm.example",
}

PROVIDERS = {
    "patel": ("ANAND", "PATEL", "1999999992"),
    "kim": ("HELEN", "KIM", "1999999976"),
    "okoye": ("CHIDI", "OKOYE", "1999999968"),
}

TIDEWATER = {
    "name": "Tidewater Health Plan",
    "addr": ["PO Box 4400", "Harborview, CA 94001"],
    "provider_phone": "1-800-555-0141",
    "member_phone": "1-800-555-0143",
}
GRANITE = {
    "name": "Granite Mutual Health",
    "addr": ["PO Box 18810", "Granite Falls, CA 94012"],
    "provider_phone": "1-800-555-0162",
}

# Short service descriptions (our own wording, as a practice-management system prints them)
CPT_DESC = {
    "99204": "NEW PT OFFICE VISIT LVL 4",
    "99213": "OFFICE/OUTPT VISIT EST LVL 3",
    "99214": "OFFICE/OUTPT VISIT EST LVL 4",
    "80053": "COMPREHENSIVE METABOLIC PANEL",
    "85025": "CBC W/ AUTO DIFF",
    "36415": "ROUTINE VENIPUNCTURE",
    "87880": "STREP A ASSAY W/ OPTIC",
    "93000": "ELECTROCARDIOGRAM COMPLETE",
    "71046": "X-RAY CHEST 2 VIEWS",
    "72148": "MRI LUMBAR SPINE W/O DYE",
    "20610": "ARTHROCENTESIS/INJ MAJOR JT",
    "73562": "X-RAY KNEE 3 VIEWS",
}


def line(proc, billed, allowed, co=0, ded=0, coins=0, copay=0, paid=0, co_code="45"):
    """One adjudicated service line. Invariant: billed - CO - (ded+coins+copay) - paid == 0."""
    d = dict(proc=proc, billed=billed, allowed=allowed, co=co, ded=ded, coins=coins,
             copay=copay, paid=paid, co_code=co_code)
    assert billed - co == allowed, (proc, "allowed")
    assert billed - co - ded - coins - copay - paid == 0, (proc, "balance")
    return d


CLAIMS = {
    "maria": dict(
        last="DELGADO", first="MARIA", member="XBC884210377", acnt="HFM1001",
        icn="BC26100800417", provider="patel", dos="10/03/2026", received="10/05/2026",
        processed="10/08/2026",
        lines=[
            line("99214", 350, 190, co=160, ded=190, paid=0),
            line("80053", 180, 50, co=130, paid=50),
            line("93000", 320, 210, co=110, ded=10, coins=40, paid=160),
        ],
    ),
    "samuel": dict(
        last="ORTIZ", first="SAMUEL", member="XBC552019846", acnt="HFM1012",
        icn="BC26100800452", provider="okoye", dos="09/22/2026", received="09/25/2026",
        processed="10/07/2026",
        lines=[
            line("99213", 280, 230, co=50, copay=80, paid=150),
            line("85025", 90, 80, co=10, paid=80),
            line("36415", 30, 25, co=5, paid=25),
            line("87880", 50, 45, co=5, paid=45),
        ],
    ),
    "james": dict(
        last="WHITFIELD", first="JAMES", member="XBC310588721", acnt="HFM1007",
        icn="BC26093000288", provider="okoye", dos="09/18/2026", received="09/22/2026",
        processed="09/29/2026", remarks=["M62", "N/A"],
        lines=[line("72148", 2400, 0, co=2400, paid=0, co_code="197")],
    ),
    "marcus": dict(
        last="REID", first="MARCUS", member="W204115689", acnt="HFM1006",
        icn="AE2609140377", provider="okoye", dos="08/25/2026", received="08/29/2026",
        processed="09/12/2026",
        lines=[
            line("99204", 400, 310, co=90, ded=150, paid=160),
            line("71046", 220, 200, co=20, coins=40, paid=160),
            line("93000", 280, 250, co=30, coins=50, paid=200),
        ],
    ),
    "linda": dict(
        last="PARK", first="LINDA", member="W166045812", acnt="HFM1013",
        icn="AE2609140342", provider="patel", dos="09/10/2026", received="09/11/2026",
        processed="09/12/2026",
        lines=[
            line("99213", 260, 240, co=20, coins=48, paid=192),
            line("80053", 210, 190, co=20, coins=38, paid=152),
            line("85025", 90, 80, co=10, coins=14, paid=66),
        ],
    ),
}


def totals(claim):
    keys = ["billed", "allowed", "co", "ded", "coins", "copay", "paid"]
    t = {k: sum(l[k] for l in claim["lines"]) for k in keys}
    t["pr"] = t["ded"] + t["coins"] + t["copay"]
    return t


# Seed-table cross-check (billed, discount, ins paid, owes)
SEED = {
    "maria": (850, 400, 210, 240),
    "samuel": (450, 70, 300, 80),
    "james": (2400, None, 0, 0),
    "marcus": (900, 140, 520, 240),
    "linda": (560, 50, 410, 100),
}
for k, (b, disc, p, owes) in SEED.items():
    t = totals(CLAIMS[k])
    assert t["billed"] == b and t["paid"] == p and t["pr"] == owes, k
    if disc is not None:
        assert t["co"] == disc, k


def money(v, blank_zero=False):
    if blank_zero and v == 0:
        return ""
    return f"{v:,.2f}"
