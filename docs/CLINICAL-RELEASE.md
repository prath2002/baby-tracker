# Clinical release process (spec §19 release gates)

Every medical value lives in `reference/medical_reference_data.json` with provenance. At first deploy **nothing is CLEARED**, so parents see:

- **Feeding:** "No universal milk amount applies… Breastfeed responsively/on demand" (absence statement), measured-milk arithmetic and their own records. WHO guidance text appears only after it is cleared.
- **Low birth weight / preterm babies:** "Follow your baby's care-team feeding plan" plus the ability to record that plan. Clinical tables stay hidden.
- **Vaccines:** manual recording only (the schedule is pending verification).
- **Growth:** "pending clinical review" until datasets are imported, validated and cleared.

## Who clears a value

Two different named people for every item:

1. **Clinician reviewer:** a pediatrician or neonatologist who confirms applicability and wording.
2. **Source checker:** opens the primary source and confirms the exact value, unit, population and page/section.

## How

```bash
npm run reference:release -- --list
npm run reference:release -- --id FG_WHO_RESPONSIVE --gate CLEARED \
  --clinician "Dr A. Sharma, MD (Paediatrics), Reg. 12345" --checker "R. Iyer" --page "Key facts; Recommendations"
npm run reference:release -- --id CFR_NHM_FLUID_D3_LT_1500G --gate REJECTED --clinician "…" --checker "…" --note "Table differs in 2014 PDF p.27"
npm run reference:release -- --dataset WFA_MALE_DAY --gate CLEARED --clinician "…" --checker "…"
```

Every change is written to `reference_release_log`. If the JSON content of a cleared rule changes later, the next deploy **automatically resets** it to the file's gate.

## Suggested order (from the spec's open questions)

| Priority | Items | Notes |
|---|---|---|
| 1 | `FG_WHO_RESPONSIVE`, `FG_WHO_EBF_6M`, `FG_WHO_INITIATION_1H`, `FG_WHO_CONTINUED_BF`, `CF_WHO_*` | Verified from the WHO fact sheet (4 Aug 2026); needs human re-check of wording. |
| 2 | `UIP_*` vaccine items | Re-check against the current MoHFW Immunization Handbook. Resolve TT vs Td (Q11) and the rotavirus dose (Q12). |
| 3 | WHO growth datasets | After `npm run who:import`, compare ~200 z-scores with WHO Anthro (tolerance per Q9). |
| 4 | `CFR_NHM_*`, `BAI_IAP_*`, `FG_IAP_*`, `CFR_WHO_HEPNFS_*` | The NHM, IAP and WHO training PDFs could not be opened during research. Verify page by page (Q1), and decide whether parents should see LBW tables at all (Q2) and the day-of-life convention (Q3). |
| 5 | `IAP*` vaccine items | Load the **2025** IAP schedule as a new data version first (the file holds the superseded 2023 rows). |

Changing a value means editing the JSON in a pull request (with provenance), deploying, and then clearing it again.
