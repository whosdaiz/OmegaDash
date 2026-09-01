const MAPS = {
  Mirage: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/de_mirage.png",
  Inferno: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/de_inferno.png",
  Dust2: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/de_dust2.png",
  Ancient: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/de_ancient.png",
  Nuke: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/de_nuke.png",
  Anubis: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/de_anubis.png",
  Overpass: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/de_overpass.png",
  Cache: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/de_cache.png",
  Vertigo: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/de_vertigo.png",
  Train: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/de_train.png",
  Italy: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/cs_italy.png",
  Office: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/cs_office.png"
};

const OFFICIAL_MAPS = [
  { id: "de_ancient", name: "Ancient", pool: "Active Duty" },
  { id: "de_anubis", name: "Anubis", pool: "Active Duty" },
  { id: "de_cache", name: "Cache", pool: "Active Duty" },
  { id: "de_dust2", name: "Dust2", pool: "Active Duty" },
  { id: "de_inferno", name: "Inferno", pool: "Active Duty" },
  { id: "de_mirage", name: "Mirage", pool: "Active Duty" },
  { id: "de_nuke", name: "Nuke", pool: "Active Duty" },
  { id: "de_overpass", name: "Overpass", pool: "Competitive" },
  { id: "de_train", name: "Train", pool: "Competitive" },
  { id: "de_vertigo", name: "Vertigo", pool: "Competitive" },
  { id: "cs_italy", name: "Italy", pool: "Competitive" },
  { id: "cs_office", name: "Office", pool: "Competitive" }
];

const RADARS = {
  Mirage: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/radars/de_mirage_radar_psd.png",
  Inferno: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/radars/de_inferno_radar_psd.png",
  Dust2: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/radars/de_dust2_radar_psd.png",
  Ancient: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/radars/de_ancient_radar_psd.png",
  Nuke: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/radars/de_nuke_radar_psd.png",
  Anubis: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/radars/de_anubis_radar_psd.png",
  Overpass: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/radars/de_overpass_radar_psd.png",
  Cache: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/radars/de_cache_radar_psd.png",
  Vertigo: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/radars/de_vertigo_radar_psd.png",
  Train: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/radars/de_train_radar_psd.png",
  Italy: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/radars/cs_italy_radar_psd.png",
  Office: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/radars/cs_office_radar_psd.png"
};

const THUMBS = {
  Mirage: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/thumbs/de_mirage_1_png.png",
  Inferno: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/thumbs/de_inferno_1_png.png",
  Dust2: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/thumbs/de_dust2_1_png.png",
  Ancient: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/thumbs/de_ancient_1_png.png",
  Nuke: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/thumbs/de_nuke_1_png.png",
  Anubis: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/thumbs/de_anubis_1_png.png",
  Overpass: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/thumbs/de_overpass_1_png.png",
  Cache: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/thumbs/de_cache_1_png.png",
  Vertigo: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/thumbs/de_vertigo_1_png.png",
  Train: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/thumbs/de_train_1_png.png",
  Italy: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/thumbs/cs_italy_1_png.png",
  Office: "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/thumbs/cs_office_png.png"
};

