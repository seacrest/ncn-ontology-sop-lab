# NCN Ontology SOP Lab

Runnable UI for SOP-AP-014 (invoice 3-way match) on the `ncn.otc` ontology. ScopeGate sits below the model. T3 `propose_payment` is never on the agent allowlist.

## Web UI

- Repo UI files: `web/`
- Live (GitHub Pages, after first workflow): https://seacrest.github.io/ncn-ontology-sop-lab/
- Local: `python3 run.py serve --port 8765` then open http://127.0.0.1:8765/

Click **Run all**. Golden set TSR should be 100% and unowned writes 0.

| Case | Expect |
|------|--------|
| INV-1001 | WRITE_EXCEPTION (price +1.5%) |
| INV-1002 | HITL_PAY (price +4%) |
| INV-1003 | HITL_QTY |
| INV-1004 | CREATE_HOLD |
| INV-1005 | MATCH_OK |

Enable Pages: Settings → Pages → GitHub Actions, or wait for `.github/workflows/pages.yml`.
