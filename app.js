(function () {
  const P = window.Plan;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const LS = "reisplanner1";
  const STANDAARD = { thuis: { label: "Naarden", lat: 52.2953, lon: 5.1608 }, dest: null, fiets: "geen", inst: { wacht: 60, rijtijd: 35, buffer: 5, kans: 40 }, stations: null };

  let S;
  try { S = { ...STANDAARD, ...JSON.parse(localStorage.getItem(LS) || "{}") }; } catch (e) { S = { ...STANDAARD }; }
  S.inst = { ...STANDAARD.inst, ...(S.inst || {}) };
  const bewaar = () => { try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) { /* privévenster */ } };

  let standaardStations = [];
  const stations = () => S.stations || standaardStations;

  // ---- invoer ----
  const vandaag = new Date(); vandaag.setDate(vandaag.getDate() + 1);
  const dagStr = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  $("datum").value = $("terugdatum").value = dagStr(vandaag);
  $("datum").addEventListener("change", () => { if ($("terugdatum").value < $("datum").value) $("terugdatum").value = $("datum").value; });
  $("thuis").value = S.thuis?.label || "";
  $("dest").value = S.dest?.label || "";
  document.querySelectorAll("input[name=fiets]").forEach((r) => { r.checked = r.value === S.fiets; r.addEventListener("change", () => { S.fiets = r.value; bewaar(); }); });
  const instVelden = { wacht: "i-wacht", rijtijd: "i-rij", buffer: "i-buf", kans: "i-kans" };
  for (const [k, id] of Object.entries(instVelden)) { $(id).value = S.inst[k]; $(id).addEventListener("change", () => { S.inst[k] = +$(id).value; bewaar(); }); }

  // zoekvelden met suggesties
  function zoekveld(inp, alleenStop, kies) {
    const lijst = inp.parentNode.querySelector(".sugg");
    let timer, teller = 0;
    inp.addEventListener("input", () => {
      clearTimeout(timer);
      inp.dataset.gekozen = "";
      const q = inp.value.trim();
      if (q.length < 3) { lijst.hidden = true; return; }
      timer = setTimeout(async () => {
        const nr = ++teller;
        try {
          const r = (await P.zoekPlaats(q, alleenStop)).slice(0, 6);
          if (nr !== teller) return;
          lijst.innerHTML = "";
          r.forEach((x) => {
            const b = document.createElement("button");
            b.type = "button";
            b.innerHTML = `${esc(x.label)} <small>${x.type === "STOP" ? "halte" : x.type === "ADDRESS" ? "adres" : "plaats"}</small>`;
            b.addEventListener("click", () => { inp.value = x.label; lijst.hidden = true; kies(x); });
            lijst.appendChild(b);
          });
          lijst.hidden = !r.length;
        } catch (e) { lijst.hidden = true; }
      }, 300);
    });
    inp.addEventListener("keydown", (e) => { if (e.key === "Escape") lijst.hidden = true; });
    document.addEventListener("click", (e) => { if (!inp.parentNode.contains(e.target)) lijst.hidden = true; });
  }
  zoekveld($("thuis"), false, (x) => { S.thuis = { label: x.label, lat: x.lat, lon: x.lon }; bewaar(); });
  zoekveld($("dest"), false, (x) => { S.dest = { label: x.label, lat: x.lat, lon: x.lon }; bewaar(); });
  zoekveld($("nieuwstation"), true, (x) => {
    const lijst = stations().slice();
    if (!lijst.some((s) => s.naam === x.label)) lijst.push({ naam: x.label, lat: x.lat, lon: x.lon, cap: 150, vol: "08:00", aan: true });
    S.stations = lijst; bewaar(); $("nieuwstation").value = ""; tabel();
  });

  // ---- stationtabel ----
  function tabel() {
    const t = $("stationtabel");
    t.innerHTML = `<tr><th>Aan</th><th>Station</th><th>Plaatsen</th><th>Vol rond</th><th></th></tr>`;
    stations().forEach((s, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><input type="checkbox" ${s.aan !== false ? "checked" : ""} aria-label="${esc(s.naam)} gebruiken"></td><td>${esc(s.naam)}</td><td><input type="number" min="10" step="10" value="${s.cap || 150}" aria-label="Plaatsen ${esc(s.naam)}"></td><td><input type="time" value="${s.vol || ""}" aria-label="Vol rond ${esc(s.naam)}"></td><td><button type="button" class="klein" aria-label="${esc(s.naam)} verwijderen">✕</button></td>`;
      const [aan, cap, vol] = tr.querySelectorAll("input");
      const wijzig = () => { const l = stations().map((x) => ({ ...x })); l[i] = { ...l[i], aan: aan.checked, cap: +cap.value || 150, vol: vol.value || null }; S.stations = l; bewaar(); };
      [aan, cap, vol].forEach((e) => e.addEventListener("change", wijzig));
      tr.querySelector("button").addEventListener("click", () => { const l = stations().filter((_, k) => k !== i); S.stations = l; bewaar(); tabel(); });
      t.appendChild(tr);
    });
  }
  $("resetstations").addEventListener("click", () => { S.stations = null; bewaar(); tabel(); });

  // ---- weergave ----
  const ICOON = { WALK: "🚶", BIKE: "🚲", BUS: "🚌", TRAM: "🚊", SUBWAY: "🚇", FERRY: "⛴️", COACH: "🚌" };
  const icoon = (m) => ICOON[m] || (P.TREIN.has(m) ? "🚆" : "🚍");
  const kansKlasse = (p) => (p >= 0.7 ? "k-goed" : p >= 0.4 ? "k-matig" : "k-slecht");
  const kansTekst = (p) => `${Math.round(p * 100)}% kans op plek`;

  function benen(a, eind = "bestemming") {
    const rijen = a.it.legs.filter((l) => !(l.mode === "WALK" && l.duration < 90 && (l.from.name === "START" || l.to.name === "END"))).map((l) => {
      const van = l.from.name === "START" ? "vertrek" : l.from.name, naar = l.to.name === "END" ? eind : l.to.name;
      const tijd = `${P.hhmm(Date.parse(l.startTime))}–${P.hhmm(Date.parse(l.endTime))}`;
      const min = Math.round(l.duration / 60);
      let tekst;
      if (l.mode === "WALK") tekst = `Lopen ${min} min naar ${esc(naar)}`;
      else if (l.mode === "BIKE") tekst = `Fietsen ${min} min naar ${esc(naar)}`;
      else {
        const nm = l.displayName || l.routeShortName || l.mode;
        const spoor = l.from.track ? ` · spoor ${esc(l.from.track)}` : "";
        tekst = `<b>${esc(nm)}</b> richting ${esc(l.headsign || "")}${spoor}<br><span class="meta">${esc(van)} → ${esc(naar)}</span>`;
      }
      return `<li><span aria-hidden="true">${icoon(l.mode)}</span><span><span class="t">${tijd}</span> ${tekst}</span></li>`;
    });
    return `<ul class="benen">${rijen.join("")}</ul>`;
  }
  const chips = (a, fiets) => {
    const c = [`<span class="chip">${a.duur} min</span>`, `<span class="chip">${a.overstap} overstap${a.overstap === 1 ? "" : "pen"}</span>`];
    c.push(a.alleenTrein ? `<span class="chip k-goed">alleen trein</span>` : `<span class="chip k-matig">trein + bus/tram/metro</span>`);
    if (a.fiets) c.push(`<span class="chip">🚲 ${fiets === "ov" ? "OV-fiets" : "vouwfiets"}</span>`);
    if (a.maxWacht >= 15) c.push(`<span class="chip">wacht ${a.maxWacht} min in ${esc(a.wachtPlek)}</span>`);
    return c.join("");
  };

  let heenRes = null, gekozen = 0, inv = null;
  const terugCache = new Map();

  function toonHeen() {
    const min = S.inst.kans / 100;
    let lijst = heenRes.opties;
    const zeker = lijst.filter((o) => o.p >= min);
    const verborgen = lijst.length - zeker.length;
    if (zeker.length) lijst = zeker;
    const html = [`<h2>Heenreis: auto naar station</h2>`];
    if (!zeker.length) html.push(`<div class="waarsch">Alle stations hebben een lage parkeerkans op dit tijdstip. Eerder vertrekken helpt, of kies een ander moment.</div>`);
    lijst.forEach((o, i) => {
      const b = o.beste, thuisTijd = o.aankStation;
      html.push(`<button type="button" class="opt" data-i="${heenRes.opties.indexOf(o)}" aria-pressed="${heenRes.opties.indexOf(o) === gekozen}">
        <div class="kop"><b>P ${esc(o.s.naam)}</b><span class="chip ${kansKlasse(o.p)}">${kansTekst(o.p)}</span></div>
        <div class="meta">${o.rij} min rijden · op station ${P.hhmm(thuisTijd)} · trein ${P.hhmm(b.eersteOV)}</div>
        <div class="groot">${P.hhmm(b.eersteOV)} → ${P.hhmm(b.eind)} <span class="meta">aankomst bestemming</span></div>
        <div>${chips(b, inv.inst.fiets)}</div>
      </button>`);
    });
    if (verborgen > 0 && zeker.length) html.push(`<p class="meta">${verborgen} station(s) met minder dan ${S.inst.kans}% parkeerkans verborgen (instelbaar).</p>`);
    const o = heenRes.opties[gekozen];
    html.push(`<div class="kaart"><div class="meta">Gekozen reis vanaf P ${esc(o.s.naam)}</div>${benen(o.beste)}`);
    if (o.reizen.length > 1) html.push(`<p class="meta">Volgende alternatieven: ${o.reizen.slice(1, 4).map((a) => `${P.hhmm(a.eersteOV)} → ${P.hhmm(a.eind)}`).join(" · ")}</p>`);
    if (inv.inst.fiets === "ov") html.push(`<p class="meta">🚲 OV-fiets: ophalen bij het uitstapstation (reken ~3 min); inleveren doe je bij het station waar je terug instapt.</p>`);
    html.push(`</div>`);
    $("uit").innerHTML = html.join("") + `<div id="terug"></div>`;
    $("uit").querySelectorAll(".opt").forEach((b) => b.addEventListener("click", () => { gekozen = +b.dataset.i; toonHeen(); laadTerug(); }));
  }

  function terugKaart(a, titel, klasse, uitleg, o) {
    if (!a) return `<div class="hero ${klasse}"><div class="titel">${titel}</div><div>Geen geschikte terugreis gevonden.</div></div>`;
    const thuisOm = a.eind + o.rij * P.MIN;
    return `<div class="hero ${klasse}"><div class="titel">${titel}</div>
      <div class="groot">Vertrek ${P.hhmm(a.start)} <span class="meta">→ station ${P.hhmm(a.eind)}</span></div>
      <div>Thuis rond <b>${P.hhmm(thuisOm)}</b> <span class="meta">(${o.rij} min rijden van P ${esc(o.s.naam)})</span></div>
      <div>${chips(a, inv.inst.fiets)}</div>
      <div class="meta">${uitleg}</div>
      <details><summary>Reisdetails</summary>${benen(a, "parkeerstation")}</details></div>`;
  }

  async function laadTerug() {
    const o = heenRes.opties[gekozen];
    const box = $("terug");
    if (!box) return;
    const v = $("vroegst").value;
    const vroegst = v ? P.lokaalNaarMs(inv.terugdatum, v) : o.beste.eind + 60 * P.MIN;
    const sleutel = [o.s.naam, vroegst, S.inst.wacht, S.fiets].join("|");
    box.innerHTML = `<h2>Terugreis: vanaf bestemming naar P ${esc(o.s.naam)}</h2><div class="status">Laatste terugreizen zoeken…</div>`;
    let t = terugCache.get(sleutel);
    try {
      if (!t) { t = await P.zoekTerug({ ...inv, vroegst }, o, (m) => { const s = box.querySelector(".status"); if (s) s.textContent = m; }); terugCache.set(sleutel, t); }
    } catch (e) { box.innerHTML += `<div class="status fout">Terugreis ophalen mislukt: ${esc(e.message)}</div>`; return; }
    if (heenRes.opties[gekozen] !== o) return; // inmiddels andere keuze
    const html = [`<h2>Terugreis: vanaf bestemming naar P ${esc(o.s.naam)}</h2>`];
    const dag = inv.terugdatum.split("-").reverse().join("-");
    if (!t.geldig.length) {
      html.push(`<div class="waarsch">Geen terugreis op ${dag} zonder meer dan ${S.inst.wacht} min wachten. Kies een andere dag, ander station of verhoog de maximale wachttijd.</div>`);
    } else {
      const zelfde = t.laatste === t.laatsteSnel;
      html.push(terugKaart(t.laatste, zelfde ? "Laatste mogelijkheid · ook snel" : "Laatste mogelijkheid", "", zelfde ? "Dit is tegelijk de laatste én een snelle reis." : "Dit is de allerlaatste reis die je nog thuisbrengt zonder lange wachttijd.", o));
      if (!zelfde) html.push(terugKaart(t.laatsteSnel, "Laatste snelle mogelijkheid", "snel", `Snel = binnen ${t.snelGrens} min reistijd (snelste reis is ${t.kortst} min).`, o));
      t.afgewezen.forEach((a) => html.push(`<p class="meta">Overgeslagen: ${P.hhmm(a.start)} → ${P.hhmm(a.eind)} vanwege ${a.maxWacht} min wachten in ${esc(a.wachtPlek)}.</p>`));
      const rest = t.geldig.filter((a) => a !== t.laatste && a !== t.laatsteSnel).slice(0, 10);
      if (rest.length) html.push(`<details><summary>Eerdere terugreizen (${rest.length})</summary><div class="lijst">${rest.map((a, i) => `<button type="button" data-r="${i}"><span><b>${P.hhmm(a.start)}</b> → ${P.hhmm(a.eind)}</span><span class="meta">${a.duur} min · ${a.overstap}× over${a.alleenTrein ? "" : " · bus/tram"}</span></button>`).join("")}</div><div id="restdetail"></div></details>`);
      if (o.p < 0.4) html.push(`<div class="waarsch">Let op: op de heenreis is de parkeerkans bij dit station laag (${Math.round(o.p * 100)}%). De auto moet er wel kunnen staan.</div>`);
      box.innerHTML = html.join("");
      box.querySelectorAll("[data-r]").forEach((b) => b.addEventListener("click", () => { $("restdetail").innerHTML = `<div class="kaart">${benen(rest[+b.dataset.r], "parkeerstation")}</div>`; }));
      return;
    }
    box.innerHTML = html.join("");
  }

  // ---- plannen ----
  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const st = $("status"), knop = $("plan");
    st.className = "status";
    const resolve = async (inp, sleutel) => {
      if (S[sleutel] && S[sleutel].label === inp.value.trim()) return S[sleutel];
      const r = (await P.zoekPlaats(inp.value.trim(), false))[0];
      if (!r) throw new Error(`"${inp.value}" niet gevonden`);
      S[sleutel] = { label: r.label, lat: r.lat, lon: r.lon }; inp.value = r.label; bewaar();
      return S[sleutel];
    };
    knop.disabled = true; $("uit").innerHTML = ""; terugCache.clear();
    try {
      st.textContent = "Adressen opzoeken…";
      const thuis = await resolve($("thuis"), "thuis"), dest = await resolve($("dest"), "dest");
      inv = { thuis, dest, datum: $("datum").value, tijd: $("tijd").value, terugdatum: $("terugdatum").value, stations: stations(), inst: { ...S.inst, fiets: S.fiets } };
      heenRes = await P.zoekHeen(inv, (m) => (st.textContent = m));
      if (!heenRes.opties.length) { st.className = "status fout"; st.textContent = heenRes.melding; return; }
      gekozen = 0; st.textContent = "";
      toonHeen(); await laadTerug();
    } catch (err) {
      st.className = "status fout"; st.textContent = "Er ging iets mis: " + err.message;
    } finally { knop.disabled = false; }
  });

  fetch("stations.json").then((r) => r.json()).then((j) => { standaardStations = j.map((s) => ({ ...s, aan: true })); tabel(); }).catch(() => { $("status").textContent = "Kon stationslijst niet laden."; });
})();
