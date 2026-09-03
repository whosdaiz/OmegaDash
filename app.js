let data = emptyState();
const charts = {};

Chart.defaults.color = "#6e7a86";
Chart.defaults.font.family = "DM Mono";
Chart.defaults.font.size = 10;
Chart.defaults.borderColor = "rgba(148,163,184,.09)";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const WEBAPP_VERSION = "1.0";
const GITHUB_REPO_URL = "https://github.com/whosdaiz/OmegaDash";

const MATCH_MODE_OPTIONS = [
  { id: "prem_comp", label: "Prem/Comp" },
  { id: "practice", label: "Practice" },
  { id: "casual", label: "Casual" },
  { id: "deathmatch", label: "Deathmatch" },
  { id: "untagged", label: "Untagged" }
];

function defaultSampleModes() {
  return MATCH_MODE_OPTIONS.map(item => item.id);
}

function normalizeSampleModes(value) {
  if (!Array.isArray(value)) return defaultSampleModes();
  const allowed = new Set(MATCH_MODE_OPTIONS.map(item => item.id));
  const next = [];
  for (const item of value) {
    let id = item == null ? "untagged" : String(item);
    if (id === "") id = "untagged";
    if (!allowed.has(id) || next.includes(id)) continue;
    next.push(id);
  }
  return next.length ? next : defaultSampleModes();
}

function remapLegacyScriptKey(key) {
  return String(key || "").replace(/omegastats\.lua/gi, "omegadash.lua");
}

function normalizeHiddenScripts(value) {
  if (!Array.isArray(value)) return [];
  const next = [];
  const seen = new Set();
  for (const raw of value) {
    const key = remapLegacyScriptKey(String(raw || "").trim().slice(0, 80));
    if (!key || seen.has(key)) continue;
    if (!key.startsWith("id:") && !key.startsWith("name:")) continue;
    if (key === "name:") continue;
    seen.add(key);
    next.push(key);
    if (next.length >= 200) break;
  }
  return next;
}

function normalizeHiddenScriptFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [rawKey, rawFields] of Object.entries(value)) {
    const key = remapLegacyScriptKey(String(rawKey || "").trim().slice(0, 80));
    if (!key || key === "name:" || out[key]) continue;
    if (!key.startsWith("id:") && !key.startsWith("name:")) continue;
    const src = rawFields && typeof rawFields === "object" && !Array.isArray(rawFields)
      ? rawFields
      : Array.isArray(rawFields)
        ? Object.fromEntries(rawFields.map(name => [name, true]))
        : {};
    const fields = {};
    for (const [rawField, on] of Object.entries(src)) {
      const name = String(rawField || "").trim().slice(0, 80);
      if (!name || !on) continue;
      fields[name] = true;
      if (Object.keys(fields).length >= 80) break;
    }
    if (Object.keys(fields).length) out[key] = fields;
    if (Object.keys(out).length >= 200) break;
  }
  return out;
}

function cloneConfigSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    const parsed = JSON.parse(JSON.stringify(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeScriptBaselines(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [rawKey, rawCfg] of Object.entries(value)) {
    const key = remapLegacyScriptKey(String(rawKey || "").trim().slice(0, 80));
    if (!key || key === "name:" || out[key]) continue;
    if (!key.startsWith("id:") && !key.startsWith("name:")) continue;
    out[key] = cloneConfigSettings(rawCfg);
    if (Object.keys(out).length >= 200) break;
  }
  return out;
}

function normalizeLogColor(value) {
  const hex = String(value || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    const r = hex[1];
    const g = hex[2];
    const b = hex[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return "";
}

function normalizeLogScriptMap(value, asColor) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [raw, rawVal] of Object.entries(value)) {
    const src = String(raw || "").trim().slice(0, 80);
    if (!src) continue;
    if (asColor) {
      const color = normalizeLogColor(rawVal);
      if (!color) continue;
      out[src] = color;
    } else if (rawVal) {
      out[src] = true;
    }
    if (Object.keys(out).length >= 200) break;
  }
  return out;
}

function normalizeLogLineHighlights(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [raw, rawVal] of Object.entries(value)) {
    const key = String(raw || "").slice(0, 240);
    const color = normalizeLogColor(rawVal);
    if (!key || !color) continue;
    out[key] = color;
    if (Object.keys(out).length >= 500) break;
  }
  return out;
}

function matchModeId(match) {
  return String(match?.mode || "") || "untagged";
}

function modesForApi(modes) {
  return normalizeSampleModes(modes).map(id => id === "untagged" ? "" : id);
}

function matchModeSelect(match) {
  const current = String(match?.mode || "");
  const options = [
    ["", "Tag"],
    ["prem_comp", "Prem/Comp"],
    ["practice", "Practice"],
    ["casual", "Casual"],
    ["deathmatch", "Deathmatch"]
  ].map(([id, label]) => `<option value="${id}"${current === id ? " selected" : ""}>${label}</option>`).join("");
  return `<select class="match-mode${current ? " is-tagged" : ""}" data-match-mode="${esc(match?.id)}" aria-label="Match type">${options}</select>`;
}

function emptyFlickStats() {
  return { target: 0, under: 0, over: 0, clipped: 0, total: 0 };
}

function emptyState() {
  const zeros = { kd: 0, hs: 0, reaction: 0, firstShot: 0, counterStrafe: 0, pathEff: 0, hesitation: null };
  return {
    source: "empty",
    player: {
      name: "Whos", matches: 0, engagements: 0, hoursTracked: 0,
      kd: 0, hs: 0, reaction: 0, firstShot: 0, counterStrafe: 0, pathEff: 0,
      avgVelocity: 0, movingShots: 0, placementOffset: 0, headLevel: 0, preAimed: 0,
      hesitation: null,
      preaimClass: { onHead: 0, tight: 0, loose: 0, wide: 0, n: 0, label: "" }
    },
    ranges: { "7": { ...zeros }, "30": { ...zeros }, all: { ...zeros } },
    reactionHistory: [],
    flickPoints: [],
    flickStats: { "7": { ...emptyFlickStats() }, "30": { ...emptyFlickStats() }, all: { ...emptyFlickStats() } },
    placementPoints: [],
    placementStats: { total: 0, clipped: 0 },
    lastMatch: null,
    matches: [],
    maps: [],
    weapons: [],
    live: { lastPacket: "never", connected: false, latestWebAppVer: "" }
  };
}

function decorateMatch(match) {
  if (!match) return match;
  const maps = window.MAPS || {};
  const radars = window.RADARS || {};
  const thumbs = window.THUMBS || {};
  match.mapImage = maps[match.map] || match.mapImage || "";
  match.radarImage = radars[match.map] || match.radarImage || "";
  match.thumbImage = thumbs[match.map] || match.thumbImage || match.mapImage || "";
  match.engagements = match.engagements || [];
  match.locations = match.locations || [];
  const byKind = {
    kill: match.engagements.filter(e => String(e.result || "").toUpperCase() === "KILL"),
    death: match.engagements.filter(e => String(e.result || "").toUpperCase() === "DEATH")
  };
  const used = { kill: 0, death: 0 };
  const byId = new Map(match.engagements.map(item => [Number(item.id), item]));
  match.locations = match.locations.map(point => {
    let next = point;
    if (point.id == null) {
      const eng = byKind[point.type]?.[used[point.type]++] || null;
      next = eng ? { ...point, id: eng.id } : point;
    }
    if (next.round == null && next.id != null) {
      const eng = byId.get(Number(next.id));
      if (eng?.round != null) next = { ...next, round: eng.round };
    }
    return next;
  });
  match.side = match.side || {
    ct: { rounds: 0, kd: 0, reaction: 0 },
    t: { rounds: 0, kd: 0, reaction: 0 }
  };
  match.landing = match.landing || { under: 0, target: 0, over: 0 };
  match.mode = String(match.mode || "");
  return match;
}

function trend(value, inverse = false) {
  if (value == null || value === "") return `<span class="trend">—</span>`;
  const n = Number(value);
  if (!Number.isFinite(n)) return `<span class="trend">—</span>`;
  const text = `${n > 0 ? "+" : ""}${n}%`;
  if (n === 0) return `<span class="trend">${text}</span>`;
  const positive = inverse ? n < 0 : n > 0;
  return `<span class="trend ${positive ? "positive" : "negative"}">${text}</span>`;
}

function rangeCompareLabel(range) {
  if (range === "7") return "vs previous 7 days";
  if (range === "all") return "vs last 30 days";
  return "vs previous 30 days";
}

function paintTrendEl(el, value, inverse = false) {
  if (!el) return;
  if (value == null || value === "") {
    el.className = "trend";
    el.textContent = "—";
    return;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    el.className = "trend";
    el.textContent = "—";
    return;
  }
  el.textContent = `${n > 0 ? "+" : ""}${n}%`;
  if (n === 0) {
    el.className = "trend";
    return;
  }
  const positive = inverse ? n < 0 : n > 0;
  el.className = `trend ${positive ? "positive" : "negative"}`;
}

function hesitationLine(value) {
  if (value == null || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return `hesitation ${Math.round(n)}ms`;
}

function kpiCardHtml(card, glow) {
  const sub = card.sub ? `<div class="kpi-sub">${card.sub}</div>` : "";
  const valueClass = card.valueClass ? ` ${card.valueClass}` : "";
  return `
    <article class="kpi"${glow ? ` style="--glow:${glow}"` : ""}>
      <div class="kpi-label">${card.icon ? `<span>${card.label}</span><svg viewBox="0 0 24 24"><path d="${card.icon}"/></svg>` : card.label}</div>
      <div class="kpi-value${valueClass}">${card.value}</div>
      ${sub}
      <div class="kpi-foot">${card.foot}</div>
    </article>`;
}

function renderKpis(range = "30") {
  const stats = data.ranges?.[range] || data.ranges?.["30"] || { kd: 0, hs: 0, reaction: 0, firstShot: 0, counterStrafe: 0 };
  const vs = rangeCompareLabel(range);
  const cards = [
    { label: "K/D RATIO", value: Number(stats.kd || 0).toFixed(2), foot: `${trend(stats.kdDelta)} ${vs}`, icon: "M4 18 10 12l4 4 6-8" },
    { label: "HEADSHOT RATE", value: `${Number(stats.hs || 0).toFixed(1)}<small>%</small>`, foot: `${trend(stats.hsDelta)} ${vs}`, icon: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5v8m-4-4h8" },
    { label: "REACTION TIME", value: `${stats.reaction || 0}<small>ms</small>`, sub: hesitationLine(stats.hesitation) || "hesitation —", foot: `${trend(stats.reactionDelta, true)} faster`, icon: "m13 2-9 12h7l-1 8 9-12h-7l1-8Z" },
    { label: "FIRST SHOT", value: `${Number(stats.firstShot || 0).toFixed(1)}<small>%</small>`, foot: `${trend(stats.firstShotDelta)} accuracy`, icon: "M12 2v4m0 12v4M2 12h4m12 0h4M7 7l-3-3m13 3 3-3M7 17l-3 3m13-3 3 3" },
    { label: "COUNTER-STRAFE", value: `${Number(stats.counterStrafe || 0).toFixed(1)}<small>%</small>`, foot: `${trend(stats.counterStrafeDelta)} execution`, icon: "M5 12h14M9 8l-4 4 4 4m6-8 4 4-4 4" },
    { label: "PATH EFFICIENCY", value: `${Number(stats.pathEff || 0).toFixed(1)}<small>%</small>`, foot: `${trend(stats.pathEffDelta)} directness`, icon: "M4 19 20 5M14 5h6v6" }
  ];
  const glows = ["var(--accent)","var(--blue)","var(--accent-2)","var(--orange)","var(--accent)","var(--blue)"];
  $("#overallKpis").innerHTML = cards.map((card, i) => kpiCardHtml(card, glows[i])).join("");
  $("#reactionCurrent").textContent = stats.reaction;
  if ($("#placementOffset")) $("#placementOffset").textContent = `${stats.placementOffset ?? data.player?.placementOffset ?? 0}°`;
  if ($("#headLevel")) $("#headLevel").textContent = `${stats.headLevel ?? data.player?.headLevel ?? 0}%`;
  if ($("#preAimed")) $("#preAimed").textContent = `${stats.preAimed ?? data.player?.preAimed ?? 0}%`;
  const mix = $("#placementMix");
  if (mix) mix.textContent = classMixLabel(stats.preaimClass || data.player?.preaimClass);
  setGauge(stats.counterStrafe);
  paintTrendEl($("#counterTrend"), stats.counterStrafeDelta);
  paintRankKpis();
}

function hexToRgba(hex, alpha) {
  const raw = String(hex || "").replace("#", "");
  if (raw.length < 6) return `rgba(121, 242, 176, ${alpha})`;
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function themeGradientStops() {
  const theme = themeDef();
  if (Array.isArray(theme.gradient) && theme.gradient.length >= 2) {
    return [theme.gradient[0], theme.gradient[1]];
  }
  return [theme.accent, theme.accent2];
}

function cssAccent() {
  return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || themeAccent();
}

function lineGradient(context) {
  const chart = context.chart;
  const { ctx, chartArea } = chart;
  const rgb = getComputedStyle(document.documentElement).getPropertyValue("--accent-rgb").trim() || "121, 242, 176";
  if (!chartArea) return `rgba(${rgb},.2)`;
  if (document.body.classList.contains("static-gradients")) {
    const [from, to] = themeGradientStops();
    const gradient = ctx.createLinearGradient(chartArea.left, chartArea.top, chartArea.right, chartArea.bottom);
    gradient.addColorStop(0, hexToRgba(from, 0.3));
    gradient.addColorStop(0.55, hexToRgba(to, 0.12));
    gradient.addColorStop(1, hexToRgba(to, 0));
    return gradient;
  }
  const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  gradient.addColorStop(0, `rgba(${rgb},.25)`);
  gradient.addColorStop(1, `rgba(${rgb},0)`);
  return gradient;
}

function reactionStroke(context) {
  if (!document.body.classList.contains("static-gradients")) return cssAccent();
  const chart = context.chart;
  const { ctx, chartArea } = chart;
  if (!chartArea) return cssAccent();
  const [from, to] = themeGradientStops();
  const gradient = ctx.createLinearGradient(chartArea.left, chartArea.top, chartArea.right, chartArea.bottom);
  gradient.addColorStop(0, from);
  gradient.addColorStop(1, to);
  return gradient;
}

function makeReactionChart(id, points, compact = false, valueKey = null) {
  const el = document.getElementById(id);
  if (!el || charts[id]) return;
  const pick = p => {
    if (valueKey) return p[valueKey];
    return p.value ?? p.reaction;
  };
  charts[id] = new Chart(el, {
    type: "line",
    data: {
      labels: points.map((p, i) => compact ? i + 1 : p.label),
      datasets: [{
        data: points.map(pick),
        borderColor: reactionStroke, borderWidth: 1.6, pointRadius: 0, pointHoverRadius: 4,
        pointHoverBackgroundColor: () => cssAccent(), fill: true, backgroundColor: lineGradient, tension: .35,
        spanGaps: true
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 650 },
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: { display: false },
        tooltip: compact ? {
          ...tooltipOptions("ms"),
          callbacks: {
            title: items => {
              const index = items[0]?.dataIndex;
              const point = Number.isInteger(index) ? points[index] : null;
              const n = (index ?? 0) + 1;
              const rnd = Number(point?.round);
              return Number.isFinite(rnd) && rnd > 0 ? `#${n} · Round ${rnd}` : `#${n}`;
            },
            label: context => {
              const raw = context.raw?.y ?? context.raw;
              return raw == null ? "—" : `${raw}ms`;
            }
          }
        } : tooltipOptions("ms")
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 8, color: "#46535e" } },
        y: { border: { display: false }, grid: { color: "rgba(148,163,184,.07)" }, ticks: { callback: v => `${v}ms`, maxTicksLimit: 5 } }
      }
    }
  });
}

function tooltipOptions(suffix = "") {
  return {
    backgroundColor: "#151e25", borderColor: "rgba(121,242,176,.2)", borderWidth: 1,
    titleColor: "#788591", bodyColor: "#eef3f5", padding: 10, displayColors: false,
    callbacks: { label: context => `${context.raw?.y ?? context.raw}${suffix}` }
  };
}

function flickPointTooltip(raw) {
  if (!raw || raw.alongDeg == null) {
    return `depth ${Number(raw?.x || 0).toFixed(1)}° · vert ${Number(raw?.y || 0).toFixed(1)}°`;
  }
  const along = Number(raw.alongDeg) || 0;
  const vert = Number(raw.vertDeg) || 0;
  const cone = Number(raw.coneDeg) || 0;
  const pitch = !vert ? "level" : `${Math.abs(vert).toFixed(1)}° ${vert > 0 ? "high" : "low"}`;
  const clip = raw.clipped ? " · off-scale" : "";
  if (raw.type === "target") {
    const depth = Math.abs(along);
    if (depth < 0.05) return `${pitch} · cone ${cone.toFixed(1)}°${clip}`;
    return `${depth.toFixed(1)}° off center · ${pitch} · cone ${cone.toFixed(1)}°${clip}`;
  }
  const side = along > 0.05 ? "past" : along < -0.05 ? "short" : "on depth";
  return `${Math.abs(along).toFixed(1)}° ${side} · ${pitch} · cone ${cone.toFixed(1)}°${clip}`;
}

function selectedStatRange() {
  return $("#rangeControl .active")?.dataset.range || "30";
}

function flickInSelectedRange(point, range) {
  if (range === "all") return true;
  const limit = range === "7" ? 7 : 30;
  const ago = Number(point.daysAgo);
  if (!Number.isFinite(ago)) return true;
  return ago <= limit;
}

function flickScatterState() {
  const range = selectedStatRange();
  const inRange = (data.flickPoints || []).filter(point => flickInSelectedRange(point, range));
  const plotted = { under: [], target: [], over: [] };
  const fromPoints = emptyFlickStats();
  inRange.forEach(point => {
    if (fromPoints[point.type] == null) return;
    fromPoints[point.type] += 1;
    fromPoints.total += 1;
    if (point.clipped) {
      fromPoints.clipped += 1;
      return;
    }
    plotted[point.type].push(point);
  });
  const stats = data.flickStats?.[range];
  const counts = stats
    ? {
        under: Number(stats.under) || 0,
        target: Number(stats.target) || 0,
        over: Number(stats.over) || 0,
        clipped: Number(stats.clipped) || 0,
        total: Number(stats.total) || 0
      }
    : fromPoints;
  return { plotted, counts, sampled: counts.total > inRange.length, shown: inRange.length };
}

function flickScatterDatasets(plotted) {
  return [
    { label: "Undershoot", data: plotted.under, backgroundColor: "rgba(105,167,255,.6)" },
    { label: "On target", data: plotted.target, backgroundColor: `${themeAccent()}c7` },
    { label: "Overshoot", data: plotted.over, backgroundColor: "rgba(255,157,102,.62)" }
  ].map(d => ({ ...d, pointRadius: 2.4, pointHoverRadius: 4, pointHitRadius: 8 }));
}

function paintFlickSummary(counts, sampled, shown) {
  const total = counts.total;
  const clipped = counts.clipped;
  const note = $("#flickGraphNote");
  if (note) {
    note.hidden = false;
    note.textContent = "Graph is limited to the last 100 flicks. Dots outside this window are not drawn. Side totals still count every flick.";
  }
  const summary = $("#flickSummary");
  if (!summary) return;
  summary.innerHTML = [
    ["On target", total ? counts.target / total * 100 : 0, themeAccent(), counts.target],
    ["Under", total ? counts.under / total * 100 : 0, "#69a7ff", counts.under],
    ["Over", total ? counts.over / total * 100 : 0, "#ff9d66", counts.over]
  ].map(([label, value, color, n]) => `<div><span>${label}</span><strong style="color:${color}">${value.toFixed(0)}%<small>${n}</small></strong></div>`).join("");
}

function makeScatter() {
  const canvas = $("#flickScatter");
  if (!canvas) return;
  const { plotted, counts, sampled, shown } = flickScatterState();
  const datasets = flickScatterDatasets(plotted);
  if (charts.flickScatter) {
    charts.flickScatter.data.datasets.forEach((ds, i) => {
      ds.data = datasets[i]?.data || [];
    });
    charts.flickScatter.update("none");
  } else {
    charts.flickScatter = new Chart(canvas, {
      type: "scatter",
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            ...tooltipOptions("°"),
            callbacks: {
              title: items => items[0]?.dataset.label || "",
              label: c => flickPointTooltip(c.raw)
            }
          }
        },
        scales: {
          x: { min: -4.5, max: 4.5, title: { display: true, text: "FLICK DEPTH (DEG)", color: "#6e7a86", font: { size: 8 } }, grid: { color: c => c.tick.value === 0 ? `${themeAccent()}38` : "rgba(148,163,184,.06)" } },
          y: { min: -2.5, max: 2.5, title: { display: true, text: "VERTICAL ERROR", color: "#6e7a86", font: { size: 8 } }, grid: { color: c => c.tick.value === 0 ? `${themeAccent()}38` : "rgba(148,163,184,.06)" } }
        }
      }
    });
  }
  paintFlickSummary(counts, sampled, shown);
}

function paintPlacementNote() {
  const note = $("#placementGraphNote");
  if (!note) return;
  note.hidden = false;
  note.textContent = "Graph shows the newest 100 peeks. Dots outside this window are not drawn.";
}

function makeRadar() {
  if (charts.placementRadar) return;
  const points = (data.placementPoints || [])
    .filter(point => !point.clipped)
    .map(point => ({
      x: Number(point.x) || 0,
      y: Number(point.y) || 0
    }));
  paintPlacementNote();
  const axisTitle = text => ({ display: true, text, color: "#6e7a86", font: { size: 8 } });
  const zeroGrid = c => c.tick.value === 0 ? `${themeAccent()}38` : "rgba(148,163,184,.06)";
  charts.placementRadar = new Chart($("#placementRadar"), {
    type: "scatter",
    data: {
      datasets: [{
        data: points,
        pointRadius: 2.4,
        pointHoverRadius: 5,
        pointHitRadius: 8,
        pointBackgroundColor: `${themeAccent()}c7`,
        pointHoverBackgroundColor: cssAccent(),
        pointBorderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipOptions("°"),
          callbacks: {
            title: () => "First peek vs head",
            label: c => {
              const x = Number(c.raw?.x) || 0;
              const y = Number(c.raw?.y) || 0;
              const horiz = !x ? "on yaw" : `${Math.abs(x).toFixed(1)}° ${x > 0 ? "right" : "left"}`;
              const vert = !y ? "head-level" : `${Math.abs(y).toFixed(1)}° ${y > 0 ? "high" : "low"}`;
              return `${horiz} · ${vert}`;
            }
          }
        }
      },
      scales: {
        x: {
          min: -12, max: 12,
          title: axisTitle("YAW · LEFT / RIGHT"),
          ticks: { color: "#46535e", maxTicksLimit: 7, callback: v => `${v}°` },
          grid: { color: zeroGrid }
        },
        y: {
          min: -6, max: 6,
          title: axisTitle("PITCH · LOW / HIGH"),
          ticks: { color: "#46535e", maxTicksLimit: 7, callback: v => `${v}°` },
          grid: { color: zeroGrid }
        }
      }
    }
  });
}

function setGauge(value) {
  const gauge = $("#counterGauge");
  if (!gauge) return;
  const n = Math.max(0, Math.min(100, Number(value) || 0));
  gauge.style.setProperty("--value", String(n));
  const arc = gauge.querySelector(".gauge-arc");
  if (arc) {
    const radius = Number(arc.getAttribute("r")) || 52;
    const circ = 2 * Math.PI * radius;
    arc.style.strokeDasharray = `${circ}`;
    arc.style.strokeDashoffset = `${circ * (1 - n / 100)}`;
  }
  const label = gauge.querySelector("strong");
  if (label) label.textContent = `${n.toFixed(1)}%`;
  if ($("#perfectShots")) $("#perfectShots").textContent = `${n.toFixed(1)}%`;
  if ($("#avgVelocity")) $("#avgVelocity").textContent = `${data.player?.avgVelocity ?? 0} u/s`;
  if ($("#movingShots")) $("#movingShots").textContent = `${data.player?.movingShots ?? 0}%`;
}

let radarMeta = null;
let heatmapHits = [];
let selectedSpotId = null;
let heatmapMode = "all";
let heatmapRound = 0;
let heatmapMatchId = null;

