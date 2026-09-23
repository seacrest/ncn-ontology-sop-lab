(function () {
  const pack = window.NCN_PACK;
  const engine = window.NCNEngine;
  const sops = pack.sops.slice().sort((a, b) =>
    String(a.department || "").localeCompare(b.department || "") || a.id.localeCompare(b.id)
  );
  let sopId = (sops.find((s) => s.id === "SOP-AP-014") || sops[0]).id;
  let selected = null;
  let lastBundle = null;

  const $ = (id) => document.getElementById(id);

  function currentSop() {
    return pack.sops.find((s) => s.id === sopId);
  }

  function visibleCases() {
    if (lastBundle && lastBundle.sop === "PORTFOLIO") return pack.cases;
    return engine.casesFor(pack, sopId);
  }

  function fillSops() {
    const depts = [];
    sops.forEach((s) => {
      if (!depts.includes(s.department || "Other")) depts.push(s.department || "Other");
    });
    $("dept").innerHTML = ["All departments"].concat(depts).map((d) =>
      `<option value="${d}">${d}</option>`
    ).join("");
    renderSopOptions("All departments");
  }

  function renderSopOptions(dept) {
    const list = dept === "All departments" ? sops : sops.filter((s) => s.department === dept);
    $("sop").innerHTML = list.map((s) =>
      `<option value="${s.id}">${s.id} · ${s.label}</option>`
    ).join("");
    if (!list.find((s) => s.id === sopId) && list.length) sopId = list[0].id;
    $("sop").value = sopId;
  }

  function renderCases() {
    const box = $("cases");
    box.innerHTML = "";
    const rows = visibleCases();
    if (!selected || !rows.find((c) => c.id === selected)) selected = rows[0] && rows[0].id;
    rows.forEach((c) => {
      const b = document.createElement("button");
      b.className = "case" + (c.id === selected ? " active" : "");
      const result = lastBundle && lastBundle.results.find((r) => r.case_id === c.id);
      const mark = result ? (result.correct ? "PASS" : "FAIL") : "—";
      const klass = result ? (result.correct ? "ok" : "bad") : "";
      const sopTag = c.sop && lastBundle && lastBundle.sop === "PORTFOLIO" ? `<div class="meta">${c.sop}</div>` : "";
      b.innerHTML = `<strong>${c.id}</strong> <span class="${klass}">${mark}</span><div class="meta">${c.label}</div>${sopTag}`;
      b.onclick = () => { selected = c.id; showCase(c.id); renderCases(); };
      box.appendChild(b);
    });
  }

  function kpis(bundle, result) {
    const tsr = bundle ? Math.round(bundle.tsr * 100) + "%" : "—";
    const dec = result ? result.decision : "—";
    const hitl = result && result.interrupt ? "YES" : (result ? "no" : "—");
    const uw = bundle ? String(bundle.unowned_writes) : "—";
    const n = bundle ? String(bundle.n) : "—";
    $("kpis").innerHTML = [
      ["TSR", tsr],
      ["Cases", n],
      ["Decision", dec],
      ["HITL", hitl],
      ["Unowned writes", uw],
    ].map(([k, v]) => `<div class="kpi"><span>${k}</span><b>${v}</b></div>`).join("");
  }

  function showResult(result, bundle) {
    kpis(bundle, result);
    const sop = pack.sops.find((s) => s.id === result.sop) || currentSop();
    const steps = Object.keys(sop.steps);
    $("path").innerHTML = steps.map((s) => {
      const on = result.path.includes(s);
      const hitl = sop.steps[s].kind === "interrupt" && result.path.includes(s);
      return `<span class="chip${on ? " on" : ""}${hitl ? " hitl" : ""}">${s}</span>`;
    }).join("");
    $("subtitle").textContent =
      `${sop.id} · ${sop.department || ""} / ${sop.function || sop.owner || ""} · ${pack.sops.length} SOPs · ${pack.cases.length} cases · ScopeGate below the model`;

    $("tools").innerHTML = (result.tool_calls || []).map((t) => {
      const gate = t.ok ? "allow" : t.reason;
      const klass = t.ok ? "ok" : (t.reason === "t3_requires_hitl" || t.reason === "not_on_step_allowlist" ? "warn" : "bad");
      const snippet = JSON.stringify(t.result);
      return `<tr><td>${t.step}</td><td>${t.tool_name}</td><td>${t.tier || ""}</td><td class="${klass}">${gate}</td><td>${snippet}</td></tr>`;
    }).join("") || `<tr><td colspan="5">No tools.</td></tr>`;

    $("writes").innerHTML = (result.writes || []).map((w) =>
      `<tr><td>${w.object}</td><td>${w.field}</td><td>${w.value}</td><td>${w.tier}</td></tr>`
    ).join("") || `<tr><td colspan="4">None (clean path or interrupt before write).</td></tr>`;

    $("expect").textContent = JSON.stringify({
      expect: result.expect,
      actual: {
        decision: result.decision,
        exception_code: result.exception_code,
        interrupt: result.interrupt,
        fired_rule: result.fired_rule,
        correct: result.correct,
      },
      evidence: result.evidence,
    }, null, 2);

    $("objects").textContent = JSON.stringify(result.objects || pack.cases.find((c) => c.id === result.case_id).objects, null, 2);
  }

  function showCase(id) {
    const existing = lastBundle && lastBundle.results.find((r) => r.case_id === id);
    if (existing) { showResult(existing, lastBundle); return; }
    const raw = pack.cases.find((c) => c.id === id);
    kpis(lastBundle, null);
    $("path").innerHTML = "";
    $("tools").innerHTML = "";
    $("writes").innerHTML = "";
    $("expect").textContent = JSON.stringify(raw.expect, null, 2);
    $("objects").textContent = JSON.stringify(raw.objects, null, 2);
  }

  $("dept").onchange = () => {
    renderSopOptions($("dept").value);
    lastBundle = null;
    selected = null;
    renderCases();
    if (selected) showCase(selected);
  };

  $("sop").onchange = () => {
    sopId = $("sop").value;
    lastBundle = null;
    selected = null;
    const sop = currentSop();
    $("subtitle").textContent =
      `${sop.id} · ${sop.department || ""} / ${sop.function || ""} · ScopeGate below the model`;
    renderCases();
    if (selected) showCase(selected);
  };

  $("runOne").onclick = () => {
    const result = engine.runCase(pack, selected, sopId);
    if (!lastBundle || lastBundle.sop === "PORTFOLIO") {
      lastBundle = { sop: sopId, n: 0, tsr: 0, interrupts: 0, violations: 0, unowned_writes: 0, results: [] };
    }
    lastBundle.results = lastBundle.results.filter((r) => r.case_id !== selected).concat([result]);
    lastBundle.n = lastBundle.results.length;
    lastBundle.tsr = lastBundle.results.filter((r) => r.correct).length / lastBundle.results.length;
    lastBundle.unowned_writes = lastBundle.results.reduce((s, r) => s + r.unowned_writes.length, 0);
    lastBundle.interrupts = lastBundle.results.filter((r) => r.interrupt).length;
    renderCases();
    showResult(result, lastBundle);
  };

  $("runAll").onclick = () => {
    lastBundle = engine.runAll(pack, sopId);
    selected = lastBundle.results[0] && lastBundle.results[0].case_id;
    renderCases();
    if (selected) showResult(lastBundle.results[0], lastBundle);
  };

  $("runPortfolio").onclick = () => {
    lastBundle = engine.runPortfolio(pack);
    selected = lastBundle.results[0] && lastBundle.results[0].case_id;
    renderCases();
    if (selected) showResult(lastBundle.results[0], lastBundle);
  };

  fillSops();
  renderCases();
  if (selected) showCase(selected);
})();
