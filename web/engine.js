(function (global) {
  function get(ctx, path) {
    let cur = ctx;
    for (const part of String(path).split(".")) {
      if (cur && typeof cur === "object" && part in cur) cur = cur[part];
      else return undefined;
    }
    return cur;
  }
  function compare(left, pred, ctx) {
    if (pred === null || typeof pred !== "object" || Array.isArray(pred)) return left === pred;
    for (const [op, raw] of Object.entries(pred)) {
      let right = raw;
      if (typeof raw === "string" && raw.startsWith("policy.")) right = get(ctx, raw);
      if (op === "gt") { if (left == null || !(Number(left) > Number(right))) return false; }
      else if (op === "gte") { if (left == null || !(Number(left) >= Number(right))) return false; }
      else if (op === "lt") { if (left == null || !(Number(left) < Number(right))) return false; }
      else if (op === "lte") { if (left == null || !(Number(left) <= Number(right))) return false; }
      else if (op === "gt_ref") {
        const ref = typeof raw === "string" ? get(ctx, raw) : raw;
        if (left == null || ref == null || !(Number(left) > Number(ref))) return false;
      } else if (op === "eq") { if (left !== right) return false; }
      else return false;
    }
    return true;
  }
  function ruleMatches(when, ctx) {
    for (const [path, pred] of Object.entries(when || {})) {
      if (!compare(get(ctx, path), pred, ctx)) return false;
    }
    return true;
  }
  function indexObjects(caseDoc, objects) {
    const keys = {};
    for (const spec of objects) keys[spec.id] = spec.key;
    const keyed = {};
    const bag = caseDoc.objects || {};
    for (const [otype, rows] of Object.entries(bag)) {
      const key = keys[otype];
      keyed[otype] = {};
      for (const row of rows) keyed[otype][row[key]] = Object.assign({}, row);
    }
    return keyed;
  }
  function first(keyed, otype) {
    const vals = Object.values(keyed[otype] || {});
    return vals.length ? vals[0] : {};
  }
  function check(actionId, stepId, allowlist, actions) {
    const spec = actions[actionId];
    if (!spec) return { ok: false, reason: "unknown_action", tier: "" };
    const t3 = !!(spec.hitl || spec.tier === "T3");
    if (!allowlist.includes(actionId)) return { ok: false, reason: "not_on_step_allowlist", tier: spec.tier };
    if (t3) return { ok: false, reason: "t3_requires_hitl", tier: spec.tier };
    return { ok: true, reason: "ok", tier: spec.tier };
  }
  function execAction(actionId, ctx, keyed, actions, writes) {
    const spec = actions[actionId] || {};
    const invoice = first(keyed, "Invoice");
    const po = first(keyed, "PurchaseOrder");
    const gr = first(keyed, "GoodsReceipt");
    let seller = {}, buyer = {};
    if (invoice.seller_id && keyed.TradingParty) seller = keyed.TradingParty[invoice.seller_id] || {};
    if (po.buyer_id && keyed.TradingParty) buyer = keyed.TradingParty[po.buyer_id] || {};
    if (actionId === "read_po") { ctx.po = po; return po; }
    if (actionId === "read_gr") { ctx.gr = gr; return gr; }
    if (actionId === "read_invoice") { ctx.invoice = invoice; return invoice; }
    if (actionId === "read_party") { ctx.seller = seller; ctx.buyer = buyer; return { seller: seller, buyer: buyer }; }
    if (actionId === "assess_variance") {
      const qtyPo = Number(po.qty_ordered || 0), qtyGr = Number(gr.qty_received || 0), qtyInv = Number(invoice.qty_invoiced || 0);
      const pricePo = Number(po.unit_price || 0), priceInv = Number(invoice.unit_price || 0);
      const qtyBase = qtyGr || qtyPo;
      const qtyVar = qtyBase === 0 ? 0 : Math.max(0, (qtyInv - qtyGr) / qtyBase * 100);
      const priceVar = pricePo === 0 ? 0 : (priceInv - pricePo) / pricePo * 100;
      ctx.qty_variance_pct = Math.round(qtyVar * 10000) / 10000;
      ctx.price_variance_pct = Math.round(priceVar * 10000) / 10000;
      ctx.amount_variance = Math.round((priceInv - pricePo) * qtyInv * 10000) / 10000;
      return { qty_variance_pct: ctx.qty_variance_pct, price_variance_pct: ctx.price_variance_pct, amount_variance: ctx.amount_variance };
    }
    if (actionId === "write_exception_code") {
      const code = ctx.exception_code || "UNSPECIFIED";
      invoice.exception_code = code; invoice.match_status = "exception";
      writes.push({ object: "Invoice", field: "exception_code", value: code, tier: "T2" });
      return { written: code };
    }
    if (actionId === "create_hold") {
      const hold = { hold_id: "H-" + (invoice.invoice_id || ""), party_id: seller.party_id, reason: ctx.exception_code || "HOLD", active: true };
      keyed.ComplianceHold = keyed.ComplianceHold || {};
      keyed.ComplianceHold[hold.hold_id] = hold;
      writes.push({ object: "ComplianceHold", field: "active", value: true, tier: "T2" });
      ctx.hold = hold; return hold;
    }
    if (actionId === "notify_template") {
      const note = { notification_id: "N-" + (invoice.invoice_id || ""), template_id: ctx.template_id || "INV_EXCEPTION_VENDOR", party_id: seller.party_id, sent: true };
      const allowed = spec.allowed_templates || [];
      if (allowed.length && allowed.indexOf(note.template_id) < 0) return { sent: false, error: "template_not_allowlisted" };
      writes.push({ object: "Notification", field: "sent", value: true, tier: "T2" });
      ctx.notification = note; return note;
    }
    return { error: "no_executor_for_" + actionId };
  }
  function runCase(pack, caseId, sopId) {
    sopId = sopId || "SOP-AP-014";
    const caseDoc = pack.cases.find(function(c){return c.id===caseId;});
    const sop = pack.sops.find(function(s){return s.id===sopId;});
    if (!caseDoc || !sop) throw new Error("unknown case or sop");
    const actions = {};
    pack.actions.forEach(function(a){ actions[a.id]=a; });
    const keyed = indexObjects(caseDoc, pack.objects);
    const writes = [], path = [], toolCalls = [], violations = [];
    const ctx = { policy: sop.policy || {}, task: { invoice_id: caseId }, decision: null, exception_code: null, interrupt: false };
    var stepId = sop.start, visited = 0;
    while (stepId && visited < 50) {
      visited += 1;
      const step = sop.steps[stepId];
      path.push(stepId);
      const kind = step.kind, allow = step.allowlist || [];
      function runAllow() {
        allow.forEach(function(action){
          const gate = check(action, stepId, allow, actions);
          const result = gate.ok ? execAction(action, ctx, keyed, actions, writes) : { blocked: gate.reason };
          if (!gate.ok) violations.push({ action: action, reason: gate.reason, tier: gate.tier, step: stepId });
          toolCalls.push({ tool_name: action, ok: gate.ok, reason: gate.reason, step: stepId, tier: gate.tier, result: result });
        });
      }
      if (kind === "fetch" || kind === "compute") { runAllow(); stepId = step.next; continue; }
      if (kind === "decide") {
        var fired = null;
        (step.rules || []).some(function(rule){ if (ruleMatches(rule.when || {}, ctx)) { fired = rule; return true; } return false; });
        const chosen = (fired && fired.then) || step.default || {};
        if (chosen.decision) ctx.decision = chosen.decision;
        if (chosen.exception_code != null) ctx.exception_code = chosen.exception_code;
        ctx.fired_rule = (fired && fired.id) || "default";
        stepId = chosen.next || step.next; continue;
      }
      if (kind === "act") { if (step.template_id) ctx.template_id = step.template_id; runAllow(); stepId = step.next; continue; }
      if (kind === "interrupt") {
        ctx.interrupt = true;
        (step.blocked || []).forEach(function(blocked){
          const gate = check(blocked, stepId, allow, actions);
          violations.push({ action: blocked, reason: gate.reason, tier: gate.tier, step: stepId });
          toolCalls.push({ tool_name: blocked, ok: gate.ok, reason: gate.reason, step: stepId, tier: gate.tier, result: { blocked: gate.reason } });
        });
        stepId = step.next; continue;
      }
      if (kind === "finalize") break;
      stepId = step.next;
    }
    const output = ctx.decision || "UNDECIDED";
    const expect = caseDoc.expect || {};
    const correct = output === expect.decision && (expect.exception_code == null || ctx.exception_code === expect.exception_code) && (expect.interrupt == null || ctx.interrupt === expect.interrupt);
    return {
      case_id: caseId, label: caseDoc.label, sop: sopId, decision: output, exception_code: ctx.exception_code,
      interrupt: ctx.interrupt, fired_rule: ctx.fired_rule, path: path,
      evidence: { qty_variance_pct: ctx.qty_variance_pct, price_variance_pct: ctx.price_variance_pct, amount_variance: ctx.amount_variance, seller: (ctx.seller || {}).party_id, buyer: (ctx.buyer || {}).party_id },
      tool_calls: toolCalls, writes: writes, violations: violations,
      unowned_writes: writes.filter(function(w){ return w.tier === "T3"; }), expect: expect, correct: correct, objects: keyed
    };
  }
  function runAll(pack, sopId) {
    sopId = sopId || "SOP-AP-014";
    const results = pack.cases.map(function(c){ return runCase(pack, c.id, sopId); });
    const n = results.length || 1;
    const correct = results.filter(function(r){ return r.correct; }).length;
    return { sop: sopId, n: results.length, tsr: Math.round((correct / n) * 10000) / 10000, interrupts: results.filter(function(r){ return r.interrupt; }).length, violations: results.reduce(function(s,r){ return s + r.violations.length; }, 0), unowned_writes: results.reduce(function(s,r){ return s + r.unowned_writes.length; }, 0), results: results };
  }
  global.NCNEngine = { runCase: runCase, runAll: runAll };
})(window);