function engagementRound(item) {
  const n = Number(item?.round);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function matchHeatmapMaxRound(match) {
  if (!match) return 0;
  const fromList = list => (list || []).reduce((max, item) => {
    const n = engagementRound(item);
    return n != null && n > max ? n : max;
  }, 0);
  const played = Number(match.rounds) || 0;
  const scoreCt = Number(match.scoreCt);
  const scoreT = Number(match.scoreT);
  const fromScore = (Number.isFinite(scoreCt) ? scoreCt : 0) + (Number.isFinite(scoreT) ? scoreT : 0);
  let max = Math.max(fromList(match.engagements), fromList(match.locations), played, fromScore);
  if (match.live && max < played + 1) max = played + 1;
  return max;
}

function syncHeatmapRoundControl(match) {
  const label = $("#heatmapRoundLabel");
  const prev = $("#heatmapRoundPrev");
  const next = $("#heatmapRoundNext");
  const max = matchHeatmapMaxRound(match);
  if (heatmapRound > max) heatmapRound = 0;
  if (label) {
    label.textContent = heatmapRound > 0 ? `Round ${heatmapRound}` : "All rounds";
    label.title = heatmapRound > 0 ? "Click to show all rounds" : "";
  }
  const disabled = max <= 0;
  if (prev) prev.disabled = disabled;
  if (next) next.disabled = disabled;
}

function cycleHeatmapRound(step) {
  const max = matchHeatmapMaxRound(data.lastMatch);
  if (max <= 0) return;
  const span = max + 1;
  const next = ((heatmapRound + step) % span + span) % span;
  setHeatmapRound(next);
}

function syncEngagementRoundHighlight() {
  $$("#engagementRows tr").forEach(row => {
    const rnd = Number(row.dataset.round);
    row.classList.toggle("is-offround", heatmapRound > 0 && rnd !== heatmapRound);
  });
}

function setHeatmapRound(value) {
  const n = Number(value);
  heatmapRound = Number.isFinite(n) && n > 0 ? n : 0;
  syncHeatmapRoundControl(data.lastMatch);
  if (selectedSpotId != null) {
    const eng = findEngagement(selectedSpotId);
    if (heatmapRound > 0 && engagementRound(eng) !== heatmapRound) selectedSpotId = null;
  }
  drawLocationHeatmap();
  syncEngagementRoundHighlight();
}

function radarPoint(point, width, height) {
  if (point.worldX != null && radarMeta) {
    const radarSize = radarMeta.scale * 1024;
    return {
      x: ((point.worldX - radarMeta.pos_x) / radarSize) * width,
      y: ((radarMeta.pos_y - point.worldY) / radarSize) * height
    };
  }
  return { x: point.x * width, y: point.y * height };
}

function noFlickDetected(engagement) {
  if (!engagement || engagement.unattributed) return false;
  if (engagement.flickDetected === false || engagement.landing === "none") return true;
  const deg = Number(engagement.flick);
  if (!Number.isFinite(deg) || deg < 1.5) return true;
  return false;
}

function landingLabel(engagement) {
  if (!engagement) return "—";
  if (engagement.unattributed) return engagement.unattributedWhy || "Unattributed";
  if (noFlickDetected(engagement)) return "No flick detected";
  if (engagement.landing === "target") return "On target";
  if (engagement.landing === "under") return `Undershoot ${engagement.landingDeg}°`;
  if (engagement.landing === "over") return `Overshoot ${engagement.landingDeg}°`;
  return engagement.landing || "—";
}

function landingPillText(engagement) {
  if (!engagement) return "—";
  if (engagement.unattributed) return engagement.unattributedWhy || "UNATTRIBUTED";
  if (noFlickDetected(engagement)) return "NO FLICK DETECTED";
  if (engagement.landing === "target") return "ON TARGET";
  if (engagement.landing === "under" || engagement.landing === "over") {
    return `${String(engagement.landing).toUpperCase()} ${engagement.landingDeg}°`;
  }
  return String(engagement.landing || "—").toUpperCase();
}

function flickCell(engagement) {
  if (!engagement || engagement.unattributed) return "—";
  if (noFlickDetected(engagement) || engagement.flick == null) return "—";
  return `${engagement.flick}°`;
}

function findEngagement(id) {
  if (id == null) return null;
  return (data.lastMatch?.engagements || []).find(item => Number(item.id) === Number(id)) || null;
}

function highlightEngagementRow(id) {
  $$("#engagementRows tr").forEach(row => {
    row.classList.toggle("is-active", id != null && Number(row.dataset.id) === Number(id));
  });
}

function selectSpot(id) {
  selectedSpotId = id;
  drawLocationHeatmap(heatmapMode);
  highlightEngagementRow(id);
}

function canvasPoint(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return { x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY };
}

const SPOT_HIT_R = 28;
const HEAT_RADIUS = 38;

function hitSpots(event, canvas) {
  const { x, y } = canvasPoint(event, canvas);
  const seen = new Set();
  const hits = [];
  for (let i = heatmapHits.length - 1; i >= 0; i -= 1) {
    const hit = heatmapHits[i];
    const dx = x - hit.x;
    const dy = y - hit.y;
    if (dx * dx + dy * dy > hit.r * hit.r) continue;
    const key = Number(hit.id);
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(hit);
  }
  return hits;
}

function cycleSpot(hits) {
  if (!hits.length) {
    selectSpot(null);
    return;
  }
  const ids = hits.map(hit => Number(hit.id));
  const current = ids.indexOf(Number(selectedSpotId));
  const next = hits[(current + 1) % hits.length];
  selectSpot(next.id);
}

function rgbLuma(rgb) {
  const lin = rgb.map(c => {
    const s = Number(c) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function heatmapRgb(type) {
  if (type === "kill") {
    const accentHex = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    return accentHex.match(/\w\w/g)?.map(value => parseInt(value, 16)) || [121, 242, 176];
  }
  return [255, 86, 116];
}

function heatGlowGain(rgb) {
  const luma = rgbLuma(rgb);
  const chroma = (Math.max(...rgb) - Math.min(...rgb)) / 255;
  let gain = 1;
  if (settings?.theme === "neon") gain = 0.55;
  else if (chroma > 0.65 && luma > 0.3 && rgb[0] > 200 && rgb[2] > 130) gain = 0.68;
  if (luma < 0.2) gain *= 1.45;
  return gain;
}

function drawHeatBlob(ctx, point) {
  const { x, y } = point;
  const rgb = heatmapRgb(point.type);
  const gain = heatGlowGain(rgb);
  const glow = ctx.createRadialGradient(x, y, 0, x, y, HEAT_RADIUS);
  glow.addColorStop(0, `rgba(${rgb.join(",")},${Math.min(0.95, 0.82 * gain)})`);
  glow.addColorStop(0.12, `rgba(${rgb.join(",")},${Math.min(0.7, 0.46 * gain)})`);
  glow.addColorStop(0.34, `rgba(${rgb.join(",")},${0.12 * gain})`);
  glow.addColorStop(0.58, `rgba(${rgb.join(",")},${0.03 * gain})`);
  glow.addColorStop(1, `rgba(${rgb.join(",")},0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(x - HEAT_RADIUS, y - HEAT_RADIUS, HEAT_RADIUS * 2, HEAT_RADIUS * 2);
}

function drawSpotSelection(ctx, point) {
  const { x, y } = point;
  const rgb = heatmapRgb(point.type);
  ctx.beginPath();
  ctx.arc(x, y, 16, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(${rgb.join(",")},.9)`;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 21, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,.4)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawLocationHeatmap(mode) {
  if (mode) heatmapMode = mode;
  heatmapMode = heatmapMode || "all";
  const canvas = $("#locationHeatmap");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const locations = data.lastMatch?.locations || [];
  const visible = locations.filter(p => {
    if (heatmapMode !== "all" && `${p.type}s` !== heatmapMode) return false;
    if (heatmapRound > 0 && engagementRound(p) !== heatmapRound) return false;
    if (p.worldX != null && !radarMeta) return false;
    return true;
  });

  heatmapHits = visible.map(point => {
    const pos = radarPoint(point, w, h);
    return { x: pos.x, y: pos.y, r: SPOT_HIT_R, id: point.id, type: point.type, cluster: 1 };
  });
  const reach = SPOT_HIT_R * SPOT_HIT_R;
  heatmapHits.forEach(hit => {
    hit.cluster = heatmapHits.filter(other => {
      const dx = other.x - hit.x;
      const dy = other.y - hit.y;
      return dx * dx + dy * dy <= reach;
    }).length;
  });

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  heatmapHits.forEach(point => drawHeatBlob(ctx, point));
  ctx.restore();
  if (selectedSpotId != null) {
    heatmapHits
      .filter(point => Number(point.id) === Number(selectedSpotId))
      .forEach(point => drawSpotSelection(ctx, point));
  }

  const kills = visible.filter(p => p.type === "kill").length;
  const deaths = visible.filter(p => p.type === "death").length;
  const pkd = deaths ? (kills / deaths).toFixed(2) : kills ? String(kills) : "—";
  const engagement = findEngagement(selectedSpotId);
  const result = String(engagement?.result || "").toUpperCase();
  const cluster = heatmapHits.find(hit => Number(hit.id) === Number(selectedSpotId))?.cluster || 1;
  const roundText = engagementRound(engagement);
  $("#locationInsights").innerHTML = `
    <div class="insight-score"><span>POSITIONAL K/D</span><strong>${pkd}</strong><small>${kills} kills · ${deaths} deaths${heatmapRound > 0 ? ` · round ${heatmapRound}` : ""}</small></div>
    ${engagement ? `
      <div class="spot-detail">
        <div class="spot-detail-head">
          <span class="result-pill ${result.toLowerCase()}">${esc(result || "—")}</span>
          <strong>#${String(engagement.id).padStart(2, "0")}</strong>
          ${cluster > 1 ? `<em class="spot-cycle">${cluster} overlapping · click again</em>` : ""}
          <button type="button" class="spot-clear" id="spotClear" aria-label="Clear selection">×</button>
        </div>
        <div class="spot-grid">
          <div><span>Round</span><strong>${roundText ?? "—"}</strong></div>
          <div><span>Weapon</span><strong>${esc(engagement.weapon || "—")}</strong></div>
          <div><span>Pre-aim</span><strong>${esc(fmtPreaimCell(engagement))}</strong></div>
          <div><span>Flick</span><strong>${esc(flickCell(engagement))}</strong></div>
          <div><span>Path</span><strong>${esc(fmtPathEff(engagement.pathEff))}</strong></div>
          <div><span>Landing</span><strong>${esc(landingLabel(engagement))}</strong></div>
          <div><span>Reaction</span><strong>${engagement.reaction != null ? `${esc(engagement.reaction)}ms` : "—"}</strong></div>
          <div><span>Hesitation</span><strong>${engagement.hesitation != null ? `${esc(engagement.hesitation)}ms` : "—"}</strong></div>
          <div><span>TTK</span><strong>${engagement.ttk ? `${esc(engagement.ttk)}ms` : "—"}</strong></div>
          <div><span>1st shot</span><strong>${engagement.firstShot == null ? "—" : engagement.firstShot ? "HIT" : "MISS"}</strong></div>
          <div><span>Velocity</span><strong>${engagement.velocity != null ? `${esc(engagement.velocity)} u/s` : "—"}</strong></div>
        </div>
      </div>` : `<p class="spot-empty">Click a kill or death marker to inspect that engagement. If spots overlap, click again to cycle through them.</p>`}`;
  $("#spotClear")?.addEventListener("click", () => selectSpot(null));
}

function bindHeatmap() {
  const canvas = $("#locationHeatmap");
  if (!canvas || canvas.dataset.bound) return;
  canvas.dataset.bound = "1";
  canvas.addEventListener("mousemove", event => {
    canvas.style.cursor = hitSpots(event, canvas).length ? "pointer" : "default";
  });
  canvas.addEventListener("click", event => {
    cycleSpot(hitSpots(event, canvas));
  });
}

let mapCatalogPromise = null;

function loadMapCatalog() {
  if (!mapCatalogPromise) {
    mapCatalogPromise = fetch("https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/data/available.json")
      .then(response => {
        if (!response.ok) throw new Error("Map catalog unavailable");
        return response.json();
      })
      .catch(() => null);
  }
  return mapCatalogPromise;
}

function catalogMapEntry(catalog, mapName) {
  const maps = catalog?.maps;
  if (!maps || !mapName) return null;
  const needle = String(mapName).toLowerCase().replace(/\s+/g, "");
  return Object.entries(maps).find(([id, entry]) => {
    const display = String(entry?.display_name || "").toLowerCase().replace(/\s+/g, "");
    const key = String(id).toLowerCase();
    return display === needle
      || key === needle
      || key === `de_${needle}`
      || key === `cs_${needle}`;
  })?.[1] || null;
}

async function resolveRadarFromCatalog(mapName, fallbacks = {}) {
  try {
    const catalog = await loadMapCatalog();
    const map = catalogMapEntry(catalog, mapName);
    const thumbs = map?.thumb_paths || [];
    return {
      radar: map?.radar_paths?.find(path => !path.includes("_lower_")) || map?.radar_paths?.[0] || fallbacks.radar,
      icon: map?.path || fallbacks.icon,
      thumb: thumbs.find(path => /_\d+_png\.png$/.test(path)) || thumbs[0] || fallbacks.thumb,
      info: map?.radar_info || null
    };
  } catch {
    return { radar: fallbacks.radar, icon: fallbacks.icon, thumb: fallbacks.thumb, info: null };
  }
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtMoney(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return `$${Number(value).toLocaleString("en-US")}`;
}

function fmtPathEff(value) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n)}%`;
}

function fmtMs(value) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n)}ms`;
}

function preaimClassLabel(value) {
  const key = String(value || "").trim().toLowerCase();
  if (key === "on head" || key === "onhead" || key === "on-head") return "on head";
  if (key === "tight" || key === "loose" || key === "wide") return key;
  return "";
}

function fmtPreaimCell(engagement) {
  if (!engagement || engagement.unattributed) return "—";
  if (engagement.preaimHeld) return "already vis";
  const deg = engagement.preaim != null && engagement.preaim !== "" ? `${engagement.preaim}°` : "—";
  const cls = preaimClassLabel(engagement.preaimClass);
  return cls ? `${cls} ${deg}` : deg;
}

function classMixLabel(mix) {
  if (!mix) return "";
  if (mix.label) return mix.label;
  const parts = [
    [mix.onHead, "on head"],
    [mix.tight, "tight"],
    [mix.loose, "loose"],
    [mix.wide, "wide"]
  ].filter(([pct]) => Number(pct) > 0).map(([pct, name]) => `${pct}% ${name}`);
  return parts.join(" · ");
}

function fmtKd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

function fmtHs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(1);
}

function teamSide(team) {
  if (Number(team) === 3) return { key: "ct", tag: "CT", label: "COUNTER-TERRORISTS" };
  return { key: "t", tag: "T", label: "TERRORISTS" };
}

function scoreboardKey(state) {
  const last = state?.lastMatch;
  const board = last?.scoreboard;
  const you = board?.you || [];
  const them = board?.them || [];
  const rows = [...you, ...them].map(row => [
    row.id, row.health, row.money, row.kills, row.deaths, row.assists,
    row.armor, row.helmet ? 1 : 0, row.kit ? 1 : 0, row.primaryId || "",
    row.primary || "", row.secondaryId || "", row.secondary || "",
    row.dmg, row.hs, row.headshots, row.ud, row.flashed, row.alive ? 1 : 0,
    row.steam64 || ""
  ].join(":"));
  return [
    last?.id, last?.live ? 1 : 0, last?.score, last?.scoreCt, last?.scoreT,
    board?.scoreCt, board?.scoreT, you.length, them.length, ...rows
  ].join("|");
}

const EQUIP_ICON = "https://cdn.jsdelivr.net/gh/Juknum/counter-strike-icons@main/cs2/panorama/images/icons/equipment/";

const WEAPON_ICON_BY_ID = {
  1: "deagle", 2: "elite", 3: "fiveseven", 4: "glock", 7: "ak47", 8: "aug",
  9: "awp", 10: "famas", 11: "g3sg1", 13: "galilar", 14: "m249", 16: "m4a1",
  17: "mac10", 19: "p90", 23: "mp5sd", 24: "ump45", 25: "xm1014", 26: "bizon",
  27: "mag7", 28: "negev", 29: "sawedoff", 30: "tec9", 31: "taser", 32: "hkp2000",
  33: "mp7", 34: "mp9", 35: "nova", 36: "p250", 38: "scar20", 39: "sg556",
  40: "ssg08", 41: "knife", 42: "knife", 59: "knife", 60: "m4a1_silencer",
  61: "usp_silencer", 63: "cz75a", 64: "revolver",
  500: "knife", 503: "knife", 505: "knife", 506: "knife", 507: "knife",
  508: "knife", 509: "knife", 512: "knife", 514: "knife", 515: "knife",
  516: "knife", 517: "knife", 518: "knife", 519: "knife", 520: "knife",
  521: "knife", 522: "knife", 523: "knife", 525: "knife"
};

const WEAPON_ICON_BY_NAME = {
  "Desert Eagle": "deagle", "Dual Berettas": "elite", "Five-SeveN": "fiveseven",
  "Glock-18": "glock", "AK-47": "ak47", "AUG": "aug", "AWP": "awp", "FAMAS": "famas",
  "G3SG1": "g3sg1", "Galil AR": "galilar", "M249": "m249", "M4A4": "m4a1",
  "MAC-10": "mac10", "P90": "p90", "MP5-SD": "mp5sd", "UMP-45": "ump45",
  "XM1014": "xm1014", "PP-Bizon": "bizon", "MAG-7": "mag7", "Negev": "negev",
  "Sawed-Off": "sawedoff", "Tec-9": "tec9", "Zeus x27": "taser", "P2000": "hkp2000",
  "MP7": "mp7", "MP9": "mp9", "Nova": "nova", "P250": "p250", "SCAR-20": "scar20",
  "SG 553": "sg556", "SSG 08": "ssg08", "M4A1-S": "m4a1_silencer", "USP-S": "usp_silencer",
  "CZ75-Auto": "cz75a", "R8 Revolver": "revolver", "Knife": "knife"
};

function equipmentSrc(file) {
  return `icons/equipment/${file}.svg`;
}

function equipmentFallback(file) {
  return `${EQUIP_ICON}${file}.svg`;
}

function iconImg(file, title, cls) {
  const src = equipmentSrc(file);
  const cdn = equipmentFallback(file);
  return `<span class="${cls}" title="${esc(title)}"><img src="${src}" alt="${esc(title)}" data-cdn="${esc(cdn)}" onerror="if(!this.dataset.tried){this.dataset.tried=1;this.src=this.dataset.cdn}else{this.remove()}"><em>${esc(title)}</em></span>`;
}

function weaponIconFile(id, name) {
  const n = Number(id);
  if (Number.isFinite(n) && WEAPON_ICON_BY_ID[n]) return WEAPON_ICON_BY_ID[n];
  if (name && WEAPON_ICON_BY_NAME[name]) return WEAPON_ICON_BY_NAME[name];
  if (name) {
    const slug = String(name).toLowerCase().replace(/^weapon_/, "").replace(/[^a-z0-9]/g, "");
    if (slug.includes("knife") || slug.includes("bayonet") || slug.includes("karambit") || slug.includes("daggers")) {
      return "knife";
    }
    const hit = Object.entries(WEAPON_ICON_BY_NAME).find(([label]) =>
      label.toLowerCase().replace(/[^a-z0-9]/g, "") === slug
    );
    if (hit) return hit[1];
  }
  return null;
}

function weaponMark(id, name, klass) {
  const file = weaponIconFile(id, name);
  const abbr = esc((String(name || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 2) || "?").toUpperCase());
  const kind = esc(klass || "other");
  if (!file) {
    return `<div class="weapon-mark is-abbr" data-class="${kind}">${abbr}</div>`;
  }
  const src = equipmentSrc(file);
  const cdn = equipmentFallback(file);
  return `<div class="weapon-mark has-icon" data-class="${kind}" title="${esc(name || "")}">
    <img src="${src}" alt="${esc(name || "")}" data-cdn="${esc(cdn)}" data-abbr="${abbr}" onerror="if(!this.dataset.tried){this.dataset.tried=1;this.src=this.dataset.cdn}else{const p=this.parentElement;p.classList.remove('has-icon');p.classList.add('is-abbr');p.textContent=this.dataset.abbr}">
  </div>`;
}

function weaponCell(id, name) {
  if (!name && (id == null || id === "")) return `<span class="sb-muted">—</span>`;
  const file = weaponIconFile(id, name);
  const label = name || `#${id}`;
  if (!file) return `<span class="sb-muted">${esc(label)}</span>`;
  return iconImg(file, label, "sb-wep");
}

function armorCell(row) {
  const armor = Number(row.armor) || 0;
  if (armor <= 0 && !row.helmet) return `<span class="sb-muted">—</span>`;
  const file = row.helmet ? "armor_helmet" : "kevlar";
  const title = row.helmet ? `Kevlar + Helmet (${armor})` : `Kevlar (${armor})`;
  return `${iconImg(file, title, "sb-gear")}<b class="sb-armor-n">${armor}</b>`;
}

function kitCell(hasKit) {
  if (!hasKit) return `<span class="sb-muted">—</span>`;
  return iconImg("defuser", "Defuse kit", "sb-gear sb-kit-on");
}

let scoreboardView = "game";
let leetifyProfiles = {};
let leetifyInflight = false;

function syncScoreboardViewUi() {
  const label = $("#sbViewLabel");
  if (label) label.textContent = scoreboardView === "leetify" ? "Leetify" : "Match";
}

function cycleScoreboardView(step = 1) {
  scoreboardView = scoreboardView === "game" ? "leetify" : "game";
  syncScoreboardViewUi();
  paintScoreboard(data.lastMatch);
}

function asSteam64(value) {
  const text = String(value || "").trim();
  if (/^7656119\d{8,}$/.test(text)) return text;
  if (/^\d{1,16}$/.test(text)) {
    try {
      const n = BigInt(text);
      const base = 76561197960265728n;
      if (n > 0n && n < base) return String(n + base);
    } catch { /* ignore */ }
    return "";
  }
  const steam2 = /^STEAM_[0-5]:([01]):(\d+)$/i.exec(text);
  if (steam2) return String(BigInt(steam2[2]) * 2n + BigInt(steam2[1]) + 76561197960265728n);
  const steam3 = /\[U:1:(\d+)\]/i.exec(text);
  return steam3 ? asSteam64(steam3[1]) : "";
}

function collectSteam64s(match) {
  const rows = [...(match?.scoreboard?.you || []), ...(match?.scoreboard?.them || [])];
  const ids = [];
  const seen = new Set();
  for (const row of rows) {
    const id = asSteam64(row.steam64);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  const selfId = asSteam64(selfSteam64);
  if (selfId && !seen.has(selfId)) ids.push(selfId);
  return ids;
}

function leetifyNeedsFetch(id) {
  const profile = leetifyProfiles[id];
  if (!profile) return true;
  if (profile.status === "loading") return true;
  if (profile.status === "error") return true;
  if (profile.status === "ok" && !Array.isArray(profile.competitive)) return true;
  const fetched = Number(profile.fetchedAt) || 0;
  if (!fetched) return true;
  return Date.now() - fetched * 1000 >= LEETIFY_TTL_MS;
}

function applyLeetifyData(data) {
  if (!data || typeof data !== "object") return;
  Object.assign(leetifyProfiles, data);
  if (selfSteam64 && data[selfSteam64]) {
    selfLeetify = data[selfSteam64];
    paintRankKpis();
    renderMaps();
  }
}

async function ensureLeetifyProfiles(match) {
  const ids = collectSteam64s(match).filter(leetifyNeedsFetch);
  if (!ids.length || leetifyInflight || !window.pywebview?.api?.get_leetify_profiles) return;
  leetifyInflight = true;
  ids.forEach(id => {
    if (!leetifyProfiles[id]) leetifyProfiles[id] = { steam64: id, status: "loading" };
  });
  try {
    const result = await window.pywebview.api.get_leetify_profiles(JSON.stringify(ids));
    if (result?.ok && result.data && typeof result.data === "object") {
      applyLeetifyData(result.data);
      if (scoreboardView === "leetify") paintScoreboard(data.lastMatch);
    }
  } catch { /* keep cached profiles */ }
  finally {
    leetifyInflight = false;
  }
}

function fmtLeetify(value, digits = 1, suffix = "") {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}${suffix}`;
}

function fmtPremier(value) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

const CS_SKILL_GROUPS = [
  "Unranked",
  "Silver I",
  "Silver II",
  "Silver III",
  "Silver IV",
  "Silver Elite",
  "Silver Elite Master",
  "Gold Nova I",
  "Gold Nova II",
  "Gold Nova III",
  "Gold Nova Master",
  "Master Guardian I",
  "Master Guardian II",
  "Master Guardian Elite",
  "Distinguished Master Guardian",
  "Legendary Eagle",
  "Legendary Eagle Master",
  "Supreme Master First Class",
  "Global Elite"
];

const FACEIT_LEVELS = {
  1:  { color: "#eeeeee", elo: "100 – 500" },
  2:  { color: "#1bb000", elo: "501 – 750" },
  3:  { color: "#32d91e", elo: "751 – 900" },
  4:  { color: "#ffd000", elo: "901 – 1,050" },
  5:  { color: "#ffc400", elo: "1,051 – 1,200" },
  6:  { color: "#ffb000", elo: "1,201 – 1,350" },
  7:  { color: "#ffa000", elo: "1,351 – 1,530" },
  8:  { color: "#ff6a00", elo: "1,531 – 1,750" },
  9:  { color: "#ff3d00", elo: "1,751 – 2,000" },
  10: { color: "#ff2424", elo: "2,001+" },
  11: { color: "#e80128", elo: "Top 1,000" }
};

const LEETIFY_TTL_MS = 30 * 60 * 1000;

let selfSteam64 = "";
let selfLeetify = null;

function skillgroupIndex(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 18) return null;
  return n;
}

function skillgroupName(rank) {
  const n = skillgroupIndex(rank);
  return n == null ? "" : CS_SKILL_GROUPS[n] || "";
}

function skillgroupImg(rank, extraClass = "") {
  const n = skillgroupIndex(rank);
  if (n == null) return "";
  const label = skillgroupName(n);
  return `<img class="skillgroup${extraClass ? ` ${extraClass}` : ""}" src="icons/ranks/skillgroup${n}.png" alt="${esc(label)}" title="${esc(label)}">`;
}

function faceitLevel(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 11) return null;
  return n;
}

function faceitBadge(level, extraClass = "") {
  const n = faceitLevel(level);
  const cls = extraClass ? ` ${extraClass}` : "";
  if (!n) return `<span class="faceit-badge is-empty${cls}">—</span>`;
  const spec = FACEIT_LEVELS[n];
  const label = n === 11 ? "FACEIT Challenger" : `FACEIT Level ${n}`;
  return `<img class="faceit-badge${cls}" src="icons/faceit/${n}.svg" alt="${esc(label)}" title="${esc(`${label} · ${spec.elo}`)}">`;
}

function premierColor(value) {
  if (value == null || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  if (n >= 30000) return "#ff4d4d";
  if (n >= 25000) return "#eb4b4b";
  if (n >= 20000) return "#d32ce6";
  if (n >= 15000) return "#8847ff";
  if (n >= 10000) return "#4b69ff";
  if (n >= 5000) return "#5e98d9";
  return "#b0c3d9";
}

function competitiveRankForMap(map) {
  const rows = Array.isArray(selfLeetify?.competitive) ? selfLeetify.competitive : [];
  const id = String(map?.id || "").toLowerCase();
  const name = String(map?.name || "").toLowerCase().replace(/\s+/g, "");
  for (const row of rows) {
    const key = String(row.mapName || row.map_name || "").toLowerCase();
    if (!key) continue;
    if (key === id) return row.rank;
    if (key.replace(/^de_|^cs_/, "") === name) return row.rank;
  }
  return null;
}

function paintRankKpis() {
  const root = $("#rankKpis");
  if (!root) return;
  const profile = selfLeetify;
  const loading = Boolean(selfSteam64) && (!profile || profile.status === "loading");
  const ready = Boolean(profile) && profile.status !== "error" && profile.status !== "missing" && profile.status !== "loading";
  const premier = ready ? profile.premier : null;
  const faceit = ready ? profile.faceit : null;
  const elo = ready ? profile.faceitElo : null;
  const wingman = ready ? profile.wingman : null;
  const premColor = premierColor(premier);
  const wingName = skillgroupName(wingman);
  const cards = [
    {
      label: "PREMIER",
      value: loading ? "…" : `<span class="is-premier"${premColor ? ` style="color:${premColor}"` : ""}>${fmtPremier(premier)}</span>`,
      foot: "CS rating",
      glow: premColor || "var(--blue)"
    },
    {
      label: "FACEIT",
      value: loading ? "…" : faceitBadge(faceit),
      foot: faceitLevel(faceit) === 11 ? "Challenger" : (FACEIT_LEVELS[faceitLevel(faceit)] ? `Level ${faceitLevel(faceit)}` : "Level"),
      glow: FACEIT_LEVELS[faceitLevel(faceit)]?.color || "var(--orange)"
    },
    {
      label: "FACEIT ELO",
      value: loading ? "…" : (elo == null ? "—" : Number(elo).toLocaleString("en-US")),
      foot: "FACEIT rating",
      glow: "var(--orange)"
    },
    {
      label: "WINGMAN",
      value: loading ? "…" : (skillgroupImg(wingman) || "—"),
      foot: wingName || "Skill group",
      glow: "var(--accent)"
    }
  ];
  root.innerHTML = cards.map(card => `
    <article class="kpi" style="--glow:${card.glow}">
      <div class="kpi-label"><span>${card.label}</span></div>
      <div class="kpi-value is-rank">${card.value}</div>
      <div class="kpi-foot">${esc(card.foot)}</div>
    </article>`).join("");
}

function loadSelfLeetify(steam64) {
  const sid = asSteam64(steam64);
  if (!sid) {
    selfSteam64 = "";
    selfLeetify = null;
    paintRankKpis();
    renderMaps();
    return;
  }
  selfSteam64 = sid;
  const cached = leetifyProfiles[sid];
  if (cached && cached.status !== "loading") {
    selfLeetify = cached;
    paintRankKpis();
    renderMaps();
    if (cached.status === "ok" && Array.isArray(cached.competitive)) return;
  } else {
    selfLeetify = cached || { steam64: sid, status: "loading" };
    paintRankKpis();
  }
  ensureLeetifyProfiles(data.lastMatch);
}

function leetifyCell(profile, key) {
  if (!profile) return `<span class="sb-muted">—</span>`;
  if (profile.status === "loading") return `<span class="sb-muted">…</span>`;
  if (profile.status === "missing") return `<span class="sb-muted">—</span>`;
  if (profile.status === "private") return `<span class="sb-muted">Priv</span>`;
  if (profile.status === "error") return `<span class="sb-muted">—</span>`;
  if (key === "bans") {
    const bans = Array.isArray(profile.bans) ? profile.bans : [];
    if (!bans.length) return `<span class="sb-ban is-clean">—</span>`;
    return `<span class="sb-ban" title="${esc(bans.join(", "))}">${esc(bans.join(", "))}</span>`;
  }
  if (key === "premier") return `<span class="sb-num">${fmtPremier(profile.premier)}</span>`;
  if (key === "faceit") {
    const n = faceitLevel(profile.faceit);
    return `<span class="sb-num">${n == null ? "—" : `Level ${n}`}</span>`;
  }
  if (key === "elo") return `<span class="sb-num">${profile.faceitElo == null ? "—" : Number(profile.faceitElo).toLocaleString("en-US")}</span>`;
  if (key === "aim") return `<span class="sb-num">${fmtLeetify(profile.aim, 1)}</span>`;
  if (key === "preaim") return `<span class="sb-num">${fmtLeetify(profile.preaim, 1, "°")}</span>`;
  if (key === "reaction") return `<span class="sb-num">${profile.reaction == null ? "—" : `${Math.round(Number(profile.reaction))}ms`}</span>`;
  if (key === "spray") return `<span class="sb-num">${fmtLeetify(profile.spray, 1, "%")}</span>`;
  return `<span class="sb-muted">—</span>`;
}

function paintScoreboard(match) {
  const root = $("#matchScoreboard");
  const meta = $("#scoreboardMeta");
  if (!root) return;
  const board = match?.scoreboard;
  const you = board?.you || [];
  const them = board?.them || [];
  if (!match || (!you.length && !them.length)) {
    root.classList.add("empty");
    root.innerHTML = `<p class="insight-note">${match?.live ? "Waiting for the live board from OmegaDash…" : "Final scoreboard stays here after the game until you join the next one."}</p>`;
    if (meta) meta.textContent = match?.live ? "Your team on top · live with the score" : "Final board";
    return;
  }
  root.classList.remove("empty");
  const ourTeam = board.team || match.team;
  const ours = teamSide(ourTeam);
  const theirs = teamSide(Number(ourTeam) === 3 ? 2 : 3);
  const ourScore = ours.key === "ct" ? (board.scoreCt ?? match.scoreCt) : (board.scoreT ?? match.scoreT);
  const theirScore = theirs.key === "ct" ? (board.scoreCt ?? match.scoreCt) : (board.scoreT ?? match.scoreT);
  if (meta) meta.textContent = match.live ? "Updating live" : "Final board";
  syncScoreboardViewUi();
  ensureLeetifyProfiles(match);

  const leetify = scoreboardView === "leetify";
  const cols = leetify
    ? `<div class="sb-cols">
        <span>Player</span><span>Bans</span><span>Premier</span><span>FACEIT</span><span>ELO</span>
        <span>Aim</span><span>Pre-aim</span><span>Reaction</span><span>Spray</span>
      </div>`
    : `<div class="sb-cols">
        <span>Player</span><span>$</span><span>Primary</span><span>Secondary</span><span>Armor</span>
        <span>Kit</span><span>HP</span><span>K</span><span>D</span><span>A</span>
        <span>K/D</span><span>HS%</span><span>DMG</span><span>ADR</span><span>UD</span><span>EF</span>
      </div>`;

  const emptyRow = `<div class="sb-row sb-empty"><span class="sb-muted">No players</span></div>`;

  const rowHtml = row => {
    const hp = Math.max(0, Math.min(Number(row.health) || 0, 100));
    const dead = row.alive === false || hp <= 0;
    const name = `<span class="sb-name">${esc(row.name)}${row.you ? "  · you" : ""}</span>`;
    if (leetify) {
      const sid = asSteam64(row.steam64) || (row.you ? asSteam64(selfSteam64) : "");
      const profile = sid ? (leetifyProfiles[sid] || { steam64: sid, status: "loading" }) : null;
      return `<div class="sb-row ${row.you ? "sb-you" : ""} ${dead ? "sb-dead" : ""}">
        ${name}
        ${leetifyCell(profile, "bans")}
        ${leetifyCell(profile, "premier")}
        ${leetifyCell(profile, "faceit")}
        ${leetifyCell(profile, "elo")}
        ${leetifyCell(profile, "aim")}
        ${leetifyCell(profile, "preaim")}
        ${leetifyCell(profile, "reaction")}
        ${leetifyCell(profile, "spray")}
      </div>`;
    }
    return `<div class="sb-row ${row.you ? "sb-you" : ""} ${dead ? "sb-dead" : ""}">
      ${name}
      <span class="sb-num">${fmtMoney(row.money)}</span>
      <span class="sb-wep-cell">${weaponCell(row.primaryId, row.primary)}</span>
      <span class="sb-wep-cell">${weaponCell(row.secondaryId, row.secondary)}</span>
      <span class="sb-gear-cell">${armorCell(row)}</span>
      <span class="sb-gear-cell">${kitCell(row.kit)}</span>
      <span class="sb-hp"><span class="sb-bar"><i style="--hp:${dead ? 0 : hp}%"></i></span><b>${dead ? 0 : hp}</b></span>
      <span class="sb-num">${row.kills ?? 0}</span>
      <span class="sb-num">${row.deaths ?? 0}</span>
      <span class="sb-num">${row.assists ?? 0}</span>
      <span class="sb-num">${fmtKd(row.kd)}</span>
      <span class="sb-num">${fmtHs(row.hs)}</span>
      <span class="sb-num">${row.dmg ?? 0}</span>
      <span class="sb-num">${row.adr ?? 0}</span>
      <span class="sb-num">${row.ud ?? 0}</span>
      <span class="sb-num">${row.flashed ?? 0}</span>
    </div>`;
  };

  const teamHead = (side, label, score) => `
    <div class="sb-team-head" data-side="${side.key}">
      <div><span class="sb-tag">${side.tag}</span><strong>${label}</strong></div>
      <em>${score ?? "—"}</em>
    </div>`;

  root.innerHTML = `<div class="sb-board${leetify ? " is-leetify" : ""}">
    ${teamHead(ours, "YOUR TEAM", ourScore)}
    ${cols}
    ${you.map(rowHtml).join("") || emptyRow}
    ${teamHead(theirs, "ENEMY TEAM", theirScore)}
    ${cols}
    ${them.map(rowHtml).join("") || emptyRow}
  </div>`;
}

function updateMatchHeroScore(match) {
  const hero = $("#lastMatchHero");
  if (!hero || !match) return;
  const score = hero.querySelector(".hero-result strong");
  const status = hero.querySelector(".hero-result span");
  if (score) score.textContent = match.score;
  if (status) status.textContent = match.live ? "IN PROGRESS" : match.won ? "VICTORY" : "DEFEAT";
}

function paintMatchLive() {
  const match = decorateMatch(data.lastMatch);
  updateMatchHeroScore(match);
  paintScoreboard(match);
  syncHeatmapRoundControl(match);
}

function renderLastMatch() {
  const m = decorateMatch(data.lastMatch);
  const hero = $("#lastMatchHero");
  if (!m) {
    hero.style.removeProperty("--map-image");
    hero.innerHTML = `<div class="hero-map"><span>LAST MATCH</span><div class="hero-title"><strong>No matches yet</strong></div><small>Play a game with OmegaDash loaded and the dashboard open.</small></div>`;
    $("#matchKpis").innerHTML = "";
    $("#sideSplit").innerHTML = "";
    $("#engagementRows").innerHTML = "";
    paintScoreboard(null);
    heatmapMatchId = null;
    heatmapRound = 0;
    heatmapMode = "all";
    $$("#locationMode button").forEach(btn => btn.classList.toggle("active", btn.dataset.mode === "all"));
    syncHeatmapRoundControl(null);
    drawLocationHeatmap();
    return;
  }
  const paintHero = (thumb, icon) => {
    hero.style.setProperty("--map-image", `url("${thumb}")`);
    hero.innerHTML = `
      <div class="hero-map">
        <span>${m.live ? "LIVE MATCH" : "LAST MATCH"}</span>
        <div class="hero-title">
          <div class="map-thumb" style="--map-image:url('${icon}')"></div>
          <strong>${m.map}</strong>
        </div>
        <small>${m.date} · ${m.duration}</small>
      </div>
      <div class="hero-result"><span>${m.live ? "IN PROGRESS" : m.won ? "VICTORY" : "DEFEAT"}</span><strong>${m.score}</strong></div>`;
  };
  if (heatmapMatchId !== m.id) {
    heatmapMatchId = m.id;
    heatmapRound = 0;
  }
  paintHero(m.thumbImage || m.mapImage, m.mapImage);
  paintScoreboard(m);
  syncHeatmapRoundControl(m);
  const mix = classMixLabel(m.preaimClass);
  const kpis = [
    { label: "K / D / A", value: `${m.kills} / ${m.deaths} / ${m.assists}`, foot: "Match output" },
    { label: "K/D RATIO", value: Number(m.kd || 0).toFixed(2), foot: "Kills / deaths" },
    { label: "HEADSHOTS", value: `${m.hs}%`, foot: "Of kills" },
    { label: "ADR", value: m.adr, foot: "Damage / round" },
    { label: "REACTION", value: `${m.reaction}<small>ms</small>`, sub: hesitationLine(m.hesitation) || "hesitation —", foot: "Visible time only" },
    { label: "PLACEMENT", value: mix || "—", valueClass: mix ? "is-mix" : "", foot: `${m.preaim ?? 0}° avg · ${m.headLevel ?? 0}% head-level` }
  ];
  $("#matchKpis").innerHTML = kpis.map(card => kpiCardHtml(card)).join("");
  const maxRounds = Math.max(m.side.ct.rounds, m.side.t.rounds, 13);
  $("#sideSplit").innerHTML = [["CT SIDE",m.side.ct,"#69a7ff"],["T SIDE",m.side.t,"#ffb164"]].map(([name,side,color]) => `
    <div class="side-card"><div class="side-card-head"><span>${name}</span><strong>${side.rounds} rounds</strong></div>
    <div class="mini-bar"><i style="width:${side.rounds / maxRounds * 100}%;background:${color}"></i></div>
    <div class="side-detail"><span>K/D ${side.kd}</span><span>${side.reaction}ms reaction</span></div></div>`).join("");
  $("#engagementRows").innerHTML = m.engagements.map(e => `
    <tr data-id="${e.id}" data-round="${engagementRound(e) ?? ""}"><td>${String(e.id).padStart(2,"0")}</td><td><span class="result-pill ${(e.result || "").toLowerCase()}${e.unattributed ? " unattributed" : ""}">${e.result || "—"}</span></td>
    <td>${engagementRound(e) ?? "—"}</td>
    <td>${e.weapon || "—"}</td>
    <td>${esc(fmtPreaimCell(e))}</td><td>${esc(flickCell(e))}</td><td>${fmtPathEff(e.pathEff)}</td><td><span class="landing-pill ${noFlickDetected(e) ? "none" : e.landing}">${esc(landingPillText(e))}</span></td>
    <td><strong>${e.reaction != null ? `${e.reaction}ms` : "—"}</strong></td>
    <td>${e.hesitation != null ? `${e.hesitation}ms` : "—"}</td><td>${e.ttk ? `${e.ttk}ms` : "—"}</td><td>${e.firstShot == null ? "—" : e.firstShot ? "HIT" : "MISS"}</td><td>${e.velocity != null ? `${e.velocity} u/s` : "—"}</td></tr>`).join("");
  highlightEngagementRow(selectedSpotId);
  syncEngagementRoundHighlight();
  const radar = $("#radarImage");
  radar.onload = () => drawLocationHeatmap();
  resolveRadarFromCatalog(m.map, { radar: m.radarImage, icon: m.mapImage, thumb: m.thumbImage || m.mapImage }).then(asset => {
    radarMeta = asset.info;
    if (asset.radar) radar.src = asset.radar;
    paintHero(asset.thumb, asset.icon);
  });
}

function closeUiSelects(except) {
  $$(".ui-select.open").forEach(wrap => {
    if (wrap === except) return;
    wrap.classList.remove("open");
    if (wrap._menu) {
      wrap._menu.hidden = true;
      wrap.appendChild(wrap._menu);
    }
  });
}

function placeUiSelectMenu(wrap) {
  const btn = wrap._btn;
  const menu = wrap._menu;
  if (!btn || !menu) return;
  const r = btn.getBoundingClientRect();
  const minW = r.width;
  menu.style.minWidth = `${minW}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - minW - 8))}px`;
  menu.hidden = false;
  const h = menu.offsetHeight;
  const below = r.bottom + 4;
  const top = below + h > window.innerHeight - 8 && r.top - 4 - h > 8 ? r.top - 4 - h : below;
  menu.style.top = `${top}px`;
}

function syncUiSelect(select) {
  if (!select) return;
  const wrap = select.closest(".ui-select");
  if (!wrap || !wrap._btn || !wrap._menu) return;
  const label = wrap._btn.querySelector("span");
  if (label) label.textContent = select.options[select.selectedIndex]?.text || "";
  wrap.classList.toggle("is-disabled", select.disabled);
  wrap.classList.toggle("is-tagged", select.classList.contains("match-mode") && Boolean(select.value));
  wrap._btn.disabled = select.disabled;
  wrap._menu.innerHTML = [...select.options].map(opt =>
    `<button type="button" class="${opt.value === select.value ? "is-active" : ""}" data-value="${esc(opt.value)}">${esc(opt.text)}</button>`
  ).join("");
  wrap._menu.querySelectorAll("button").forEach(item => {
    item.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const next = item.dataset.value;
      if (select.value !== next) {
        select.value = next;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      syncUiSelect(select);
      closeUiSelects();
    });
  });
}

function enhanceSelect(select) {
  if (!select) return;
  let wrap = select.closest(".ui-select");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "ui-select";
    if (select.classList.contains("match-mode")) wrap.classList.add("match-mode-wrap");
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ui-select-btn";
    btn.innerHTML = `<span></span><svg viewBox="0 0 24 24"><path d="m7 9 5 5 5-5"/></svg>`;
    const menu = document.createElement("div");
    menu.className = "ui-select-menu";
    menu.hidden = true;
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    wrap._btn = btn;
    wrap._menu = menu;
    btn.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (select.disabled) return;
      const open = !wrap.classList.contains("open");
      closeUiSelects(open ? wrap : null);
      wrap.classList.toggle("open", open);
      if (open) {
        syncUiSelect(select);
        document.body.appendChild(wrap._menu || menu);
        placeUiSelectMenu(wrap);
      } else {
        menu.hidden = true;
        wrap.appendChild(menu);
      }
    });
    menu.addEventListener("mousedown", event => event.stopPropagation());
    menu.addEventListener("click", event => event.stopPropagation());
  }
  wrap._btn = wrap._btn || wrap.querySelector(".ui-select-btn");
  wrap._menu = wrap._menu || wrap.querySelector(".ui-select-menu");
  syncUiSelect(select);
}

function bindUiSelects() {
  if (bindUiSelects.bound) return;
  bindUiSelects.bound = true;
  document.addEventListener("click", () => closeUiSelects());
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeUiSelects();
  });
  window.addEventListener("resize", () => closeUiSelects());
  document.addEventListener("scroll", () => closeUiSelects(), true);
}

function renderMatches() {
  closeUiSelects();
  const matches = (data.matches || []).map(decorateMatch);
  if (!matches.length) {
    $("#historySummary").innerHTML = [["Win rate","—"],["Avg K/D","—"],["Avg reaction","—"]].map(([l,v])=>`<div><span>${l}</span><strong>${v}</strong></div>`).join("");
    $("#matchList").innerHTML = `<p class="insight-note">No saved matches yet. Closed games from OmegaDash show up here.</p>`;
    return;
  }
  const wins = matches.filter(m=>m.won).length;
  $("#historySummary").innerHTML = [
    ["Win rate",`${Math.round(wins / matches.length * 100)}%`],
    ["Avg K/D",(matches.reduce((s,m)=>s+m.kd,0)/matches.length).toFixed(2)],
    ["Avg reaction",`${Math.round(matches.reduce((s,m)=>s+m.reaction,0)/matches.length)}ms`]
  ].map(([l,v])=>`<div><span>${l}</span><strong>${v}</strong></div>`).join("");
  $("#matchList").innerHTML = matches.map((m,i)=>`
    <article class="match-row" data-match="${m.id}">
      <div class="match-summary">
        <div class="map-thumb" style="--map-image:url('${m.mapImage || m.thumbImage || ""}')"></div>
        <div class="match-name"><strong>${m.map}</strong><span>${m.date} · ${m.duration}${m.live ? " · live" : ""}</span>${matchModeSelect(m)}</div>
        <div class="match-stat"><span>Result</span><strong><span class="match-result ${m.won?"win":"loss"}">${m.score}</span></strong></div>
        <div class="match-stat"><span>K / D</span><strong>${m.kills} / ${m.deaths}</strong></div>
        <div class="match-stat"><span>K/D</span><strong>${m.kd}</strong></div>
        <div class="match-stat"><span>Reaction</span><strong>${m.reaction}ms</strong></div>
        <svg class="chevron" viewBox="0 0 24 24"><path d="m7 9 5 5 5-5"/></svg>
        <button type="button" class="match-delete" data-delete="${esc(m.id)}" aria-label="Delete match">×</button>
      </div>
      <div class="match-details"><div class="detail-grid">
        ${[["Headshots",`${m.hs}%`],["ADR",m.adr],["First shot",`${m.firstShot}%`],["Counter-strafe",`${m.counterStrafe}%`],["Pre-aim",`${m.preaim}°`],["Placement", classMixLabel(m.preaimClass) || "—"],["Head-level",`${m.headLevel ?? 0}%`],["TTK",`${m.ttk}ms`],["Hesitation", fmtMs(m.hesitation)]].map(([l,v])=>`<div class="detail-box"><span>${l}</span><strong>${v}</strong></div>`).join("")}
        <div class="land-strip"><span>UNDER ${m.landing.under}%</span><i class="u" style="width:${m.landing.under*2}px"></i><span>ON ${m.landing.target}%</span><i class="t" style="width:${m.landing.target*2}px"></i><span>OVER ${m.landing.over}%</span><i class="o" style="width:${m.landing.over*2}px"></i></div>
      </div></div>
    </article>`).join("");
  const list = $("#matchList");
  list.querySelectorAll(".match-summary").forEach(row => row.addEventListener("click", event => {
    if (event.target.closest(".match-delete, .match-mode, .ui-select")) return;
    row.parentElement.classList.toggle("open");
  }));
  list.querySelectorAll(".match-delete").forEach(btn => {
    btn.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      deleteMatch(btn.dataset.delete);
    });
  });
  list.querySelectorAll(".match-mode").forEach(sel => {
    sel.addEventListener("click", event => event.stopPropagation());
    sel.addEventListener("mousedown", event => event.stopPropagation());
    sel.addEventListener("change", event => {
      event.stopPropagation();
      sel.classList.toggle("is-tagged", Boolean(sel.value));
      setMatchMode(sel.dataset.matchMode, sel.value);
      syncUiSelect(sel);
    });
    enhanceSelect(sel);
  });
  applyMatchListIcons(matches);
}

function applyMatchListIcons(matches) {
  $$("#matchList .match-row[data-match]").forEach(row => {
    const match = matches.find(item => String(item.id) === String(row.dataset.match));
    const thumb = row.querySelector(".map-thumb");
    if (!match || !thumb) return;
    resolveRadarFromCatalog(match.map, { icon: match.mapImage, thumb: match.thumbImage }).then(asset => {
      const icon = asset.icon || asset.thumb;
      if (icon) thumb.style.setProperty("--map-image", `url("${icon}")`);
    });
  });
}

function officialMapCatalog() {
  return window.OFFICIAL_MAPS || [];
}

const MAP_WINRATE_EXCLUDE = new Set(["practice", "casual", "deathmatch"]);

function matchCountsForMapWinRate(match) {
  return !MAP_WINRATE_EXCLUDE.has(String(match?.mode || "").trim());
}

function aggregateMaps(matches) {
  const official = officialMapCatalog();
  const buckets = new Map();
  for (const item of official) {
    buckets.set(item.name, {
      id: item.id, name: item.name, pool: item.pool,
      played: 0, wins: 0, losses: 0, draws: 0, kills: 0, deaths: 0,
      reactionSum: 0, reactionW: 0, preaimSum: 0, preaimW: 0
    });
  }
  for (const match of matches || []) {
    if (match.live) continue;
    const name = match.map || "Unknown";
    if (!buckets.has(name)) {
      buckets.set(name, {
        id: match.mapId || name, name, pool: "Other",
        played: 0, wins: 0, losses: 0, draws: 0, kills: 0, deaths: 0,
        reactionSum: 0, reactionW: 0, preaimSum: 0, preaimW: 0
      });
    }
    const bucket = buckets.get(name);
    bucket.played += 1;
    bucket.kills += Number(match.kills) || 0;
    bucket.deaths += Number(match.deaths) || 0;
    const weight = (match.engagements || []).length || 1;
    if (Number.isFinite(Number(match.reaction))) {
      bucket.reactionSum += Number(match.reaction) * weight;
      bucket.reactionW += weight;
    }
    if (Number.isFinite(Number(match.preaim))) {
      bucket.preaimSum += Number(match.preaim) * weight;
      bucket.preaimW += weight;
    }
    if (matchCountsForMapWinRate(match)) {
      if (match.draw) bucket.draws += 1;
      else if (match.won) bucket.wins += 1;
      else bucket.losses += 1;
    }
  }
  const order = official.map(item => item.name);
  const extra = [...buckets.keys()].filter(name => !order.includes(name)).sort();
  return [...order, ...extra].map(name => {
    const bucket = buckets.get(name);
    const decided = bucket.wins + bucket.losses;
    return {
      id: bucket.id,
      name: bucket.name,
      pool: bucket.pool,
      played: bucket.played,
      wins: bucket.wins,
      losses: bucket.losses,
      draws: bucket.draws,
      winRate: decided ? Math.round(bucket.wins / decided * 1000) / 10 : null,
      reaction: bucket.reactionW ? Math.round(bucket.reactionSum / bucket.reactionW) : null,
      preaim: bucket.preaimW ? Math.round(bucket.preaimSum / bucket.preaimW * 10) / 10 : null,
      kd: bucket.played ? Math.round((bucket.deaths ? bucket.kills / bucket.deaths : bucket.kills) * 100) / 100 : null,
      kills: bucket.kills,
      deaths: bucket.deaths
    };
  });
}

function fmtMapVal(value, suffix = "") {
  return value == null || value === "" ? "—" : `${value}${suffix}`;
}

let leakStore = { maps: null, weapons: null };
const leakVisible = { map: false, weapon: false };
const leakBusy = { map: false, weapon: false };

function leakReasonLabel(reason) {
  return ({
    winrate: "Win rate",
    preaim: "Pre-aim",
    reaction: "Reaction",
    kd: "K/D",
    mixed: "Mixed",
    none: "On track"
  })[reason] || "Aim";
}

function leakSlice(kind) {
  return kind === "weapon" ? leakStore.weapons : leakStore.maps;
}

function leakTabId(kind) {
  return kind === "weapon" ? "weapons" : "maps";
}

function leakOnTab(kind) {
  return document.querySelector(".tab-panel.active")?.id === leakTabId(kind);
}

function leakIsFocus(kind, name, id) {
  if (!leakVisible[kind]) return false;
  const a = leakSlice(kind)?.analysis;
  if (!a || a.verdict !== kind) return false;
  if (kind === "map") return String(a.focusName || "") === String(name);
  return String(a.focusId || "") === String(id) || String(a.focusName || "") === String(name);
}

function syncLeakButtons(kind) {
  const analyzeBtn = $(kind === "weapon" ? "#weaponAnalyze" : "#mapAnalyze");
  const toggleBtn = $(kind === "weapon" ? "#weaponLeakToggle" : "#mapLeakToggle");
  const has = Boolean(leakSlice(kind)?.analysis);
  const busy = Boolean(leakBusy[kind]);
  const visible = Boolean(leakVisible[kind]);
  if (analyzeBtn) {
    analyzeBtn.disabled = busy;
    analyzeBtn.textContent = busy ? "Analyzing…" : (has ? "Reanalyze" : "Analyze");
  }
  if (toggleBtn) {
    toggleBtn.hidden = !has && !visible;
    toggleBtn.disabled = busy;
    toggleBtn.textContent = visible ? "Hide analysis" : "Show previous analysis";
  }
}

function paintLeakPanel(root, kind, { loading = false, error = "" } = {}) {
  if (!root) return;
  const label = kind === "weapon" ? "weapons" : "maps";
  if (loading) {
    root.hidden = false;
    root.className = "leak-panel is-loading";
    root.innerHTML = `
      <div class="leak-head">
        <div>
          <p class="eyebrow">WEAK POINT</p>
          <h3>Reading ${label}…</h3>
          <p>${kind === "weapon" ? "Gemini is comparing fight share, K/D, pre-aim, and reaction on the guns you actually use." : "Gemini is comparing win rate, pre-aim, and reaction, weighted by how many games you have on each map."}</p>
        </div>
      </div>`;
    return;
  }
  if (error) {
    root.hidden = false;
    root.className = "leak-panel is-leak";
    root.innerHTML = `
      <div class="leak-head">
        <div>
          <p class="eyebrow">WEAK POINT</p>
          <h3>Could not analyze</h3>
          <p>${esc(error)}</p>
        </div>
      </div>`;
    return;
  }
  const result = leakSlice(kind);
  const a = result?.analysis;
  if (!leakVisible[kind] || !a) {
    root.hidden = true;
    root.innerHTML = "";
    return;
  }
  const ok = a.verdict === "ok";
  const focus = a.focusName ? a.focusName : "No single leak";
  root.hidden = false;
  root.className = `leak-panel ${ok ? "is-ok" : "is-leak"}`;
  root.innerHTML = `
    <div class="leak-head">
      <div>
        <p class="eyebrow">WEAK POINT</p>
        <h3>${esc(a.headline || "Aim read")}</h3>
        <p>${esc(a.summary || "")}</p>
      </div>
      <div class="leak-badges">
        <span class="leak-badge ${ok ? "ok" : "leak"}">${esc(focus)}</span>
        <span class="leak-badge">${esc(leakReasonLabel(a.reason))}</span>
        <span class="leak-badge">${Number(a.confidence) || 0}% confidence</span>
      </div>
    </div>
    <div class="leak-cols">
      <div>
        <h4>Findings</h4>
        <ul>${(a.findings || []).map(item => `<li>${esc(item)}</li>`).join("") || "<li>No extra notes.</li>"}</ul>
      </div>
      <div>
        <h4>What to do</h4>
        <ul>${(a.actions || []).map(item => `<li>${esc(item)}</li>`).join("") || "<li>Keep playing and send more games.</li>"}</ul>
      </div>
    </div>
    <p class="leak-meta">${result.analyzedAt ? new Date(result.analyzedAt).toLocaleString() : ""} · Uses your Gemini key. Only anonymized ${label} stats are sent.</p>`;
}

function paintLeakPanels(opts = {}) {
  const kind = opts.kind;
  if (!kind || kind === "map") {
    paintLeakPanel($("#mapLeakPanel"), "map", kind === "map" ? opts : {});
    syncLeakButtons("map");
  }
  if (!kind || kind === "weapon") {
    paintLeakPanel($("#weaponLeakPanel"), "weapon", kind === "weapon" ? opts : {});
    syncLeakButtons("weapon");
  }
}

function concealLeak(kind) {
  if (!leakVisible[kind]) {
    syncLeakButtons(kind);
    return;
  }
  leakVisible[kind] = false;
  paintLeakPanels({ kind });
  if (kind === "weapon") renderWeapons();
  else renderMaps();
}

function toggleLeakPanel(kind) {
  if (leakBusy[kind]) return;
  leakVisible[kind] = !leakVisible[kind];
  paintLeakPanels({ kind });
  if (kind === "weapon") renderWeapons();
  else renderMaps();
}

function applyMapCardIcons(maps) {
  $$("#mapGrid .map-card[data-map]").forEach(card => {
    const row = maps.find(item => item.name === card.dataset.map);
    const thumb = card.querySelector(".map-thumb");
    if (!row || !thumb) return;
    const fallback = (window.MAPS || {})[row.name] || "";
    if (fallback) thumb.style.setProperty("--map-image", `url("${fallback}")`);
    resolveRadarFromCatalog(row.name, { icon: fallback }).then(asset => {
      if (asset.icon) thumb.style.setProperty("--map-image", `url("${asset.icon}")`);
    });
  });
}

function renderMaps() {
  const summary = $("#mapSummary");
  const grid = $("#mapGrid");
  if (!summary || !grid) return;
  const maps = (data.maps && data.maps.length) ? data.maps : aggregateMaps(data.matches);
  const played = maps.filter(m => m.played);
  if (!played.length) {
    summary.innerHTML = [["Maps played","0"],["Best win rate","—"],["Best K/D","—"]].map(([l,v])=>`<div><span>${l}</span><strong>${v}</strong></div>`).join("");
  } else {
    const bestWin = [...played].sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1) || b.played - a.played)[0];
    const bestKd = [...played].sort((a, b) => (b.kd ?? -1) - (a.kd ?? -1))[0];
    summary.innerHTML = [
      ["Maps played", String(played.length)],
      ["Best win rate", `${bestWin.name} ${bestWin.winRate ?? 0}%`],
      ["Best K/D", `${bestKd.name} ${Number(bestKd.kd || 0).toFixed(2)}`]
    ].map(([l,v])=>`<div><span>${l}</span><strong>${v}</strong></div>`).join("");
  }
  grid.innerHTML = maps.map(m => {
    const empty = !m.played;
    const cold = !empty && (m.winRate ?? 0) < 50;
    const record = empty ? "Unplayed" : `${m.played} match${m.played === 1 ? "" : "es"} · ${m.wins}W ${m.losses}L`;
    const fallback = (window.MAPS || {})[m.name] || "";
    const rank = competitiveRankForMap(m);
    const rankImg = skillgroupImg(rank);
    const rankHtml = rankImg
      ? `<div class="map-rank">${rankImg}</div>`
      : `<div class="map-rank is-empty">Unranked</div>`;
    const leak = leakIsFocus("map", m.name, m.id);
    return `
    <article class="map-card${empty ? " is-empty" : ""}${cold ? " is-cold" : ""}${leak ? " is-leak" : ""}" data-map="${esc(m.name)}">
      <div class="map-card-head">
        <div class="map-thumb" style="--map-image:url('${fallback}')"></div>
        <div class="map-card-copy">
          <strong>${esc(m.name)}</strong>
          <span>${esc(m.pool || "Official")} · ${record}</span>
          ${leak ? `<span class="leak-pill">Weak point</span>` : ""}
        </div>
        ${rankHtml}
      </div>
      <div class="map-win" style="--win:${empty ? 0 : (m.winRate ?? 0)}%"><i></i></div>
      <div class="map-card-stats">
        <div><span>Win rate</span><strong>${fmtMapVal(m.winRate, "%")}</strong></div>
        <div><span>Avg reaction</span><strong>${fmtMapVal(m.reaction, "ms")}</strong></div>
        <div><span>Avg pre-aim</span><strong>${fmtMapVal(m.preaim, "°")}</strong></div>
        <div><span>Overall K/D</span><strong>${m.kd == null ? "—" : Number(m.kd).toFixed(2)}</strong></div>
      </div>
    </article>`;
  }).join("");
  applyMapCardIcons(maps);
}

function renderWeapons() {
  const weapons = data.weapons || [];
  const summary = $("#weaponSummary");
  const list = $("#weaponList");
  if (!summary || !list) return;
  if (!weapons.length) {
    summary.innerHTML = [["Weapons","—"],["Most used","—"],["Fights","—"]].map(([l,v])=>`<div><span>${l}</span><strong>${v}</strong></div>`).join("");
    list.innerHTML = `<p class="insight-note">No weapon fights yet. Each kill or death logs the gun you were holding.</p>`;
    return;
  }
  const top = weapons[0];
  const fights = weapons.reduce((sum, w) => sum + (w.fights || 0), 0);
  summary.innerHTML = [
    ["Weapons", String(weapons.length)],
    ["Most used", top.name],
    ["Fights", String(fights)]
  ].map(([l,v])=>`<div><span>${l}</span><strong>${v}</strong></div>`).join("");
  list.innerHTML = weapons.map(w => {
    const leak = leakIsFocus("weapon", w.name, w.id);
    return `
    <article class="match-row weapon-row${leak ? " is-leak open" : ""}" data-weapon="${w.id}">
      <div class="match-summary weapon-summary">
        ${weaponMark(w.weaponId ?? w.id, w.name, w.class)}
        <div class="match-name"><strong>${w.name}</strong><span>${w.class || "other"} · ${w.share}% of fights${leak ? " · weak point" : ""}</span></div>
        <div class="match-stat"><span>Fights</span><strong>${w.fights}</strong></div>
        <div class="match-stat"><span>K / D</span><strong>${w.kills} / ${w.deaths}</strong></div>
        <div class="match-stat"><span>K/D</span><strong>${w.kd}</strong></div>
        <div class="match-stat"><span>Head-level</span><strong>${w.headLevel}%</strong></div>
        <svg class="chevron" viewBox="0 0 24 24"><path d="m7 9 5 5 5-5"/></svg>
      </div>
      <div class="match-details"><div class="detail-grid">
        ${[["Reaction",`${w.reaction}ms`],["First shot",`${w.firstShot}%`],["Counter-strafe",`${w.counterStrafe}%`],["Pre-aim",`${w.preaim}°`],["Head-level",`${w.headLevel}%`],["TTK",`${w.ttk}ms`],["Pre-aimed",`${w.preAimed}%`]].map(([l,v])=>`<div class="detail-box"><span>${l}</span><strong>${v}</strong></div>`).join("")}
        <div class="land-strip"><span>UNDER ${w.landing.under}%</span><i class="u" style="width:${w.landing.under*2}px"></i><span>ON ${w.landing.target}%</span><i class="t" style="width:${w.landing.target*2}px"></i><span>OVER ${w.landing.over}%</span><i class="o" style="width:${w.landing.over*2}px"></i></div>
      </div></div>
    </article>`;
  }).join("");
  list.querySelectorAll(".match-summary").forEach(row => row.addEventListener("click",()=>row.parentElement.classList.toggle("open")));
}

function initOverallCharts() {
  makeReactionChart("reactionChart", data.reactionHistory || []);
  makeScatter();
  makeRadar();
}

function resetCharts() {
  Object.keys(charts).forEach(id => {
    if (id === "invValueChart") return;
    try { charts[id].destroy(); } catch {}
    delete charts[id];
  });
}

function paintLiveMeta() {
  const live = data.live || {};
  if ($("#lastPacket")) $("#lastPacket").textContent = live.lastPacket || "never";
  const sync = document.querySelector(".sync-card b");
  if (sync) sync.textContent = live.connected ? "Connected" : (data.source === "live" ? "Waiting" : "Idle");
  const card = $("#syncCard");
  if (card) {
    const connected = Boolean(live.connected);
    card.classList.toggle("is-live", connected);
    card.title = connected ? "Open packet log · Connected" : "Open packet log";
  }
  const liveDot = $(".live-dot");
  if (liveDot) liveDot.hidden = !data.lastMatch?.live;
  const pathEl = $("#packetLogPath");
  if (pathEl && live.ingestUrl) pathEl.textContent = live.ingestUrl;
  paintSensSampleNote();
  paintAppVersion();
}

function versionParts(value) {
  return String(value || "").split(/[^\d]+/).filter(Boolean).map(n => parseInt(n, 10) || 0);
}

function versionOlder(current, latest) {
  const a = versionParts(current);
  const b = versionParts(latest);
  if (!b.length) return false;
  const n = Math.max(a.length, b.length, 3);
  for (let i = 0; i < n; i++) {
    const left = a[i] || 0;
    const right = b[i] || 0;
    if (left < right) return true;
    if (left > right) return false;
  }
  return false;
}

function paintAppVersion() {
  const currentEl = $("#appCurrentVer");
  const latestEl = $("#appLatestVer");
  const note = $("#appVersionNote");
  const row = $("#appVersionRow");
  if (currentEl) currentEl.textContent = WEBAPP_VERSION;
  const latest = String(data.live?.latestWebAppVer || "").trim();
  if (latestEl) latestEl.textContent = latest || "—";
  const stale = Boolean(latest) && versionOlder(WEBAPP_VERSION, latest);
  row?.classList.toggle("is-stale", stale);
  const updateDot = $(".update-dot");
  if (updateDot) updateDot.hidden = !stale;
  const btn = $("#appVersionBtn");
  if (btn) {
    btn.textContent = stale ? "Update" : "No update";
    btn.disabled = !stale;
    btn.className = stale ? "settings-save version-update-btn" : "reset-btn version-update-btn";
  }
  maybePromptVersionUpdate(latest, stale);
  if (!note) return;
  if (stale) {
    note.hidden = false;
    note.textContent = "This dashboard is older than the latest version";
  } else {
    note.hidden = true;
    note.textContent = "";
  }
}

let versionPopupOffered = false;

function closeVersionPopup() {
  const overlay = $("#versionPopup");
  if (!overlay) return;
  overlay.classList.remove("open");
  overlay.hidden = true;
}

function openVersionPopup(latest) {
  const overlay = $("#versionPopup");
  if (!overlay) return;
  const copy = $("#versionPopupCopy");
  if (copy) {
    copy.textContent = `You're on ${WEBAPP_VERSION}. Latest version is ${latest}.`;
  }
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add("open"));
}

