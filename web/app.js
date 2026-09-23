(function () {
  const pack = window.NCN_PACK;
  const engine = window.NCNEngine;
  let selected = pack.cases[0].id;
  let lastBundle = null;

  const $ = (id) => document.getElementById(id);

  function renderCases() {
    const box = $("cases");
    box.innerHTML = "";
    pack.cases.forEach((c) => {
      const b = document.createElement("button");
      b.className = "case" + (c.id === selected ? " active" : "");
      const result = lastBundle && lastBundle.results.find((r) => r.case_id === c.id);
      const mark = result ? (result.correct ? "PASS" : "FAIL") : "—";
      const klass = result ? (result.correct ? "ok" : "bad") : "";
      b.innerHTML = `<strong>${c.id}</strong> <span class="${klass}">${mark}</span><div class="meta">${c.label}</div>`;
      b.onclick = () => { selected = c.id; showCase(c.id); renderCases(); };
      box.appendChild(b);
    });
  }

  function kpis(bundle, result) {
    const tsr = bundle ? Math.round(bundle.tsr * 100) + "%" : "—";
    const dec = result ? result.decision : "—";
    const hitl = result && result.interrupt ? "YES" : (result ? "no" : "—");
    const uw = bundle ? String(bundle.unowned_writes) : "—";
    $("kpis").innerHTML = [
      ["TSR", tsr],
      ["Decision", dec],
      ["HITL", hitl],
      ["Unowned writes", uw],
    ].map(([k, v]) => `<div class="kpi"><span>${k}</span><b>${v}</b></div>`).join("");
  }

  function showResult(result, bundle) {
    kpis(bundle, result);
    const sop = pack.sops[0];
    const steps = Object.keys(sop.steps);
    $("path").innerHTML = steps.map((s) => {
      const on = result.path.includes(s);
      const hitl = sop.steps[s].kind === "interrupt" && result.path.includes(s);
      return `<span class="chip${on ? " on" : ""}${hitl ? " hitl" : ""}">${s}</span>`;
    }).join("");

    $("tools").innerHTML = (result.tool_calls || []).map((t) => {
      const gate = t.ok ? "allow" : t.reason;
      const klass = t.ok ? "ok" : (t.reason === "t3_requires_hitl" ? "warn" : "bad");
      const snippet = JSON.stringify(t.result);
      return `<tr><td>${t.step}</td><td>${t.tool_name}</td><td>${t.tier || ""}</td><td class="${klass}">${gate}</td><td>${snippet}</td></tr>`;
    }).join("") || `<tr><td colspan="5">No tools.</td></tr>`;

    $("writes").innerHTML = (result.writes || []).map((w) =>
      `<tr><td>${w.object}</td><td>${w.field}</td><td>${w.value}</td><td>${w.tier}</td></tr>`
    ).join("") || `<tr><td colspan="4">None (MATCH_OK or interrupt before write).</td></tr>`;

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

  $("runOne").onclick = () => {
    const result = engine.runCase(pack, selected);
    if (!lastBundle) lastBundle = { sop: "SOP-AP-014", n: 0, tsr: 0, interrupts: 0, violations: 0, unowned_writes: 0, results: [] };
    lastBundle.results = lastBundle.results.filter((r) => r.case_id !== selected).concat([result]);
    lastBundle.n = lastBundle.results.length;
    lastBundle.tsr = lastBundle.results.filter((r) => r.correct).length / lastBundle.results.length;
    lastBundle.unowned_writes = lastBundle.results.reduce((s, r) => s + r.unowned_writes.length, 0);
    lastBundle.interrupts = lastBundle.results.filter((r) => r.interrupt).length;
    renderCases();
    showResult(result, lastBundle);
  };

  $("runAll").onclick = () => {
    lastBundle = engine.runAll(pack);
    selected = lastBundle.results[0].case_id;
    renderCases();
    showResult(lastBundle.results[0], lastBundle);
  };

  renderCases();
  showCase(selected);
})();
