# NCN Ontology SOP Lab

Runnable UI for SOP-AP-014 (invoice 3-way match) on the `ncn.otc` ontology. ScopeGate sits below the model. T3 `propose_payment` is never on the agent allowlist.

## Live

**Open the lab:** https://cdn.jsdelivr.net/gh/seacrest/ncn-ontology-sop-lab@main/web/index.html

Source: https://github.com/seacrest/ncn-ontology-sop-lab

Click **Run all**. Golden set TSR should be 100% and unowned writes 0.

| Case | Expect |
|------|--------|
| INV-1001 | WRITE_EXCEPTION (price +1.5%) |
| INV-1002 | HITL_PAY (price +4%) |
| INV-1003 | HITL_QTY |
| INV-1004 | CREATE_HOLD |
| INV-1005 | MATCH_OK |

## Local

```bash
python3 run.py serve --port 8765
```

Then http://127.0.0.1:8765/

Official GitHub Pages (`https://seacrest.github.io/ncn-ontology-sop-lab/`) needs one click: repo **Settings → Pages → Source = GitHub Actions**, then re-run the Pages workflow. Until that is enabled, use the jsDelivr URL above.