function maybePromptVersionUpdate(latest, stale) {
  if (versionPopupOffered || !stale || !latest) return;
  versionPopupOffered = true;
  openVersionPopup(latest);
}

function bindVersionPopup() {
  $("#versionPopupClose")?.addEventListener("click", closeVersionPopup);
  $("#appVersionBtn")?.addEventListener("click", () => {
    const latest = String(data.live?.latestWebAppVer || "").trim();
    if (!latest || !versionOlder(WEBAPP_VERSION, latest)) return;
    openVersionPopup(latest);
  });
  $("#versionPopupGithub")?.addEventListener("click", () => {
    openInvLink(GITHUB_REPO_URL);
    closeVersionPopup();
  });
  $("#versionPopup")?.addEventListener("click", event => {
    if (event.target.id !== "versionPopup") return;
    closeVersionPopup();
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if (!$("#versionPopup")?.classList.contains("open")) return;
    event.preventDefault();
    closeVersionPopup();
  });
}

const CS2_YAW = 0.022;
let sensResult = null;

function fmtSens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.05) return "—";
  return n.toFixed(2);
}

function isSensSuggestion(value, current) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.05) return false;
  const cur = Number(current);
  if (Number.isFinite(cur) && Math.abs(n - cur) < 0.005) return false;
  return true;
}

function sensCm360(sens, dpi) {
  const denom = Number(sens) * Number(dpi) * CS2_YAW;
  if (!Number.isFinite(denom) || denom <= 0) return 0;
  return 360 / denom * 2.54;
}

function readSensSetup() {
  const sens = Math.min(20, Math.max(0.001, Number($("#sensValue")?.value) || settings.sens || 1));
  const dpi = Math.min(20000, Math.max(100, Math.round(Number($("#sensDpi")?.value) || settings.dpi || 800)));
  const games = Math.min(20, Math.max(1, Math.round(Number($("#sensGames")?.value) || settings.sampleGames || 8)));
  return { sens, dpi, games, modes: modesForApi(readSampleModes()) };
}

function persistSensSetup() {
  const setup = readSensSetup();
  settings.sens = setup.sens;
  settings.dpi = setup.dpi;
  settings.sampleGames = setup.games;
  if (setup.modes.length) settings.sampleModes = normalizeSampleModes(setup.modes);
  saveSettings();
  paintSensMetrics();
  paintSensSampleNote();
  return setup;
}

function hydrateSensForm() {
  const sens = $("#sensValue");
  const dpi = $("#sensDpi");
  const games = $("#sensGames");
  if (sens) sens.value = String(settings.sens ?? 1);
  if (dpi) dpi.value = String(settings.dpi ?? 800);
  if (games) games.value = String(settings.sampleGames ?? 8);
  paintSensModePicks();
  paintSensMetrics();
  paintSensSampleNote();
}

function paintSensMetrics() {
  const { sens, dpi } = readSensSetup();
  const edpi = $("#sensEdpi");
  const cm = $("#sensCm360");
  if (edpi) edpi.textContent = Number.isFinite(sens * dpi) ? String(Math.round(sens * dpi)) : "—";
  if (cm) cm.textContent = `${sensCm360(sens, dpi).toFixed(1)}`;
}

function paintSensSampleNote() {
  const note = $("#sensSampleNote");
  if (!note) return;
  const modes = new Set(normalizeSampleModes(settings.sampleModes));
  const all = data.matches || [];
  const pool = all.filter(match => modes.has(matchModeId(match)));
  const available = pool.length;
  const games = Math.min(20, Math.max(1, Math.round(Number($("#sensGames")?.value) || settings.sampleGames || 8)));
  const using = Math.min(games, available);
  const skipped = all.length - available;
  if (!all.length) {
    note.textContent = "More games give a more reliable read. Play with OmegaDash loaded so Gemini has fights to judge.";
    return;
  }
  if (!available) {
    note.textContent = "None of your saved matches match those types. Tag games in Last 20, or include more types.";
    return;
  }
  note.textContent = skipped
    ? `Sending ${using} of ${available} matching match${available === 1 ? "" : "es"} (${skipped} other type${skipped === 1 ? "" : "s"} skipped). Prem/Comp is the most trustworthy; DM and practice are noisier.`
    : `Sending ${using} of ${available} saved match${available === 1 ? "" : "es"}. Prem/Comp is the most trustworthy; DM and practice are noisier.`;
}

function readSampleModes() {
  const boxes = $$("#sensModePicks input[type=checkbox]");
  if (!boxes.length) return normalizeSampleModes(settings.sampleModes);
  return boxes.filter(box => box.checked).map(box => box.value);
}

function paintSensModePicks() {
  const root = $("#sensModePicks");
  if (!root) return;
  const selected = new Set(normalizeSampleModes(settings.sampleModes));
  root.innerHTML = MATCH_MODE_OPTIONS.map(item => `
    <label>
      <input type="checkbox" value="${item.id}"${selected.has(item.id) ? " checked" : ""}>
      <i>${item.label}</i>
    </label>`).join("");
  root.querySelectorAll("input").forEach(box => {
    box.addEventListener("change", event => {
      const modes = readSampleModes();
      if (!modes.length) {
        event.target.checked = true;
        showToast("Pick at least one match type");
        return;
      }
      settings.sampleModes = modes;
      saveSettings();
      paintSensSampleNote();
    });
  });
}

function formatSampleModes(byMode) {
  if (!byMode || typeof byMode !== "object") return "";
  const labels = { prem_comp: "Prem/Comp", practice: "Practice", casual: "Casual", deathmatch: "DM", untagged: "untagged" };
  return Object.entries(byMode)
    .filter(([, bucket]) => Number(bucket?.matches) > 0)
    .map(([key, bucket]) => `${bucket.matches} ${labels[key] || key}`)
    .join(", ");
}

function issueLabel(issue) {
  return ({
    sensitivity: "Sensitivity",
    preaim: "Pre-aim",
    counterstrafe: "Counter-strafe",
    reaction: "Reaction",
    mixed: "Mixed",
    insufficient: "Thin sample"
  })[issue] || "Aim";
}

function paintSensResult(result) {
  const root = $("#sensOutput");
  if (!root) return;
  sensResult = result || null;
  if (!result?.analysis) {
    closePracticeGuide();
    root.innerHTML = `
      <div class="sens-empty">
        <div class="orb"><span></span><i></i></div>
        <p class="eyebrow">PERSONAL CALIBRATION</p>
        <h2>Let the fights decide.</h2>
        <p>Send your fights. You’ll get a new sens only if the flicks give a real too-high or too-low reason — not every time you ask.</p>
      </div>`;
    return;
  }
  const a = result.analysis;
  const setup = result.setup || {};
  const sample = result.sample || {};
  const signals = result.signals || {};
  const math = result.math || a.math || {};
  const suggested = a.suggestedSens ?? a.optionalSens;
  const hasSuggest = a.verdict !== "keep" && isSensSuggestion(suggested, setup.sens);
  const currentLine = `${fmtSens(setup.sens)} @ ${setup.dpi} DPI`;
  const nextLine = hasSuggest ? `${fmtSens(suggested)} @ ${setup.dpi} DPI` : currentLine;
  const kicker = hasSuggest ? "SUGGESTED SENS" : "KEEP THIS";
  const nextLabel = hasSuggest ? "Try" : "Stick with";
  const badgeText = hasSuggest ? "change" : "keep";
  const badgeClass = hasSuggest ? "change" : "keep";
  const whyText = hasSuggest ? (a.optionalWhy || math.reason || "") : "";
  const mathSteps = hasSuggest && Array.isArray(math.steps) ? math.steps : [];
  const mathBlock = hasSuggest && (math.equation || whyText) ? `
    <div class="sens-math">
      <p class="card-kicker">WHY THIS NUMBER</p>
      ${math.equation ? `<p class="sens-eq">${esc(math.equation)}</p>` : ""}
      ${whyText ? `<p>${esc(whyText)}</p>` : ""}
      ${mathSteps.length ? `<ol>${mathSteps.map(step => `<li>${esc(step)}</li>`).join("")}</ol>` : ""}
    </div>` : "";
  root.innerHTML = `
    <div class="sens-result-head">
      <div>
        <p class="card-kicker">${kicker}</p>
        <h2>${esc(a.headline || "Aim read")}</h2>
        <p>${esc(a.summary || "")}</p>
      </div>
      <div class="sens-badges">
        <span class="sens-badge ${badgeClass}">${esc(badgeText)}</span>
        <span class="sens-badge unsure">${esc(issueLabel(a.primaryIssue))}</span>
        <span class="sens-badge unsure">${Number(a.confidence) || 0}% confidence</span>
      </div>
    </div>
    <div class="sens-formula">
      <span>Current</span><strong>${esc(currentLine)}</strong>
      <i>→</i>
      <span>${nextLabel}</span><strong class="accent">${esc(nextLine)}</strong>
      ${hasSuggest && setup.cm360 ? `<span>${esc(String(setup.cm360))} → ${esc(String(a.suggestedCm360 ?? a.optionalCm360 ?? "—"))} cm/360</span>` : ""}
    </div>
    ${mathBlock}
    ${hasSuggest && signals.read ? `<p class="sens-signal"><strong>Telemetry:</strong> ${esc(signals.read)}</p>` : ""}
    <div class="sens-cols">
      <div>
        <h3>Findings</h3>
        <ul>${(a.findings || []).map(item => `<li>${esc(item)}</li>`).join("") || "<li>No extra notes.</li>"}</ul>
      </div>
      <div>
        <h3>What to do</h3>
        <ul>${(a.actions || []).map(item => `<li>${esc(item)}</li>`).join("") || "<li>Keep playing and send more games.</li>"}</ul>
      </div>
    </div>
    <p class="sens-meta">${sample.matches || 0} matches · ${sample.fights || 0} fights${formatSampleModes(sample.byMode) ? ` · ${formatSampleModes(sample.byMode)}` : ""}${result.analyzedAt ? ` · ${new Date(result.analyzedAt).toLocaleString()}` : ""}</p>
    ${paintSensGuideCta(result)}`;
  $("#sensGuide")?.addEventListener("click", onSensGuideClick);
}

function practiceGuide(result) {
  const guide = result?.guide;
  if (Array.isArray(guide?.items) && guide.items.length) return guide;
  return null;
}

function paintSensGuideCta(result) {
  const ready = Boolean(practiceGuide(result));
  return `
    <div class="sens-guide-cta">
      <button type="button" class="settings-save" id="sensGuide">${ready ? "Show practice guide" : "Generate practice recommendations"}</button>
    </div>`;
}

function closePracticeGuide() {
  const overlay = $("#practiceGuide");
  if (!overlay) return;
  overlay.classList.remove("open");
  overlay.hidden = true;
}

function openPracticeGuide() {
  const overlay = $("#practiceGuide");
  if (!overlay) return;
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add("open"));
}

function paintPracticeGuide(guide, { loading = false, error = "" } = {}) {
  const body = $("#guideBody");
  const title = $("#guideTitle");
  if (title) title.textContent = loading ? "Practice guide" : (guide?.title || "Practice guide");
  if (!body) return;
  if (loading) {
    body.innerHTML = `
      <div class="guide-loading">
        <div class="orb"><span></span><i></i></div>
        <p class="eyebrow">PRACTICE GUIDE</p>
        <h3>Building recommendations…</h3>
        <p>Picking Refrag modes and workshop maps from this aim read.</p>
      </div>`;
    return;
  }
  if (error) {
    body.innerHTML = `
      <div class="guide-loading">
        <p class="eyebrow">PRACTICE GUIDE</p>
        <h3>Could not build a guide</h3>
        <p>${esc(error)}</p>
      </div>`;
    return;
  }
  const items = Array.isArray(guide?.items) ? guide.items : [];
  const guideItemHtml = item => `
    <li>
      <div class="guide-item-head">
        <div>
          <h4>${esc(item.name || "Mode")}</h4>
          ${item.mode && item.mode !== item.name ? `<span>${esc(item.mode)}</span>` : ""}
        </div>
      </div>
      ${item.blurb ? `<p class="guide-blurb">${esc(item.blurb)}</p>` : ""}
      ${item.why ? `<p class="guide-why">${esc(item.why)}</p>` : ""}
      ${item.setup ? `<p class="guide-setup"><strong>Setup</strong> ${esc(item.setup)}</p>` : ""}
      ${item.how ? `<p class="guide-how"><strong>Focus</strong> ${esc(item.how)}</p>` : ""}
    </li>`;
  const refragSubs = [
    { category: "aim", label: "Aim practice" },
    { category: "peek", label: "Peek practice" },
    { category: "hold", label: "Hold practice" },
    { category: "awp", label: "AWP practice" }
  ].map(sub => {
    const rows = items.filter(item => item.platform === "refrag" && item.category === sub.category);
    if (!rows.length) return "";
    return `
      <div class="guide-sub">
        <h4>${esc(sub.label)}</h4>
        <ul>${rows.map(guideItemHtml).join("")}</ul>
      </div>`;
  }).join("");
  const workshopRows = items.filter(item => item.platform === "workshop");
  const sections = [
    refragSubs ? `
      <section class="guide-group">
        <h3>Refrag</h3>
        <div class="guide-group-body">
          ${refragSubs}
        </div>
      </section>` : "",
    workshopRows.length ? `
      <section class="guide-group">
        <h3>Workshop</h3>
        <div class="guide-group-body">
          <ul>${workshopRows.map(guideItemHtml).join("")}</ul>
        </div>
      </section>` : ""
  ].join("");
  body.innerHTML = `
    <div class="guide-intro">
      <p class="eyebrow">RECOMMENDED MODES</p>
      <h3>${esc(guide?.title || "Practice guide")}</h3>
      ${guide?.intro ? `<p>${esc(guide.intro)}</p>` : ""}
    </div>
    ${sections || "<p class=\"guide-empty\">No modes in this guide.</p>"}`;
}

async function onSensGuideClick() {
  const existing = practiceGuide(sensResult);
  if (existing) {
    paintPracticeGuide(existing);
    openPracticeGuide();
    return;
  }
  await generatePracticeGuide();
}

async function generatePracticeGuide() {
  const btn = $("#sensGuide");
  const api = window.pywebview?.api;
  if (!api?.analyze_sens_guide && !api?.analyze_sens_routine) {
    showToast("Open OmegaDash to build a practice guide");
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Generating…";
  }
  paintPracticeGuide(null, { loading: true });
  openPracticeGuide();
  try {
    const result = api.analyze_sens_guide
      ? await api.analyze_sens_guide()
      : await api.analyze_sens_routine();
    if (!result?.ok) {
      paintPracticeGuide(null, { error: result?.error || "Could not build a practice guide" });
      showToast(result?.error || "Could not build a practice guide");
      return;
    }
    paintSensResult(result.data);
    paintPracticeGuide(practiceGuide(result.data));
    showToast("Practice guide ready");
  } catch {
    paintPracticeGuide(null, { error: "Gemini took too long or could not be reached" });
    showToast("Gemini took too long or could not be reached");
  } finally {
    const next = $("#sensGuide");
    if (next) {
      next.disabled = false;
      next.textContent = practiceGuide(sensResult) ? "Show practice guide" : "Generate practice recommendations";
    }
  }
}

function bindPracticeGuide() {
  $("#guideBack")?.addEventListener("click", closePracticeGuide);
  $("#guideClose")?.addEventListener("click", closePracticeGuide);
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if ($("#confirmModal")?.classList.contains("open")) return;
    if ($("#scriptEditor")?.classList.contains("open")) {
      event.preventDefault();
      requestCloseScriptEditor();
      return;
    }
    if (!$("#practiceGuide")?.classList.contains("open")) return;
    event.preventDefault();
    closePracticeGuide();
  });
}

async function loadSensAnalysis() {
  if (!window.pywebview?.api?.get_sens_analysis) {
    paintSensResult(null);
    return;
  }
  try {
    const result = await window.pywebview.api.get_sens_analysis();
    paintSensResult(result?.ok ? result.data : null);
  } catch {
    paintSensResult(null);
  }
}

async function runSensAnalysis() {
  const btn = $("#sensAnalyze");
  const setup = persistSensSetup();
  if (!setup.modes?.length) {
    showToast("Pick at least one match type");
    return;
  }
  if (!window.pywebview?.api?.analyze_sensitivity) {
    showToast("Open OmegaDash to run Sensitivity Finder");
    return;
  }
  closePracticeGuide();
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Analyzing…";
  }
  try {
    const result = await window.pywebview.api.analyze_sensitivity(JSON.stringify(setup));
    if (!result?.ok) {
      showToast(result?.error || "Could not analyze sensitivity");
      return;
    }
    paintSensResult(result.data);
    const suggested = result.data?.analysis?.suggestedSens;
    const current = result.data?.setup?.sens;
    showToast(
      isSensSuggestion(suggested, current)
        ? `Try ${Number(suggested).toFixed(2)}`
        : "Keep this sens"
    );
  } catch {
    showToast("Gemini took too long or could not be reached");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Analyze aim";
    }
  }
}

function bindSensFinder() {
  ["sensValue", "sensDpi", "sensGames"].forEach(id => {
    $(`#${id}`)?.addEventListener("change", persistSensSetup);
    $(`#${id}`)?.addEventListener("input", () => {
      paintSensMetrics();
      paintSensSampleNote();
    });
  });
  $("#sensAnalyze")?.addEventListener("click", () => runSensAnalysis());
}

async function loadLeakAnalysis() {
  if (!window.pywebview?.api?.get_leak_analysis) {
    paintLeakPanels();
    return;
  }
  try {
    const result = await window.pywebview.api.get_leak_analysis();
    const data = result?.ok ? result.data : null;
    leakStore = {
      maps: data?.maps || null,
      weapons: data?.weapons || null
    };
  } catch {
    leakStore = { maps: null, weapons: null };
  }
  paintLeakPanels();
  renderMaps();
  renderWeapons();
}

async function runLeakAnalysis(kind) {
  const scope = kind === "weapon" ? "weapon" : "map";
  const api = window.pywebview?.api;
  if (!api?.analyze_leaks) {
    showToast("Open OmegaDash to run this analysis");
    return;
  }
  leakBusy[scope] = true;
  leakVisible[scope] = true;
  syncLeakButtons(scope);
  paintLeakPanels({ kind: scope, loading: true });
  try {
    const result = await api.analyze_leaks(JSON.stringify({
      kind: scope,
      modes: modesForApi(settings.statModes)
    }));
    const stillHere = leakOnTab(scope);
    if (!result?.ok) {
      leakVisible[scope] = stillHere;
      if (stillHere) paintLeakPanels({ kind: scope, error: result?.error || "Could not analyze" });
      else paintLeakPanels({ kind: scope });
      showToast(result?.error || "Could not analyze");
      return;
    }
    leakStore = {
      maps: result.data?.maps || leakStore.maps,
      weapons: result.data?.weapons || leakStore.weapons
    };
    leakVisible[scope] = stillHere;
    paintLeakPanels({ kind: scope });
    if (scope === "weapon") renderWeapons();
    else renderMaps();
    const a = leakSlice(scope)?.analysis;
    if (a?.verdict === "ok") showToast(scope === "weapon" ? "Weapons look solid" : "Maps look solid");
    else if (a?.focusName) showToast(`Weak point: ${a.focusName}`);
    else showToast("Analysis ready");
  } catch {
    const stillHere = leakOnTab(scope);
    leakVisible[scope] = stillHere;
    if (stillHere) paintLeakPanels({ kind: scope, error: "Gemini took too long or could not be reached" });
    else paintLeakPanels({ kind: scope });
    showToast("Gemini took too long or could not be reached");
  } finally {
    leakBusy[scope] = false;
    syncLeakButtons(scope);
  }
}

function bindLeakAnalysis() {
  $("#mapAnalyze")?.addEventListener("click", () => runLeakAnalysis("map"));
  $("#weaponAnalyze")?.addEventListener("click", () => runLeakAnalysis("weapon"));
  $("#mapLeakToggle")?.addEventListener("click", () => toggleLeakPanel("map"));
  $("#weaponLeakToggle")?.addEventListener("click", () => toggleLeakPanel("weapon"));
}

function paintDashboard() {
  try {
    decorateMatch(data.lastMatch);
    (data.matches || []).forEach(decorateMatch);
    const range = $("#rangeControl .active")?.dataset.range || "30";
    renderKpis(range);
    renderLastMatch();
    renderMatches();
    renderMaps();
    renderWeapons();
    paintLeakPanels();
    paintLiveMeta();
    resetCharts();
    const tab = document.querySelector(".tab-panel.active")?.id;
    if (tab !== "last-match") initOverallCharts();
    if (tab === "last-match" && data.lastMatch) {
      makeReactionChart("matchReactionChart", (data.lastMatch.engagements || []).filter(e => !e.unattributed), true);
      drawLocationHeatmap($("#locationMode .active")?.dataset.mode);
    }
    applyTheme(settings.theme, false);
  } catch {
    paintLiveMeta();
  }
}

let lastStamp = "";
let lastBoardStamp = "";

function snapshotKey(state) {
  const last = state?.lastMatch;
  const engs = last?.engagements || [];
  const tail = engs[engs.length - 1] || {};
  return [
    state?.matches?.length,
    last?.id,
    last?.kills,
    last?.deaths,
    last?.live ? 1 : 0,
    engs.length,
    tail.id,
    tail.result,
    tail.pathEff,
    state?.weapons?.length,
    state?.maps?.length
  ].join("|");
}

function showToast(message) {
  if (!message) return;
  (showToast.queue ||= []).push(String(message));
  pumpToasts();
}

function pumpToasts() {
  if (showToast.busy) return;
  const toast = $("#toast");
  if (!toast) {
    showToast.queue = [];
    return;
  }
  const message = showToast.queue.shift();
  if (!message) return;
  showToast.busy = true;
  const copy = toast.querySelector("p");
  if (copy) copy.textContent = message;
  toast.classList.remove("show");
  void toast.offsetWidth;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.classList.remove("show");
    showToast.busy = false;
    if (showToast.queue?.length) showToast.timer = setTimeout(pumpToasts, 160);
  }, 2200);
}

let confirmResolver = null;
let confirmMode = "action";

function resetConfirmChrome() {
  confirmMode = "action";
  const overlay = $("#confirmModal");
  const extra = $("#confirmExtra");
  const ok = $("#confirmOk");
  const cancel = $("#confirmCancel");
  overlay?.classList.remove("is-unsaved");
  if (extra) extra.hidden = true;
  if (cancel) {
    cancel.hidden = false;
    cancel.textContent = "Cancel";
  }
  if (ok) {
    ok.className = "danger-btn";
    ok.textContent = "Delete";
  }
}

function closeConfirm(result) {
  const overlay = $("#confirmModal");
  if (overlay) {
    overlay.classList.remove("open");
    overlay.hidden = true;
  }
  resetConfirmChrome();
  const resolve = confirmResolver;
  confirmResolver = null;
  resolve?.(result);
}

