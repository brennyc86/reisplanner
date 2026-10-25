// Planlogica reisplanner: geen DOM, alleen fetch. Bron: Transitous (MOTIS) + OSRM (rijtijd).
(function (root) {
  const API = "https://api.transitous.org";
  const TZ = "Europe/Amsterdam";
  const NIET_OV = new Set(["WALK", "BIKE", "CAR", "RENTAL"]);
  const TREIN = new Set(["RAIL", "REGIONAL_RAIL", "LONG_DISTANCE", "HIGHSPEED_RAIL", "NIGHT_RAIL", "SUBURBAN", "REGIONAL_FAST_RAIL", "INTERCITY_RAIL"]);
  const MIN = 60000;

  // ---- tijd (alles in ms UTC, weergave in Nederlandse tijd) ----
  const tzfmt = new Intl.DateTimeFormat("nl-NL", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const hhmm = (t) => tzfmt.format(new Date(t));
  function tzOffsetMs(utcMs) {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(utcMs));
    const g = (k) => +p.find((x) => x.type === k).value;
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(utcMs / 1000) * 1000;
  }
  function lokaalNaarMs(datum, tijd, plusDagen = 0) {
    const [y, m, d] = datum.split("-").map(Number), [H, M] = tijd.split(":").map(Number);
    const g = Date.UTC(y, m - 1, d + plusDagen, H, M);
    let t = g - tzOffsetMs(g);
    t = g - tzOffsetMs(t);
    return t;
  }
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
  function minutenVanDag(ms) { const [h, m] = hhmm(ms).split(":").map(Number); return h * 60 + m; }
  function weekdag(ms) { return new Date(ms + tzOffsetMs(ms)).getUTCDay(); } // 0=zo
  const hmMin = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

  // ---- netwerk ----
  async function fetchJSON(url, ms = 45000) {
    for (let poging = 0; ; poging++) {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), ms);
      try {
        const r = await fetch(url, { signal: c.signal });
        if (!r.ok) throw new Error("HTTP " + r.status);
        return await r.json();
      } catch (e) {
        if (poging >= 1) throw e;
      } finally { clearTimeout(t); }
    }
  }
  const plan = (p) => fetchJSON(`${API}/api/v5/plan?${new URLSearchParams(p)}`);
  async function zoekPlaats(tekst, alleenStop) {
    const p = { text: tekst, language: "nl", place: "52.2,5.3" };
    if (alleenStop) p.type = "STOP";
    const r = await fetchJSON(`${API}/api/v1/geocode?${new URLSearchParams(p)}`, 15000);
    return r.map((x) => {
      const gebied = (x.areas || []).find((a) => a.default);
      const label = x.type === "ADDRESS" ? `${x.street || x.name} ${x.houseNumber || ""}`.trim() : x.name;
      return { type: x.type, label: gebied && !label.includes(gebied.name) ? `${label}, ${gebied.name}` : label, lat: x.lat, lon: x.lon, country: x.country };
    });
  }

  // ---- afstanden ----
  function km(a, b) {
    const R = 6371, r = Math.PI / 180;
    const dl = (b.lat - a.lat) * r, dn = (b.lon - a.lon) * r;
    const h = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  async function rijtijden(van, lijst) {
    const schat = (s) => Math.round((km(van, s) * 1.35) / 55 * 60) + 2;
    if (!lijst.length) return [];
    try {
      const co = [van, ...lijst].map((p) => p.lon + "," + p.lat).join(";");
      const j = await fetchJSON(`https://router.project-osrm.org/table/v1/driving/${co}?sources=0&annotations=duration`, 15000);
      return j.durations[0].slice(1).map((s, i) => (s == null ? schat(lijst[i]) : Math.round((s / 60) * 1.1 + 2)));
    } catch (e) { return lijst.map(schat); }
  }

  // ---- parkeerkans ----
  // Weekdag: tot 75 min vóór de typische 'vol'-tijd bijna zeker plek, op die tijd 50%, 75 min erna ~10%.
  function parkeerKans(s, aankomstMs) {
    const dag = weekdag(aankomstMs);
    const klein = (s.cap || 150) < 60 ? 0.1 : 0;
    if (dag === 0 || dag === 6) return 0.95 - klein;
    if (!s.vol) return 0.9 - klein;
    const d = minutenVanDag(aankomstMs) - hmMin(s.vol);
    const ruim = Math.min(1.4, Math.max(0.7, (s.cap || 150) / 200)); // grote terreinen lopen minder snel vol
    const p = 1 - (d + 75 * ruim) / (150 * ruim);
    return Math.min(0.97, Math.max(0.08, p)) - klein / 2;
  }

  // ---- reizen beoordelen ----
  function analyse(it) {
    const tl = it.legs.filter((l) => !NIET_OV.has(l.mode));
    let maxWacht = 0, wachtPlek = "";
    for (let i = 1; i < tl.length; i++) {
      const a = Date.parse(tl[i - 1].endTime), b = Date.parse(tl[i].startTime);
      const i0 = it.legs.indexOf(tl[i - 1]), i1 = it.legs.indexOf(tl[i]);
      const tussen = it.legs.slice(i0 + 1, i1).reduce((s, l) => s + l.duration * 1000, 0);
      const w = (b - a - tussen) / MIN;
      if (w > maxWacht) { maxWacht = Math.round(w); wachtPlek = tl[i].from.name; }
    }
    return {
      it, start: Date.parse(it.startTime), eind: Date.parse(it.endTime),
      duur: Math.round(it.duration / 60), overstap: it.transfers ?? Math.max(0, tl.length - 1),
      eersteOV: tl.length ? Date.parse(tl[0].startTime) : Date.parse(it.startTime),
      laatsteOV: tl.length ? Date.parse(tl[tl.length - 1].endTime) : Date.parse(it.endTime),
      heeftOV: tl.length > 0, alleenTrein: tl.length > 0 && tl.every((l) => TREIN.has(l.mode)),
      fiets: it.legs.some((l) => l.mode === "BIKE"), maxWacht, wachtPlek,
    };
  }

  async function pool(items, n, fn) {
    const uit = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; uit[k] = await fn(items[k], k); }
    }));
    return uit;
  }

  const fietsModi = (inst) => (inst.fiets !== "geen" ? "WALK,BIKE" : "WALK");
  const fietsTijd = (inst) => (inst.fiets !== "geen" ? 1800 : 900);

  // ---- heenreis: auto naar gratis-parkeerstation, dan OV ----
  async function zoekHeen(inv, voortgang = () => {}) {
    const { thuis, dest, datum, tijd, stations, inst } = inv;
    const vertrek = lokaalNaarMs(datum, tijd);
    let kand = stations.filter((s) => s.aan !== false).map((s) => ({ s, km: km(thuis, s) })).filter((x) => x.km <= inst.rijtijd * 1.4);
    if (!kand.length) return { opties: [], melding: "Geen parkeerstation binnen " + inst.rijtijd + " min rijden van thuis. Verhoog de maximale rijtijd of voeg stations toe." };
    voortgang("Rijtijden berekenen…");
    const rij = await rijtijden(thuis, kand.map((x) => x.s));
    kand.forEach((x, i) => (x.rij = rij[i]));
    kand = kand.filter((x) => x.rij <= inst.rijtijd);
    kand.forEach((x) => (x.v = x.rij + km(x.s, dest) / 1.1));
    kand.sort((a, b) => a.v - b.v);
    kand = kand.slice(0, 7);
    let klaar = 0;
    const res = await pool(kand, 3, async (x) => {
      const aank = vertrek + x.rij * MIN, zoekT = aank + inst.buffer * MIN;
      const basis = { fromPlace: `${x.s.lat},${x.s.lon}`, toPlace: `${dest.lat},${dest.lon}`, time: iso(zoekT), numItineraries: 5, maxTransfers: 4, postTransitModes: fietsModi(inst), maxPostTransitTime: fietsTijd(inst) };
      let reizen = [];
      try {
        let d = await plan({ ...basis, transitModes: "RAIL" });
        reizen = (d.itineraries || []).map(analyse).filter((a) => a.heeftOV);
        if (!reizen.length) {
          d = await plan({ ...basis, transitModes: "TRANSIT" });
          reizen = (d.itineraries || []).map(analyse).filter((a) => a.heeftOV);
        }
      } catch (e) { x.fout = String(e.message || e); }
      voortgang(`Reizen vanaf parkeerstations… ${++klaar}/${kand.length}`);
      let verworpen = 0;
      reizen.forEach((a) => { a.wachtStation = Math.max(0, Math.round((a.eersteOV - zoekT) / MIN)); });
      const geldig = reizen.filter((a) => a.maxWacht <= inst.wacht && a.wachtStation <= inst.wacht);
      verworpen = reizen.length - geldig.length;
      geldig.sort((a, b) => a.eind - b.eind);
      const p = parkeerKans(x.s, aank);
      const beste = geldig[0];
      return {
        s: x.s, rij: x.rij, aankStation: aank, p, reizen: geldig, beste, verworpen, fout: x.fout,
        score: beste ? beste.eind + (1 - p) * 40 * MIN + (beste.alleenTrein ? 0 : 10 * MIN) : Infinity,
      };
    });
    const opties = res.filter((o) => o.beste).sort((a, b) => a.score - b.score);
    return { opties, melding: opties.length ? "" : "Geen reis gevonden vanaf de parkeerstations (of alle reizen hebben te lange wachttijd)." };
  }

  // ---- terugreis: laatste en laatste snelle ----
  async function zoekTerug(inv, opt, voortgang = () => {}) {
    const { dest, terugdatum, vroegst, inst } = inv;
    const anker = lokaalNaarMs(terugdatum, "03:30", 1); // einde dienstregeldag
    const basis = { fromPlace: `${dest.lat},${dest.lon}`, toPlace: `${opt.s.lat},${opt.s.lon}`, arriveBy: true, numItineraries: 8, maxTransfers: 4, preTransitModes: fietsModi(inst), maxPreTransitTime: fietsTijd(inst) };
    const haal = async (modi, paginas) => {
      let alles = [], cursor = null;
      for (let i = 0; i < paginas; i++) {
        const p = { ...basis, time: iso(anker), transitModes: modi };
        if (cursor) p.pageCursor = cursor;
        const d = await plan(p);
        alles = alles.concat((d.itineraries || []).map(analyse).filter((a) => a.heeftOV));
        cursor = d.previousPageCursor;
        if (!cursor || !d.itineraries?.length) break;
        if (Math.min(...d.itineraries.map((it) => Date.parse(it.startTime))) < vroegst) break;
      }
      return alles;
    };
    voortgang("Laatste terugreizen zoeken…");
    let trein = await haal("RAIL", 3);
    const laatsteTrein = trein.length ? Math.max(...trein.map((a) => a.start)) : 0;
    voortgang("Controleren of er na de laatste trein nog bus/tram/metro rijdt…");
    let gemengd = [];
    try { gemengd = (await haal("TRANSIT", 1)).filter((a) => !a.alleenTrein && a.start > laatsteTrein); } catch (e) { /* trein-resultaat blijft staan */ }
    const uniek = new Map();
    [...trein, ...gemengd].forEach((a) => uniek.set(a.start + "|" + a.eind + "|" + a.it.legs.length, a));
    const alle = [...uniek.values()].filter((a) => a.start >= vroegst).sort((a, b) => b.start - a.start);
    const geldig = alle.filter((a) => a.maxWacht <= inst.wacht);
    const afgewezen = alle.filter((a) => a.maxWacht > inst.wacht && (!geldig.length || a.start > geldig[0].start));
    const kortst = geldig.length ? Math.min(...geldig.map((a) => a.duur)) : 0;
    const snelGrens = kortst * 1.35 + 5;
    const snel = geldig.find((a) => a.duur <= snelGrens && a.alleenTrein) || geldig.find((a) => a.duur <= snelGrens) || null; // trein heeft voorrang
    return { laatste: geldig[0] || null, laatsteSnel: snel, geldig, afgewezen: afgewezen.slice(0, 2), kortst, snelGrens: Math.round(snelGrens) };
  }

  root.Plan = { hhmm, lokaalNaarMs, iso, minutenVanDag, weekdag, hmMin, plan, zoekPlaats, km, rijtijden, parkeerKans, analyse, zoekHeen, zoekTerug, TREIN, NIET_OV, MIN };
  if (typeof module !== "undefined") module.exports = root.Plan;
})(typeof window !== "undefined" ? window : globalThis);
