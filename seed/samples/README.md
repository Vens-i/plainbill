# Sample billing documents (synthetic)

Realistic-looking documents for the demo and for testing extraction. **Everything is fictional**:
the patients, Harborview Family Medicine, and both payers. Each page says so in its footer. The
numbers match `seed/src/spec.ts`. These files sit outside `seed/data/` so the seed loader ignores them.

| File | Who sends it → who reads it | What it shows |
|---|---|---|
| `inbound_tidewater_remit_2026-10-08.pdf` | Payer → clinic | Old-style fixed-width remittance, two claims (Maria Delgado, Samuel Ortiz), line-level CO/PR codes, $510 EFT, code glossary on page 2 |
| `inbound_tidewater_remit_2026-09-30_denial.pdf` | Payer → clinic | $0 remittance: James Whitfield's MRI denied, CO-197 + M62 (no prior auth) |
| `inbound_granite_remit_2026-09-14.pdf` | Payer → clinic | Modern boxed remittance from a second payer, two claims (Marcus Reid, Linda Park), $930 EFT |
| `patient_tidewater_eob_delgado.pdf` | Payer → Maria | Member EOB ("THIS IS NOT A BILL"), per-line deductible/coinsurance, remark codes, deductible tracker, page 2 of appeal rights. The only non-English text is one line of language taglines at the bottom |
| `outbound_harborview_statement_delgado.pdf` | Clinic → Maria | Today's paper statement: tear-off coupon, CPT codes, running balance, aging buckets, "due upon receipt." This is the **before** for the demo |
| `outbound_harborview_statement_delgado_phone_photo.jpg` | Clinic → Maria | The same statement photographed on a table, folded in thirds, for a "snap a photo of your bill" flow |
| `outbound_harborview_statement_bello_past_due.pdf` | Clinic → Aisha | "SECOND NOTICE · PAST DUE" with collections language, eight days after she made a payment |

`manifest.json` lists the expected values for each document (billed, discount, insurance paid,
patient owes, and deductible/coinsurance/copay), so it can serve as an answer key for extraction tests.

## Payer names

The seed uses real payer names (BCBS, Aetna, UHC) in `spec.ts`, but CLAUDE.md says payers are
fictional. These documents use fictional stand-ins in the same slots:
**Tidewater Health Plan** = BCBS slot, **Granite Mutual Health** = Aetna slot.

## Regenerate

```
pip install reportlab pillow numpy   # plus poppler (pdftoppm) for the photo
cd seed/samples/generator && python3 build.py ..
```