function confirmAction({ title, copy, confirmLabel = "Delete", kicker = "CONFIRM" } = {}) {
  return new Promise(resolve => {
    if (confirmResolver) confirmResolver(false);
    confirmResolver = resolve;
    confirmMode = "action";
    const overlay = $("#confirmModal");
    if (!overlay) {
      resolve(false);
      return;
    }
    resetConfirmChrome();
    confirmMode = "action";
    const kickerEl = $("#confirmKicker");
    const titleEl = $("#confirmTitle");
    const copyEl = $("#confirmCopy");
    const ok = $("#confirmOk");
    if (kickerEl) kickerEl.textContent = kicker;
    if (titleEl) titleEl.textContent = title || "Are you sure?";
    if (copyEl) copyEl.textContent = copy || "";
    if (ok) ok.textContent = confirmLabel;
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add("open"));
    $("#confirmCancel")?.focus();
  });
}

function confirmUnsavedScript() {
  return new Promise(resolve => {
    if (confirmResolver) confirmResolver("stay");
    confirmResolver = resolve;
    confirmMode = "unsaved";
    const overlay = $("#confirmModal");
    if (!overlay) {
      resolve("stay");
      return;
    }
    const extra = $("#confirmExtra");
    const ok = $("#confirmOk");
    const cancel = $("#confirmCancel");
    const kickerEl = $("#confirmKicker");
    const titleEl = $("#confirmTitle");
    const copyEl = $("#confirmCopy");
    overlay.classList.add("is-unsaved");
    if (kickerEl) kickerEl.textContent = "UNSAVED CHANGES";
    if (titleEl) titleEl.textContent = "Leave without saving?";
    if (copyEl) copyEl.textContent = "Save these values to Omega, or continue without saving.";
    if (extra) {
      extra.hidden = false;
      extra.textContent = "Continue without saving";
    }
    if (cancel) cancel.hidden = true;
    if (ok) {
      ok.className = "settings-save";
      ok.textContent = "Save";
    }
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add("open"));
    ok?.focus();
  });
}

function bindConfirmModal() {
  $("#confirmCancel")?.addEventListener("click", () => closeConfirm(confirmMode === "unsaved" ? "stay" : false));
  $("#confirmExtra")?.addEventListener("click", () => closeConfirm("discard"));
  $("#confirmOk")?.addEventListener("click", () => closeConfirm(confirmMode === "unsaved" ? "save" : true));
  $("#confirmModal")?.addEventListener("click", event => {
    if (event.target.id !== "confirmModal") return;
    closeConfirm(confirmMode === "unsaved" ? "stay" : false);
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if (!$("#confirmModal")?.classList.contains("open")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeConfirm(confirmMode === "unsaved" ? "stay" : false);
  });
}

function applyLiveState(state) {
  data = state || emptyState();
  lastStamp = snapshotKey(data);
  lastBoardStamp = scoreboardKey(data);
  if (selectedSpotId != null && !findEngagement(selectedSpotId)) selectedSpotId = null;
  paintDashboard();
}

async function deleteMatch(matchId) {
  const id = String(matchId || "").trim();
  if (!id) return;
  const ok = await confirmAction({
    kicker: "MATCH HISTORY",
    title: "Delete this match?",
    copy: "It will be removed from your last 20 and from local telemetry.",
    confirmLabel: "Delete match"
  });
  if (!ok) return;
  const api = window.pywebview?.api;
  if (api?.delete_match) {
    try {
      const result = await api.delete_match(id);
      if (!result?.ok || !result.data) {
        showToast(result?.error || "Could not delete match");
        return;
      }
      applyLiveState(result.data);
      showToast("Match deleted");
    } catch {
      showToast("Could not delete match");
    }
    return;
  }
  data.matches = (data.matches || []).filter(match => String(match.id) !== id);
  if (String(data.lastMatch?.id) === id) data.lastMatch = data.matches[0] || null;
  applyLiveState(data);
  showToast("Match deleted");
}

function patchMatchMode(matchId, mode) {
  const key = String(matchId);
  const next = String(mode || "");
  for (const match of data.matches || []) {
    if (String(match.id) === key) match.mode = next;
  }
  if (String(data.lastMatch?.id) === key) data.lastMatch.mode = next;
}

function restoreMatchModeSelect(matchId, mode) {
  const sel = $$(".match-mode").find(item => item.dataset.matchMode === String(matchId));
  if (!sel) return;
  sel.value = String(mode || "");
  sel.classList.toggle("is-tagged", Boolean(sel.value));
  syncUiSelect(sel);
}

async function setMatchMode(matchId, mode) {
  const id = String(matchId || "").trim();
  if (!id) return;
  const next = String(mode || "");
  const prev = String((data.matches || []).find(match => String(match.id) === id)?.mode || "");
  patchMatchMode(id, next);
  paintSensSampleNote();
  const api = window.pywebview?.api;
  if (!api?.set_match_mode) return;
  try {
    const result = await api.set_match_mode(id, next);
    if (result?.ok) {
      patchMatchMode(id, result.mode || "");
      restoreMatchModeSelect(id, result.mode || "");
      return;
    }
    patchMatchMode(id, prev);
    restoreMatchModeSelect(id, prev);
    showToast(result?.error || "Could not tag match");
    paintSensSampleNote();
  } catch {
    patchMatchMode(id, prev);
    restoreMatchModeSelect(id, prev);
    showToast("Could not tag match");
    paintSensSampleNote();
  }
}

async function clearAllTelemetry() {
  const ok = await confirmAction({
    kicker: "RESET",
    title: "Delete all telemetry?",
    copy: "Every saved match will be wiped so you can start fresh. This cannot be undone.",
    confirmLabel: "Delete all data"
  });
  if (!ok) return;
  const api = window.pywebview?.api;
  if (api?.clear_telemetry) {
    try {
      const result = await api.clear_telemetry();
      if (!result?.ok || !result.data) {
        showToast(result?.error || "Could not clear telemetry");
        return;
      }
      selectedSpotId = null;
      applyLiveState(result.data);
      showToast("Telemetry cleared");
    } catch {
      showToast("Could not clear telemetry");
    }
    return;
  }
  selectedSpotId = null;
  applyLiveState(emptyState());
  showToast("Telemetry cleared");
}

function statModesPayload() {
  return modesForApi(normalizeSampleModes(settings.statModes));
}

function hydrateStatModeControl() {
  const selected = new Set(normalizeSampleModes(settings.statModes));
  $$("#modeControl [data-mode]").forEach(btn => {
    btn.classList.toggle("active", selected.has(btn.dataset.mode));
  });
}

function syncTopFilters(tab) {
  const modes = $("#modeControl");
  const range = $("#rangeControl");
  if (modes) modes.hidden = !["overall", "maps", "weapons"].includes(tab);
  if (range) range.hidden = tab !== "overall";
}

function onStatModeClick(event) {
  const btn = event.currentTarget;
  const id = btn.dataset.mode;
  if (!id) return;
  const next = new Set(normalizeSampleModes(settings.statModes));
  if (next.has(id)) {
    if (next.size <= 1) {
      showToast("Pick at least one match type");
      return;
    }
    next.delete(id);
  } else {
    next.add(id);
  }
  settings.statModes = MATCH_MODE_OPTIONS.map(item => item.id).filter(mode => next.has(mode));
  saveSettings();
  hydrateStatModeControl();
  loadTelemetry({ force: true });
}

async function loadTelemetry(opts = {}) {
  const api = window.pywebview?.api;
  if (api?.get_state) {
    try {
      const result = await api.get_state(JSON.stringify({ modes: statModesPayload() }));
      if (result?.ok && result.data) {
        if (result.omegaRestart) showToast(result.omegaRestart);
        data = result.data;
        const key = snapshotKey(data);
        const board = scoreboardKey(data);
        if (!opts.force && key === lastStamp) {
          paintLiveMeta();
          if (board !== lastBoardStamp) {
            lastBoardStamp = board;
            paintMatchLive();
          } else {
            ensureLeetifyProfiles(data.lastMatch);
          }
          return "live";
        }
        applyLiveState(data);
        return "live";
      }
    } catch { /* keep current snapshot */ }
  } else if (window.MOCK_DATA) {
    data = window.MOCK_DATA;
    data.source = "mock";
    paintDashboard();
    return "mock";
  }
  paintDashboard();
  return data.source || "empty";
}

let pollTimer = 0;
function startLivePoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = 0;
  if (!settings.liveSync) return;
  pollTimer = setInterval(() => loadTelemetry(), 1000);
}

const THEMES = {
  omega: { accent: "#79f2b0", accent2: "#3ddc97", gradient: ["#79f2b0", "#1a3d32"], blue: "#69a7ff", orange: "#ff9d66", red: "#ff6b78" },
  neon: { accent: "#ff4fd8", accent2: "#8b5cff", gradient: ["#ff4fd8", "#7aa2ff"], blue: "#34d9ff", orange: "#ffdf5d", red: "#ff4778" },
  aurora: { accent: "#8b9dff", accent2: "#ba70ff", gradient: ["#8b9dff", "#ba70ff"], blue: "#51e5ff", orange: "#ff9fe5", red: "#ff6f91" },
  ember: { accent: "#ffb347", accent2: "#ff5f6d", gradient: ["#ffb347", "#ff5f6d"], blue: "#7ec8ff", orange: "#ff7547", red: "#ff4d62" },
  violet: { accent: "#3800BA", accent2: "#4a1ad4", gradient: ["#3800BA", "#1c0068"], blue: "#7a8cff", orange: "#ffb07c", red: "#ff6b91" },
  prism: { accent: "#a855f7", accent2: "#7dd3fc", blue: "#67e8f9", orange: "#c4b5fd", red: "#f472b6", anim: "prism" },
  spectrum: { accent: "#ff4d4d", accent2: "#ffe14d", blue: "#3b82f6", orange: "#ff9f1c", red: "#ff3b3b", anim: "spectrum" },
  magma: { accent: "#ff3b30", accent2: "#ffd166", blue: "#ff8a4c", orange: "#ff7a18", red: "#ff2d2d", anim: "magma" },
  tide: { accent: "#22d3ee", accent2: "#2dd4bf", blue: "#38bdf8", orange: "#7dd3fc", red: "#fb7185", anim: "tide" },
  voltage: { accent: "#bef264", accent2: "#22d3ee", blue: "#67e8f9", orange: "#facc15", red: "#fb7185", anim: "voltage" }
};

function defaultCustomTheme(kind) {
  if (kind === "custom-anim") {
    return { name: "Custom", accent: "#e879f9", accent2: "#22d3ee", blue: "#67e8f9", orange: "#facc15", red: "#fb7185", animMode: "rgb" };
  }
  return { name: "Custom", accent: "#5eead4", accent2: "#14b8a6", blue: "#69a7ff", orange: "#ff9d66", red: "#ff6b78", gradientPct: 50, gradientFade: 80, gradientAngle: 135 };
}

function clampInt(n, min, max, fallback) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function gradientBlendStops(pos, fade) {
  const p = clampInt(pos, 0, 100, 50);
  const f = clampInt(fade, 0, 100, 80);
  if (f <= 0) return { start: p, end: p };
  const half = f / 2;
  let start = p - half;
  let end = p + half;
  if (start < 0) {
    end = Math.min(100, end - start);
    start = 0;
  }
  if (end > 100) {
    start = Math.max(0, start - (end - 100));
    end = 100;
  }
  if (end < start) end = start;
  return { start, end };
}

function normalizeCustomTheme(value, kind) {
  const base = defaultCustomTheme(kind);
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const name = String(raw.name || base.name).trim().slice(0, 18) || base.name;
  const next = {
    name,
    accent: normalizeLogColor(raw.accent) || base.accent,
    accent2: normalizeLogColor(raw.accent2) || base.accent2,
    blue: normalizeLogColor(raw.blue) || base.blue,
    orange: normalizeLogColor(raw.orange) || base.orange,
    red: normalizeLogColor(raw.red) || base.red
  };
  if (kind === "custom-anim") {
    next.animMode = raw.animMode === "fade" ? "fade" : "rgb";
    return next;
  }
  next.gradientPct = clampInt(raw.gradientPct, 0, 100, base.gradientPct);
  next.gradientFade = clampInt(raw.gradientFade, 0, 100, base.gradientFade);
  next.gradientAngle = clampInt(raw.gradientAngle, 0, 360, base.gradientAngle);
  return next;
}

function customThemeSettings(kind) {
  if (kind === "custom-anim") return settings.customAnim || defaultCustomTheme(kind);
  return settings.customStatic || defaultCustomTheme(kind);
}

function isKnownTheme(name) {
  return Boolean(THEMES[name]) || name === "custom" || name === "custom-anim";
}

function themeDef(name = settings?.theme) {
  if (name === "custom") {
    const c = customThemeSettings("custom");
    return { accent: c.accent, accent2: c.accent2, gradient: [c.accent, c.accent2], gradientPct: c.gradientPct, gradientFade: c.gradientFade, gradientAngle: c.gradientAngle, blue: c.blue, orange: c.orange, red: c.red };
  }
  if (name === "custom-anim") {
    const c = customThemeSettings("custom-anim");
    return { accent: c.accent, accent2: c.accent2, blue: c.blue, orange: c.orange, red: c.red, anim: "custom", animMode: c.animMode };
  }
  return THEMES[name] || THEMES.omega;
}

function themeAccent() {
  return themeDef().accent;
}

function isAnimatedTheme(name = settings?.theme) {
  return Boolean(themeDef(name)?.anim);
}

const defaultSettings = {
  theme: "omega", liveSync: true, compactNav: false, reduceMotion: false, themeSpeed: 5, simulateLoot: false,
  staticGradients: false, sens: 1, dpi: 800, sampleGames: 8, sampleModes: defaultSampleModes(), statModes: defaultSampleModes(),
  hiddenScripts: [], hiddenScriptFields: {}, scriptBaselines: {}, scriptAutoSave: false, cloudSortPopular: false, cloudHideLibraries: true, omegaRestartOnStall: true, fullscreenMaximize: true,
  logScriptColors: {}, logScriptHighlight: {}, logScriptHidden: {}, logLineHighlights: {},
  customStatic: defaultCustomTheme("custom"),
  customAnim: defaultCustomTheme("custom-anim")
};

let settings = { ...defaultSettings };

function saveSettings() {
  localStorage.setItem("omegaSettings", JSON.stringify(settings));
  const api = window.pywebview?.api;
  if (api?.save_ui_settings) {
    Promise.resolve(api.save_ui_settings(JSON.stringify(settings))).catch(() => {});
  }
}

function whenNativeReady() {
  return new Promise(resolve => {
    if (window.pywebview?.api) return resolve();
    window.addEventListener("pywebviewready", resolve, { once: true });
    setTimeout(resolve, 2000);
  });
}

async function loadPersistedSettings() {
  let local = {};
  let file = {};
  try { local = JSON.parse(localStorage.getItem("omegaSettings") || "{}"); } catch { local = {}; }
  if (window.pywebview?.api?.load_ui_settings) {
    try {
      const result = await window.pywebview.api.load_ui_settings();
      if (result?.ok && result.data && typeof result.data === "object") file = result.data;
    } catch { /* keep localStorage copy */ }
  }
  settings = { ...defaultSettings, ...local, ...file };
  if (settings.theme === "ice") settings.theme = "violet";
  if (!isKnownTheme(settings.theme)) settings.theme = "omega";
  settings.themeSpeed = Math.min(10, Math.max(1, Math.round(Number(settings.themeSpeed) || 5)));
  settings.staticGradients = Boolean(settings.staticGradients);
  settings.sens = Math.min(20, Math.max(0.001, Number(settings.sens) || 1));
  settings.dpi = Math.min(20000, Math.max(100, Math.round(Number(settings.dpi) || 800)));
  settings.sampleGames = Math.min(20, Math.max(1, Math.round(Number(settings.sampleGames) || 8)));
  settings.sampleModes = normalizeSampleModes(settings.sampleModes);
  settings.statModes = normalizeSampleModes(settings.statModes);
  settings.hiddenScripts = normalizeHiddenScripts(settings.hiddenScripts);
  settings.hiddenScriptFields = normalizeHiddenScriptFields(settings.hiddenScriptFields);
  settings.scriptBaselines = normalizeScriptBaselines(settings.scriptBaselines);
  settings.scriptAutoSave = Boolean(settings.scriptAutoSave);
  settings.cloudSortPopular = Boolean(settings.cloudSortPopular);
  settings.cloudHideLibraries = settings.cloudHideLibraries !== false;
  settings.omegaRestartOnStall = settings.omegaRestartOnStall !== false;
  settings.fullscreenMaximize = settings.fullscreenMaximize !== false;
  settings.logScriptColors = normalizeLogScriptMap(settings.logScriptColors, true);
  settings.logScriptHighlight = normalizeLogScriptMap(settings.logScriptHighlight, false);
  settings.logScriptHidden = normalizeLogScriptMap(settings.logScriptHidden, false);
  settings.logLineHighlights = normalizeLogLineHighlights(settings.logLineHighlights);
  settings.customStatic = normalizeCustomTheme(settings.customStatic, "custom");
  settings.customAnim = normalizeCustomTheme(settings.customAnim, "custom-anim");
}

let themeRaf = 0;
const PRISM_A = [168, 85, 247];
const PRISM_B = [125, 211, 252];
const MAGMA_STOPS = [[255, 45, 48], [255, 122, 24], [255, 209, 102]];
const TIDE_STOPS = [[3, 105, 161], [34, 211, 238], [45, 212, 191]];
const VOLTAGE_STOPS = [[190, 242, 100], [250, 204, 21], [34, 211, 238]];

function hexFromRgb(rgb) {
  return `#${rgb.map(n => n.toString(16).padStart(2, "0")).join("")}`;
}

function mixRgb(a, b, t) {
  return a.map((value, i) => Math.round(value + (b[i] - value) * t));
}

function scaleRgb(rgb, t) {
  const k = Math.min(1, Math.max(0, t));
  return rgb.map(c => Math.round(c * k));
}

function pulseColors(a, b, t) {
  const w = Math.abs(Math.cos(Math.min(1, Math.max(0, t)) * Math.PI));
  return scaleRgb(t < 0.5 ? a : b, w);
}

function mixHsl(a, b, t) {
  const ha = rgbToHsl(a);
  const hb = rgbToHsl(b);
  const ht = Math.min(1, Math.max(0, t));
  const dh = ((hb[0] - ha[0] + 540) % 360) - 180;
  return hslToRgb(
    (ha[0] + dh * ht + 360) % 360,
    ha[1] + (hb[1] - ha[1]) * ht,
    ha[2] + (hb[2] - ha[2]) * ht
  );
}

function pingPong01(elapsed, period = 2800) {
  const x = ((elapsed / Math.max(400, period)) % 2 + 2) % 2;
  return x <= 1 ? x : 2 - x;
}

function themeOnAccent(name, rgb) {
  if (name === "neon" || name === "aurora") return "#f4f1ff";
  if (themeDef(name)?.anim) return "#101611";
  return rgbLuma(rgb) < 0.28 ? "#f4f1ff" : "#101611";
}

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs(hp % 2 - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [r, g, b].map(v => Math.round((v + m) * 255));
}

function rgbToHsl(rgb) {
  const r = Number(rgb[0]) / 255;
  const g = Number(rgb[1]) / 255;
  const b = Number(rgb[2]) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = (l > 0.5 ? d / (2 - max - min) : d / (max + min)) * 100;
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l * 100];
}

function cycleStops(stops, t) {
  const x = ((t % 1) + 1) % 1 * stops.length;
  const i = Math.floor(x) % stops.length;
  const f = x - Math.floor(x);
  return mixRgb(stops[i], stops[(i + 1) % stops.length], f);
}

function hexToRgbArr(hex) {
  const m = String(hex || "").match(/\w\w/g);
  if (!m || m.length < 3) return [121, 242, 176];
  return m.slice(0, 3).map(v => parseInt(v, 16));
}

function packColors(rgb, rgb2) {
  return { rgb, rgb2, hex: hexFromRgb(rgb), hex2: hexFromRgb(rgb2) };
}

function themeSpeedScale() {
  return (Math.min(10, Math.max(1, Number(settings.themeSpeed) || 5))) / 5;
}

function themeColorsAt(name, elapsed) {
  const theme = themeDef(name);
  const anim = theme.anim;
  if (anim === "spectrum") {
    const hue = (elapsed / 8000) * 360;
    return packColors(hslToRgb(hue, 82, 62), hslToRgb(hue + 48, 78, 58));
  }
  if (anim === "prism") {
    const t = (Math.sin(elapsed / 1400) + 1) / 2;
    return packColors(mixRgb(PRISM_A, PRISM_B, t), mixRgb(PRISM_B, PRISM_A, t));
  }
  if (anim === "magma") {
    const rgb = cycleStops(MAGMA_STOPS, elapsed / 4200);
    return packColors(rgb, cycleStops(MAGMA_STOPS, elapsed / 4200 + 0.33));
  }
  if (anim === "tide") {
    const rgb = cycleStops(TIDE_STOPS, elapsed / 4800);
    return packColors(rgb, cycleStops(TIDE_STOPS, elapsed / 4800 + 0.38));
  }
  if (anim === "voltage") {
    const rgb = cycleStops(VOLTAGE_STOPS, elapsed / 3600);
    return packColors(rgb, cycleStops(VOLTAGE_STOPS, elapsed / 3600 + 0.42));
  }
  if (anim === "custom") {
    const a = hexToRgbArr(theme.accent);
    const b = hexToRgbArr(theme.accent2);
    const t = pingPong01(elapsed, 2800);
    const rgb = theme.animMode === "fade" ? pulseColors(a, b, t) : mixHsl(a, b, t);
    return packColors(rgb, rgb);
  }
  return packColors(hexToRgbArr(theme.accent), hexToRgbArr(theme.accent2));
}

function themeGradientFill(theme, from, to) {
  if (theme.gradientPct == null && theme.gradientFade == null && theme.gradientAngle == null) {
    if (!theme.anim && Array.isArray(theme.gradient) && theme.gradient.length >= 2) {
      return `linear-gradient(135deg, ${theme.gradient[0]}, ${theme.gradient[1]})`;
    }
    return `linear-gradient(135deg, ${from}, ${to})`;
  }
  const angle = clampInt(theme.gradientAngle, 0, 360, 135);
  const { start, end } = gradientBlendStops(theme.gradientPct, theme.gradientFade);
  return `linear-gradient(${angle}deg, ${from} ${start}%, ${to} ${end}%)`;
}

function paintThemeVars(colors) {
  document.documentElement.style.setProperty("--accent", colors.hex);
  document.documentElement.style.setProperty("--accent-2", colors.hex2);
  document.documentElement.style.setProperty("--accent-rgb", colors.rgb.join(", "));
  const theme = themeDef();
  const from = !theme.anim && theme.gradient?.[0] ? theme.gradient[0] : colors.hex;
  const to = !theme.anim && theme.gradient?.[1] ? theme.gradient[1] : colors.hex2;
  document.documentElement.style.setProperty("--theme-gradient", themeGradientFill(theme, from, to));
  document.documentElement.style.setProperty("--gradient-from", from);
  document.documentElement.style.setProperty("--gradient-to", to);
  document.documentElement.style.setProperty("--theme-glow", `rgba(${colors.rgb.join(",")}, .16)`);
  document.documentElement.style.setProperty("--on-accent", themeOnAccent(settings.theme, colors.rgb));
  const stops = document.querySelectorAll("#gaugeGrad stop");
  if (stops[0]) stops[0].setAttribute("stop-color", from);
  if (stops[1]) stops[1].setAttribute("stop-color", to);
}

function paintThemeCharts(hex) {
  if (charts.reactionChart) charts.reactionChart.update("none");
  if (charts.matchReactionChart) charts.matchReactionChart.update("none");
  if (charts.placementRadar) {
    charts.placementRadar.data.datasets[0].pointBackgroundColor = `${hex}c7`;
    charts.placementRadar.data.datasets[0].pointHoverBackgroundColor = hex;
    charts.placementRadar.update("none");
  }
  if (charts.flickScatter) {
    charts.flickScatter.data.datasets[1].backgroundColor = `${hex}c7`;
    charts.flickScatter.update("none");
  }
  if (charts.invValueChart) charts.invValueChart.update("none");
}

function stopThemeAnim() {
  if (themeRaf) cancelAnimationFrame(themeRaf);
  themeRaf = 0;
}

function startThemeAnim() {
  stopThemeAnim();
  if (!isAnimatedTheme() || document.body.classList.contains("reduce-motion")) return;
  const running = themeDef().anim;
  const started = performance.now();
  let lastChart = 0;
  const step = now => {
    if (themeDef().anim !== running) return;
    const colors = themeColorsAt(settings.theme, (now - started) * themeSpeedScale());
    paintThemeVars(colors);
    if (now - lastChart > 160) {
      lastChart = now;
      paintThemeCharts(colors.hex);
    }
    themeRaf = requestAnimationFrame(step);
  };
  themeRaf = requestAnimationFrame(step);
}

function syncStaticGradients() {
  const row = $("#staticGradientRow");
  const input = row?.querySelector("input");
  const staticTheme = !isAnimatedTheme();
  const on = Boolean(settings.staticGradients) && staticTheme;
  document.body.classList.toggle("static-gradients", on);
  row?.classList.toggle("is-disabled", !staticTheme);
  if (input) input.disabled = !staticTheme;
  paintThemeCharts(themeAccent());
}

function syncThemeSpeedUi() {
  const slider = $("#themeSpeed");
  const output = $("#themeSpeedValue");
  const row = $("#themeSpeedRow");
  if (!slider) return;
  slider.value = String(settings.themeSpeed);
  if (output) output.textContent = `${themeSpeedScale().toFixed(1)}×`;
  const enabled = isAnimatedTheme() && !settings.reduceMotion;
  slider.disabled = !enabled;
  row?.classList.toggle("is-disabled", !enabled);
  document.documentElement.style.setProperty("--theme-anim-ms", `${Math.round(3500 / themeSpeedScale())}ms`);
}

function applyTheme(name, persist = true) {
  const next = isKnownTheme(name) ? name : "omega";
  const theme = themeDef(next);
  settings.theme = next;
  stopThemeAnim();
  document.body.dataset.theme = settings.theme;
  Object.entries(theme).forEach(([key, value]) => {
    if (key === "anim" || key === "gradient" || key === "animMode" || key === "gradientPct" || key === "gradientFade" || key === "gradientAngle") return;
    document.documentElement.style.setProperty(`--${key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`, value);
  });
  paintThemeVars(themeColorsAt(settings.theme, 0));
  $$(".theme-option").forEach(option => option.classList.toggle("active", option.dataset.theme === settings.theme));
  paintThemeCharts(theme.accent);
  paintCustomThemeCards();
  if ($("#locationHeatmap")) drawLocationHeatmap($("#locationMode .active")?.dataset.mode);
  syncThemeSpeedUi();
  syncStaticGradients();
  if (isAnimatedTheme()) startThemeAnim();
  if (persist) saveSettings();
}

let themeEditKind = "custom";

function paintCustomPreview(el, colors) {
  if (!el || !colors) return;
  el.style.setProperty("--c1", colors.accent);
  el.style.setProperty("--c2", colors.accent2);
  if (colors.animMode != null || el.classList.contains("custom-anim-preview")) {
    el.style.setProperty("--ga", "135deg");
    el.style.setProperty("--gs", "10%");
    el.style.setProperty("--ge", "90%");
    return;
  }
  const angle = clampInt(colors.gradientAngle, 0, 360, 135);
  const { start, end } = gradientBlendStops(colors.gradientPct, colors.gradientFade);
  el.style.setProperty("--ga", `${angle}deg`);
  el.style.setProperty("--gs", `${start}%`);
  el.style.setProperty("--ge", `${end}%`);
}

function paintThemeEditPreview() {
  const el = $("#themeEditGradPreview");
  if (!el) return;
  const c = customThemeSettings(themeEditKind);
  el.style.background = themeGradientFill(c, c.accent, c.accent2);
}

function paintCustomThemeCards() {
  const stat = customThemeSettings("custom");
  const anim = customThemeSettings("custom-anim");
  const statName = $("#customStaticName");
  const animName = $("#customAnimName");
  if (statName) statName.textContent = stat.name;
  if (animName) animName.textContent = anim.name;
  paintCustomPreview($("#customStaticPreview"), stat);
  paintCustomPreview($("#customAnimPreview"), anim);
  if (themeEditorIsOpen()) paintThemeEditPreview();
}

function themeEditorIsOpen() {
  return Boolean($("#themeEditor")?.classList.contains("open"));
}

function fillThemeEditor() {
  const c = customThemeSettings(themeEditKind);
  const isAnim = themeEditKind === "custom-anim";
  const name = $("#themeEditName");
  const title = $("#themeEditTitle");
  const mix = $("#themeEditGradient");
  const mixOut = $("#themeEditGradientValue");
  const fade = $("#themeEditFade");
  const fadeOut = $("#themeEditFadeValue");
  const angle = $("#themeEditAngle");
  const angleOut = $("#themeEditAngleValue");
  const gradBlock = $("#themeEditGradientBlock");
  const animRow = $("#themeEditAnimRow");
  if (name) name.value = c.name;
  if (title) title.textContent = isAnim ? "Edit animated theme" : "Edit theme";
  $$("#themeEditor [data-theme-color]").forEach(input => {
    input.value = c[input.dataset.themeColor] || "#79f2b0";
  });
  if (mix) mix.value = String(c.gradientPct ?? 50);
  if (mixOut) mixOut.textContent = `${c.gradientPct ?? 50}%`;
  if (fade) fade.value = String(c.gradientFade ?? 80);
  if (fadeOut) fadeOut.textContent = `${c.gradientFade ?? 80}%`;
  if (angle) angle.value = String(c.gradientAngle ?? 135);
  if (angleOut) angleOut.textContent = `${c.gradientAngle ?? 135}°`;
  if (gradBlock) gradBlock.hidden = isAnim;
  if (animRow) animRow.hidden = !isAnim;
  $$("#themeEditAnimMode button").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.animMode === (c.animMode || "rgb"));
  });
  paintThemeEditPreview();
}

function commitThemeEditor() {
  const key = themeEditKind === "custom-anim" ? "customAnim" : "customStatic";
  const next = { ...customThemeSettings(themeEditKind) };
  next.name = String($("#themeEditName")?.value || "").trim().slice(0, 18) || defaultCustomTheme(themeEditKind).name;
  $$("#themeEditor [data-theme-color]").forEach(input => {
    const hex = normalizeLogColor(input.value);
    if (hex) next[input.dataset.themeColor] = hex;
  });
  if (themeEditKind === "custom-anim") {
    delete next.gradientPct;
    delete next.gradientFade;
    delete next.gradientAngle;
    next.animMode = $("#themeEditAnimMode .active")?.dataset.animMode === "fade" ? "fade" : "rgb";
  } else {
    next.gradientPct = clampInt($("#themeEditGradient")?.value, 0, 100, 50);
    next.gradientFade = clampInt($("#themeEditFade")?.value, 0, 100, 80);
    next.gradientAngle = clampInt($("#themeEditAngle")?.value, 0, 360, 135);
    const mixOut = $("#themeEditGradientValue");
    const fadeOut = $("#themeEditFadeValue");
    const angleOut = $("#themeEditAngleValue");
    if (mixOut) mixOut.textContent = `${next.gradientPct}%`;
    if (fadeOut) fadeOut.textContent = `${next.gradientFade}%`;
    if (angleOut) angleOut.textContent = `${next.gradientAngle}°`;
  }
  settings[key] = next;
  paintCustomThemeCards();
  if (settings.theme !== themeEditKind) {
    applyTheme(themeEditKind);
    return;
  }
  const theme = themeDef(themeEditKind);
  Object.entries(theme).forEach(([prop, value]) => {
    if (prop === "anim" || prop === "gradient" || prop === "animMode" || prop === "gradientPct" || prop === "gradientFade" || prop === "gradientAngle") return;
    document.documentElement.style.setProperty(`--${prop.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`, value);
  });
  if (!theme.anim || !themeRaf) {
    paintThemeVars(themeColorsAt(themeEditKind, 0));
    paintThemeCharts(theme.accent);
  }
  saveSettings();
}

function closeThemeEditor() {
  const overlay = $("#themeEditor");
  if (!overlay) return;
  overlay.classList.remove("open");
  overlay.hidden = true;
}

function openThemeEditor(kind) {
  themeEditKind = kind === "custom-anim" ? "custom-anim" : "custom";
  fillThemeEditor();
  applyTheme(themeEditKind);
  const overlay = $("#themeEditor");
  if (!overlay) return;
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add("open"));
}

function bindThemeEditor() {
  $$("[data-edit-theme]").forEach(btn => {
    btn.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      openThemeEditor(btn.dataset.editTheme);
    });
  });
  $("#themeEditorClose")?.addEventListener("click", closeThemeEditor);
  $("#themeEditor")?.addEventListener("click", event => {
    if (event.target.id !== "themeEditor") return;
    closeThemeEditor();
  });
  $("#themeEditName")?.addEventListener("input", commitThemeEditor);
  $("#themeEditGradient")?.addEventListener("input", commitThemeEditor);
  $("#themeEditFade")?.addEventListener("input", commitThemeEditor);
  $("#themeEditAngle")?.addEventListener("input", commitThemeEditor);
  $$("#themeEditor [data-theme-color]").forEach(input => {
    input.addEventListener("input", commitThemeEditor);
  });
  $("#themeEditAnimMode")?.addEventListener("click", event => {
    const btn = event.target.closest("[data-anim-mode]");
    if (!btn) return;
    $$("#themeEditAnimMode button").forEach(el => el.classList.toggle("active", el === btn));
    commitThemeEditor();
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if ($("#confirmModal")?.classList.contains("open")) return;
    if (logSettingsIsOpen()) return;
    if (!themeEditorIsOpen()) return;
    event.preventDefault();
    closeThemeEditor();
  });
}

function hydrateSettings() {
  $$("[data-setting]").forEach(input => { input.checked = Boolean(settings[input.dataset.setting]); });
  document.body.classList.toggle("compact-nav", settings.compactNav);
  document.body.classList.toggle("reduce-motion", settings.reduceMotion);
  syncCompactSidebarChrome();
  syncThemeSpeedUi();
  syncStaticGradients();
  applyTheme(settings.theme, false);
  syncLootRollButton();
  hydrateSensForm();
  hydrateStatModeControl();
  syncScriptEditorChrome();
  syncCloudPopularUi();
  paintAppVersion();
}

const API_KEY_FIELDS = [
  { name: "constelia", input: "consteliaKey", status: "consteliaStatus", placeholder: "Paste Constelia API key" },
  { name: "leetify", input: "leetifyKey", status: "leetifyStatus", placeholder: "Paste Leetify API key" },
  { name: "gemini", input: "geminiKey", status: "geminiStatus", placeholder: "Paste Gemini API key" },
  { name: "csfloat", input: "csfloatKey", status: "csfloatStatus", placeholder: "Paste CSFloat API key" }
];

function keyFieldMasked(el) {
  return el.type !== "text";
}

function setKeyFieldMasked(el, masked) {
  el.type = masked ? "password" : "text";
}

function paintApiStatus(data) {
  $$("[data-toggle-key]").forEach(btn => { btn.textContent = "Show"; });
  API_KEY_FIELDS.forEach(field => {
    const info = data?.[field.name] || {};
    const el = $(`#${field.status}`);
    const input = $(`#${field.input}`);
    if (!el || !input) return;
    input.value = "";
    setKeyFieldMasked(input, true);
    delete input.dataset.cleared;
    input.dataset.saved = info.set ? "1" : "0";
    if (info.set) {
      if (info.valid === false) {
        el.textContent = "Invalid";
        el.className = "api-status missing";
      } else {
        el.textContent = info.valid ? "Valid" : (info.length ? `Saved · ${info.length}` : "Saved");
        el.className = "api-status ok";
      }
      input.placeholder = info.hint ? `Saved · ${info.hint}` : "Key saved";
    } else {
      el.textContent = "Missing";
      el.className = "api-status missing";
      input.placeholder = field.placeholder;
    }
  });
  const note = $("#apiKeyNote");
  if (!note) return;
  if (!window.pywebview?.api?.save_api_keys) note.textContent = "API keys save in the OmegaDash desktop app.";
  else note.textContent = "Leave a field blank to keep the saved key. Show reveals a saved key.";
}

async function loadApiKeys() {
  if (!window.pywebview?.api?.get_api_keys) {
    paintApiStatus({});
    return;
  }
  try {
    const result = await window.pywebview.api.get_api_keys();
    paintApiStatus(result?.ok ? result.data : {});
  } catch {
    paintApiStatus({});
  }
}

function apiKeyPayload() {
  const payload = {};
  API_KEY_FIELDS.forEach(field => {
    const input = $(`#${field.input}`);
    if (!input) return;
    if (input.dataset.cleared === "1") payload[field.name] = "";
    else if (input.value.trim()) payload[field.name] = input.value.trim();
  });
  return payload;
}

function bindApiKeys() {
  $$("[data-toggle-key]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const input = $(`#${btn.dataset.toggleKey}`);
      if (!input) return;
      if (!keyFieldMasked(input)) {
        setKeyFieldMasked(input, true);
        btn.textContent = "Show";
        return;
      }
      if (!input.value.trim()) {
        const field = API_KEY_FIELDS.find(item => item.input === btn.dataset.toggleKey);
        if (!field || input.dataset.saved !== "1" || !window.pywebview?.api?.reveal_api_key) {
          showToast("No key to show");
          return;
        }
        btn.disabled = true;
        try {
          const result = await window.pywebview.api.reveal_api_key(field.name);
          if (!result?.ok || !result.data?.value) {
            showToast(result?.error || "No key saved");
            return;
          }
          input.value = result.data.value;
          delete input.dataset.cleared;
        } catch {
          showToast("Could not show key");
          return;
        } finally {
          btn.disabled = false;
        }
      }
      if (!input.value.trim()) return;
      setKeyFieldMasked(input, false);
      btn.textContent = "Hide";
    });
  });
  $$("[data-clear-key]").forEach(btn => {
    btn.addEventListener("click", () => {
      const input = $(`#${btn.dataset.clearKey}`);
      if (!input) return;
      input.value = "";
      setKeyFieldMasked(input, true);
      input.dataset.cleared = "1";
      input.dataset.saved = "0";
      input.placeholder = "Will be removed on save";
      const toggle = document.querySelector(`[data-toggle-key="${input.id}"]`);
      if (toggle) toggle.textContent = "Show";
    });
  });
  API_KEY_FIELDS.forEach(field => {
    $(`#${field.input}`)?.addEventListener("input", event => {
      if (event.target.value) delete event.target.dataset.cleared;
    });
  });
  $("#saveApiKeys")?.addEventListener("click", async () => {
    const btn = $("#saveApiKeys");
    if (!window.pywebview?.api?.save_api_keys) {
      showToast("Open OmegaDash to save API keys");
      return;
    }
    const payload = apiKeyPayload();
    if (!Object.keys(payload).length) {
      showToast("No key changes to save");
      return;
    }
    btn.disabled = true;
    try {
      const result = await window.pywebview.api.save_api_keys(JSON.stringify(payload));
      if (!result?.ok) {
        showToast(result?.error || "Could not save API keys");
        return;
      }
      paintApiStatus(result.data);
      if (result.data?.leetify?.valid === false) showToast(result.data.leetify.error || "Leetify key is invalid");
      else if (result.data?.csfloat?.valid === false) showToast(result.data.csfloat.error || "CSFloat key is invalid");
      else showToast("API keys saved");
      if (Object.prototype.hasOwnProperty.call(payload, "constelia")) {
        profileFetchStarted = false;
        loadForumWidget();
      }
      if (Object.prototype.hasOwnProperty.call(payload, "csfloat")) {
        csfloatAuthToast = false;
        syncInventoryPrices();
      }
    } catch {
      showToast("Could not save API keys");
    } finally {
      btn.disabled = false;
    }
  });
}