const mulberry32 = seed => () => {
  let t = seed += 0x6D2B79F5;
  t = Math.imul(t ^ t >>> 15, t | 1);
  t ^= t + Math.imul(t ^ t >>> 7, t | 61);
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

const rand = mulberry32(42069);
const pick = array => array[Math.floor(rand() * array.length)];
const round = (value, precision = 0) => Number(value.toFixed(precision));

function makeEngagements(count, seedOffset = 0) {
  const r = mulberry32(5000 + seedOffset);
  return Array.from({ length: count }, (_, i) => {
    const result = r() > .22 ? "KILL" : "DEATH";
    const landingRoll = r();
    const landing = landingRoll < .27 ? "under" : landingRoll < .79 ? "target" : "over";
    const preaim = round(.5 + r() * 10, 1);
    const reaction = Math.round(205 + r() * 310);
    return {
      id: i + 1,
      result,
      preaim,
      flick: round(1.8 + r() * 13, 1),
      landing,
      landingDeg: landing === "target" ? round(r() * .65, 2) : round(.15 + r() * 2.1, 2),
      reaction,
      ttk: result === "KILL" ? Math.round(reaction + 90 + r() * 650) : null,
      firstShot: r() > .46,
      velocity: round(r() > .74 ? 40 + r() * 150 : r() * 14, 1),
      pathEff: Math.round(68 + r() * 28),
      round: 1 + Math.floor(i * 21 / Math.max(count - 1, 1))
    };
  });
}

function makeMatch(index) {
  const maps = Object.keys(MAPS);
  const map = maps[index % maps.length];
  const won = rand() > .38;
  const own = won ? 13 : Math.floor(6 + rand() * 7);
  const enemy = won ? Math.floor(6 + rand() * 7) : 13;
  const kills = Math.floor(13 + rand() * 15);
  const deaths = Math.floor(8 + rand() * 13);
  const landUnder = Math.floor(18 + rand() * 16);
  const landOn = Math.floor(43 + rand() * 20);
  return {
    id: `match-${index + 1}`,
    map,
    mapImage: MAPS[map],
    thumbImage: THUMBS[map],
    radarImage: RADARS[map],
    date: new Date(Date.now() - index * 86400000 * (1 + rand() * .7)).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
    duration: `${28 + Math.floor(rand() * 17)}m`,
    won,
    score: `${own} : ${enemy}`,
    kills,
    deaths,
    assists: Math.floor(2 + rand() * 9),
    kd: round(kills / deaths, 2),
    hs: Math.floor(42 + rand() * 31),
    adr: Math.floor(68 + rand() * 40),
    rounds: own + enemy,
    reaction: Math.floor(275 + rand() * 135),
    firstShot: Math.floor(42 + rand() * 27),
    counterStrafe: Math.floor(70 + rand() * 24),
    preaim: round(3.2 + rand() * 4.5, 1),
    ttk: Math.floor(610 + rand() * 420),
    landing: { under: landUnder, target: landOn, over: 100 - landUnder - landOn },
    mode: ["prem_comp", "practice", "casual", "deathmatch", ""][index % 5],
    side: {
      ct: { rounds: Math.floor(own * .55), kd: round(.9 + rand() * .8, 2), reaction: Math.floor(280 + rand() * 100) },
      t: { rounds: Math.ceil(own * .45), kd: round(.85 + rand() * .75, 2), reaction: Math.floor(290 + rand() * 115) }
    },
    engagements: makeEngagements(18 + Math.floor(rand() * 10), index)
  };
}

function makeScoreboard() {
  const ct = 3;
  const t = 2;
  const row = (name, team, you, extra = {}) => ({
    id: name,
    name,
    team,
    you: Boolean(you),
    alive: extra.alive !== false,
    health: extra.health ?? 100,
    money: extra.money ?? 2700,
    armor: extra.armor ?? 100,
    helmet: extra.helmet !== false,
    kit: Boolean(extra.kit),
    primary: extra.primary ?? null,
    secondary: extra.secondary ?? null,
    kills: extra.kills ?? 0,
    deaths: extra.deaths ?? 0,
    assists: extra.assists ?? 0,
    kd: extra.kd ?? 0,
    headshots: extra.headshots ?? 0,
    hs: extra.hs ?? (extra.kills ? round((extra.headshots ?? 0) / extra.kills * 100, 1) : 0),
    dmg: extra.dmg ?? 0,
    adr: extra.adr ?? 0,
    ud: extra.ud ?? 0,
    flashed: extra.flashed ?? 0
  });
  return {
    team: ct,
    scoreCt: 8,
    scoreT: 5,
    rounds: 13,
    you: [
      row("Whos", ct, true, { kills: 18, deaths: 9, assists: 4, kd: 2, headshots: 8, dmg: 1840, adr: 141.5, ud: 62, flashed: 7, kit: true, primary: "AK-47", secondary: "USP-S", money: 4750, health: 87 }),
      row("n0thing", ct, false, { kills: 14, deaths: 11, assists: 6, kd: 1.27, headshots: 5, dmg: 1320, adr: 101.5, ud: 48, flashed: 11, kit: true, primary: "M4A1-S", secondary: "USP-S", money: 3100, health: 100 }),
      row("flusha", ct, false, { kills: 11, deaths: 12, assists: 8, kd: 0.92, headshots: 4, dmg: 980, adr: 75.4, ud: 110, flashed: 16, kit: true, primary: "AWP", secondary: "P250", money: 1850, armor: 100, health: 34 }),
      row("device", ct, false, { kills: 9, deaths: 10, assists: 3, kd: 0.9, headshots: 3, dmg: 870, adr: 66.9, ud: 21, flashed: 4, kit: false, primary: "FAMAS", secondary: "USP-S", money: 650, armor: 0, helmet: false, health: 0, alive: false }),
      row("krimz", ct, false, { kills: 7, deaths: 13, assists: 9, kd: 0.54, headshots: 2, dmg: 640, adr: 49.2, ud: 88, flashed: 9, kit: true, primary: "MP9", secondary: "USP-S", money: 2200, health: 61 })
    ],
    them: [
      row("s1mple", t, false, { kills: 21, deaths: 8, assists: 2, kd: 2.63, headshots: 9, dmg: 2010, adr: 154.6, ud: 18, flashed: 3, primary: "AWP", secondary: "Glock-18", money: 5400, health: 100 }),
      row("ZywOo", t, false, { kills: 16, deaths: 10, assists: 5, kd: 1.6, headshots: 7, dmg: 1544, adr: 118.8, ud: 40, flashed: 6, primary: "AK-47", secondary: "Deagle", money: 3850, health: 72 }),
      row("NiKo", t, false, { kills: 12, deaths: 14, assists: 7, kd: 0.86, headshots: 6, dmg: 1180, adr: 90.8, ud: 55, flashed: 8, primary: "AK-47", secondary: "Glock-18", money: 1400, health: 19 }),
      row("m0NESY", t, false, { kills: 10, deaths: 13, assists: 4, kd: 0.77, headshots: 4, dmg: 905, adr: 69.6, ud: 12, flashed: 2, primary: null, secondary: "Tec-9", money: 800, armor: 0, helmet: false, health: 0, alive: false }),
      row("donk", t, false, { kills: 8, deaths: 15, assists: 6, kd: 0.53, headshots: 5, dmg: 770, adr: 59.2, ud: 94, flashed: 13, primary: "Galil AR", secondary: "Glock-18", money: 2650, health: 100 })
    ]
  };
}

function makeLocations(kills, deaths) {
  const clusters = [[.27,.31],[.48,.42],[.67,.26],[.73,.64],[.38,.69]];
  const create = (count, type) => Array.from({ length: count }, (_, i) => {
    const [cx, cy] = clusters[(i + (type === "death" ? 2 : 0)) % clusters.length];
    return {
      type,
      x: Math.max(.08, Math.min(.92, cx + (rand() - .5) * .16)),
      y: Math.max(.08, Math.min(.92, cy + (rand() - .5) * .16))
    };
  });
  return [...create(kills, "kill"), ...create(deaths, "death")];
}

const matches = Array.from({ length: 20 }, (_, i) => makeMatch(i));
matches[0] = {
  ...matches[0],
  map: "Mirage",
  mapImage: MAPS.Mirage,
  thumbImage: THUMBS.Mirage,
  radarImage: RADARS.Mirage,
  date: "Today, 12:42",
  duration: "38m",
  won: true,
  score: "13 : 9",
  rounds: 22,
  kills: 24,
  deaths: 14,
  assists: 6,
  kd: 1.71,
  hs: 58,
  adr: 96,
  reaction: 318,
  firstShot: 61,
  counterStrafe: 87,
  preaim: 4.1,
  ttk: 742,
  landing: { under: 24, target: 57, over: 19 },
  side: {
    ct: { rounds: 7, kd: 1.88, reaction: 301 },
    t: { rounds: 6, kd: 1.56, reaction: 339 }
  },
  engagements: makeEngagements(26, 999),
  locations: makeLocations(24, 14),
  team: 3,
  scoreCt: 8,
  scoreT: 5,
  scoreboard: makeScoreboard()
};

const reactionHistory = Array.from({ length: 30 }, (_, i) => ({
  label: `M${i + 1}`,
  value: Math.round(420 - i * 3.3 + (rand() - .5) * 85)
}));

const flickPoints = Array.from({ length: 100 }, () => {
  const x = round((rand() - .49) * 8.6, 2);
  const y = round((rand() - .5) * 4.6, 2);
  const clipped = Math.abs(x) > 4.5 || Math.abs(y) > 2.5;
  const distance = Math.sqrt(x * x + y * y);
  return {
    x, y,
    type: distance < 1.6 ? "target" : x < 0 ? "under" : "over",
    clipped,
    daysAgo: round(rand() * 40, 2)
  };
});

function tallyFlickStats(points) {
  const stats = { target: 0, under: 0, over: 0, clipped: 0, total: 0 };
  points.forEach(point => {
    if (stats[point.type] == null) return;
    stats[point.type] += 1;
    stats.total += 1;
    if (point.clipped) stats.clipped += 1;
  });
  return stats;
}

const flickStats = {
  "7": tallyFlickStats(flickPoints.filter(p => p.daysAgo <= 7)),
  "30": tallyFlickStats(flickPoints.filter(p => p.daysAgo <= 30)),
  all: tallyFlickStats(flickPoints)
};

const placementPoints = Array.from({ length: 100 }, () => {
  const x = round((rand() - .54) * 6.5, 2);
  const y = round((rand() - .46) * 5.2, 2);
  return { x, y, clipped: Math.abs(x) > 12 || Math.abs(y) > 6 };
});

window.MOCK_DATA = {
  player: {
    name: "Whos",
    matches: 284,
    engagements: 6817,
    hoursTracked: 193.4,
    kd: 1.46,
    hs: 57.8,
    reaction: 336,
    firstShot: 58.4,
    counterStrafe: 84.7,
    pathEff: 81.4,
    avgVelocity: 11.2,
    movingShots: 6.8,
    placementOffset: 4.7,
    headLevel: 74,
    preAimed: 19
  },
  ranges: {
    "7": { kd: 1.54, hs: 61.2, reaction: 319, firstShot: 62.1, counterStrafe: 87.3, pathEff: 83.1, kdDelta: 5.5, hsDelta: 5.9, reactionDelta: -5.1, firstShotDelta: 6.3, counterStrafeDelta: 3.1, pathEffDelta: 2.4 },
    "30": { kd: 1.46, hs: 57.8, reaction: 336, firstShot: 58.4, counterStrafe: 84.7, pathEff: 81.4, kdDelta: 5.0, hsDelta: 4.3, reactionDelta: -4.5, firstShotDelta: 4.7, counterStrafeDelta: 3.4, pathEffDelta: 1.8 },
    all: { kd: 1.39, hs: 55.4, reaction: 352, firstShot: 55.8, counterStrafe: 81.9, pathEff: 79.2, kdDelta: -4.8, hsDelta: -4.2, reactionDelta: 4.8, firstShotDelta: -4.5, counterStrafeDelta: -3.3, pathEffDelta: -2.1 }
  },
  reactionHistory,
  flickPoints,
  flickStats,
  placementPoints,
  lastMatch: matches[0],
  matches
};

window.MAPS = MAPS;
window.RADARS = RADARS;
window.THUMBS = THUMBS;
window.OFFICIAL_MAPS = OFFICIAL_MAPS;
