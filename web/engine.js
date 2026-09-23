/* In-browser ScopeGate + SOP walker. Mirrors engine/runtime.py. */
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
    if (pred === null || typeof pred !== "object" || Array.isArray(pred)) {
      return left === pred;
    }
    for (const [op, raw] of Object.entries(pred)) {
      let right = raw;
      if (typeof raw === "string" && raw.startsWith("policy.")) right = get(ctx, raw);
      if (op === "gt") {
        if (left == null || !(Number(left) > Number(right))) return false;
      } else if (op === "gte") {
        if (left == null || !(Number(left) >= Number(right))) return false;
      } else if (op === "lt") {
        if (left == null || !(Number(left) < Number(right))) return false;
      } else if (op === "lte") {
        if (left == null || !(Number(left) <= Number(right))) return false;
      } else if (op === "gt_ref") {
        const ref = typeof raw === "string" ? get(ctx, raw) : raw;
        if (left == null || ref == null || !(Number(left) > Number(ref))) return false;
      } else if (op === "eq") {
        if (left !== right) return false;
      } else {
        return false;
      }
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
      for (const row of rows) keyed[otype][row[key]] = { ...row };
    }
    return keyed;
  }

  function first(keyed, otype) {
    const items = keyed[otype] || {};
    const vals = Object.values(items);
    return vals.length ? vals[0] : {};
  }

  function snake(name) {
    return String(name).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  }

  function bindObjects(ctx, keyed) {
    for (const [otype, items] of Object.entries(keyed)) {
      const vals = Object.values(items);
      if (!vals.length) continue;
      ctx[otype] = vals[0];
      if (ctx[snake(otype)] == null) ctx[snake(otype)] = vals[0];
    }
  }

  function applyComputes(ctx, specs) {
    const out = {};
    for (const spec of specs || []) {
      const target = spec.set;
      if (!target) continue;
      let val;
      if (spec.from) val = get(ctx, spec.from);
      else {
        const left = get(ctx, spec.left || "");
        let right = get(ctx, spec.right || "");
        if (typeof spec.right === "string" && spec.right.startsWith("policy.")) right = get(ctx, spec.right);
        const op = spec.op || "copy";
        const n = (x) => Number(x || 0);
        if (op === "pct_over") val = n(right) === 0 ? 0 : (n(left) - n(right)) / n(right) * 100;
        else if (op === "ratio_pct") val = n(right) === 0 ? 0 : n(left) / n(right) * 100;
        else if (op === "delta") val = n(left) - n(right);
        else if (op === "max0") val = Math.max(0, n(left) - n(right));
        else val = left;
      }
      if (typeof val === "number") val = Math.round(val * 10000) / 10000;
      ctx[target] = val;
      out[target] = val;
    }
    return out;
  }

  function check(actionId, stepId, allowlist, actions) {
    const spec = actions[actionId];
    if (!spec) return { ok: false, reason: "unknown_action", tier: "" };
    const t3 = !!(spec.hitl || spec.tier === "T3");
    if (!allowlist.includes(actionId)) {
      return { ok: false, reason: "not_on_step_allowlist", tier: spec.tier };
    }
    if (t3) return { ok: false, reason: "t3_requires_hitl", tier: spec.tier };
    return { ok: true, reason: "ok", tier: spec.tier };
  }

  function execAction(actionId, ctx, keyed, actions, writes) {
    const spec = actions[actionId] || {};
    const invoice = first(keyed, "Invoice");
    const po = first(keyed, "PurchaseOrder");
    const gr = first(keyed, "GoodsReceipt");
    let seller = {};
    let buyer = {};
    if (invoice.seller_id && keyed.TradingParty) seller = keyed.TradingParty[invoice.seller_id] || {};
    if (po.buyer_id && keyed.TradingParty) buyer = keyed.TradingParty[po.buyer_id] || {};

    if (actionId === "read_po") { ctx.po = po; return po; }
    if (actionId === "read_gr") { ctx.gr = gr; return gr; }
    if (actionId === "read_invoice") { ctx.invoice = invoice; return invoice; }
    if (actionId === "read_party") {
      ctx.seller = seller; ctx.buyer = buyer;
      return { seller, buyer };
    }
    if (actionId === "assess_variance") {
      const qtyPo = Number(po.qty_ordered || 0);
      const qtyGr = Number(gr.qty_received || 0);
      const qtyInv = Number(invoice.qty_invoiced || 0);
      const pricePo = Number(po.unit_price || 0);
      const priceInv = Number(invoice.unit_price || 0);
      const qtyBase = qtyGr || qtyPo;
      const qtyVar = qtyBase === 0 ? 0 : Math.max(0, (qtyInv - qtyGr) / qtyBase * 100);
      const priceVar = pricePo === 0 ? 0 : (priceInv - pricePo) / pricePo * 100;
      const amount = (priceInv - pricePo) * qtyInv;
      ctx.qty_variance_pct = Math.round(qtyVar * 10000) / 10000;
      ctx.price_variance_pct = Math.round(priceVar * 10000) / 10000;
      ctx.amount_variance = Math.round(amount * 10000) / 10000;
      return {
        qty_variance_pct: ctx.qty_variance_pct,
        price_variance_pct: ctx.price_variance_pct,
        amount_variance: ctx.amount_variance,
      };
    }
    if (actionId === "write_exception_code") {
      const code = ctx.exception_code || "UNSPECIFIED";
      invoice.exception_code = code;
      invoice.match_status = "exception";
      writes.push({ object: "Invoice", field: "exception_code", value: code, tier: "T2" });
      return { written: code };
    }
    if (actionId === "create_hold") {
      const hold = {
        hold_id: "H-" + (invoice.invoice_id || ""),
        party_id: seller.party_id,
        reason: ctx.exception_code || "HOLD",
        active: true,
      };
      keyed.ComplianceHold = keyed.ComplianceHold || {};
      keyed.ComplianceHold[hold.hold_id] = hold;
      writes.push({ object: "ComplianceHold", field: "active", value: true, tier: "T2" });
      ctx.hold = hold;
      return hold;
    }
    if (actionId === "notify_template") {
      const note = {
        notification_id: "N-" + (invoice.invoice_id || ""),
        template_id: ctx.template_id || "INV_EXCEPTION_VENDOR",
        party_id: seller.party_id,
        sent: true,
      };
      const allowed = spec.allowed_templates || [];
      if (allowed.length && !allowed.includes(note.template_id)) {
        return { sent: false, error: "template_not_allowlisted" };
      }
      writes.push({ object: "Notification", field: "sent", value: true, tier: "T2" });
      ctx.notification = note;
      return note;
    }
    if (actionId === "compute_metrics" || actionId === "assess_case" || String(actionId).indexOf("compute_") === 0) {
      bindObjects(ctx, keyed);
      return applyComputes(ctx, ctx._computes || spec.computes || []);
    }
    if (String(actionId).indexOf("read_") === 0) {
      bindObjects(ctx, keyed);
      const bound = {};
      for (const otype of spec.reads || []) {
        const row = first(keyed, otype);
        ctx[otype] = row;
        ctx[snake(otype)] = row;
        bound[otype] = row;
      }
      return Object.keys(bound).length ? bound : { bound: true };
    }
    if (spec.tier === "T1" || spec.tier === "T2") {
      const targets = spec.writes && spec.writes.length ? spec.writes : ["Record"];
      const field = spec.write_field || "status";
      const value = ctx.exception_code || ctx.decision || actionId;
      for (const obj of targets) writes.push({ object: obj, field, value, tier: spec.tier });
      return { written: value, action: actionId, objects: targets };
    }
    return { error: "no_executor_for_" + actionId };
  }

  function runCase(pack, caseId, sopId) {
    sopId = sopId || "SOP-AP-014";
    const caseDoc = pack.cases.find((c) => c.id === caseId);
    const sop = pack.sops.find((s) => s.id === sopId);
    if (!caseDoc || !sop) throw new Error("unknown case or sop");
    const actions = Object.fromEntries(pack.actions.map((a) => [a.id, a]));
    const keyed = indexObjects(caseDoc, pack.objects);
    const writes = [];
    const path = [];
    const toolCalls = [];
    const violations = [];
    const ctx = {
      policy: sop.policy || {},
      task: { case_id: caseId },
      decision: null,
      exception_code: null,
      interrupt: false,
      _computes: [],
    };
    bindObjects(ctx, keyed);

    let stepId = sop.start;
    let visited = 0;
    while (stepId && visited < 50) {
      visited += 1;
      const step = sop.steps[stepId];
      path.push(stepId);
      const kind = step.kind;
      const allow = step.allowlist || [];

      const runAllow = () => {
        for (const action of allow) {
          const gate = check(action, stepId, allow, actions);
          const result = gate.ok
            ? execAction(action, ctx, keyed, actions, writes)
            : { blocked: gate.reason };
          if (!gate.ok) violations.push({ action, reason: gate.reason, tier: gate.tier, step: stepId });
          toolCalls.push({
            tool_name: action, ok: gate.ok, reason: gate.reason, step: stepId,
            tier: gate.tier, result,
          });
        }
      };

      if (kind === "fetch") {
        bindObjects(ctx, keyed);
        runAllow();
        stepId = step.next;
        continue;
      }
      if (kind === "compute") {
        ctx._computes = step.computes || [];
        runAllow();
        stepId = step.next;
        continue;
      }
      if (kind === "decide") {
        let fired = null;
        for (const rule of step.rules || []) {
          if (ruleMatches(rule.when || {}, ctx)) { fired = rule; break; }
        }
        const chosen = (fired && fired.then) || step.default || {};
        if (chosen.decision) ctx.decision = chosen.decision;
        if (chosen.exception_code != null) ctx.exception_code = chosen.exception_code;
        ctx.fired_rule = (fired && fired.id) || "default";
        stepId = chosen.next || step.next;
        continue;
      }
      if (kind === "act") {
        if (step.template_id) ctx.template_id = step.template_id;
        runAllow();
        stepId = step.next;
        continue;
      }
      if (kind === "interrupt") {
        ctx.interrupt = true;
        for (const blocked of step.blocked || []) {
          const gate = check(blocked, stepId, allow, actions);
          violations.push({ action: blocked, reason: gate.reason, tier: gate.tier, step: stepId });
          toolCalls.push({
            tool_name: blocked, ok: gate.ok, reason: gate.reason, step: stepId,
            tier: gate.tier, result: { blocked: gate.reason },
          });
        }
        stepId = step.next;
        continue;
      }
      if (kind === "finalize") break;
      stepId = step.next;
    }

    const output = ctx.decision || "UNDECIDED";
    const expect = caseDoc.expect || {};
    const correct =
      output === expect.decision &&
      (expect.exception_code == null || ctx.exception_code === expect.exception_code) &&
      (expect.interrupt == null || ctx.interrupt === expect.interrupt);
    const unowned = writes.filter((w) => w.tier === "T3");

    return {
      case_id: caseId,
      label: caseDoc.label,
      sop: sopId,
      decision: output,
      exception_code: ctx.exception_code,
      interrupt: ctx.interrupt,
      fired_rule: ctx.fired_rule,
      path,
      evidence: {
        qty_variance_pct: ctx.qty_variance_pct,
        price_variance_pct: ctx.price_variance_pct,
        amount_variance: ctx.amount_variance,
        seller: (ctx.seller || {}).party_id,
        buyer: (ctx.buyer || {}).party_id,
      },
      tool_calls: toolCalls,
      writes,
      violations,
      unowned_writes: unowned,
      expect,
      correct,
      objects: keyed,
    };
  }

  function casesFor(pack, sopId) {
    return pack.cases.filter((c) => (c.sop || "SOP-AP-014") === sopId);
  }

  function runAll(pack, sopId) {
    sopId = sopId || "SOP-AP-014";
    const subset = casesFor(pack, sopId);
    const results = subset.map((c) => runCase(pack, c.id, sopId));
    const n = results.length || 1;
    const correct = results.filter((r) => r.correct).length;
    return {
      sop: sopId,
      n: results.length,
      tsr: Math.round((correct / n) * 10000) / 10000,
      interrupts: results.filter((r) => r.interrupt).length,
      violations: results.reduce((s, r) => s + r.violations.length, 0),
      unowned_writes: results.reduce((s, r) => s + r.unowned_writes.length, 0),
      results,
    };
  }

  function runPortfolio(pack) {
    const bundles = pack.sops.map((s) => runAll(pack, s.id));
    const results = bundles.flatMap((b) => b.results);
    const n = results.length || 1;
    const correct = results.filter((r) => r.correct).length;
    return {
      sop: "PORTFOLIO",
      n,
      sops: bundles.length,
      tsr: Math.round((correct / n) * 10000) / 10000,
      interrupts: results.filter((r) => r.interrupt).length,
      violations: results.reduce((s, r) => s + r.violations.length, 0),
      unowned_writes: results.reduce((s, r) => s + r.unowned_writes.length, 0),
      bundles,
      results,
    };
  }

  global.NCNEngine = { runCase, runAll, runPortfolio, casesFor };
})(window);