const LOG_POLL_MS = 400;
const LOG_MAX_LINES = 50000;
const LOG_HEAD_RE = /^\[\d{2}:\d{2}:\d{2}\]\s+\[[^\]]+\]/;
const LOG_LINE_HL_MAX = 500;
const LOG_LINE_DEFAULT = "#ff9a3d";
let logOffset = 0;
let logTimer = 0;
let logBusy = false;
let logFollow = true;
let logIgnoreScroll = false;
let logDayOffset = 0;
let logLastRaw = null;
let logTimeMin = null;
let logTimeMax = null;
let logRangeStart = 0;
let logRangeEnd = 0;
let logPinnedStart = true;
let logPinnedEnd = true;
let logScriptListKey = "";
let logLinePopBlock = null;
let logPickBlocks = [];
let logDrag = null;
let logLineLastColor = LOG_LINE_DEFAULT;
const logLineColorMemory = {};

function logSettingsIsOpen() {
  return Boolean($("#logSettings")?.classList.contains("open"));
}

function parseHms(hms) {
  const m = String(hms || "").match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function parseLogHead(line) {
  const m = String(line).match(/^\[(\d{2}:\d{2}:\d{2})\]\s+\[([^\]]+)\]\s*(.*)$/);
  if (!m) return null;
  return { time: m[1], src: m[2].trim(), msg: m[3] };
}

function logAbsTime(hms) {
  const sec = parseHms(hms);
  if (sec == null) return null;
  if (logLastRaw != null && sec + 3600 < logLastRaw) logDayOffset += 86400;
  logLastRaw = sec;
  return sec + logDayOffset;
}

function logClock(abs) {
  if (abs == null || !Number.isFinite(abs)) return "—";
  const s = ((abs % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map(n => String(n).padStart(2, "0")).join(":");
}

function resetLogTimeState() {
  logDayOffset = 0;
  logLastRaw = null;
  logTimeMin = null;
  logTimeMax = null;
  logRangeStart = 0;
  logRangeEnd = 0;
  logPinnedStart = true;
  logPinnedEnd = true;
}

function logRangeIsAll() {
  return logPinnedStart && logPinnedEnd;
}

function logSourceClass(src, msg) {
  const blob = `${src} ${msg}`.toLowerCase();
  if (/\berror\b|\bfail(?:ed|ure)?\b|\bexception\b/.test(blob)) return "is-err";
  if (/omegadash|ingest/i.test(src)) return "is-dash";
  if (/\.lua$/i.test(src) || src.toLowerCase() === "lua" || src.toLowerCase() === "file") return "is-lua";
  return "";
}

function logFallbackColor(src) {
  if (/omegadash/i.test(src)) {
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    return normalizeLogColor(accent) || "#79f2b0";
  }
  if (/\.lua$/i.test(src) || src.toLowerCase() === "lua") return "#8bb4ff";
  return "#69a7ff";
}

function logSrcColor(src) {
  return settings.logScriptColors?.[src] || "";
}

function formatLogLine(line) {
  const parsed = parseLogHead(line);
  if (!parsed) return `<span class="log-plain">${esc(line)}</span>`;
  const kind = logSourceClass(parsed.src, parsed.msg);
  const color = logSrcColor(parsed.src);
  const style = color ? ` style="color:${esc(color)}"` : "";
  return `<span class="log-time">[${esc(parsed.time)}]</span> <span class="log-src ${kind}"${style}>[${esc(parsed.src)}]</span> <span class="log-msg ${kind === "is-err" ? "is-err" : ""}">${esc(parsed.msg)}</span>`;
}

function isLogHead(line) {
  return LOG_HEAD_RE.test(String(line));
}

function logBlockIdFromLine(line) {
  const parsed = parseLogHead(line);
  const raw = parsed ? `${parsed.time}|${parsed.src}|${parsed.msg}` : String(line || "");
  return raw.slice(0, 240);
}

function ensureLogBlockId(block) {
  if (!block) return "";
  if (block.dataset.lid) return block.dataset.lid;
  const first = block.querySelector(".log-line")?.textContent || block.textContent || "";
  block.dataset.lid = logBlockIdFromLine(first);
  return block.dataset.lid;
}

function logLineColorFor(lid) {
  return (settings.logLineHighlights || {})[lid] || logLineColorMemory[lid] || logLineLastColor || LOG_LINE_DEFAULT;
}

function setLogLineHighlights(lids, color) {
  const list = [...new Set((Array.isArray(lids) ? lids : [lids]).map(id => String(id || "")).filter(Boolean))];
  if (!list.length) return;
  const next = { ...(settings.logLineHighlights || {}) };
  const hex = normalizeLogColor(color);
  if (hex) logLineLastColor = hex;
  for (const lid of list) {
    if (!hex) {
      delete next[lid];
      continue;
    }
    delete next[lid];
    next[lid] = hex;
    logLineColorMemory[lid] = hex;
  }
  const keys = Object.keys(next);
  if (keys.length > LOG_LINE_HL_MAX) {
    keys.slice(0, keys.length - LOG_LINE_HL_MAX).forEach(k => delete next[k]);
  }
  settings.logLineHighlights = next;
  saveSettings();
  applyLogHighlight();
  if (logLinePopIsOpen()) paintLogLinePop();
}

function setLogLineHighlight(lid, color) {
  setLogLineHighlights([lid], color);
}

function applyLogHighlight() {
  const marks = settings.logScriptHighlight || {};
  const lineMarks = settings.logLineHighlights || {};
  const anyScript = Object.values(marks).some(Boolean);
  const view = $("#logsView");
  view?.classList.toggle("is-hl", anyScript);
  $$("#logsView .log-block").forEach(el => {
    const src = el.dataset.src || "";
    const scriptOn = Boolean(marks[src]);
    const lineColor = lineMarks[el.dataset.lid];
    const lineOn = Boolean(lineColor);
    el.classList.toggle("is-hl", scriptOn);
    el.classList.toggle("is-line-hl", lineOn);
    if (lineOn) {
      el.style.setProperty("--log-line-hl", lineColor);
      el.style.setProperty("--log-hl", lineColor);
    } else if (scriptOn) {
      el.style.setProperty("--log-hl", logSrcColor(src) || logFallbackColor(src));
      el.style.removeProperty("--log-line-hl");
    } else {
      el.style.removeProperty("--log-hl");
      el.style.removeProperty("--log-line-hl");
    }
  });
}

function restyleLogSources() {
  $$("#logsView .log-src").forEach(el => {
    const src = el.closest(".log-block")?.dataset.src;
    const color = logSrcColor(src);
    if (color) el.style.color = color;
    else el.style.removeProperty("color");
  });
  applyLogHighlight();
}

function applyLogFilter() {
  const q = ($("#logsFilter")?.value || "").trim().toLowerCase();
  const ranged = logTimeMin != null && logTimeMax != null && !logRangeIsAll();
  const hidden = settings.logScriptHidden || {};
  $$("#logsView .log-block").forEach(el => {
    const textOk = !q || el.textContent.toLowerCase().includes(q);
    let timeOk = true;
    if (ranged) {
      const t = Number(el.dataset.t);
      timeOk = !Number.isFinite(t) || (t >= logRangeStart && t <= logRangeEnd);
    }
    const srcOk = !hidden[el.dataset.src];
    el.hidden = !(textOk && timeOk && srcOk);
  });
  applyLogHighlight();
}

function visibleLogBlocks() {
  return [...document.querySelectorAll("#logsView > .log-block")].filter(el => !el.hidden);
}

function buildLogTxtExport(blocks) {
  return blocks.map(block =>
    [...block.querySelectorAll(".log-line")].map(line => (line.textContent || "").replace(/\u00a0/g, " ")).join("\n")
  ).join("\n");
}

function bakeLogBlockHtml(block) {
  const clone = block.cloneNode(true);
  clone.hidden = false;
  clone.removeAttribute("hidden");
  clone.querySelectorAll(".log-src").forEach((src, i) => {
    const live = block.querySelectorAll(".log-src")[i];
    const color = live ? getComputedStyle(live).color : "";
    if (color) src.style.color = color;
  });
  clone.classList.remove("is-picked");
  if (clone.classList.contains("is-hl")) {
    const hl = getComputedStyle(block).getPropertyValue("--log-hl").trim()
      || logSrcColor(block.dataset.src || "")
      || logFallbackColor(block.dataset.src || "");
    if (hl) clone.style.setProperty("--log-hl", hl);
  }
  if (clone.classList.contains("is-line-hl")) {
    const lineHl = getComputedStyle(block).getPropertyValue("--log-line-hl").trim()
      || (settings.logLineHighlights || {})[block.dataset.lid];
    if (lineHl) clone.style.setProperty("--log-line-hl", lineHl);
  }
  return clone.outerHTML;
}

function buildLogHtmlExport(blocks) {
  const highlighted = Boolean($("#logsView")?.classList.contains("is-hl"));
  const inner = blocks.map(bakeLogBlockHtml).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OmegaDash log</title>
<style>
  html, body { margin: 0; background: #080c10; color: #c5ced4; }
  .logs-view {
    padding: 16px 18px 24px;
    font: 11px/1.55 DM Mono, ui-monospace, monospace;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .log-block { display: block; }
  .log-line { display: block; }
  .log-cont { color: #9aa6b0; }
  .log-time { color: #5a6772; }
  .log-src { color: #69a7ff; }
  .log-src.is-lua { color: #8bb4ff; }
  .log-src.is-dash { color: #79f2b0; }
  .log-src.is-err { color: #ff6b78; }
  .log-msg.is-err { color: #ff9aa3; }
  .logs-view.is-hl .log-block { opacity: .32; }
  .logs-view.is-hl .log-block.is-hl,
  .logs-view.is-hl .log-block.is-line-hl {
    opacity: 1;
    background: color-mix(in srgb, var(--log-hl, var(--log-line-hl, #79f2b0)) 10%, transparent);
    box-shadow: inset 3px 0 0 var(--log-hl, var(--log-line-hl, #79f2b0));
  }
  .log-block.is-line-hl {
    background: color-mix(in srgb, var(--log-line-hl, #79f2b0) 14%, transparent);
    box-shadow: inset 3px 0 0 var(--log-line-hl, #79f2b0);
  }
</style>
</head>
<body>
<div class="logs-view${highlighted ? " is-hl" : ""}">${inner}</div>
</body>
</html>`;
}

async function exportVisibleLog(format) {
  const kind = format === "html" ? "html" : "txt";
  const blocks = visibleLogBlocks();
  if (!blocks.length) {
    showToast("Nothing to export");
    return;
  }
  const content = kind === "html" ? buildLogHtmlExport(blocks) : buildLogTxtExport(blocks);
  if (!window.pywebview?.api?.export_log) {
    showToast("Open OmegaDash to export logs");
    return;
  }
  try {
    const result = await window.pywebview.api.export_log(JSON.stringify({ format: kind, content }));
    if (result?.error === "cancelled") return;
    if (!result?.ok) {
      showToast(result?.error || "Could not export log");
      return;
    }
    showToast(kind === "html" ? "Log exported as HTML" : "Log exported as text");
  } catch {
    showToast("Could not export log");
  }
}

function logSpanBounds() {
  const lo = logTimeMin ?? 0;
  const hi = logTimeMax == null || logTimeMax <= lo ? lo + 1 : logTimeMax;
  return { lo, hi };
}

function syncLogRangeUi() {
  const start = $("#logRangeStart");
  const end = $("#logRangeEnd");
  const allBtn = $("#logRangeAll");
  const fill = $("#logDualFill");
  const startLabel = $("#logRangeStartLabel");
  const endLabel = $("#logRangeEndLabel");
  const status = $("#logRangeStatus");
  const { lo, hi } = logSpanBounds();
  const hasTimes = logTimeMin != null && logTimeMax != null;
  const canSlide = hasTimes && logTimeMax > logTimeMin;
  const all = !hasTimes || logRangeIsAll();
  if (start) {
    start.min = String(lo);
    start.max = String(hi);
    start.value = String(hasTimes ? logRangeStart : lo);
    start.disabled = !canSlide;
  }
  if (end) {
    end.min = String(lo);
    end.max = String(hi);
    end.value = String(hasTimes ? logRangeEnd : hi);
    end.disabled = !canSlide;
  }
  if (allBtn) allBtn.classList.toggle("is-on", all);
  if (startLabel) startLabel.textContent = hasTimes ? logClock(logRangeStart) : "—";
  if (endLabel) endLabel.textContent = hasTimes ? logClock(logRangeEnd) : "—";
  if (status) status.textContent = all ? "All" : `${logClock(logRangeStart)} – ${logClock(logRangeEnd)}`;
  if (fill) {
    const span = Math.max(1, hi - lo);
    const a = hasTimes ? ((logRangeStart - lo) / span) * 100 : 0;
    const b = hasTimes ? ((logRangeEnd - lo) / span) * 100 : 100;
    fill.style.left = `${Math.min(a, b)}%`;
    fill.style.width = `${Math.max(0, Math.abs(b - a))}%`;
  }
  if (start && end) {
    const mid = lo + (hi - lo) / 2;
    start.style.zIndex = logRangeStart >= mid ? "5" : "4";
    end.style.zIndex = logRangeEnd <= mid ? "5" : "3";
  }
}

function setLogRangeStart(value) {
  if (logTimeMin == null) return;
  const next = Math.max(logTimeMin, Math.min(Number(value), logRangeEnd));
  logRangeStart = next;
  logPinnedStart = next <= logTimeMin;
  syncLogRangeUi();
  applyLogFilter();
}

function setLogRangeEnd(value) {
  if (logTimeMax == null) return;
  const next = Math.min(logTimeMax, Math.max(Number(value), logRangeStart));
  logRangeEnd = next;
  logPinnedEnd = next >= logTimeMax;
  syncLogRangeUi();
  applyLogFilter();
}

function resetLogRangeAll() {
  logPinnedStart = true;
  logPinnedEnd = true;
  if (logTimeMin != null) logRangeStart = logTimeMin;
  if (logTimeMax != null) logRangeEnd = logTimeMax;
  syncLogRangeUi();
  applyLogFilter();
}

function expandLogRangePins() {
  if (logTimeMin == null) return;
  if (logPinnedStart) logRangeStart = logTimeMin;
  if (logPinnedEnd) logRangeEnd = logTimeMax;
  logRangeStart = Math.max(logTimeMin, Math.min(logRangeStart, logTimeMax));
  logRangeEnd = Math.max(logRangeStart, Math.min(logRangeEnd, logTimeMax));
}

function stampLogHead(block, line) {
  const parsed = parseLogHead(line);
  if (!parsed) return;
  block.dataset.src = parsed.src;
  block.dataset.lid = logBlockIdFromLine(line);
  const abs = logAbsTime(parsed.time);
  if (abs == null) return;
  block.dataset.t = String(abs);
  if (logTimeMin == null || abs < logTimeMin) logTimeMin = abs;
  if (logTimeMax == null || abs > logTimeMax) logTimeMax = abs;
}

function collectLogSources() {
  const set = new Set();
  $$("#logsView .log-block").forEach(el => {
    if (el.dataset.src) set.add(el.dataset.src);
  });
  Object.keys(settings.logScriptColors || {}).forEach(k => set.add(k));
  Object.keys(settings.logScriptHighlight || {}).forEach(k => set.add(k));
  Object.keys(settings.logScriptHidden || {}).forEach(k => set.add(k));
  return [...set].sort((a, b) => a.localeCompare(b));
}

function paintLogScriptList() {
  const list = $("#logScriptList");
  if (!list) return;
  const sources = collectLogSources();
  const key = sources.join("\0");
  if (key === logScriptListKey && list.childElementCount) return;
  logScriptListKey = key;
  if (!sources.length) {
    list.innerHTML = `<p class="log-scripts-empty">No scripts in this log yet.</p>`;
    return;
  }
  list.innerHTML = sources.map(src => {
    const color = logSrcColor(src) || logFallbackColor(src);
    const hl = Boolean(settings.logScriptHighlight?.[src]);
    const hide = Boolean(settings.logScriptHidden?.[src]);
    return `<div class="log-script-row${hide ? " is-hidden" : ""}">
      <span class="log-script-name" style="color:${esc(color)}">[${esc(src)}]</span>
      <input type="color" class="log-color" data-log-color="${esc(src)}" value="${esc(color)}" title="Script color" aria-label="Color for ${esc(src)}">
      <label class="log-hl-toggle" title="Highlight this script">
        <input type="checkbox" data-log-hl="${esc(src)}" ${hl ? "checked" : ""}>
        <i></i>
        <em>HL</em>
      </label>
      <label class="log-hl-toggle" title="Hide this script from the log">
        <input type="checkbox" data-log-hide="${esc(src)}" ${hide ? "checked" : ""}>
        <i></i>
        <em>Hide</em>
      </label>
    </div>`;
  }).join("");
}

function resetLogScriptStyles() {
  settings.logScriptColors = {};
  settings.logScriptHighlight = {};
  saveSettings();
  logScriptListKey = "";
  paintLogScriptList();
  restyleLogSources();
}

function closeLogSettings() {
  const overlay = $("#logSettings");
  if (!overlay) return;
  overlay.classList.remove("open");
  overlay.hidden = true;
  $("#logsSettings")?.classList.remove("is-on");
}

function openLogSettings() {
  closeLogLinePop();
  logScriptListKey = "";
  paintLogScriptList();
  syncLogRangeUi();
  const overlay = $("#logSettings");
  if (!overlay) return;
  overlay.hidden = false;
  $("#logsSettings")?.classList.add("is-on");
  requestAnimationFrame(() => overlay.classList.add("open"));
}

function syncLogFollowBtn() {
  const btn = $("#logsFollow");
  if (!btn) return;
  btn.classList.toggle("is-on", logFollow);
  btn.setAttribute("aria-pressed", String(logFollow));
  btn.textContent = logFollow ? "Follow" : "Paused";
}

function trimLogView(view) {
  const blocks = [...view.querySelectorAll(":scope > .log-block")];
  const extra = blocks.length - LOG_MAX_LINES;
  if (extra <= 0) return;
  for (let i = 0; i < extra; i += 1) blocks[i].remove();
  const first = view.querySelector(":scope > .log-block[data-t]");
  if (!first) return;
  const t = Number(first.dataset.t);
  if (!Number.isFinite(t) || t <= (logTimeMin ?? t)) return;
  logTimeMin = t;
  if (logPinnedStart) logRangeStart = logTimeMin;
  else logRangeStart = Math.max(logRangeStart, logTimeMin);
}

function appendLogText(text, { reset = false, truncated = false } = {}) {
  const view = $("#logsView");
  if (!view) return;
  if (reset) {
    closeLogLinePop();
    view.innerHTML = "";
    resetLogTimeState();
  }
  const chunk = String(text || "").replace(/\n+$/, "");
  if (!chunk) {
    if (reset && !view.childElementCount) {
      view.innerHTML = `<div class="log-line logs-empty">Waiting for Omega to write logs…</div>`;
    }
    if (logSettingsIsOpen()) {
      syncLogRangeUi();
      paintLogScriptList();
    }
    return;
  }
  if (view.querySelector(":scope > .logs-empty")) view.innerHTML = "";
  const frag = document.createDocumentFragment();
  if (truncated && !view.querySelector(".log-block")) {
    const note = document.createElement("div");
    note.className = "log-line logs-empty";
    note.textContent = "Log is huge — showing the most recent 8 MB.";
    frag.appendChild(note);
  }
  let block = (!reset && view.lastElementChild?.classList.contains("log-block"))
    ? view.lastElementChild
    : null;
  for (const line of chunk.split("\n")) {
    const head = isLogHead(line);
    if (!block || head) {
      if (!head && !String(line).trim()) continue;
      block = document.createElement("div");
      block.className = "log-block";
      if (head) stampLogHead(block, line);
      else if (!block.dataset.lid) block.dataset.lid = logBlockIdFromLine(line);
      frag.appendChild(block);
    }
    const row = document.createElement("div");
    row.className = head ? "log-line" : "log-line log-cont";
    row.innerHTML = formatLogLine(line);
    block.appendChild(row);
  }
  view.appendChild(frag);
  trimLogView(view);
  if (logPickBlocks.length) {
    const left = logPickBlocks.filter(el => el.isConnected);
    if (!left.length) closeLogLinePop();
    else if (left.length !== logPickBlocks.length) setLogPickedBlocks(left);
  }
  expandLogRangePins();
  applyLogFilter();
  if (logSettingsIsOpen()) {
    syncLogRangeUi();
    paintLogScriptList();
  }
  if (logFollow) {
    logIgnoreScroll = true;
    view.scrollTop = view.scrollHeight;
    requestAnimationFrame(() => { logIgnoreScroll = false; });
  }
}

async function pullOmegaLog() {
  if (logBusy) return;
  const api = window.pywebview?.api;
  if (!api?.read_omega_log) return;
  logBusy = true;
  try {
    const result = await api.read_omega_log(JSON.stringify({ offset: logOffset }));
    const live = $("#logsLive");
    const pathEl = $("#logsPath");
    if (pathEl && result?.path) pathEl.textContent = result.path;
    if (!result?.ok) {
      if (live) live.hidden = true;
      if (pathEl && result?.error) pathEl.textContent = result.error;
      if (result?.reset) {
        logOffset = 0;
        appendLogText("", { reset: true });
      }
      return;
    }
    if (live) live.hidden = false;
    if (result.reset) logOffset = 0;
    if (result.omegaRestart) showToast(result.omegaRestart);
    if (result.text || result.reset) {
      appendLogText(result.text || "", { reset: Boolean(result.reset), truncated: Boolean(result.truncated) });
    }
    logOffset = Number.isFinite(Number(result.offset)) ? Number(result.offset) : logOffset;
  } catch {
    const live = $("#logsLive");
    if (live) live.hidden = true;
  } finally {
    logBusy = false;
  }
}

function startLogWatch() {
  syncLogFollowBtn();
  pullOmegaLog();
  if (logTimer) return;
  logTimer = setInterval(pullOmegaLog, LOG_POLL_MS);
}

function stopLogWatch() {
  if (!logTimer) return;
  clearInterval(logTimer);
  logTimer = 0;
}

function logLinePopIsOpen() {
  return Boolean($("#logLinePop") && !$("#logLinePop").hidden);
}

function logPickTargets() {
  const blocks = logPickBlocks.length
    ? logPickBlocks
    : (logLinePopBlock ? [logLinePopBlock] : []);
  return blocks.filter(el => el?.isConnected);
}

function logBlockPlainText(block) {
  if (!block) return "";
  const rows = [...block.querySelectorAll(":scope > .log-line")];
  const parts = (rows.length ? rows : [block]).map(el =>
    String(el.innerText || el.textContent || "").replace(/\u00a0/g, " ").replace(/\s+\n/g, "\n").trimEnd()
  );
  return parts.filter(line => line.length).join("\n");
}

function logCopySourceText() {
  const sel = window.getSelection?.();
  const selected = String(sel?.toString() || "").replace(/\r\n/g, "\n");
  if (selected.trim()) {
    const node = sel.anchorNode;
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    if (el?.closest?.("#logsView")) return selected;
  }
  return logPickTargets().map(logBlockPlainText).filter(Boolean).join("\n");
}

function writeClipboardText(text) {
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    ta.remove();
    if (!ok) throw new Error("copy failed");
  };
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(fallback);
  }
  return Promise.resolve().then(fallback);
}

async function copyLogLines() {
  const text = logCopySourceText();
  if (!text) return false;
  try {
    await writeClipboardText(text);
  } catch {
    showToast("Couldn't copy");
    return false;
  }
  const n = logPickTargets().length;
  const selected = Boolean((window.getSelection?.()?.toString() || "").trim());
  showToast(selected || n <= 1 ? "Copied" : `Copied ${n} logs`);
  return true;
}

function clearLogPicked() {
  logPickBlocks.forEach(el => el.classList?.remove("is-picked"));
  if (logLinePopBlock) logLinePopBlock.classList.remove("is-picked");
  logPickBlocks = [];
  logLinePopBlock = null;
}

function setLogPickedBlocks(blocks) {
  $$("#logsView .log-block.is-picked").forEach(el => el.classList.remove("is-picked"));
  const unique = [];
  const seen = new Set();
  for (const block of blocks || []) {
    if (!block || !block.isConnected || seen.has(block)) continue;
    seen.add(block);
    ensureLogBlockId(block);
    block.classList.add("is-picked");
    unique.push(block);
  }
  logPickBlocks = unique;
  logLinePopBlock = unique[0] || null;
}

function logBlocksBetween(a, b) {
  const all = visibleLogBlocks();
  const i = all.indexOf(a);
  const j = all.indexOf(b);
  if (i < 0 && j < 0) return [];
  if (i < 0) return b ? [b] : [];
  if (j < 0) return a ? [a] : [];
  const lo = Math.min(i, j);
  const hi = Math.max(i, j);
  return all.slice(lo, hi + 1);
}

function closeLogLinePop() {
  clearLogPicked();
  const view = $("#logsView");
  view?.classList.remove("is-selecting");
  const pop = $("#logLinePop");
  if (!pop) return;
  pop.hidden = true;
}

function paintLogLinePop() {
  const pop = $("#logLinePop");
  if (!pop) return;
  const blocks = logPickTargets();
  if (!blocks.length) return;
  const n = blocks.length;
  const lid = ensureLogBlockId(blocks[0]);
  const marks = settings.logLineHighlights || {};
  const onCount = blocks.filter(el => marks[el.dataset.lid]).length;
  const color = logLineColorFor(lid);
  const src = blocks[0].dataset.src || "log";
  const kicker = $("#logLinePopKicker");
  const srcEl = $("#logLinePopSrc");
  const hint = $("#logLinePopHint");
  const toggle = $("#logLineHlOn");
  const picker = $("#logLineColorPick");
  if (kicker) kicker.textContent = n > 1 ? "SELECTED LOGS" : "THIS LOG";
  if (srcEl) srcEl.textContent = n > 1 ? `${n} logs` : `[${src}]`;
  if (hint) {
    hint.textContent = n > 1
      ? "Highlight and color apply to every selected log."
      : "Applies to the whole block, including wrapped lines from the same print.";
  }
  if (toggle) {
    toggle.checked = onCount === n;
    toggle.indeterminate = onCount > 0 && onCount < n;
  }
  if (picker) picker.value = color;
  $$("#logLinePopColors .log-line-swatch").forEach(btn => {
    btn.classList.toggle("is-on", normalizeLogColor(btn.dataset.logLineColor) === color);
  });
}

function placeLogLinePop(x, y) {
  const pop = $("#logLinePop");
  if (!pop) return;
  pop.hidden = false;
  const pad = 10;
  const width = pop.offsetWidth || 260;
  const height = pop.offsetHeight || 180;
  let left = x + 10;
  let top = y + 10;
  if (left + width > window.innerWidth - pad) left = x - width - 10;
  if (top + height > window.innerHeight - pad) top = y - height - 10;
  pop.style.left = `${Math.max(pad, left)}px`;
  pop.style.top = `${Math.max(pad, top)}px`;
}

function openLogLinePopFor(blocks, x, y, { toggle = true } = {}) {
  const unique = [];
  const seen = new Set();
  for (const block of blocks || []) {
    if (!block || !block.isConnected || seen.has(block)) continue;
    seen.add(block);
    ensureLogBlockId(block);
    unique.push(block);
  }
  if (!unique.length) return;
  if (
    toggle
    && unique.length === 1
    && logLinePopIsOpen()
    && logPickBlocks.length === 1
    && logPickBlocks[0] === unique[0]
  ) {
    closeLogLinePop();
    return;
  }
  setLogPickedBlocks(unique);
  paintLogLinePop();
  placeLogLinePop(x, y);
}

function logBlockFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  const block = el?.closest?.("#logsView .log-block");
  if (!block || block.hidden) return null;
  return block;
}

function scrollLogsForDrag(y) {
  const view = $("#logsView");
  if (!view) return;
  const r = view.getBoundingClientRect();
  const edge = 36;
  if (y < r.top + edge) view.scrollTop -= Math.max(10, Math.round(r.top + edge - y));
  else if (y > r.bottom - edge) view.scrollTop += Math.max(10, Math.round(y - (r.bottom - edge)));
}

function stopLogDragTick() {
  if (!logDrag?.raf) return;
  cancelAnimationFrame(logDrag.raf);
  logDrag.raf = 0;
}

function tickLogDrag() {
  if (!logDrag?.ranging) return;
  scrollLogsForDrag(logDrag.lastY);
  const over = logBlockFromPoint(logDrag.lastX, logDrag.lastY) || logDrag.lastOver || logDrag.anchor;
  if (over) logDrag.lastOver = over;
  setLogPickedBlocks(logBlocksBetween(logDrag.anchor, over));
  logDrag.raf = requestAnimationFrame(tickLogDrag);
}

function beginLogDragRange() {
  if (!logDrag || logDrag.ranging) return;
  logDrag.ranging = true;
  window.getSelection?.()?.removeAllRanges();
  $("#logsView")?.classList.add("is-selecting");
  const pop = $("#logLinePop");
  if (pop) pop.hidden = true;
  if (logFollow) {
    logFollow = false;
    syncLogFollowBtn();
  }
  tickLogDrag();
}

function updateLogDrag(event) {
  if (!logDrag || logDrag.skip) return;
  logDrag.lastX = event.clientX;
  logDrag.lastY = event.clientY;
  const dx = event.clientX - logDrag.x;
  const dy = event.clientY - logDrag.y;
  const over = logBlockFromPoint(event.clientX, event.clientY);
  if (!logDrag.ranging) {
    if (over && over !== logDrag.anchor) beginLogDragRange();
    else if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
      if (over && over !== logDrag.anchor) beginLogDragRange();
    }
  }
  if (!logDrag.ranging) return;
  event.preventDefault();
  if (over) logDrag.lastOver = over;
  setLogPickedBlocks(logBlocksBetween(logDrag.anchor, over || logDrag.lastOver || logDrag.anchor));
}

function endLogDrag(event) {
  if (!logDrag) return;
  const drag = logDrag;
  stopLogDragTick();
  logDrag = null;
  $("#logsView")?.classList.remove("is-selecting");
  if (drag.skip) return;
  if (drag.ranging) {
    const blocks = logPickBlocks.length
      ? logPickBlocks
      : logBlocksBetween(drag.anchor, drag.lastOver || drag.anchor);
    if (blocks.length) {
      openLogLinePopFor(blocks, event.clientX, event.clientY, { toggle: false });
      return;
    }
    closeLogLinePop();
    return;
  }
  const over = event.target?.closest?.("#logsView .log-block");
  if (over !== drag.anchor) return;
  if ((window.getSelection?.()?.toString() || "").trim()) return;
  openLogLinePopFor([drag.anchor], event.clientX, event.clientY);
}

function bindLogs() {
  $("#logsFollow")?.addEventListener("click", () => {
    logFollow = !logFollow;
    syncLogFollowBtn();
    if (logFollow) {
      const view = $("#logsView");
      if (view) view.scrollTop = view.scrollHeight;
    }
  });
  $("#logsClear")?.addEventListener("click", () => {
    closeLogLinePop();
    const view = $("#logsView");
    if (view) view.innerHTML = "";
    resetLogTimeState();
    logScriptListKey = "";
    applyLogFilter();
    if (logSettingsIsOpen()) {
      syncLogRangeUi();
      paintLogScriptList();
    }
  });
  $("#logsFilter")?.addEventListener("input", applyLogFilter);
  $("#logsFilter")?.addEventListener("search", applyLogFilter);
  $("#logsView")?.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    const block = event.target.closest("#logsView .log-block");
    if (!block || block.hidden) {
      logDrag = null;
      return;
    }
    if (event.shiftKey) {
      const anchor = logPickBlocks[0] || logLinePopBlock;
      if (anchor && anchor !== block) {
        event.preventDefault();
        openLogLinePopFor(logBlocksBetween(anchor, block), event.clientX, event.clientY, { toggle: false });
        logDrag = { skip: true };
        return;
      }
    }
    logDrag = {
      anchor: block,
      x: event.clientX,
      y: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      lastOver: block,
      ranging: false,
      skip: false
    };
  });
  document.addEventListener("pointermove", event => {
    if (!logDrag || logDrag.skip) return;
    updateLogDrag(event);
  });
  document.addEventListener("pointerup", event => {
    if (!logDrag) return;
    endLogDrag(event);
  });
  document.addEventListener("pointercancel", () => {
    if (!logDrag) return;
    stopLogDragTick();
    logDrag = null;
    $("#logsView")?.classList.remove("is-selecting");
  });
  document.addEventListener("selectstart", event => {
    if (logDrag?.ranging) event.preventDefault();
  });
  $("#logLineHlOn")?.addEventListener("change", event => {
    const lids = logPickTargets().map(ensureLogBlockId);
    if (!lids.length) return;
    if (event.target.checked) setLogLineHighlights(lids, logLineLastColor);
    else setLogLineHighlights(lids, "");
  });
  $("#logLinePopColors")?.addEventListener("click", event => {
    const swatch = event.target.closest(".log-line-swatch");
    if (!swatch) return;
    const lids = logPickTargets().map(ensureLogBlockId);
    const color = normalizeLogColor(swatch.dataset.logLineColor);
    if (!lids.length || !color) return;
    setLogLineHighlights(lids, color);
  });
  $("#logLineColorPick")?.addEventListener("input", event => {
    const lids = logPickTargets().map(ensureLogBlockId);
    const color = normalizeLogColor(event.target.value);
    if (!lids.length || !color) return;
    setLogLineHighlights(lids, color);
  });
  $("#logLineCopy")?.addEventListener("click", () => {
    copyLogLines();
  });
  document.addEventListener("mousedown", event => {
    if (!logLinePopIsOpen()) return;
    if (event.target.closest("#logLinePop")) return;
    if (event.target.closest("#logsView .log-block")) return;
    closeLogLinePop();
  });
  $("#logLinePop")?.addEventListener("mousedown", event => event.stopPropagation());
  $("#logsView")?.addEventListener("scroll", () => {
    if (logIgnoreScroll) return;
    const view = $("#logsView");
    if (!view) return;
    const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 48;
    if (atBottom !== logFollow) {
      logFollow = atBottom;
      syncLogFollowBtn();
    }
  });
  $("#logsSettings")?.addEventListener("click", openLogSettings);
  $("#logSettingsClose")?.addEventListener("click", closeLogSettings);
  $("#logSettings")?.addEventListener("click", event => {
    if (event.target.id !== "logSettings") return;
    closeLogSettings();
  });
  $("#logRangeAll")?.addEventListener("click", resetLogRangeAll);
  $("#logScriptsReset")?.addEventListener("click", resetLogScriptStyles);
  $("#logExportHtml")?.addEventListener("click", () => exportVisibleLog("html"));
  $("#logExportTxt")?.addEventListener("click", () => exportVisibleLog("txt"));
  $("#logRangeStart")?.addEventListener("input", event => setLogRangeStart(event.target.value));
  $("#logRangeEnd")?.addEventListener("input", event => setLogRangeEnd(event.target.value));
  $("#logDual")?.addEventListener("pointerdown", event => {
    if (event.target.tagName === "INPUT" || logTimeMin == null) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const { lo, hi } = logSpanBounds();
    const v = Math.round(lo + t * (hi - lo));
    if (Math.abs(v - logRangeStart) <= Math.abs(v - logRangeEnd)) setLogRangeStart(v);
    else setLogRangeEnd(v);
  });
  $("#logScriptList")?.addEventListener("input", event => {
    const color = event.target.closest("[data-log-color]");
    if (!color) return;
    const src = color.dataset.logColor;
    const hex = normalizeLogColor(color.value);
    settings.logScriptColors = { ...(settings.logScriptColors || {}) };
    if (hex) settings.logScriptColors[src] = hex;
    else delete settings.logScriptColors[src];
    saveSettings();
    const name = color.closest(".log-script-row")?.querySelector(".log-script-name");
    if (name && hex) name.style.color = hex;
    restyleLogSources();
  });
  $("#logScriptList")?.addEventListener("change", event => {
    const hl = event.target.closest("[data-log-hl]");
    if (hl) {
      const src = hl.dataset.logHl;
      settings.logScriptHighlight = { ...(settings.logScriptHighlight || {}) };
      if (hl.checked) settings.logScriptHighlight[src] = true;
      else delete settings.logScriptHighlight[src];
      saveSettings();
      applyLogHighlight();
      return;
    }
    const hide = event.target.closest("[data-log-hide]");
    if (!hide) return;
    const src = hide.dataset.logHide;
    settings.logScriptHidden = { ...(settings.logScriptHidden || {}) };
    if (hide.checked) settings.logScriptHidden[src] = true;
    else delete settings.logScriptHidden[src];
    hide.closest(".log-script-row")?.classList.toggle("is-hidden", hide.checked);
    saveSettings();
    applyLogFilter();
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if ($("#confirmModal")?.classList.contains("open")) return;
    if (logLinePopIsOpen()) {
      event.preventDefault();
      closeLogLinePop();
      return;
    }
    if (!logSettingsIsOpen()) return;
    event.preventDefault();
    closeLogSettings();
  });
  document.addEventListener("keydown", event => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "c") return;
    if (event.altKey || event.shiftKey) return;
    if (document.querySelector(".tab-panel.active")?.id !== "logs") return;
    if (typeof packetLogIsOpen === "function" && packetLogIsOpen()) return;
    if (event.target.closest("input, textarea, select, [contenteditable='true']")) return;
    if ($("#confirmModal")?.classList.contains("open")) return;
    if (!logCopySourceText()) return;
    event.preventDefault();
    copyLogLines();
  });
}

let packetAfter = 0;
let packetBusy = false;
let packetTimer = 0;
let packetFollow = true;
const PACKET_MAX_LINES = 2000;

function packetLogIsOpen() {
  return Boolean($("#packetLog")?.classList.contains("open"));
}

function applyPacketFilter() {
  const q = ($("#packetLogFilter")?.value || "").trim().toLowerCase();
  $$("#packetLogView .log-block").forEach(el => {
    el.hidden = Boolean(q) && !el.textContent.toLowerCase().includes(q);
  });
}

function syncPacketFollowBtn() {
  const btn = $("#packetLogFollow");
  if (!btn) return;
  btn.classList.toggle("is-on", packetFollow);
  btn.setAttribute("aria-pressed", String(packetFollow));
  btn.textContent = packetFollow ? "Follow" : "Paused";
}

function appendPacketText(text, { reset = false } = {}) {
  const view = $("#packetLogView");
  if (!view) return;
  if (reset) view.innerHTML = "";
  const chunk = String(text || "").replace(/\n+$/, "");
  if (!chunk) {
    if (reset && !view.childElementCount) {
      view.innerHTML = `<div class="log-line logs-empty">Waiting for packets…</div>`;
    }
    return;
  }
  if (view.querySelector(":scope > .logs-empty")) view.innerHTML = "";
  const frag = document.createDocumentFragment();
  const q = ($("#packetLogFilter")?.value || "").trim().toLowerCase();
  for (const line of chunk.split("\n")) {
    if (!String(line).trim()) continue;
    const block = document.createElement("div");
    block.className = "log-block";
    const row = document.createElement("div");
    row.className = "log-line";
    row.innerHTML = formatLogLine(line);
    block.appendChild(row);
    if (q && !line.toLowerCase().includes(q)) block.hidden = true;
    frag.appendChild(block);
  }
  view.appendChild(frag);
  const blocks = [...view.querySelectorAll(":scope > .log-block")];
  const extra = blocks.length - PACKET_MAX_LINES;
  for (let i = 0; i < extra; i += 1) blocks[i].remove();
  if (packetFollow) {
    view.scrollTop = view.scrollHeight;
  }
}

async function pullPacketLog() {
  if (packetBusy || !packetLogIsOpen()) return;
  const api = window.pywebview?.api;
  if (!api?.read_packet_log) return;
  packetBusy = true;
  try {
    const result = await api.read_packet_log(JSON.stringify({ after: packetAfter }));
    const live = $("#packetLogLive");
    const pathEl = $("#packetLogPath");
    if (pathEl && result?.url) pathEl.textContent = result.url;
    if (pathEl && !result?.ok && result?.error) pathEl.textContent = result.error;
    if (!result?.ok) {
      if (live) live.hidden = true;
      return;
    }
    if (live) live.hidden = false;
    if (result.reset) packetAfter = 0;
    if (result.text || result.reset) {
      appendPacketText(result.text || "", { reset: Boolean(result.reset) });
    } else if (!$("#packetLogView")?.childElementCount) {
      appendPacketText("", { reset: true });
    }
    packetAfter = Number.isFinite(Number(result.after)) ? Number(result.after) : packetAfter;
  } catch {
    const live = $("#packetLogLive");
    if (live) live.hidden = true;
  } finally {
    packetBusy = false;
  }
}

function startPacketWatch() {
  syncPacketFollowBtn();
  pullPacketLog();
  if (packetTimer) return;
  packetTimer = setInterval(pullPacketLog, LOG_POLL_MS);
}

function stopPacketWatch() {
  if (!packetTimer) return;
  clearInterval(packetTimer);
  packetTimer = 0;
}

function closePacketLog() {
  stopPacketWatch();
  const overlay = $("#packetLog");
  if (!overlay) return;
  overlay.classList.remove("open");
  overlay.hidden = true;
}

function openPacketLog() {
  packetAfter = 0;
  const view = $("#packetLogView");
  if (view) view.innerHTML = "";
  const overlay = $("#packetLog");
  if (!overlay) return;
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add("open"));
  startPacketWatch();
}

function bindPacketLog() {
  const card = $("#syncCard");
  card?.addEventListener("click", openPacketLog);
  card?.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openPacketLog();
  });
  $("#packetLogClose")?.addEventListener("click", closePacketLog);
  $("#packetLog")?.addEventListener("click", event => {
    if (event.target.id !== "packetLog") return;
    closePacketLog();
  });
  $("#packetLogFollow")?.addEventListener("click", () => {
    packetFollow = !packetFollow;
    syncPacketFollowBtn();
    if (packetFollow) {
      const view = $("#packetLogView");
      if (view) view.scrollTop = view.scrollHeight;
    }
  });
  $("#packetLogClear")?.addEventListener("click", () => {
    const view = $("#packetLogView");
    if (view) view.innerHTML = `<div class="log-line logs-empty">Waiting for packets…</div>`;
  });
  $("#packetLogFilter")?.addEventListener("input", applyPacketFilter);
  $("#packetLogFilter")?.addEventListener("search", applyPacketFilter);
  $("#packetLogView")?.addEventListener("scroll", () => {
    const view = $("#packetLogView");
    if (!view) return;
    const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 48;
    if (atBottom !== packetFollow) {
      packetFollow = atBottom;
      syncPacketFollowBtn();
    }
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if ($("#confirmModal")?.classList.contains("open")) return;
    if (logSettingsIsOpen() || themeEditorIsOpen()) return;
    if (!packetLogIsOpen()) return;
    event.preventDefault();
    closePacketLog();
  });
}

function activateTab(id) {
  closeUiSelects();
  if (id !== "logs") closeLogLinePop();
  if (id !== "sensitivity") closePracticeGuide();
  $$(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.tab === id));
  $$(".tab-panel").forEach(panel => panel.classList.toggle("active", panel.id === id));
  if (id !== "maps") concealLeak("map");
  else syncLeakButtons("map");
  if (id !== "weapons") concealLeak("weapon");
  else syncLeakButtons("weapon");
  const titles = {
    overall:["PERFORMANCE OVERVIEW","Overall Stats"],
    "last-match":["MATCH ANALYSIS","Last Match"],
    matches:["MATCH HISTORY","Last 20 Matches"],
    maps:["MAP BREAKDOWN","Maps"],
    weapons:["LOADOUT BREAKDOWN","Weapons"],
    sensitivity:["PERSONAL CALIBRATION","Sensitivity Finder"],
    loot:["ABUNDANCE OF JUPITER","Loot"],
    inventory:["STEAM CS2","Inventory"],
    config:["SCRIPTS","Scripts"],
    logs:["OMEGA PROCESS","Logs"],
    settings:["APPLICATION","Settings"]
  };
  $("#pageEyebrow").textContent=titles[id][0];$("#pageTitle").textContent=titles[id][1];
  syncTopFilters(id);
  if(id==="overall") setTimeout(() => {
    initOverallCharts();
    applyTheme(settings.theme, false);
  }, 0);
  if(id==="last-match") setTimeout(()=>{
    if (charts.matchReactionChart) {
      try { charts.matchReactionChart.destroy(); } catch {}
      delete charts.matchReactionChart;
    }
    if (data.lastMatch) makeReactionChart("matchReactionChart",(data.lastMatch.engagements || []).filter(e => !e.unattributed),true);
    drawLocationHeatmap($("#locationMode .active")?.dataset.mode);
    applyTheme(settings.theme, false);
  },0);
  if (id === "inventory") loadSteamInventory();
  if (id === "sensitivity") paintSensSampleNote();
  if (id === "config") {
    paintConfig();
    startConfigWatch();
    ensureCloudCatalog();
  } else {
    stopConfigWatch();
    closeChangelog();
  }
  if (id === "logs") startLogWatch();
  else {
    stopLogWatch();
    closeLogSettings();
  }
  if (id !== "settings") closeThemeEditor();
}

function syncMaxButton(maximized) {
  const btn = $("#winMax");
  if (!btn) return;
  btn.classList.toggle("is-max", Boolean(maximized));
  btn.setAttribute("aria-label", maximized ? "Restore" : "Maximize");
  document.body.classList.toggle("is-max", Boolean(maximized));
}

async function toggleWindowMax() {
  if (!window.pywebview?.api?.window_toggle_max) return;
  const result = await window.pywebview.api.window_toggle_max();
  syncMaxButton(result?.maximized);
}

function syncLaunchOmega() {
  const btn = $("#launchOmega");
  if (!btn) return;
  const running = Boolean(omegaLaunchRunning);
  const dir = String(memberConfig.directory || "").trim();
  btn.classList.toggle("is-running", running);
  btn.textContent = running ? "Omega running - relaunch" : "Launch Omega";
  btn.title = running
    ? "Stop the running Omega payload and start earthbound again"
    : (dir ? `Launch Omega from ${dir}` : "Launch Omega");
}

let omegaLaunchRunning = false;
let omegaStatusTimer = 0;

async function pullOmegaStatus() {
  const api = window.pywebview?.api;
  if (!api?.omega_status) return;
  try {
    const result = await api.omega_status();
    omegaLaunchRunning = Boolean(result?.ok && result.running);
  } catch {
    return;
  }
  syncLaunchOmega();
}

function startOmegaStatusWatch() {
  pullOmegaStatus();
  if (omegaStatusTimer) return;
  omegaStatusTimer = setInterval(pullOmegaStatus, 1500);
}

let launchOmegaBusy = false;

async function onLaunchOmega() {
  if (launchOmegaBusy) return;
  const api = window.pywebview?.api;
  if (!api?.launch_omega) {
    showToast("Open OmegaDash to launch Omega");
    return;
  }
  launchOmegaBusy = true;
  const btn = $("#launchOmega");
  if (btn) btn.disabled = true;
  try {
    const result = await api.launch_omega();
    if (!result?.ok) showToast(result?.error || "Could not launch Omega");
    else if (result.relaunch) showToast("Relaunching Omega");
  } catch {
    showToast("Could not launch Omega");
  } finally {
    launchOmegaBusy = false;
    if (btn) btn.disabled = false;
    pullOmegaStatus();
  }
}

function bindWindowChrome() {
  $("#winMin")?.addEventListener("click", () => {
    window.pywebview?.api?.window_minimize?.();
  });
  $("#winMax")?.addEventListener("click", () => { toggleWindowMax(); });
  $("#winClose")?.addEventListener("click", () => {
    window.pywebview?.api?.window_close?.();
  });
  const drag = $(".titlebar-drag");
  drag?.addEventListener("mousedown", event => {
    if (event.button !== 0 || event.target.closest(".win-btn")) return;
    const startX = event.screenX;
    const startY = event.screenY;
    const onMove = ev => {
      if (Math.abs(ev.screenX - startX) + Math.abs(ev.screenY - startY) < 4) return;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.pywebview?.api?.window_begin_drag?.();
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  drag?.addEventListener("dblclick", () => { toggleWindowMax(); });
  $("#launchOmega")?.addEventListener("click", onLaunchOmega);
  $$(".win-resize").forEach(handle => {
    handle.addEventListener("mousedown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      window.pywebview?.api?.window_begin_resize?.(handle.dataset.edge);
    });
  });
}

function bindInteractions() {
  bindUiSelects();
  enhanceSelect($("#protectionSelect"));
  enhanceSelect($("#cloudCategory"));
  $$(".nav-item").forEach(button=>button.addEventListener("click",()=>activateTab(button.dataset.tab)));
  bindLogs();
  bindPacketLog();
  bindChangelog();
  $$("#rangeControl button").forEach(button=>button.addEventListener("click",()=>{
    $$("#rangeControl button").forEach(b=>b.classList.remove("active"));button.classList.add("active");renderKpis(button.dataset.range);makeScatter();
  }));
  $$("#modeControl [data-mode]").forEach(btn => btn.addEventListener("click", onStatModeClick));
  $$("#locationMode button").forEach(button=>button.addEventListener("click",()=>{
    $$("#locationMode button").forEach(b=>b.classList.remove("active"));button.classList.add("active");drawLocationHeatmap(button.dataset.mode);
  }));
  $$("#configMode button").forEach(button => button.addEventListener("click", () => {
    activateConfigTab(button.dataset.configTab);
  }));
  $("#cloudSearch")?.addEventListener("input", paintConfigCloud);
  $("#cloudCategory")?.addEventListener("change", paintConfigCloud);
  $("#config")?.addEventListener("click", event => {
    const hideBtn = event.target.closest("[data-hide-script]");
    if (hideBtn) {
      event.preventDefault();
      event.stopPropagation();
      toggleHiddenScript(hideBtn.dataset.hideScript);
      return;
    }
    const editBtn = event.target.closest("[data-edit-script]");
    if (editBtn) {
      event.preventDefault();
      event.stopPropagation();
      openScriptEditor(editBtn.dataset.editScript);
      return;
    }
    const changelogBtn = event.target.closest("[data-changelog]");
    if (changelogBtn) {
      event.preventDefault();
      event.stopPropagation();
      openChangelog(changelogBtn.dataset.changelog);
      return;
    }
    if (event.target.closest("#configCloud, a, button, select, input")) return;
    const item = event.target.closest("[data-config-expand]");
    if (!item) return;
    item.classList.toggle("open");
  });
  $("#configCloud")?.addEventListener("click", event => {
    const toggle = event.target.closest("[data-cloud-toggle]");
    if (toggle) {
      event.preventDefault();
      event.stopPropagation();
      toggleCloudScript(toggle.dataset.cloudToggle);
      return;
    }
    const head = event.target.closest("[data-cloud-group]");
    if (head) {
      const name = head.dataset.cloudGroup || "";
      const group = head.closest(".config-cloud-group");
      const open = group?.classList.toggle("open");
      head.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) cloudOpenGroups.add(name);
      else cloudOpenGroups.delete(name);
      return;
    }
    const chip = event.target.closest("[data-cloud-cat]");
    if (!chip) return;
    const select = $("#cloudCategory");
    if (!select) return;
    const name = chip.dataset.cloudCat || "";
    select.value = select.value === name ? "" : name;
    syncUiSelect(select);
    paintConfigCloud();
  });
  $("#protectionSelect")?.addEventListener("change", onProtectionChange);
  $("#heatmapRoundPrev")?.addEventListener("click", () => cycleHeatmapRound(-1));
  $("#heatmapRoundNext")?.addEventListener("click", () => cycleHeatmapRound(1));
  $("#heatmapRoundLabel")?.addEventListener("click", () => {
    if (heatmapRound > 0) setHeatmapRound(0);
  });
  $("#sbViewPrev")?.addEventListener("click", () => cycleScoreboardView(-1));
  $("#sbViewNext")?.addEventListener("click", () => cycleScoreboardView(1));
  $$(".theme-option").forEach(button=>button.addEventListener("click",()=>applyTheme(button.dataset.theme)));
  bindThemeEditor();
  $("#themeSpeed")?.addEventListener("input", e => {
    settings.themeSpeed = Math.min(10, Math.max(1, Number(e.target.value) || 5));
    syncThemeSpeedUi();
    if (isAnimatedTheme()) startThemeAnim();
    saveSettings();
  });
  bindApiKeys();
  $$("[data-setting]").forEach(input=>input.addEventListener("change",e=>{
    settings[e.target.dataset.setting] = e.target.checked;
    document.body.classList.toggle("compact-nav", settings.compactNav);
    document.body.classList.toggle("reduce-motion", settings.reduceMotion);
    if (e.target.dataset.setting === "compactNav") syncCompactSidebarChrome();
    if (isAnimatedTheme()) {
      if (settings.reduceMotion) stopThemeAnim();
      else startThemeAnim();
    }
    syncThemeSpeedUi();
    syncStaticGradients();
    saveSettings();
    startLivePoll();
    if (e.target.dataset.setting === "simulateLoot") syncLootRollButton();
    if (e.target.dataset.setting === "scriptAutoSave") {
      syncScriptEditorChrome();
      if (settings.scriptAutoSave) flushScriptAutoSave();
    }
    if (e.target.dataset.setting === "cloudSortPopular" || e.target.dataset.setting === "cloudHideLibraries") {
      syncCloudPopularUi();
      paintConfigCloud();
    }
  }));
  $("#resetSettings").addEventListener("click",()=>{
    settings = {
      ...defaultSettings,
      hiddenScripts: [],
      hiddenScriptFields: {},
      scriptBaselines: {},
      logScriptColors: {},
      logScriptHighlight: {},
      logScriptHidden: {},
      logLineHighlights: {},
      customStatic: defaultCustomTheme("custom"),
      customAnim: defaultCustomTheme("custom-anim")
    };
    hydrateSettings();
    saveSettings();
    startLivePoll();
    syncLootRollButton();
    paintConfig();
    restyleLogSources();
    applyLogFilter();
    closeLogLinePop();
    logScriptListKey = "";
    if (logSettingsIsOpen()) paintLogScriptList();
  });
  $("#refreshBtn").addEventListener("click",e=>{
    e.currentTarget.classList.remove("spin");void e.currentTarget.offsetWidth;e.currentTarget.classList.add("spin");
    loadTelemetry({ force: true });
  });
  $("#exportBtn").addEventListener("click",async()=>{
    if(window.pywebview?.api?.export_data) await window.pywebview.api.export_data(JSON.stringify(data));
    showToast("Telemetry exported successfully");
  });
  $("#clearTelemetry")?.addEventListener("click", () => clearAllTelemetry());
  bindConfirmModal();
  bindVersionPopup();
  bindProfile();
  bindLoot();
  bindInventory();
  bindWindowChrome();
  bindHeatmap();
  bindSensFinder();
  bindLeakAnalysis();
  bindPracticeGuide();
  bindScriptEditor();
  $("#engagementRows")?.addEventListener("click", event => {
    const row = event.target.closest("tr[data-id]");
    if (!row) return;
    const rnd = Number(row.dataset.round);
    if (heatmapRound > 0 && Number.isFinite(rnd) && rnd > 0 && rnd !== heatmapRound) {
      setHeatmapRound(rnd);
    }
    selectSpot(Number(row.dataset.id));
  });
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

function initials(name) {
  const text = String(name || "").trim();
  if (!text) return "?";
  const parts = text.split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : text.slice(0, 2)).toUpperCase();
}

function fmtNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString() : "—";
}

function fmtUnix(ts) {
  const n = Number(ts);
  if (!n) return "—";
  return new Date(n * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function setAvatar(url, name) {
  const avatar = $("#profileAvatar");
  const initialsEl = $("#profileAvatarInitials");
  if (initialsEl) initialsEl.textContent = initials(name);
  if (url) {
    const probe = new Image();
    probe.onload = () => {
      avatar.style.backgroundImage = `url("${url}")`;
      avatar.classList.add("has-image");
    };
    probe.onerror = () => {
      avatar.style.backgroundImage = "";
      avatar.classList.remove("has-image");
    };
    probe.src = url;
    return;
  }
  avatar.style.backgroundImage = "";
  avatar.classList.remove("has-image");
}

function setNotice(id, count) {
  const value = Number(count) || 0;
  const countEl = $(id);
  const btn = countEl?.closest(".profile-notice");
  if (countEl) countEl.textContent = String(value);
  if (btn) btn.classList.toggle("unread", value > 0);
  syncNoticeBadge();
}

function syncNoticeBadge() {
  const dms = Number($("#noticeConversations")?.textContent) || 0;
  const alerts = Number($("#noticeAlerts")?.textContent) || 0;
  const wrap = document.querySelector(".avatar-wrap");
  if (wrap) wrap.classList.toggle("has-notice", dms + alerts > 0);
}

const COMPACT_SIDEBAR_MQ = window.matchMedia("(max-width: 800px)");

function isCompactSidebar() {
  return Boolean(settings.compactNav) || COMPACT_SIDEBAR_MQ.matches;
}

function syncCompactSidebarChrome() {
  const notices = $("#profileNotices");
  const sheet = $("#profileSheet");
  const card = document.querySelector(".profile-card");
  if (!notices || !sheet || !card) return;
  const compact = isCompactSidebar();
  if (compact) {
    if (notices.parentElement !== sheet) sheet.prepend(notices);
  } else if (notices.parentElement !== card) {
    card.append(notices);
  }
}

const NOTICE_HEARTBEAT_MS = 5 * 60 * 1000;
const CONFIG_WATCH_MS = 15 * 1000;
const CONFIG_POLL_MS = 2500;
const CONFIG_POLL_MAX = 16;
let noticeTimer = 0;
let configWatchTimer = 0;
let configPollTimer = 0;
const pendingConfig = new Map();
let memberFetchBusy = false;
let memberFetchQueued = false;

async function refreshMemberConfig() {
  if (!window.pywebview?.api?.get_member) return;
  if (memberFetchBusy) {
    memberFetchQueued = true;
    return;
  }
  memberFetchBusy = true;
  try {
    const result = await window.pywebview.api.get_member();
    if (!result?.ok || !result.data) return;
    setNotice("#noticeConversations", result.data.unread_conversations);
    setNotice("#noticeAlerts", result.data.unread_alerts);
    ingestMemberConfig(result.data);
  } catch { /* keep last */ }
  finally {
    memberFetchBusy = false;
    if (memberFetchQueued) {
      memberFetchQueued = false;
      refreshMemberConfig();
    }
  }
}

async function refreshUnreadNotices() {
  await refreshMemberConfig();
}

function startNoticeHeartbeat() {
  if (noticeTimer) clearInterval(noticeTimer);
  noticeTimer = 0;
  if (!window.pywebview?.api?.get_member) return;
  noticeTimer = setInterval(refreshUnreadNotices, NOTICE_HEARTBEAT_MS);
}

function startConfigWatch() {
  refreshMemberConfig();
  if (configWatchTimer) return;
  configWatchTimer = setInterval(refreshMemberConfig, CONFIG_WATCH_MS);
}

function stopConfigWatch() {
  if (!configWatchTimer) return;
  clearInterval(configWatchTimer);
  configWatchTimer = 0;
}

function scriptConfigReady(id) {
  const item = [...(memberConfig.scripts || []), ...(memberConfig.libs || [])]
    .find(entry => asCloudId(entry?.id) === id);
  return Boolean(item && scriptSettings(item).length);
}

function startConfigPoll(id) {
  if (id == null) return;
  pendingConfig.set(id, 0);
  if (configPollTimer) return;
  configPollTimer = setInterval(tickConfigPoll, CONFIG_POLL_MS);
}

async function tickConfigPoll() {
  await refreshMemberConfig();
  let changed = false;
  for (const [id, tries] of [...pendingConfig]) {
    const next = tries + 1;
    if (scriptConfigReady(id) || !cloudIsEnabled({ id }) || next >= CONFIG_POLL_MAX) {
      pendingConfig.delete(id);
      changed = true;
    } else {
      pendingConfig.set(id, next);
    }
  }
  if (!pendingConfig.size && configPollTimer) {
    clearInterval(configPollTimer);
    configPollTimer = 0;
  }
  if (changed && document.querySelector(".tab-panel.active")?.id === "config") paintConfig();
}

const LOOT_ITEM_W = 148;
const LOOT_GAP = 10;
const LOOT_WIN_INDEX = 36;
const LOOT_POOL = [
  { kind: "XP", title: "12 XP", rarity: "milspec" },
  { kind: "XP", title: "25 XP", rarity: "milspec" },
  { kind: "XP", title: "40 XP", rarity: "restricted" },
  { kind: "XP", title: "55 XP", rarity: "restricted" },
  { kind: "XP", title: "77 XP", rarity: "classified" },
  { kind: "XP", title: "100 XP", rarity: "classified" },
  { kind: "XP", title: "150 XP", rarity: "covert" },
  { kind: "XP", title: "250 XP", rarity: "gold" },
  { kind: "GIFT", title: "Daily gift", rarity: "restricted" }
];

function lootDailyPrize(n) {
  const task = `die ${n} times`;
  return {
    kind: "DAILY",
    title: task,
    rarity: "restricted",
    subtitle: `You unlocked a new daily quest: ${task}`
  };
}

function lootWeeklyPrize(n) {
  const task = `kill ${n} enemies`;
  return {
    kind: "WEEKLY",
    title: task,
    rarity: "classified",
    subtitle: `You unlocked a new weekly quest: ${task}`
  };
}

function lootFreeRollPrize() {
  return { kind: "LOOT", title: "Free roll", rarity: "restricted", subtitle: "Free roll" };
}

function lootMultiplierPrize(base) {
  const n = Math.max(1, Math.round(Number(base) || 0));
  return {
    kind: "MULT",
    title: `x10 of ${n}`,
    rarity: "gold",
    subtitle: `You rolled a x10 multiplier of ${n} (${n * 10})`
  };
}

function lootRng(seedText) {
  let x = 2166136261;
  const s = String(seedText || "loot");
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  x = x >>> 0 || 1;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

function pickCommonLoot(rng = Math.random) {
  return LOOT_POOL[Math.floor(rng() * LOOT_POOL.length)];
}

function pickLootCard(rng = Math.random) {
  const roll = rng();
  if (roll < 0.01) return lootMultiplierPrize(20 + Math.floor(rng() * 80));
  if (roll < 0.025) return lootFreeRollPrize();
  if (roll < 0.04) return lootDailyPrize([25, 50, 75][Math.floor(rng() * 3)]);
  if (roll < 0.055) return lootWeeklyPrize([10, 20, 30][Math.floor(rng() * 3)]);
  return pickCommonLoot(rng);
}

let lootBusy = false;
let lootCanRoll = false;

function pickLootFiller() {
  return pickLootCard();
}

function titleCaseLoot(value) {
  return String(value || "").replace(/\w\S*/g, word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function lootIsReplacedPrize(text) {
  return /\bperk\b|perk shard|protection|rootlink|\baura\b|crate\s*fill|cratefill/i.test(text);
}

function parseLootPrize(message, seedKey) {
  const text = String(message || "").trim();
  const quoted = text.match(/['"‘’“”]([^'"‘’“”]+)['"‘’“”]/);
  const named = quoted ? titleCaseLoot(quoted[1].trim()) : "";
  const xp = text.match(/(\d+)\s*xp/i);
  if (xp) {
    const amount = Number(xp[1]);
    const rarity = amount >= 200 ? "gold" : amount >= 120 ? "covert" : amount >= 70 ? "classified" : amount >= 40 ? "restricted" : "milspec";
    return { kind: "XP", title: `${amount} XP`, rarity, subtitle: text };
  }
  if (lootIsReplacedPrize(text) || lootIsReplacedPrize(named)) {
    return pickLootCard(lootRng(seedKey || text));
  }
  if (/free roll|earned nothing/i.test(text)) return lootFreeRollPrize();
  if (named) return { kind: "LOOT", title: named, rarity: "classified", subtitle: text };
  return { kind: "LOOT", title: text || "Loot", rarity: "classified", subtitle: text || "Loot" };
}

function lootItemHtml(item, winner = false) {
  const compact = String(item.title || "").length > 14 ? " compact" : "";
  const kind = String(item.kind || "LOOT").toLowerCase();
  return `<div class="loot-item ${esc(item.rarity)}${compact}${winner ? " winner" : ""}" data-kind="${esc(kind)}"><em>${esc(item.kind)}</em><div class="loot-gem" aria-hidden="true"><i></i></div><strong>${esc(item.title)}</strong></div>`;
}

function fillLootTrack(items) {
  const track = $("#lootTrack");
  if (!track) return;
  track.style.transition = "none";
  track.style.transform = "translateX(0)";
  track.innerHTML = items.map((item, i) => lootItemHtml(item, false)).join("");
}

function seedLootReel() {
  fillLootTrack(Array.from({ length: 18 }, pickLootFiller));
}

function lootSimulateOn() {
  return Boolean(settings.simulateLoot);
}

function syncLootRollButton() {
  const btn = $("#rollLootBtn");
  if (!btn || lootBusy) return;
  const sim = lootSimulateOn();
  const can = sim || lootCanRoll;
  btn.disabled = !can;
  btn.textContent = sim ? "Simulate roll" : (lootCanRoll ? "Roll loot" : "Loot not ready");
}

function renderLoot(loot = {}) {
  lootCanRoll = Boolean(loot.can_roll);
  const badge = $("#lootReadyBadge");
  if (badge) {
    badge.textContent = lootCanRoll ? "Loot ready to roll" : "Loot not ready";
    badge.className = `loot-badge ${lootCanRoll ? "ready" : "cooldown"}`;
  }
  const last = $("#lootLastRoll");
  const next = $("#lootNextRoll");
  if (last) last.textContent = fmtUnix(loot.last_roll);
  if (next) next.textContent = loot.next_roll ? fmtUnix(loot.next_roll) : (lootCanRoll ? "Ready now" : "—");
  const dot = $(".loot-dot");
  if (dot) dot.hidden = !lootCanRoll;
  syncLootRollButton();
  if ($("#lootTrack") && !$("#lootTrack").children.length) seedLootReel();
}

let lootAudioCtx = null;
let lootNoiseBuffer = null;

function getLootAudio() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!lootAudioCtx) lootAudioCtx = new AudioCtx();
  if (lootAudioCtx.state === "suspended") lootAudioCtx.resume();
  return lootAudioCtx;
}

function lootNoise(ctx) {
  if (!lootNoiseBuffer || lootNoiseBuffer.sampleRate !== ctx.sampleRate) {
    lootNoiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = lootNoiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return lootNoiseBuffer;
}

function lootNoiseBurst(ctx, time, { duration = 0.03, freq = 2000, q = 2.4, gain = 0.16, type = "bandpass", freqEnd } = {}) {
  const src = ctx.createBufferSource();
  src.buffer = lootNoise(ctx);
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(freq, time);
  if (freqEnd) filter.frequency.exponentialRampToValueAtTime(freqEnd, time + duration);
  filter.Q.value = q;
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(Math.max(gain, 0.0001), time);
  amp.gain.exponentialRampToValueAtTime(0.0001, time + duration);
  src.connect(filter);
  filter.connect(amp);
  amp.connect(ctx.destination);
  src.start(time);
  src.stop(time + duration + 0.02);
}

function playLootOpen() {
  const ctx = getLootAudio();
  if (!ctx) return;
  const t = ctx.currentTime;
  lootNoiseBurst(ctx, t, { duration: 0.08, freq: 240, freqEnd: 90, q: 0.8, gain: 0.18, type: "lowpass" });
  lootNoiseBurst(ctx, t + 0.02, { duration: 0.04, freq: 1800, q: 2.2, gain: 0.08 });
}

function playLootTick() {
  const ctx = getLootAudio();
  if (!ctx) return;
  const t = ctx.currentTime;
  lootNoiseBurst(ctx, t, { duration: 0.022, freq: 2650 + Math.random() * 350, q: 4.6, gain: 0.2 });
  lootNoiseBurst(ctx, t, { duration: 0.016, freq: 380, q: 0.9, gain: 0.1, type: "lowpass" });
}

function playLootReveal(rarity) {
  const ctx = getLootAudio();
  if (!ctx) return;
  const t = ctx.currentTime;
  lootNoiseBurst(ctx, t, { duration: 0.16, freq: 700, freqEnd: 2800, q: 0.7, gain: 0.1, type: "lowpass" });

  const knock = ctx.createOscillator();
  const knockGain = ctx.createGain();
  knock.type = "sine";
  knock.frequency.setValueAtTime(72, t);
  knock.frequency.exponentialRampToValueAtTime(38, t + 0.14);
  knockGain.gain.setValueAtTime(0.16, t);
  knockGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
  knock.connect(knockGain);
  knockGain.connect(ctx.destination);
  knock.start(t);
  knock.stop(t + 0.18);

  const bells = rarity === "gold"
    ? [987.8, 1480, 1975.5]
    : rarity === "covert"
      ? [880, 1318.5]
      : [830.6, 1244.5];
  bells.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.97, t + 0.45);
    filter.type = "lowpass";
    filter.frequency.value = 2400;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.07 / (i + 1), t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.58);
  });
}

function watchLootTicks(track, windowEl, ticking) {
  let last = -1;
  const stride = LOOT_ITEM_W + LOOT_GAP;
  const step = () => {
    if (ticking.stop) return;
    const transform = getComputedStyle(track).transform;
    let x = 0;
    if (transform && transform !== "none") {
      const parts = transform.match(/matrix\(([^)]+)\)/);
      if (parts) x = Number(parts[1].split(",")[4]) || 0;
    }
    const center = windowEl.clientWidth / 2 - x;
    const idx = Math.floor((center - 10) / stride);
    if (idx !== last && idx >= 0) {
      last = idx;
      playLootTick();
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function spinLootTrack(winIndex) {
  const track = $("#lootTrack");
  const windowEl = $(".loot-window");
  if (!track || !windowEl) return Promise.resolve();
  const stride = LOOT_ITEM_W + LOOT_GAP;
  const itemCenter = 10 + winIndex * stride + LOOT_ITEM_W / 2;
  const jitter = (Math.random() - 0.5) * 36;
  const x = windowEl.clientWidth / 2 - itemCenter + jitter;
  track.style.transition = "none";
  track.style.transform = "translateX(40px)";
  void track.offsetWidth;
  const ticking = { stop: false };
  watchLootTicks(track, windowEl, ticking);
  return new Promise(resolve => {
    const finish = () => {
      ticking.stop = true;
      track.removeEventListener("transitionend", finish);
      resolve();
    };
    track.addEventListener("transitionend", finish);
    requestAnimationFrame(() => {
      track.style.transition = "transform 5.6s cubic-bezier(0.12, 0.82, 0.08, 1)";
      track.style.transform = `translateX(${x}px)`;
    });
    setTimeout(finish, 5800);
  });
}

async function refreshLootFromWidget() {
  if (!window.pywebview?.api?.get_forum_widget) return;
  try {
    const result = await window.pywebview.api.get_forum_widget();
    if (result?.ok) renderLoot(result.data.loot || {});
  } catch { /* keep current loot state */ }
}

async function rollLoot() {
  const simulate = lootSimulateOn();
  if (lootBusy || (!simulate && !lootCanRoll)) return;
  const btn = $("#rollLootBtn");
  const resultEl = $("#lootResult");
  const stage = $("#lootStage");
  lootBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = simulate ? "Simulating…" : "Opening…"; }
  if (resultEl) { resultEl.classList.remove("win"); resultEl.textContent = simulate ? "Simulating crate…" : "Opening crate…"; }
  stage?.classList.add("rolling");
  getLootAudio();
  playLootOpen();

  try {
    if (!window.pywebview?.api?.roll_loot) throw new Error("Desktop app only");
    const response = await window.pywebview.api.roll_loot(simulate);
    const message = response?.message || response?.data?.message || "Loot roll failed";
    if (!response?.ok && !response?.success) throw new Error(message);

    const latest = Array.isArray(response?.history) ? response.history[0] : null;
    const prize = parseLootPrize(message, `${message}|${latest?.rolledAt ?? ""}|${latest?.id ?? ""}`);
    const reel = Array.from({ length: LOOT_WIN_INDEX + 8 }, pickLootFiller);
    reel[LOOT_WIN_INDEX] = prize;
    fillLootTrack(reel);

    if (document.body.classList.contains("reduce-motion")) {
      $("#lootTrack")?.children[LOOT_WIN_INDEX]?.classList.add("winner");
    } else {
      await spinLootTrack(LOOT_WIN_INDEX);
      $("#lootTrack")?.children[LOOT_WIN_INDEX]?.classList.add("winner");
    }
    playLootReveal(prize.rarity);

    if (resultEl) {
      resultEl.classList.add("win");
      resultEl.textContent = prize.subtitle || message;
    }
    renderLootHistory(Array.isArray(response?.history) ? response.history : null);
    if (!Array.isArray(response?.history)) await loadLootHistory();
    await refreshLootFromWidget();
  } catch (error) {
    if (resultEl) {
      resultEl.classList.remove("win");
      resultEl.textContent = error?.message || "Could not roll loot";
    }
  } finally {
    lootBusy = false;
    stage?.classList.remove("rolling");
    syncLootRollButton();
  }
}

function renderLootHistory(rows) {
  if (rows == null) return;
  const list = $("#lootHistoryList");
  const count = $("#lootHistoryCount");
  const items = Array.isArray(rows) ? rows : [];
  if (count) count.textContent = items.length === 1 ? "1 roll" : `${items.length} rolls`;
  if (!list) return;
  if (!items.length) {
    list.innerHTML = `<p class="loot-history-empty">No rolls yet. Open a crate to start a history.</p>`;
    return;
  }
  list.innerHTML = items.map((row) => {
    const prize = parseLootPrize(row.message, `${row.message}|${row.rolledAt}|${row.id}`);
    const sim = Boolean(row.simulate);
    const subtitle = prize.subtitle && prize.subtitle !== prize.title ? prize.subtitle : "";
    const when = Number(row.rolledAt) ? new Date(Number(row.rolledAt) * 1000).toISOString() : "";
    return `<div class="loot-history-row">
      <span class="loot-history-kind ${sim ? "sim" : "live"}">${sim ? "SIM" : "LIVE"}</span>
      <div>
        <strong class="${esc(prize.rarity)}">${esc(prize.title)}</strong>
        ${subtitle ? `<small>${esc(subtitle)}</small>` : ""}
      </div>
      <time datetime="${esc(when)}">${esc(fmtUnix(row.rolledAt))}</time>
    </div>`;
  }).join("");
}

async function loadLootHistory() {
  if (!window.pywebview?.api?.get_loot_history) return;
  try {
    const result = await window.pywebview.api.get_loot_history();
    if (result?.ok) renderLootHistory(result.data || []);
  } catch { /* keep current history */ }
}

function bindLoot() {
  const btn = $("#rollLootBtn");
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", rollLoot);
  seedLootReel();
  loadLootHistory();
}

let steamInventory = null;
let steamInvFilter = "all";
let steamInvSort = "newest";
let steamInvBusy = false;
let steamInvCooldownUntil = 0;
let steamInvCooldownTimer = 0;
let steamInvLiveOk = false;
let steamInvAutoTried = false;
let csfloatPollTimer = 0;
let invValueTimer = 0;
let csfloatAuthToast = false;
let openInvItemId = "";
let invValueHistory = [];

const INV_RARITY_RANK = {
  gold: 0, covert: 1, classified: 2, restricted: 3, milspec: 4, industrial: 5, consumer: 6, other: 7
};

function invRarityOf(item) {
  const blob = `${item?.rarityName || ""} ${item?.type || ""} ${item?.name || ""}`;
  const key = blob.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (key.includes("highgrade")) return "milspec";
  if (key.includes("remarkable")) return "restricted";
  if (key.includes("exotic")) return "classified";
  if (key.includes("sticker") && key.includes("extraordinary")) return "covert";
  if (item?.rarity && item.rarity !== "other") return item.rarity;
  if (key.includes("extraordinary") || key.includes("contraband")) return "gold";
  return item?.rarity || "other";
}

function stickerRarityOf(sticker) {
  if (sticker?.rarity) return sticker.rarity;
  const name = String(sticker?.name || "");
  const low = name.toLowerCase();
  if (/\(gold\)/.test(low)) return "covert";
  if (/\(holo\)|\(foil\)|\(lenticular\)/.test(low)) return "classified";
  if (/\(glitter\)/.test(low)) return "restricted";
  const needle = low.replace(/^sticker\s*\|\s*/, "");
  const owned = (steamInventory?.items || []).find(item => {
    if (item.category !== "stickers") return false;
    const other = String(item.name || item.shortName || "").toLowerCase().replace(/^sticker\s*\|\s*/, "");
    return other === needle || other === low;
  });
  return owned ? invRarityOf(owned) : "";
}

function invCacheReady(data) {
  if (!data || !Array.isArray(data.items) || data.error) return false;
  if (data.complete === true) return true;
  const total = Number(data.total) || 0;
  const count = data.items.length;
  if (data.fetchedAt && total === 0 && count === 0) return true;
  if (total && count < total) return false;
  return count > 0;
}

function invAssetRank(id) {
  const text = String(id || "0");
  try {
    return BigInt(text);
  } catch {
    return 0n;
  }
}

function sortInventoryItems(items) {
  const rows = items.slice();
  const nameOf = item => String(item.shortName || item.name || "").toLowerCase();
  if (steamInvSort === "name") {
    rows.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  } else if (steamInvSort === "name-desc") {
    rows.sort((a, b) => nameOf(b).localeCompare(nameOf(a)));
  } else if (steamInvSort === "type") {
    rows.sort((a, b) => {
      const type = String(a.type || a.category || "").localeCompare(String(b.type || b.category || ""));
      return type || nameOf(a).localeCompare(nameOf(b));
    });
  } else if (steamInvSort === "newest") {
    rows.sort((a, b) => {
      const delta = invAssetRank(b.id) - invAssetRank(a.id);
      return delta > 0n ? 1 : delta < 0n ? -1 : 0;
    });
  } else if (steamInvSort === "price") {
    rows.sort((a, b) => {
      const pa = Number.isFinite(Number(a.priceCents)) ? Number(a.priceCents) : -1;
      const pb = Number.isFinite(Number(b.priceCents)) ? Number(b.priceCents) : -1;
      return pb - pa || nameOf(a).localeCompare(nameOf(b));
    });
  } else {
    rows.sort((a, b) => {
      const rarity = (INV_RARITY_RANK[invRarityOf(a)] ?? 9) - (INV_RARITY_RANK[invRarityOf(b)] ?? 9);
      return rarity || nameOf(a).localeCompare(nameOf(b));
    });
  }
  return rows;
}

function invQuery() {
  return String($("#invSearch")?.value || "").trim().toLowerCase();
}

function applyInvCooldown(seconds) {
  const sec = Math.max(0, Number(seconds) || 0);
  steamInvCooldownUntil = sec > 0 ? Date.now() + sec * 1000 : 0;
  if (steamInvCooldownTimer) {
    clearInterval(steamInvCooldownTimer);
    steamInvCooldownTimer = 0;
  }
  if (sec > 0) steamInvCooldownTimer = setInterval(syncInvRefreshBtn, 15000);
  syncInvRefreshBtn();
}

function syncInvRefreshBtn() {
  const btn = $("#invRefresh");
  if (!btn) return;
  const left = steamInvCooldownUntil - Date.now();
  if (steamInvBusy) {
    btn.disabled = true;
    btn.textContent = "Loading…";
    return;
  }
  if (left > 0) {
    const mins = Math.max(1, Math.ceil(left / 60000));
    btn.disabled = true;
    btn.textContent = mins >= 60 ? `Wait ${Math.ceil(mins / 60)}h` : `Wait ${mins}m`;
    return;
  }
  if (steamInvCooldownTimer) {
    clearInterval(steamInvCooldownTimer);
    steamInvCooldownTimer = 0;
  }
  btn.disabled = false;
  btn.textContent = "Refresh";
}

function paintSteamInventory() {
  const summary = $("#invSummary");
  const status = $("#invStatus");
  const grid = $("#invGrid");
  if (!summary || !grid) return;
  const items = Array.isArray(steamInventory?.items) ? steamInventory.items : [];
  const query = invQuery();
  const filtered = sortInventoryItems(items.filter(item => {
    const cat = item.category || "other";
    if (steamInvFilter === "other") {
      if (["weapons", "knives", "gloves", "agents", "stickers", "cases"].includes(cat)) return false;
    } else if (steamInvFilter !== "all" && cat !== steamInvFilter) {
      return false;
    }
    if (!query) return true;
    const hay = `${item.name || ""} ${item.shortName || ""} ${item.weapon || ""} ${item.type || ""}`.toLowerCase();
    return hay.includes(query);
  }));
  const steam64 = steamInventory?.steam64 || memberConfig.steam64 || "";
  const stats = inventoryValueCents(items);
  const valueLabel = stats.priced ? formatUsdCents(stats.cents) : (stats.pending ? "…" : "—");
  summary.innerHTML = [
    ["Est. value", valueLabel, "invEstValue"],
    ["Items", steamInventory ? String(steamInventory.count ?? items.length) : "—"],
    ["Showing", steamInventory ? String(filtered.length) : "—"],
    ["Steam ID", steam64 || "—"]
  ].map(([l, v, id]) => `<div><span>${l}</span><strong${id ? ` id="${esc(id)}"` : ""}>${esc(v)}</strong></div>`).join("");
  paintInvValueChart();
  if (steamInvBusy) {
    status.textContent = "Loading inventory…";
    if (!items.length) grid.innerHTML = "";
    return;
  }
  if (!steamInventory) {
    status.textContent = steamInvCooldownUntil > Date.now()
      ? "Steam is still rate-limiting. Wait for the button, then Refresh once."
      : "Inventory will load from Steam if you have not saved one yet.";
    grid.innerHTML = "";
    return;
  }
  if (steamInventory.error) {
    status.textContent = steamInventory.error;
    grid.innerHTML = "";
    return;
  }
  const when = steamInventory.fetchedAt ? new Date(steamInventory.fetchedAt).toLocaleString() : "";
  status.textContent = filtered.length
    ? `${filtered.length} item${filtered.length === 1 ? "" : "s"}${when ? ` · saved ${when}` : ""}. Hit Refresh to update.`
    : (items.length ? "No items match that filter." : "This inventory is empty. Hit Refresh to check again.");
  if (!filtered.length) {
    grid.innerHTML = `<article class="inv-card is-empty">${items.length ? "Nothing matches." : "No CS2 items."}</article>`;
    return;
  }
  grid.innerHTML = filtered.map(item => {
    const extra = [item.exterior, item.statTrak ? "StatTrak" : "", item.souvenir ? "Souvenir" : "", item.amount > 1 ? `x${item.amount}` : ""]
      .filter(Boolean).join(" · ");
    const img = item.icon
      ? `<img src="${esc(item.icon)}" alt="" loading="lazy">`
      : "";
    const price = invPriceLabel(item);
    const trade = item.tradable
      ? `<em class="inv-trade is-yes">Tradable</em>`
      : `<em class="inv-trade is-no">Not tradable</em>`;
    return `<article class="inv-card ${esc(invRarityOf(item))}" data-inv-id="${esc(item.id)}" role="button" tabindex="0">
      ${img}
      <span>${esc(item.rarityName || item.category || "item")}${extra ? ` · ${esc(extra)}` : ""}</span>
      <strong>${esc(item.shortName || item.name || "Unknown")}</strong>
      <b class="inv-price${invPriceClass(item)}">${esc(price)}</b>
      ${trade}
    </article>`;
  }).join("");
}

function invItemById(id) {
  const key = String(id || "");
  return (steamInventory?.items || []).find(item => String(item.id) === key) || null;
}

function invIconLarge(item) {
  const hasStickers = Array.isArray(item?.stickers) && item.stickers.length;
  const raw = String((hasStickers ? item?.icon : item?.iconLarge) || item?.iconLarge || item?.icon || "");
  return raw.replace(/\/\d+f?x\d+f?(?:\?.*)?$/i, "") || raw;
}

function formatInvWear(value) {
  if (value == null || value === "") return "";
  const wear = Number(value);
  if (!Number.isFinite(wear) || wear < 0 || wear > 1) return "";
  if (wear === 0) return "";
  return wear.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function formatUsdCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n / 100);
}

function inventoryValueCents(items) {
  let cents = 0;
  let priced = 0;
  let pending = 0;
  (items || []).forEach(item => {
    const amount = Number(item.amount) > 0 ? Number(item.amount) : 1;
    if (item.priceCents != null && Number.isFinite(Number(item.priceCents))) {
      cents += Number(item.priceCents) * amount;
      priced += amount;
    } else if (item.priceState === "pending") {
      pending += amount;
    }
  });
  return { cents, priced, pending };
}

function invValueAxisLabel(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n >= 100 ? 0 : 2
  }).format(n);
}

function invHistoryLabel(points, index) {
  const point = points[index];
  if (!point) return "";
  const at = new Date(Number(point.at) * 1000);
  if (!Number.isFinite(at.getTime())) return "";
  const first = Number(points[0]?.at) || 0;
  const last = Number(points[points.length - 1]?.at) || first;
  if (last - first > 48 * 3600) {
    return at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return at.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function paintInvValueHud() {
  const stats = inventoryValueCents(steamInventory?.items || []);
  const label = stats.priced ? formatUsdCents(stats.cents) : (stats.pending ? "…" : "—");
  const nowEl = $("#invValueNow");
  if (nowEl) nowEl.textContent = label;
  const est = $("#invEstValue");
  if (est) est.textContent = label;
  const deltaEl = $("#invValueDelta");
  if (!deltaEl) return;
  const last = invValueHistory[invValueHistory.length - 1];
  const prev = invValueHistory.length >= 2 ? invValueHistory[invValueHistory.length - 2] : null;
  const live = stats.priced ? stats.cents : last?.cents;
  if (prev == null || live == null || live === prev.cents) {
    deltaEl.hidden = true;
    deltaEl.textContent = "";
    return;
  }
  const diff = live - prev.cents;
  deltaEl.hidden = false;
  deltaEl.textContent = `${diff > 0 ? "+" : "−"}${formatUsdCents(Math.abs(diff))}`;
  deltaEl.className = `trend ${diff > 0 ? "positive" : "negative"}`;
}

function invChartRows() {
  const rows = invValueHistory.slice();
  const stats = inventoryValueCents(steamInventory?.items || []);
  if (!stats.priced) return rows;
  const last = rows[rows.length - 1];
  if (!last) {
    rows.push({ at: Date.now() / 1000, cents: stats.cents });
    return rows;
  }
  if (Number(last.cents) === stats.cents) return rows;
  rows.push({ at: Date.now() / 1000, cents: stats.cents });
  return rows;
}

function paintInvValueChart(points) {
  if (Array.isArray(points)) invValueHistory = points.slice();
  paintInvValueHud();
  const el = $("#invValueChart");
  if (!el || typeof Chart === "undefined") return;
  const rows = invChartRows();
  const labels = rows.map((_, i) => invHistoryLabel(rows, i));
  const data = rows.map(row => (Number(row.cents) || 0) / 100);
  const radius = rows.length ? 4 : 0;
  if (charts.invValueChart) {
    charts.invValueChart.data.labels = labels;
    charts.invValueChart.data.datasets[0].data = data;
    charts.invValueChart.data.datasets[0].pointRadius = radius;
    charts.invValueChart.update("none");
    return;
  }
  charts.invValueChart = new Chart(el, {
    type: "line",
    data: {
      labels,
      datasets: [{
        data,
        borderColor: reactionStroke,
        borderWidth: 1.6,
        pointRadius: radius,
        pointHoverRadius: 5,
        pointHitRadius: 10,
        pointHoverBackgroundColor: () => cssAccent(),
        fill: true,
        backgroundColor: lineGradient,
        tension: .35
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 650 },
      layout: { padding: { top: 10, right: 12, left: 4, bottom: 4 } },
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipOptions(""),
          callbacks: {
            title: items => {
              const index = items[0]?.dataIndex;
              return Number.isInteger(index) ? invHistoryLabel(invChartRows(), index) : "";
            },
            label: context => invValueAxisLabel(context.raw)
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 6, color: "#46535e" } },
        y: {
          border: { display: false },
          grace: "12%",
          grid: { color: "rgba(148,163,184,.07)" },
          ticks: { callback: v => invValueAxisLabel(v), maxTicksLimit: 5 }
        }
      }
    }
  });
}

async function loadInvValueHistory() {
  const api = window.pywebview?.api;
  if (!api?.get_inventory_value_history && !api?.get_csfloat_prices) {
    paintInvValueChart(invValueHistory);
    return;
  }
  try {
    const result = api.get_inventory_value_history
      ? await api.get_inventory_value_history()
      : await api.get_csfloat_prices();
    const history = result?.ok ? result.data?.history : null;
    paintInvValueChart(Array.isArray(history) ? history : invValueHistory);
  } catch {
    paintInvValueChart(invValueHistory);
  }
}

async function tickInvPricesAndValue() {
  await loadInvValueHistory();
  if (!window.pywebview?.api?.get_csfloat_prices) return;
  await pullCsfloatPrices();
  if (inventoryHasPendingPrices()) startCsfloatPoll();
}

function startInvValueWatch() {
  tickInvPricesAndValue();
  if (invValueTimer) return;
  invValueTimer = setInterval(tickInvPricesAndValue, 60000);
}

function invPriceLabel(item) {
  if (item?.priceCents != null && Number.isFinite(Number(item.priceCents))) {
    return formatUsdCents(item.priceCents);
  }
  if (item?.priceState === "none") return "No listing";
  if (item?.priceState === "pending") return "…";
  return "";
}

function invPriceClass(item) {
  if (item?.priceCents != null && Number.isFinite(Number(item.priceCents))) return "";
  if (item?.priceState === "pending") return " is-pending";
  if (item?.priceState === "none") return " is-none";
  return " is-empty";
}

function invPriceFactHtml(item) {
  const hasCents = item?.priceCents != null && Number.isFinite(Number(item.priceCents));
  const label = hasCents
    ? formatUsdCents(item.priceCents)
    : item?.priceState === "none"
      ? "No buy-now listing"
      : item?.priceState === "pending"
        ? "Looking up…"
        : "";
  if (!label) return "";
  return `<div><span>Est. price</span><strong id="invItemPrice">${esc(label)}</strong></div>`;
}

function invCsfloatUrl(item) {
  if (item?.priceListingId) return `https://csfloat.com/item/${encodeURIComponent(String(item.priceListingId))}`;
  const name = String(item?.name || "").trim();
  if (!name || item?.marketable === false) return "";
  const params = new URLSearchParams({
    sort_by: "lowest_price",
    type: "buy_now",
    market_hash_name: name
  });
  if (["weapons", "knives", "gloves"].includes(String(item?.category || ""))) {
    if (item?.souvenir) params.set("category", "3");
    else if (item?.statTrak) params.set("category", "2");
  }
  return `https://csfloat.com/search?${params.toString()}`;
}

function inventoryHasPendingPrices() {
  return (steamInventory?.items || []).some(item => item?.priceState === "pending");
}

function stopCsfloatPoll() {
  if (!csfloatPollTimer) return;
  clearInterval(csfloatPollTimer);
  csfloatPollTimer = 0;
}

function startCsfloatPoll() {
  if (!window.pywebview?.api?.get_csfloat_prices) return;
  if (csfloatPollTimer) {
    pullCsfloatPrices();
    return;
  }
  csfloatPollTimer = setInterval(pullCsfloatPrices, 2000);
  pullCsfloatPrices();
}

function paintInvCardPrices() {
  $$("#invGrid .inv-card[data-inv-id]").forEach(card => {
    const item = invItemById(card.dataset.invId);
    const el = card.querySelector(".inv-price");
    if (!item || !el) return;
    el.textContent = invPriceLabel(item);
    el.className = `inv-price${invPriceClass(item)}`;
  });
  paintInvValueChart();
  const priceEl = $("#invItemPrice");
  if (!priceEl || !openInvItemId) return;
  const item = invItemById(openInvItemId);
  if (!item) return;
  const label = item.priceCents != null && Number.isFinite(Number(item.priceCents))
    ? formatUsdCents(item.priceCents)
    : item.priceState === "none"
      ? "No buy-now listing"
      : item.priceState === "pending"
        ? "Looking up…"
        : "";
  if (label) priceEl.textContent = label;
}

async function pullCsfloatPrices() {
  const api = window.pywebview?.api;
  if (!api?.get_csfloat_prices) {
    stopCsfloatPoll();
    return;
  }
  try {
    const result = await api.get_csfloat_prices();
    const data = result?.ok ? result.data : null;
    if (!data) return;
    if (data.authError && !csfloatAuthToast) {
      csfloatAuthToast = true;
      showToast("CSFloat API key is invalid. Update it in Settings.");
      stopCsfloatPoll();
      return;
    }
    const prices = data.prices || {};
    let changed = false;
    (steamInventory?.items || []).forEach(item => {
      const row = prices[item.name];
      if (!row) return;
      if (item.priceCents !== row.cents || item.priceState !== row.state || item.priceListingId !== (row.listingId || "")) {
        item.priceCents = row.cents;
        item.priceState = row.state;
        item.priceListingId = row.listingId || "";
        changed = true;
      }
    });
    if (Array.isArray(data.history)) paintInvValueChart(data.history);
    if (changed) {
      if (steamInvSort === "price") paintSteamInventory();
      else paintInvCardPrices();
    } else {
      paintInvValueHud();
      paintInvValueChart();
    }
    const pending = Number(data.pending) || 0;
    if (pending <= 0 && !inventoryHasPendingPrices()) stopCsfloatPoll();
  } catch {
    /* keep polling while the worker may still be filling prices */
  }
}

async function syncInventoryPrices() {
  const api = window.pywebview?.api;
  if (!api?.get_cs2_inventory) {
    startCsfloatPoll();
    return;
  }
  if (!steamInventory?.items) {
    startCsfloatPoll();
    return;
  }
  try {
    const result = await api.get_cs2_inventory(JSON.stringify({ force: false }));
    if (result?.ok && Array.isArray(result.data?.items)) {
      steamInventory = result.data;
      paintSteamInventory();
      if (openInvItemId) openInvItem(openInvItemId);
    }
  } catch { /* ignore */ }
  if (inventoryHasPendingPrices()) startCsfloatPoll();
  else stopCsfloatPoll();
}

function invInspectUrl(item) {
  const href = String(item?.inspect || "").trim();
  if (!href || /%propid:|%owner_steamid%|%assetid%/i.test(href)) return "";
  return href;
}

function invFact(label, value, tone) {
  const text = value == null ? "" : String(value).trim();
  if (!text) return "";
  const klass = tone ? ` class="${esc(tone)}"` : "";
  return `<div><span>${esc(label)}</span><strong${klass}>${esc(text)}</strong></div>`;
}

function loadInvHero(root) {
  const img = root?.querySelector(".inv-item-hero img");
  if (!img) return;
  const full = String(img.dataset.full || "").trim();
  const current = String(img.getAttribute("src") || "");
  if (!full || full === current) {
    img.classList.remove("is-loading");
    return;
  }
  const hi = new Image();
  hi.onload = () => {
    if (img.dataset.full !== full) return;
    img.src = full;
    img.classList.remove("is-loading");
  };
  hi.onerror = () => img.classList.remove("is-loading");
  hi.src = full;
}

function invMarketUrl(item) {
  const name = String(item?.name || "").trim();
  if (!name || item?.marketable === false) return "";
  return `https://steamcommunity.com/market/listings/730/${encodeURIComponent(name)}`;
}

function invSteamUrl(item) {
  const steam64 = steamInventory?.steam64 || memberConfig.steam64 || "";
  const id = String(item?.id || "");
  if (!steam64 || !id) return "";
  return `https://steamcommunity.com/profiles/${steam64}/inventory/#730_2_${id}`;
}

async function openInvLink(url) {
  const href = String(url || "").trim();
  if (!href) return;
  if (window.pywebview?.api?.open_url) {
    try {
      const result = await window.pywebview.api.open_url(href);
      if (result?.ok) return;
    } catch { /* fall through */ }
  }
  window.open(href, "_blank", "noopener");
}

function closeInvItem() {
  openInvItemId = "";
  const overlay = $("#invItemModal");
  if (!overlay) return;
  overlay.classList.remove("open");
  overlay.hidden = true;
}

function openInvItem(id) {
  const item = invItemById(id);
  const overlay = $("#invItemModal");
  const body = $("#invItemBody");
  if (!item || !overlay || !body) return;
  openInvItemId = String(item.id || id || "");
  const title = $("#invItemTitle");
  const kicker = $("#invItemKicker");
  if (title) title.textContent = item.shortName || item.name || "Item";
  if (kicker) kicker.textContent = item.type || item.category || "ITEM";
  const rarity = invRarityOf(item);
  const flags = [item.statTrak ? "StatTrak" : "", item.souvenir ? "Souvenir" : "", item.nametag ? `"${item.nametag}"` : ""]
    .filter(Boolean).join(" · ");
  const thumb = item.icon || "";
  const image = invIconLarge(item) || thumb;
  const facts = [
    invFact("Rarity", item.rarityName, rarity),
    invFact("Exterior", item.exterior),
    invPriceFactHtml(item),
    invFact("Weapon", item.weapon),
    invFact("Quality", item.quality),
    invFact("Wear", formatInvWear(item.wear)),
    invFact("Pattern", Number.isFinite(Number(item.pattern)) && item.pattern != null ? String(item.pattern) : ""),
    invFact("Collection", item.collection),
    invFact("Tournament", item.tournament),
    invFact("Team", item.team),
    invFact("Amount", item.amount > 1 ? `x${item.amount}` : ""),
    invFact("Tradable", item.tradable ? "Yes" : "No", item.tradable ? "is-yes" : "is-no"),
    invFact("Marketable", item.marketable ? "Yes" : "No", item.marketable ? "is-yes" : "is-no")
  ].join("");
  const stickers = Array.isArray(item.stickers) ? item.stickers.filter(sticker => sticker?.name || sticker?.icon) : [];
  const contents = Array.isArray(item.contents) ? item.contents.filter(row => row?.name) : [];
  const listed = new Set(contents.map(row => String(row.name).toLowerCase()));
  const notes = (Array.isArray(item.notes) ? item.notes.filter(Boolean) : []).filter(note => {
    if (/contains one of the following/i.test(note)) return false;
    if (listed.has(note.toLowerCase())) return false;
    if (contents.length && (note.includes("|") || /exceedingly rare/i.test(note))) return false;
    return true;
  });
  const inspect = invInspectUrl(item);
  const market = invMarketUrl(item);
  const steam = invSteamUrl(item);
  const csfloat = invCsfloatUrl(item);
  const loading = thumb && image && image !== thumb ? " is-loading" : "";
  body.innerHTML = `
    ${image ? `<div class="inv-item-hero ${esc(rarity)}"><img class="inv-item-img${loading}" src="${esc(thumb || image)}" ${thumb && image !== thumb ? `data-full="${esc(image)}"` : ""} alt=""></div>` : ""}
    ${flags ? `<p class="inv-item-notes"><strong>${esc(flags)}</strong></p>` : ""}
    ${facts ? `<div class="inv-item-facts">${facts}</div>` : ""}
    ${stickers.length ? `<div>
      <p class="inv-item-stickers-label">Stickers</p>
      <div class="inv-item-stickers">${stickers.map(sticker => `
      <div class="inv-item-sticker">
        ${sticker.icon ? `<img src="${esc(sticker.icon)}" alt="">` : ""}
        <span class="${esc(stickerRarityOf(sticker))}">${esc(sticker.name || "Sticker")}</span>
      </div>`).join("")}</div>
    </div>` : ""}
    ${contents.length ? `<div>
      <p class="inv-item-stickers-label">Contains</p>
      <div class="inv-item-contents">${contents.map(row => `<p class="${esc(row.rarity || "")}">${esc(row.name)}</p>`).join("")}</div>
    </div>` : ""}
    ${notes.length ? `<div class="inv-item-notes">${notes.map(note => `<p>${esc(note)}</p>`).join("")}</div>` : ""}
    ${inspect || market || steam || csfloat ? `<div class="inv-item-links">
      ${inspect ? `<button type="button" class="settings-save" data-inv-link="${esc(inspect)}">Inspect in game</button>` : ""}
      ${market ? `<button type="button" class="reset-btn" data-inv-link="${esc(market)}">Steam market</button>` : ""}
      ${steam ? `<button type="button" class="reset-btn" data-inv-link="${esc(steam)}">Open on Steam</button>` : ""}
      ${csfloat ? `<button type="button" class="reset-btn" data-inv-link="${esc(csfloat)}">CSFloat</button>` : ""}
    </div>` : ""}`;
  overlay.hidden = false;
  requestAnimationFrame(() => {
    overlay.classList.add("open");
    loadInvHero(body);
  });
}

function maybeFillInventory() {
  if (steamInvAutoTried || steamInvLiveOk || steamInvBusy) return;
  if (steamInvCooldownUntil > Date.now()) return;
  if (invCacheReady(steamInventory)) {
    steamInvLiveOk = true;
    return;
  }
  steamInvAutoTried = true;
  loadSteamInventory(true);
}

async function loadSteamInventory(force = false) {
  const api = window.pywebview?.api;
  if (!api?.get_cs2_inventory) {
    paintSteamInventory();
    return;
  }
  if (steamInvBusy) return;
  if (force && steamInvCooldownUntil > Date.now()) {
    showToast("Steam is still rate-limiting. Wait for the timer, then Refresh once.");
    paintSteamInventory();
    return;
  }
  if (!force && steamInventory && !steamInventory.error) {
    paintSteamInventory();
    maybeFillInventory();
    if (inventoryHasPendingPrices()) startCsfloatPoll();
    return;
  }
  const keep = steamInventory && !steamInventory.error ? steamInventory : null;
  steamInvBusy = true;
  syncInvRefreshBtn();
  paintSteamInventory();
  try {
    const result = await api.get_cs2_inventory(JSON.stringify({ force: Boolean(force) }));
    applyInvCooldown(result?.cooldown);
    if (!result?.ok) {
      showToast(result?.error || "Could not load inventory");
      if (!keep) {
        steamInventory = { items: [], error: result?.error || "Could not load inventory", steam64: memberConfig.steam64 || "" };
      }
    } else if (result.data && Array.isArray(result.data.items)) {
      steamInventory = result.data;
      if (!result.cached) steamInvLiveOk = true;
      if (result.notice) showToast(result.notice);
    } else if (!keep) {
      steamInventory = null;
    }
  } catch {
    showToast("Could not reach Steam inventory");
    if (!keep) {
      steamInventory = { items: [], error: "Could not reach Steam inventory", steam64: memberConfig.steam64 || "" };
    }
  } finally {
    steamInvBusy = false;
    syncInvRefreshBtn();
    paintSteamInventory();
    if (!force) maybeFillInventory();
    if (inventoryHasPendingPrices()) startCsfloatPoll();
    loadInvValueHistory();
  }
}

function bindInventory() {
  $("#invRefresh")?.addEventListener("click", () => loadSteamInventory(true));
  $("#invSearch")?.addEventListener("input", paintSteamInventory);
  $("#invSearch")?.addEventListener("search", paintSteamInventory);
  const sort = $("#invSort");
  if (sort) {
    steamInvSort = sort.value || "newest";
    sort.addEventListener("change", () => {
      steamInvSort = sort.value || "newest";
      syncUiSelect(sort);
      paintSteamInventory();
    });
    enhanceSelect(sort);
  }
  $$("#invFilter [data-inv]").forEach(btn => {
    btn.addEventListener("click", () => {
      steamInvFilter = btn.dataset.inv || "all";
      $$("#invFilter [data-inv]").forEach(el => el.classList.toggle("active", el === btn));
      paintSteamInventory();
    });
  });
  const grid = $("#invGrid");
  grid?.addEventListener("click", event => {
    const card = event.target.closest(".inv-card[data-inv-id]");
    if (!card) return;
    openInvItem(card.dataset.invId);
  });
  grid?.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest(".inv-card[data-inv-id]");
    if (!card) return;
    event.preventDefault();
    openInvItem(card.dataset.invId);
  });
  $("#invItemClose")?.addEventListener("click", closeInvItem);
  $("#invItemModal")?.addEventListener("click", event => {
    if (event.target.id !== "invItemModal") return;
    closeInvItem();
  });
  $("#invItemBody")?.addEventListener("click", event => {
    const link = event.target.closest("[data-inv-link]");
    if (!link) return;
    event.preventDefault();
    openInvLink(link.dataset.invLink);
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if (!$("#invItemModal")?.classList.contains("open")) return;
    event.preventDefault();
    closeInvItem();
  });
  startInvValueWatch();
}

let memberConfig = { scripts: [], libs: [], protection: null, protectionName: "", directory: "", steam64: "" };
let protectionBusy = false;

const PROTECTION_NAMES = {
  0: "Standard (usermode)",
  1: "IPC/Zombie",
  2: "Kernel Mode Protection",
  3: "Minimum (Usermode)",
  4: "Minimum (Kernel)",
  5: "Rootlink"
};

function ingestMemberConfig(member) {
  if (!member) return;
  const level = Number(member.protection);
  memberConfig = {
    scripts: mergeConfigItems(memberConfig.scripts, member.scripts),
    libs: mergeConfigItems(memberConfig.libs, member.libs),
    protection: Number.isInteger(level) && level in PROTECTION_NAMES ? level : memberConfig.protection,
    protectionName: member.protection_name || memberConfig.protectionName || "",
    directory: String(member.directory || memberConfig.directory || "").trim(),
    steam64: asSteam64(member.steam64) || memberConfig.steam64 || ""
  };
  rememberScriptUsers(memberConfig.scripts);
  rememberScriptUsers(memberConfig.libs);
  syncLaunchOmega();
  syncProtectionSelect();
  paintProfileProtection();
  if (document.querySelector(".tab-panel.active")?.id === "config") paintConfig();
}

function syncProtectionSelect() {
  const select = $("#protectionSelect");
  if (!select) return;
  if (!protectionBusy) {
    const known = Number.isInteger(memberConfig.protection);
    select.disabled = !known || !window.pywebview?.api?.set_protection;
    if (known) select.value = String(memberConfig.protection);
  }
  syncUiSelect(select);
}

function paintProfileProtection() {
  const name = memberConfig.protectionName || PROTECTION_NAMES[memberConfig.protection] || "";
  if (name && $("#profileProtection")) $("#profileProtection").textContent = name;
}

async function onProtectionChange(event) {
  const select = event.currentTarget;
  const next = Number(select.value);
  if (!Number.isInteger(next) || !(next in PROTECTION_NAMES) || next === memberConfig.protection) return;
  if (!window.pywebview?.api?.set_protection) {
    showToast("Open OmegaDash to change protection");
    syncProtectionSelect();
    return;
  }
  const previous = memberConfig.protection;
  protectionBusy = true;
  select.disabled = true;
  syncUiSelect(select);
  try {
    const result = await window.pywebview.api.set_protection(next);
    if (!result?.ok) {
      showToast(result?.error || "Could not set protection");
      memberConfig.protection = previous;
      syncProtectionSelect();
      return;
    }
    memberConfig.protection = Number(result.data?.protection ?? next);
    memberConfig.protectionName = result.data?.protection_name || PROTECTION_NAMES[next];
    paintProfileProtection();
    const panel = $("#profilePanel");
    if (panel) {
      const row = [...panel.querySelectorAll(".profile-row")].find(el => el.querySelector("span")?.textContent === "Protection");
      const strong = row?.querySelector("strong");
      if (strong) strong.textContent = memberConfig.protectionName;
    }
    showToast(`Protection set to ${memberConfig.protectionName}`);
  } catch {
    showToast("Could not set protection");
    memberConfig.protection = previous;
  } finally {
    protectionBusy = false;
    syncProtectionSelect();
  }
}

function prettyConfigKey(key) {
  return String(key || "").replace(/_/g, " ").replace(/\b\w/g, ch => ch.toUpperCase());
}

function formatConfigValue(value) {
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (value == null || value === "") return "—";
  if (typeof value === "object") {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function scriptSettings(item) {
  if (!item?.settings || typeof item.settings !== "object" || Array.isArray(item.settings)) return [];
  const entries = Object.entries(item.settings);
  const enabled = entries.filter(([key]) => key === "enabled");
  const rest = entries.filter(([key]) => key !== "enabled");
  return [...enabled, ...rest];
}

function scriptMergeKey(item) {
  const id = asCloudId(item?.id);
  if (id != null) return `id:${id}`;
  return `name:${String(item?.name || "").trim().toLowerCase()}`;
}

function mergeConfigItems(prev, next) {
  if (!Array.isArray(next)) return Array.isArray(prev) ? prev : [];
  const prevMap = new Map((prev || []).map(item => [scriptMergeKey(item), item]));
  return next.map(item => {
    const old = prevMap.get(scriptMergeKey(item));
    if (!old) return item;
    if (scriptSettings(item).length) return item;
    if (scriptSettings(old).length) {
      return { ...item, settings: old.settings, enabled: item.enabled ?? old.enabled };
    }
    return item;
  });
}

function scriptLabel(name) {
  return String(name || "").replace(/\.lua$/i, "") || "Script";
}

function cloudAuthorLine(item) {
  const author = String(item?.author || "").trim();
  const when = item?.last_update ? fmtUnix(item.last_update) : "";
  const date = when && when !== "—" ? when : "";
  if (author && date) return `${author} - ${date}`;
  return author || date;
}

function mergeCloudItem(item, owned) {
  if (!owned) return item;
  return {
    ...item,
    author: item.author || owned.author || "",
    last_update: item.last_update ?? owned.last_update,
    update_notes: item.update_notes || owned.update_notes || "",
    forums: item.forums || owned.forums || "",
    users: item.users ?? owned.users,
    enabled: item.enabled ?? owned.enabled,
    settings: item.settings || owned.settings
  };
}

function hiddenScriptKeys() {
  return Array.isArray(settings.hiddenScripts) ? settings.hiddenScripts : [];
}

function isScriptHidden(item) {
  const key = scriptMergeKey(item);
  return Boolean(key) && key !== "name:" && hiddenScriptKeys().includes(key);
}

function hiddenScriptsList() {
  return (memberConfig.scripts || []).filter(isScriptHidden);
}

function visibleScripts() {
  return (memberConfig.scripts || []).filter(item => !isScriptHidden(item));
}

function activateConfigTab(tab) {
  if (!tab) return;
  const hiddenBtn = $("#configHiddenTab");
  if (tab === "hidden" && hiddenBtn?.hidden) tab = "scripts";
  $$("#configMode button").forEach(b => b.classList.toggle("active", b.dataset.configTab === tab));
  $$("[data-config-panel]").forEach(panel => panel.classList.toggle("active", panel.dataset.configPanel === tab));
  paintConfigMeta();
  if (tab === "cloud") ensureCloudCatalog();
}

function syncHiddenTab() {
  const btn = $("#configHiddenTab");
  const has = hiddenScriptsList().length > 0;
  if (btn) btn.hidden = !has;
  if (!has && configSubTab() === "hidden") activateConfigTab("scripts");
}

function toggleHiddenScript(rawKey) {
  const key = String(rawKey || "").trim();
  if (!key || key === "name:") return;
  const next = new Set(hiddenScriptKeys());
  if (next.has(key)) next.delete(key);
  else next.add(key);
  settings.hiddenScripts = [...next];
  saveSettings();
  paintConfig();
}

let scriptEditorKey = "";
let scriptEditorSaving = false;
let scriptEditorClean = "";
let scriptShowHidden = false;
let scriptAutoSaveTimer = 0;
const scriptSavePending = new Map();
let scriptSaveDrain = null;

function scriptAutoSaveOn() {
  return Boolean(settings.scriptAutoSave);
}

function syncScriptEditorChrome() {
  const note = $(".script-edit-note");
  if (note) {
    note.textContent = scriptAutoSaveOn()
      ? "Auto save is on. Each change is pushed to Omega."
      : "Reset restores the first saved copy and pushes it to Omega.";
  }
}

function scriptSaveJob(values, key = scriptEditorKey) {
  const match = String(key || "").trim();
  const item = findConfigScript(match);
  return {
    key: match,
    id: item?.id ?? null,
    name: item?.name || "",
    settings: cloneConfigSettings(values)
  };
}

function enqueueScriptConfig(job) {
  if (!job?.key) return;
  scriptSavePending.set(job.key, job);
  drainScriptConfig();
}

function drainScriptConfig() {
  if (scriptSaveDrain) {
    return scriptSaveDrain.then(ok => {
      if (scriptSavePending.size) return drainScriptConfig().then(next => ok !== false && next);
      return ok;
    });
  }
  if (!scriptSavePending.size) return Promise.resolve(true);
  scriptSaveDrain = (async () => {
    let ok = true;
    while (scriptSavePending.size) {
      const key = scriptSavePending.keys().next().value;
      const job = scriptSavePending.get(key);
      scriptSavePending.delete(key);
      if (job && !await sendScriptConfig(job)) ok = false;
    }
    return ok;
  })().finally(() => {
    scriptSaveDrain = null;
  });
  return scriptSaveDrain;
}

function snapshotScriptEditorSave() {
  if (!scriptEditorKey) return { ok: false };
  const parsed = collectScriptEditorValues();
  if (!parsed.ok) return parsed;
  enqueueScriptConfig(scriptSaveJob(parsed.values, scriptEditorKey));
  return parsed;
}

function scheduleScriptAutoSave({ immediate = false } = {}) {
  if (!scriptAutoSaveOn() || !scriptEditorKey) return;
  clearTimeout(scriptAutoSaveTimer);
  scriptAutoSaveTimer = 0;
  if (immediate) {
    snapshotScriptEditorSave();
    return;
  }
  scriptAutoSaveTimer = setTimeout(() => snapshotScriptEditorSave(), 450);
}

function flushScriptAutoSave() {
  clearTimeout(scriptAutoSaveTimer);
  scriptAutoSaveTimer = 0;
  if (!scriptAutoSaveOn() || !scriptEditorKey) return;
  snapshotScriptEditorSave();
}

function findConfigScript(key) {
  const match = String(key || "").trim();
  if (!match || match === "name:") return null;
  return (memberConfig.scripts || []).find(item => scriptMergeKey(item) === match) || null;
}

function findConfigItem(key) {
  const match = String(key || "").trim();
  if (!match || match === "name:") return null;
  const owned = findConfigScript(match)
    || (memberConfig.libs || []).find(item => scriptMergeKey(item) === match)
    || null;
  const cloud = (cloudCatalog.scripts || []).find(item => scriptMergeKey(item) === match);
  if (owned && cloud) return mergeCloudItem(cloud, owned);
  return owned || cloud || null;
}

function closeChangelog() {
  const overlay = $("#changelogPopup");
  if (!overlay) return;
  overlay.classList.remove("open");
  overlay.hidden = true;
}

function openChangelog(key) {
  const item = findConfigItem(key);
  if (!item) return;
  const notes = String(item.update_notes || "").trim();
  const title = $("#changelogTitle");
  const body = $("#changelogBody");
  if (title) title.textContent = scriptLabel(item.name) || item.name || "Changelog";
  if (body) body.textContent = notes || "No changelog.";
  const overlay = $("#changelogPopup");
  if (!overlay) return;
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add("open"));
}

function bindChangelog() {
  $("#changelogClose")?.addEventListener("click", closeChangelog);
  $("#changelogPopup")?.addEventListener("click", event => {
    if (event.target.id !== "changelogPopup") return;
    closeChangelog();
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if (!$("#changelogPopup")?.classList.contains("open")) return;
    event.preventDefault();
    closeChangelog();
  });
}

function configFieldKind(value) {
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? "int" : "number";
  }
  if (value != null && typeof value === "object") return "json";
  return "text";
}

function hiddenFieldsFor(scriptKey = scriptEditorKey) {
  const key = String(scriptKey || "").trim();
  const map = settings.hiddenScriptFields?.[key];
  return map && typeof map === "object" && !Array.isArray(map) ? map : {};
}

function setScriptFieldHidden(field, hidden) {
  const key = String(scriptEditorKey || "").trim();
  const name = String(field || "").trim();
  if (!key || !name) return;
  const map = { ...(settings.hiddenScriptFields || {}) };
  const fields = { ...(map[key] || {}) };
  if (hidden) fields[name] = true;
  else delete fields[name];
  if (Object.keys(fields).length) map[key] = fields;
  else delete map[key];
  settings.hiddenScriptFields = map;
  saveSettings();
  applyScriptFieldVisibility();
}

function applyScriptFieldVisibility() {
  const hidden = hiddenFieldsFor();
  const show = Boolean($("#scriptShowHidden")?.checked);
  let visible = 0;
  $$("#scriptEditorBody .script-edit-item").forEach(el => {
    const field = el.dataset.scriptOption;
    const isHidden = Boolean(hidden[field]);
    el.classList.toggle("is-opt-hidden", isHidden);
    el.hidden = isHidden && !show;
    if (!el.hidden) visible += 1;
    const btn = el.querySelector("[data-hide-field]");
    if (btn) {
      btn.setAttribute("aria-pressed", String(isHidden));
      btn.title = isHidden ? "Show this option" : "Hide this option";
      btn.setAttribute("aria-label", `${isHidden ? "Show" : "Hide"} ${prettyConfigKey(field)}`);
    }
  });
  const empty = $("#scriptHiddenEmpty");
  if (empty) empty.hidden = visible > 0;
}

function hideControlIcon() {
  return `<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 10.6A3 3 0 1 0 13.4 13.4M9.9 5.1A11 11 0 0 1 12 5c6.5 0 10 7 10 7a19 19 0 0 1-3.5 4.5M6.1 6.1C3.8 7.8 2 12 2 12s3.5 7 10 7a11 11 0 0 0 4.5-1"/></svg>`;
}

function scriptEditorHideBtn(key) {
  const hidden = Boolean(hiddenFieldsFor()[key]);
  return `<button type="button" class="script-edit-hide" data-hide-field="${esc(key)}" aria-pressed="${hidden ? "true" : "false"}" title="${hidden ? "Show this option" : "Hide this option"}" aria-label="${hidden ? "Show" : "Hide"} ${esc(prettyConfigKey(key))}">
    ${hideControlIcon()}
  </button>`;
}

function scriptEditorFieldHtml(key, value) {
  const kind = configFieldKind(value);
  const label = `<span><strong>${esc(prettyConfigKey(key))}</strong><small>${esc(key)}</small></span>`;
  const hidden = Boolean(hiddenFieldsFor()[key]);
  let inner = "";
  if (kind === "bool") {
    inner = `<label class="setting-toggle">${label}<input type="checkbox" data-script-field="${esc(key)}" data-kind="bool"${value ? " checked" : ""}><i></i></label>`;
  } else if (kind === "json") {
    let text = "";
    try { text = JSON.stringify(value, null, 2); } catch { text = String(value ?? ""); }
    inner = `<label class="script-edit-row is-json">${label}<textarea data-script-field="${esc(key)}" data-kind="json" spellcheck="false">${esc(text)}</textarea></label>`;
  } else {
    const raw = value == null ? "" : String(value);
    const input = kind === "int"
      ? `<input type="number" step="1" data-script-field="${esc(key)}" data-kind="int" value="${esc(raw)}">`
      : kind === "number"
        ? `<input type="number" step="any" data-script-field="${esc(key)}" data-kind="number" value="${esc(raw)}">`
        : `<input type="text" data-script-field="${esc(key)}" data-kind="text" value="${esc(raw)}" spellcheck="false">`;
    inner = `<label class="script-edit-row">${label}${input}</label>`;
  }
  return `<div class="script-edit-item${hidden ? " is-opt-hidden" : ""}" data-script-option="${esc(key)}">${inner}${scriptEditorHideBtn(key)}</div>`;
}

function paintScriptEditor(item, { markClean = true } = {}) {
  const title = $("#scriptEditorTitle");
  const body = $("#scriptEditorBody");
  const name = scriptLabel(item?.name) || "Script";
  if (title) title.textContent = name;
  if (!body) return;
  const rows = scriptSettings(item);
  if (!rows.length) {
    body.innerHTML = `<p class="guide-empty">This script has no config fields.</p>`;
    if (markClean) markScriptEditorClean();
    return;
  }
  body.innerHTML = `
    <div class="guide-intro">
      <p class="eyebrow">SCRIPT CONFIG</p>
      <h3>${esc(name)}</h3>
      <p>${scriptAutoSaveOn()
        ? "Change the values below. Auto save pushes each edit to Omega."
        : "Change the values below. Reset restores the first saved copy and pushes it to Omega."}</p>
      <label class="setting-toggle script-show-hidden">
        <span><strong>Show hidden</strong><small>Reveal options you hid from this list</small></span>
        <input type="checkbox" id="scriptShowHidden"${scriptShowHidden ? " checked" : ""}>
        <i></i>
      </label>
    </div>
    <div class="script-edit-fields">${rows.map(([key, value]) => scriptEditorFieldHtml(key, value)).join("")}</div>
    <p class="guide-empty" id="scriptHiddenEmpty" hidden>All options are hidden. Turn on Show hidden to bring them back.</p>`;
  applyScriptFieldVisibility();
  if (markClean) markScriptEditorClean();
}

function markScriptEditorClean() {
  const parsed = collectScriptEditorValues();
  scriptEditorClean = parsed.ok ? JSON.stringify(parsed.values) : "";
}

function scriptEditorIsDirty() {
  if (!scriptEditorKey || !$("#scriptEditor")?.classList.contains("open")) return false;
  const parsed = collectScriptEditorValues();
  if (!parsed.ok) return true;
  return JSON.stringify(parsed.values) !== scriptEditorClean;
}

function closeScriptEditor() {
  const overlay = $("#scriptEditor");
  if (!overlay) return;
  clearTimeout(scriptAutoSaveTimer);
  scriptAutoSaveTimer = 0;
  overlay.classList.remove("open");
  overlay.hidden = true;
  scriptEditorKey = "";
  scriptEditorClean = "";
  scriptShowHidden = false;
  document.body.classList.remove("script-editor-open");
}

function requestCloseScriptEditor() {
  if (scriptAutoSaveOn()) {
    clearTimeout(scriptAutoSaveTimer);
    scriptAutoSaveTimer = 0;
    snapshotScriptEditorSave();
    closeScriptEditor();
    return;
  }
  if (scriptEditorSaving) return;
  if (!scriptEditorIsDirty()) {
    closeScriptEditor();
    return;
  }
  confirmUnsavedScript().then(choice => {
    if (choice === "discard") {
      closeScriptEditor();
      return;
    }
    if (choice !== "save") return;
    const parsed = collectScriptEditorValues();
    if (!parsed.ok) {
      showToast(parsed.error);
      return;
    }
    saveScriptEditorValues(parsed.values, { closeAfter: true });
  });
}

function scriptBaselineFor(key) {
  const match = String(key || "").trim();
  const stored = settings.scriptBaselines?.[match];
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  return cloneConfigSettings(stored);
}

function ensureScriptBaseline(item) {
  const key = scriptMergeKey(item);
  if (!key || key === "name:") return;
  const map = normalizeScriptBaselines(settings.scriptBaselines);
  if (!map[key]) {
    map[key] = cloneConfigSettings(item.settings);
    settings.scriptBaselines = map;
    saveSettings();
    return;
  }
  settings.scriptBaselines = map;
}

function openScriptEditor(rawKey) {
  const item = findConfigScript(rawKey);
  if (!item || !scriptSettings(item).length) {
    showToast("This script has no config to edit");
    return;
  }
  closePracticeGuide();
  scriptEditorKey = scriptMergeKey(item);
  ensureScriptBaseline(item);
  paintScriptEditor(item);
  const overlay = $("#scriptEditor");
  if (!overlay) return;
  overlay.hidden = false;
  document.body.classList.add("script-editor-open");
  syncScriptEditorChrome();
  requestAnimationFrame(() => overlay.classList.add("open"));
}

function collectScriptEditorValues() {
  const out = {};
  for (const el of $$("#scriptEditorBody [data-script-field]")) {
    const key = el.dataset.scriptField;
    const kind = el.dataset.kind;
    if (!key) continue;
    if (kind === "bool") {
      out[key] = el.checked;
      continue;
    }
    if (kind === "int") {
      const raw = String(el.value ?? "").trim();
      if (raw === "") return { ok: false, error: `${prettyConfigKey(key)} needs a whole number` };
      const n = Number(raw);
      if (!Number.isInteger(n)) return { ok: false, error: `${prettyConfigKey(key)} needs a whole number` };
      out[key] = n;
      continue;
    }
    if (kind === "number") {
      const raw = String(el.value ?? "").trim();
      if (raw === "") return { ok: false, error: `${prettyConfigKey(key)} needs a number` };
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: `${prettyConfigKey(key)} needs a number` };
      out[key] = n;
      continue;
    }
    if (kind === "json") {
      try {
        out[key] = JSON.parse(el.value);
      } catch {
        return { ok: false, error: `${prettyConfigKey(key)} is not valid JSON` };
      }
      continue;
    }
    out[key] = el.value;
  }
  return { ok: true, values: out };
}

function saveScriptEditorValues(values, { toast = "Saved to Omega", closeAfter = false, silent = false } = {}) {
  const key = scriptEditorKey;
  if (!key) return Promise.resolve(false);
  enqueueScriptConfig(scriptSaveJob(values, key));
  return drainScriptConfig().then(ok => {
    if (!ok) return false;
    if (closeAfter) closeScriptEditor();
    if (toast) showToast(toast);
    return true;
  });
}

async function sendScriptConfig(job) {
  const api = window.pywebview?.api;
  if (!api?.set_script_config) {
    showToast("Open OmegaDash to save script config");
    return false;
  }
  scriptEditorSaving = true;
  try {
    const result = await Promise.resolve(api.set_script_config(JSON.stringify({
      key: job.key,
      id: job.id ?? null,
      name: job.name || "",
      settings: job.settings
    })));
    if (!result?.ok) {
      showToast(result?.error || "Could not save config");
      return false;
    }
    if (result.data) ingestMemberConfig(result.data);
    if (scriptEditorKey === job.key && $("#scriptEditor")?.classList.contains("open")) {
      scriptEditorClean = JSON.stringify(job.settings);
    }
    return true;
  } catch {
    showToast("Could not save config");
    return false;
  } finally {
    scriptEditorSaving = false;
    const saveBtn = $("#scriptEditorSave");
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    }
  }
}

function onScriptEditorSave() {
  if (!scriptEditorKey) return;
  const parsed = collectScriptEditorValues();
  if (!parsed.ok) {
    showToast(parsed.error);
    return;
  }
  const btn = $("#scriptEditorSave");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving…";
  }
  saveScriptEditorValues(parsed.values);
}

async function onScriptEditorReset() {
  if (!scriptEditorKey) return;
  clearTimeout(scriptAutoSaveTimer);
  scriptAutoSaveTimer = 0;
  const item = findConfigScript(scriptEditorKey);
  if (!item) {
    showToast("This script is no longer loaded");
    return;
  }
  const baseline = scriptBaselineFor(scriptEditorKey);
  if (!baseline) {
    ensureScriptBaseline(item);
    paintScriptEditor(item, { markClean: false });
  } else {
    paintScriptEditor({ ...item, settings: { ...(item.settings || {}), ...baseline } }, { markClean: false });
  }
  const parsed = collectScriptEditorValues();
  if (!parsed.ok) {
    showToast(parsed.error);
    return;
  }
  await saveScriptEditorValues(parsed.values, { toast: "Reset saved to Omega" });
}

function bindScriptEditor() {
  $("#scriptEditorBack")?.addEventListener("click", () => requestCloseScriptEditor());
  $("#scriptEditorClose")?.addEventListener("click", () => requestCloseScriptEditor());
  $("#scriptEditorReset")?.addEventListener("click", onScriptEditorReset);
  $("#scriptEditorSave")?.addEventListener("click", onScriptEditorSave);
  $("#scriptEditor")?.addEventListener("click", event => {
    if (event.target.id === "scriptEditor") requestCloseScriptEditor();
  });
  $("#scriptEditorBody")?.addEventListener("click", event => {
    const btn = event.target.closest("[data-hide-field]");
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    const field = btn.dataset.hideField;
    if (!field) return;
    setScriptFieldHidden(field, !hiddenFieldsFor()[field]);
  });
  $("#scriptEditorBody")?.addEventListener("input", event => {
    const el = event.target.closest("[data-script-field]");
    if (!el || el.dataset.kind === "bool" || !scriptAutoSaveOn()) return;
    scheduleScriptAutoSave();
  });
  $("#scriptEditorBody")?.addEventListener("change", event => {
    if (event.target.id === "scriptShowHidden") {
      scriptShowHidden = event.target.checked;
      applyScriptFieldVisibility();
      return;
    }
    if (!event.target.closest("[data-script-field]") || !scriptAutoSaveOn()) return;
    scheduleScriptAutoSave({ immediate: true });
  });
}

function cloudInfoCard(item, options = {}) {
  const { toggle = false, ids, expandable = false, hideToggle = false, editable = false, details = true, showId = false } = options;
  const id = asCloudId(item.id);
  const idLabel = showId && id != null ? `<span class="config-lib-id">#${esc(id)}</span>` : "";
  let switchHtml = "";
  if (toggle && id != null) {
    const enabled = cloudIsEnabled(item, ids);
    const busy = cloudToggleBusy.has(id);
    switchHtml = `<button type="button" class="cloud-switch${enabled ? " is-on" : ""}" data-cloud-toggle="${esc(id)}" ${busy ? "disabled" : ""} aria-pressed="${enabled ? "true" : "false"}" aria-label="${enabled ? "Disable" : "Enable"} ${esc(scriptLabel(item.name) || "script")}"><i></i></button>`;
  }
  const settings = expandable ? scriptSettings(item) : [];
  const openable = settings.length > 0;
  const mergeKey = scriptMergeKey(item);
  let editHtml = "";
  if (editable && openable && mergeKey && mergeKey !== "name:") {
    editHtml = `<button type="button" class="config-edit config-badge off" data-edit-script="${esc(mergeKey)}">Edit</button>`;
  }
  let hideHtml = "";
  if (hideToggle && mergeKey && mergeKey !== "name:") {
    const hidden = isScriptHidden(item);
    const label = scriptLabel(item.name) || item.name || "script";
    hideHtml = `<button type="button" class="config-hide" data-hide-script="${esc(mergeKey)}" aria-pressed="${hidden ? "true" : "false"}" title="${hidden ? "Show this script" : "Hide this script"}" aria-label="${hidden ? "Show" : "Hide"} ${esc(label)}">${hideControlIcon()}</button>`;
  }
  const waiting = Boolean(expandable && !openable && pendingConfig.has(asCloudId(item.id)));
  const chevron = openable
    ? `<svg class="chevron" viewBox="0 0 24 24"><path d="m7 9 5 5 5-5"/></svg>`
    : "";
  const href = item.forums
    ? `<a href="${esc(item.forums)}" target="_blank" rel="noreferrer">Forum</a>`
    : "";
  const author = toggle || !details ? "" : cloudAuthorLine(item);
  const notesText = String(item.update_notes || "").trim();
  const changelog = notesText || toggle
    ? `<button type="button" class="config-lib-link" data-changelog="${esc(mergeKey)}">Changelog</button>`
    : "";
  const notes = details && notesText ? `<small>${esc(notesText)}</small>` : "";
  const linkParts = [href, changelog].filter(Boolean);
  const links = linkParts.length
    ? `<div class="config-lib-links">${linkParts.join('<span class="config-lib-sep">/</span>')}</div>`
    : "";
  const waitNote = waiting ? `<em>Checking for config…</em>` : "";
  const rows = settings.map(([key, value]) =>
    `<span>${esc(prettyConfigKey(key))}</span><strong>${esc(formatConfigValue(value))}</strong>`
  ).join("");
  const key = esc(mergeKey);
  return `<article class="config-item${openable ? " can-expand" : ""}"${openable ? " data-config-expand" : ""} data-config-key="${key}">
    <div class="config-lib">
      <strong>${esc(scriptLabel(item.name) || item.name)}</strong>
      <div class="config-lib-meta">${cloudUsersBadge(item)}${switchHtml}${editHtml}${hideHtml}${idLabel}${chevron}</div>
      ${links}
      ${author ? `<em>${esc(author)}</em>` : ""}
      ${waitNote}
      ${notes}
    </div>
    ${openable ? `<div class="config-settings">${rows}</div>` : ""}
  </article>`;
}

function paintConfigMeta() {
  const meta = $("#configMeta");
  if (!meta) return;
  const scripts = memberConfig.scripts || [];
  const libs = memberConfig.libs || [];
  const tab = configSubTab();
  if (tab === "cloud") {
    if (cloudCatalog.loading) {
      meta.textContent = "Loading cloud scripts…";
      return;
    }
    if (cloudCatalog.error && !cloudCatalog.loaded) {
      meta.textContent = cloudCatalog.error;
      return;
    }
    const shown = filteredCloudScripts().length;
    const total = cloudCatalog.scripts.length;
    const on = (cloudCatalog.scripts || []).filter(item => cloudIsEnabled(item)).length;
    const count = shown === total
      ? `${total} cloud scripts`
      : `${shown} of ${total} cloud scripts`;
    meta.textContent = on ? `${count} · ${on} enabled` : count;
    return;
  }
  if (!scripts.length && !libs.length) {
    meta.textContent = window.pywebview?.api?.get_member
      ? "No configuration loaded yet."
      : "Open OmegaDash with a Constelia key to load this.";
    return;
  }
  if (tab === "libs") {
    meta.textContent = `${libs.length} librar${libs.length === 1 ? "y" : "ies"} enabled`;
    return;
  }
  const visible = visibleScripts();
  const hidden = hiddenScriptsList();
  if (tab === "hidden") {
    meta.textContent = `${hidden.length} hidden script${hidden.length === 1 ? "" : "s"}`;
    return;
  }
  const configured = visible.filter(item => scriptSettings(item).length).length;
  let text = configured && configured !== visible.length
    ? `${visible.length} scripts · ${configured} with config`
    : `${visible.length} script${visible.length === 1 ? "" : "s"}`;
  if (hidden.length) text += ` · ${hidden.length} hidden`;
  meta.textContent = text;
}

function paintConfigScripts() {
  const root = $("#configScripts");
  if (!root) return;
  const all = memberConfig.scripts || [];
  const scripts = visibleScripts();
  if (!all.length) {
    root.innerHTML = `<div class="config-empty">No scripts enabled.</div>`;
    return;
  }
  if (!scripts.length) {
    root.innerHTML = `<div class="config-empty">All enabled scripts are hidden.</div>`;
    return;
  }
  root.innerHTML = scripts.map(item => cloudInfoCard(item, { expandable: true, hideToggle: true, editable: true, details: false })).join("");
}

function paintConfigHidden() {
  const root = $("#configHidden");
  if (!root) return;
  const scripts = hiddenScriptsList();
  if (!scripts.length) {
    root.innerHTML = `<div class="config-empty">No hidden scripts.</div>`;
    return;
  }
  root.innerHTML = scripts.map(item => cloudInfoCard(item, { expandable: true, hideToggle: true, editable: true, details: false })).join("");
}

function paintConfigLibs() {
  const root = $("#configLibs");
  if (!root) return;
  const libs = memberConfig.libs || [];
  if (!libs.length) {
    root.innerHTML = `<div class="config-empty">No libraries enabled on this account.</div>`;
    return;
  }
  root.innerHTML = libs.map(item => cloudInfoCard(item, { expandable: true, details: false })).join("");
}

let cloudCatalog = { scripts: [], loaded: false, loading: false, error: "" };
const cloudOpenGroups = new Set();
const cloudToggleBusy = new Set();

function configSubTab() {
  return $("#configMode .active")?.dataset.configTab || "scripts";
}

function fillCloudCategories() {
  const select = $("#cloudCategory");
  if (!select) return;
  const current = select.value;
  const cats = new Set();
  cloudCatalog.scripts.forEach(item => (item.category_names || []).forEach(name => cats.add(name)));
  const names = [...cats].sort((a, b) => a.localeCompare(b));
  select.innerHTML = `<option value="">All categories</option>${names.map(name =>
    `<option value="${esc(name)}">${esc(name)}</option>`
  ).join("")}`;
  if (names.includes(current)) select.value = current;
  enhanceSelect(select);
}

function asCloudId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const scriptUsers = new Map();

function rememberScriptUsers(items) {
  for (const item of items || []) {
    const id = asCloudId(item?.id);
    const n = Number(item?.users);
    if (id != null && Number.isFinite(n) && n >= 0) scriptUsers.set(id, n);
  }
}

function scriptUserCount(item) {
  const id = asCloudId(item?.id);
  if (id == null) return null;
  const n = Number(item?.users ?? scriptUsers.get(id));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function cloudUsersBadge(item) {
  const n = scriptUserCount(item);
  if (n == null) return "";
  const label = n === 1 ? "1 person using this" : `${n.toLocaleString("en-US")} people using this`;
  return `<span class="config-users" title="${esc(label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>${esc(n.toLocaleString("en-US"))}</span>`;
}

function cloudPopularityOn() {
  return Boolean(settings.cloudSortPopular);
}

function syncCloudPopularUi() {
  const cloud = $("#configCloud");
  if (cloud) cloud.classList.toggle("is-popular", cloudPopularityOn());
  const popularBox = document.querySelector("[data-setting='cloudSortPopular']");
  if (popularBox) popularBox.checked = cloudPopularityOn();
  const libsBox = document.querySelector("[data-setting='cloudHideLibraries']");
  if (libsBox) libsBox.checked = settings.cloudHideLibraries !== false;
}

function isCloudLibrary(item) {
  return (item?.category_names || []).some(name => {
    const key = String(name || "").toLowerCase().replace(/\s+/g, "");
    return key === "dependency/library" || key === "dependancy/library";
  });
}

function cloudHideLibrariesOn() {
  return cloudPopularityOn() && settings.cloudHideLibraries !== false;
}

function sortCloudRows(rows, popularity) {
  return rows.slice().sort((a, b) => {
    if (popularity) {
      const du = (scriptUserCount(b) ?? -1) - (scriptUserCount(a) ?? -1);
      if (du) return du;
    }
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

function ownedCloudIds() {
  const ids = new Set();
  const add = value => {
    const id = asCloudId(value);
    if (id != null) ids.add(id);
  };
  (memberConfig.scripts || []).forEach(item => add(item?.id));
  (memberConfig.libs || []).forEach(item => add(item?.id));
  return ids;
}

function ownedCloudById() {
  const map = new Map();
  for (const item of [...(memberConfig.scripts || []), ...(memberConfig.libs || [])]) {
    const id = asCloudId(item.id);
    if (id != null) map.set(id, item);
  }
  return map;
}

function cloudIsEnabled(item, ids) {
  const id = asCloudId(item?.id);
  return id != null && (ids || ownedCloudIds()).has(id);
}

function cloudInstalledItems() {
  const owned = ownedCloudById();
  const out = [];
  const seen = new Set();
  for (const item of [...(memberConfig.scripts || []), ...(memberConfig.libs || [])]) {
    const id = asCloudId(item.id);
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    const catalog = (cloudCatalog.scripts || []).find(entry => asCloudId(entry.id) === id);
    out.push(catalog ? mergeCloudItem(catalog, item) : { ...item });
  }
  return out;
}

function cloudMatchesQuery(item, query) {
  if (!query) return true;
  const cats = item.category_names || [];
  const hay = [item.name, String(item.id ?? ""), item.author || "", item.update_notes || "", ...cats].join(" ").toLowerCase();
  return hay.includes(query);
}

function filteredCloudScripts() {
  const query = String($("#cloudSearch")?.value || "").trim().toLowerCase();
  const category = cloudPopularityOn() ? "" : ($("#cloudCategory")?.value || "");
  const hideLibs = cloudHideLibrariesOn();
  const owned = ownedCloudById();
  return (cloudCatalog.scripts || []).filter(item => {
    const cats = item.category_names || [];
    if (category && !cats.includes(category)) return false;
    if (hideLibs && isCloudLibrary(item)) return false;
    return cloudMatchesQuery(mergeCloudItem(item, owned.get(asCloudId(item.id))), query);
  });
}

async function toggleCloudScript(rawId) {
  const id = asCloudId(rawId);
  if (id == null || cloudToggleBusy.has(id)) return;
  if (!window.pywebview?.api?.set_script) {
    showToast("Open OmegaDash to toggle cloud scripts");
    return;
  }
  const item = (cloudCatalog.scripts || []).find(entry => asCloudId(entry.id) === id);
  const label = scriptLabel(item?.name) || `#${id}`;
  const wasOn = cloudIsEnabled(item || { id });
  cloudToggleBusy.add(id);
  paintConfigCloud();
  let toggled = false;
  try {
    const result = await window.pywebview.api.set_script(id);
    if (!result?.ok) throw new Error(result?.error || "Could not toggle script");
    ingestMemberConfig(result.data);
    showToast(`${label} ${wasOn ? "disabled" : "enabled"}`);
    toggled = true;
    showToast("Synced");
    if (wasOn) pendingConfig.delete(id);
    else startConfigPoll(id);
  } catch (error) {
    showToast(error?.message || (toggled ? "Could not sync Omega" : "Could not toggle script"));
  } finally {
    cloudToggleBusy.delete(id);
    paintConfigCloud();
  }
}

function cloudGroupHtml(title, rows, ids, extraClass = "", popularity = false) {
  const owned = ownedCloudById();
  const cards = sortCloudRows(rows, popularity).map(item => {
    const merged = mergeCloudItem(item, owned.get(asCloudId(item.id)));
    return cloudInfoCard(merged, { toggle: true, ids, showId: true, details: false });
  }).join("");
  const open = cloudOpenGroups.has(title);
  const count = rows.length;
  const label = count === 1 ? "1 script" : `${count} scripts`;
  return `<article class="match-row config-cloud-group${extraClass}${open ? " open" : ""}">
    <button type="button" class="config-cloud-summary" data-cloud-group="${esc(title)}" aria-expanded="${open ? "true" : "false"}">
      <div class="match-name">
        <strong>${esc(title)}</strong>
        <span>${esc(label)}</span>
      </div>
      <div class="match-stat"><span>Scripts</span><strong>${count}</strong></div>
      <svg class="chevron" viewBox="0 0 24 24"><path d="m7 9 5 5 5-5"/></svg>
    </button>
    <div class="config-cloud-body">${cards}</div>
  </article>`;
}

function paintConfigCloud() {
  const root = $("#configCloudList");
  if (!root) return;
  syncCloudPopularUi();
  if (cloudCatalog.loading) {
    root.innerHTML = `<div class="config-empty">Loading cloud scripts…</div>`;
    paintConfigMeta();
    return;
  }
  if (!cloudCatalog.loaded) {
    root.innerHTML = `<div class="config-empty">${esc(cloudCatalog.error || "Open the Cloud tab to load public scripts.")}</div>`;
    paintConfigMeta();
    return;
  }
  const popular = cloudPopularityOn();
  const items = filteredCloudScripts();
  const ids = ownedCloudIds();
  const query = String($("#cloudSearch")?.value || "").trim().toLowerCase();
  const category = popular ? "" : ($("#cloudCategory")?.value || "");
  const enabledItems = cloudInstalledItems().filter(item => {
    if (category && !(item.category_names || []).includes(category)) return false;
    if (popular && cloudHideLibrariesOn() && isCloudLibrary(item)) return false;
    return cloudMatchesQuery(item, query);
  });
  if (!items.length) {
    root.innerHTML = `<div class="config-empty">No cloud scripts match this search.</div>`;
    paintConfigMeta();
    return;
  }
  const enabledHtml = enabledItems.length
    ? cloudGroupHtml("Enabled", enabledItems, ids, " is-enabled", popular)
    : "";
  if (popular) {
    const owned = ownedCloudById();
    const cards = sortCloudRows(items, true).map(item => {
      const merged = mergeCloudItem(item, owned.get(asCloudId(item.id)));
      return cloudInfoCard(merged, { toggle: true, ids, showId: true, details: false });
    }).join("");
    root.innerHTML = enabledHtml + `<div class="config-cloud-popular-list">${cards}</div>`;
    paintConfigMeta();
    return;
  }
  const filterCat = $("#cloudCategory")?.value || "";
  if (filterCat) cloudOpenGroups.add(filterCat);
  const groups = new Map();
  items.forEach(item => {
    const cats = item.category_names || [];
    const key = filterCat || cats[0] || "Uncategorized";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  root.innerHTML = enabledHtml + keys.map(key =>
    cloudGroupHtml(key, groups.get(key), ids)
  ).join("");
  paintConfigMeta();
}

async function ensureCloudCatalog() {
  if (cloudCatalog.loading) {
    paintConfigCloud();
    return;
  }
  if (cloudCatalog.loaded) {
    paintConfigCloud();
    return;
  }
  if (!window.pywebview?.api?.get_encyclopedia) {
    cloudCatalog.error = "Open OmegaDash to load cloud scripts";
    paintConfigCloud();
    return;
  }
  cloudCatalog.loading = true;
  cloudCatalog.error = "";
  paintConfigCloud();
  try {
    const result = await window.pywebview.api.get_encyclopedia();
    if (!result?.ok) throw new Error(result?.error || "Could not load cloud scripts");
    cloudCatalog.scripts = Array.isArray(result.data) ? result.data : [];
    cloudCatalog.loaded = true;
    rememberScriptUsers(cloudCatalog.scripts);
    fillCloudCategories();
  } catch (error) {
    cloudCatalog.error = error?.message || "Could not load cloud scripts";
  } finally {
    cloudCatalog.loading = false;
    paintConfig();
  }
}

function paintConfig() {
  const open = new Set(
    [...document.querySelectorAll("#configScripts [data-config-expand].open, #configLibs [data-config-expand].open, #configHidden [data-config-expand].open")]
      .map(el => el.dataset.configKey)
      .filter(Boolean)
  );
  paintConfigScripts();
  paintConfigLibs();
  paintConfigHidden();
  paintConfigCloud();
  syncHiddenTab();
  paintConfigMeta();
  syncProtectionSelect();
  if (!open.size) return;
  document.querySelectorAll("#configScripts [data-config-expand], #configLibs [data-config-expand], #configHidden [data-config-expand]").forEach(el => {
    if (open.has(el.dataset.configKey)) el.classList.add("open");
  });
}

function paintProfileError(message) {
  $("#profilePersona").textContent = "Offline";
  $("#profileProtection").textContent = message;
  setAvatar("", "?");
  $("#profilePanel").innerHTML = `<p class="profile-row"><span>Status</span><strong>${esc(message)}</strong></p>`;
  const lootResult = $("#lootResult");
  if (lootResult) {
    lootResult.classList.remove("win");
    lootResult.textContent = "Could not load loot status.";
  }
  renderLoot({});
}

function paintProfile(widget, member = {}) {
  ingestMemberConfig(member);
  const username = member.username || widget?.steam?.persona || "Unknown";
  const protection = widget?.protection || "—";
  $("#profilePersona").textContent = username;
  $("#profileProtection").textContent = protection;
  $("#profilePersona").dataset.loaded = "1";
  setAvatar(member.avatar, username);
  setNotice("#noticeConversations", member.unread_conversations);
  setNotice("#noticeAlerts", member.unread_alerts);

  const rank = widget.rank || {};
  const session = widget.session || {};
  const steam = widget.steam || {};
  const astro = widget.astrology || {};
  const loot = widget.loot || {};
  const frozen = Boolean(session.frozen);
  const steamId = asSteam64(steam.id);
  if (steamId) memberConfig.steam64 = steamId;
  const steamHref = steamId ? `https://steamcommunity.com/profiles/${steamId}` : "";

  $("#profilePanel").innerHTML = `
    <div class="profile-group">
      <div class="profile-group-label">RANK</div>
      <div class="profile-row"><span>Name</span><strong>${esc(rank.name || "—")}</strong></div>
      <div class="rank-bar" style="--p:${Number(rank.progress) || 0}%"><i></i></div>
      <div class="profile-row"><span>Progress</span><strong>${esc(rank.progress ?? 0)}%</strong></div>
    </div>
    <div class="profile-group">
      <div class="profile-group-label">SESSION</div>
      <div class="profile-row"><span>Status</span><strong class="session-pill ${frozen ? "frozen" : ""}"><i></i>${frozen ? "Frozen" : "Active"}</strong></div>
      <div class="profile-row"><span>Activity</span><strong>${esc(session.last_activity || "—")}</strong></div>
    </div>
    <div class="profile-group">
      <div class="profile-group-label">STEAM</div>
      <div class="profile-row"><span>Persona</span><strong>${esc(steam.persona || "—")}</strong></div>
      <div class="profile-row"><span>ID</span>${steamHref ? `<a href="${steamHref}" target="_blank" rel="noreferrer">${esc(steamId)}</a>` : "<strong>—</strong>"}</div>
    </div>
    <div class="profile-group">
      <div class="profile-group-label">ACCOUNT</div>
      <div class="profile-row"><span>Protection</span><strong>${esc(protection)}</strong></div>
      <div class="profile-row"><span>Sign</span><strong>${esc(astro.sign || "—")}</strong></div>
      <div class="profile-row"><span>XP</span><strong>${esc(fmtNum(astro.xp))}${astro.gain ? ` · +${esc(fmtNum(astro.gain))}` : ""}</strong></div>
      ${widget.discord ? `<div class="profile-row"><span>Discord</span><strong>${esc(widget.discord)}</strong></div>` : ""}
      <div class="profile-row"><span>Loot</span><strong>${loot.can_roll ? "Ready to roll" : "On cooldown"}</strong></div>
      <div class="profile-row"><span>Last roll</span><strong>${esc(fmtUnix(loot.last_roll))}</strong></div>
    </div>`;
  renderLoot(loot);
  loadLootHistory();
  setTimeout(() => loadSelfLeetify(steamId), 0);
}

let profileFetchStarted = false;

async function loadForumWidget() {
  if (profileFetchStarted || !window.pywebview?.api?.get_forum_widget) return;
  profileFetchStarted = true;
  try {
    const widget = await window.pywebview.api.get_forum_widget();
    if (widget?.ok) paintProfile(widget.data, {});
    const member = window.pywebview.api.get_member
      ? await window.pywebview.api.get_member()
      : { ok: false };
    if (!widget?.ok && !member?.ok) {
      profileFetchStarted = false;
      paintProfileError(widget?.error || member?.error || "Unavailable");
      return;
    }
    paintProfile(widget?.ok ? widget.data : {}, member?.ok ? member.data : {});
    startNoticeHeartbeat();
  } catch {
    profileFetchStarted = false;
    paintProfileError("Unavailable");
  }
}

function bindProfile() {
  const dock = $("#profileDock");
  const btn = $("#profileBtn");
  if (!dock || !btn) return;
  syncCompactSidebarChrome();
  if (!bindProfile.mqBound) {
    bindProfile.mqBound = true;
    COMPACT_SIDEBAR_MQ.addEventListener("change", syncCompactSidebarChrome);
  }
  if (btn.dataset.bound) return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", () => {
    const open = dock.classList.toggle("open");
    btn.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", event => {
    if (dock.contains(event.target)) return;
    dock.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
  });
  $$("[data-forum]").forEach(notice => {
    notice.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      const kind = notice.dataset.forum;
      if (window.pywebview?.api?.open_forum) {
        await window.pywebview.api.open_forum(kind);
        return;
      }
      const urls = {
        conversations: "https://constelia.ai/forums/index.php?direct-messages/",
        alerts: "https://constelia.ai/forums/index.php?account/alerts"
      };
      if (urls[kind]) window.open(urls[kind], "_blank", "noopener");
    });
  });
}

async function init() {
  await whenNativeReady();
  await loadPersistedSettings();
  hydrateSettings();
  saveSettings();
  await loadApiKeys();
  await loadTelemetry();
  await loadSensAnalysis();
  await loadLeakAnalysis();
  loadSteamInventory();
  bindInteractions();
  startLivePoll();
  startOmegaStatusWatch();
  requestAnimationFrame(() => {
    initOverallCharts();
    applyTheme(settings.theme, false);
  });
  loadForumWidget();
  window.addEventListener("pywebviewready", async () => {
    await loadPersistedSettings();
    hydrateSettings();
    applyTheme(settings.theme, false);
    await loadApiKeys();
    await loadTelemetry();
    await loadSensAnalysis();
    await loadLeakAnalysis();
    loadSteamInventory();
    startLivePoll();
    startOmegaStatusWatch();
    loadForumWidget();
    loadLootHistory();
    const chrome = await window.pywebview?.api?.window_state?.();
    syncMaxButton(chrome?.maximized);
  });
  setTimeout(() => {
    if (!$("#profilePersona").dataset.loaded && !window.pywebview?.api) {
      paintProfileError("Open via OmegaDash");
    }
  }, 1800);
}

document.addEventListener("DOMContentLoaded", init);
