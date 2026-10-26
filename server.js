#!/usr/bin/env node
/* ============================================================
   Ambre 3724 · serveur multijoueur dédié (aucune dépendance)
   Node.js 18+ requis.

   Lancer :
     node server.js
     node server.js --port 3724 --name "Les Nations d'Ambre" --motd "Bienvenue !" --max 8

   Options :
     --port N       port TCP (défaut 3724)
     --name TEXTE   nom affiché dans la liste des serveurs
     --motd TEXTE   message du jour affiché sous le nom
     --max N        joueurs maximum (défaut 8)
     --html FICHIER page du jeu servie à la racine (défaut Ambre-3724-multijoueur.html)
     --world FICHIER sauvegarde du monde (défaut world-<port>.json)

   Les joueurs se connectent depuis la liste de serveurs du jeu
   (adresse IP:port) ou en ouvrant http://adresse:port/ dans le navigateur.
   Le monde (société, trésor, guerres, recherches…) est sauvegardé
   automatiquement et rechargé au prochain démarrage.
   ============================================================ */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

/* ---------- options ---------- */
function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const PORT = parseInt(arg("port", process.env.PORT || "3724"), 10) || 3724;
const NAME = String(arg("name", process.env.SERVER_NAME || "Serveur Ambre 3724")).slice(0, 40);
const MOTD = String(arg("motd", process.env.SERVER_MOTD || "Une société née de l'ambre")).slice(0, 80);
const MAX = Math.max(1, Math.min(32, parseInt(arg("max", process.env.SERVER_MAX || "8"), 10) || 8));
const HTML_FILE = path.resolve(arg("html", path.join(__dirname, "Ambre-3724-multijoueur.html")));
const WORLD_FILE = path.resolve(arg("world", process.env.WORLD_FILE || path.join(__dirname, "world-" + PORT + ".json")));
const VERSION = "1.0";

/* ---------- rôles ---------- */
const ROLES = {
  gouverneur: { name: "Gouverneur", color: "#f0a63a", unique: true,
    desc: "Dirige la société : régime, lois, réformes. Peut lancer le chapitre II.",
    tabs: ["politique", "lois", "ville", "evenements", "cohesion"] },
  intendant: { name: "Intendant", color: "#86ad5f", unique: true,
    desc: "Gère l'économie, le commerce, l'énergie, les infrastructures et les services.",
    tabs: ["economie", "infrastructures", "services", "energie"] },
  general: { name: "Général", color: "#d0603a", unique: true,
    desc: "Commande l'armée, la défense, l'espionnage et déclare la guerre.",
    tabs: ["guerre", "espionnage"] },
  scientifique: { name: "Scientifique", color: "#5fa8d3", unique: true,
    desc: "Dirige la recherche et les découvertes.",
    tabs: ["recherche", "statistiques"] },
  explorateur: { name: "Explorateur", color: "#c58ad9", unique: true,
    desc: "Parcourt la carte, peut lancer le chapitre II et suit les événements.",
    tabs: ["statistiques", "evenements", "cohesion"] },
  citoyen: { name: "Citoyen", color: "#b9ab92", unique: false,
    desc: "Survit et explore librement ; consulte les statistiques de la société.",
    tabs: ["statistiques"] }
};

/* ---------- état du monde ---------- */
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const DAY_SECONDS = 480;   // durée d'un jour dans le jeu (secondes réelles)
const world = {
  civic: {}, cv: 0, keyV: {}, keyOwner: {},
  seed: parseInt(arg("seed", process.env.WORLD_SEED || "0"), 10) || 0,
  clock: { time: 7 / 24, day: 1, at: Date.now() },
  builds: [],      // constructions partagées {id,t,x,z,r,dy?,o}
  saves: {}        // sauvegarde de chaque joueur : pid -> {t,name,data}
};
function worldClock() {
  const el = (Date.now() - world.clock.at) / 1000 / DAY_SECONDS;
  let t = world.clock.time + el, d = world.clock.day;
  const w = Math.floor(t); t -= w; d += w;
  return { time: t, day: d };
}
function applyLoaded(saved) {
  if (saved.civic && typeof saved.civic === "object") world.civic = saved.civic;
  world.cv = saved.cv | 0;
  for (const k of Object.keys(world.civic)) world.keyV[k] = world.cv;
  if (saved.seed && !world.seed) world.seed = saved.seed | 0;
  if (saved.clock && typeof saved.clock.time === "number") world.clock = { time: saved.clock.time, day: saved.clock.day | 0 || 1, at: Date.now() };
  if (Array.isArray(saved.builds)) world.builds = saved.builds;
  if (saved.saves && typeof saved.saves === "object") world.saves = saved.saves;
}
function snapshot() {
  const c = worldClock();
  return { civic: world.civic, cv: world.cv, seed: world.seed, clock: c, builds: world.builds, saves: world.saves };
}
function hasContent(x) {
  return x && ((x.civic && Object.keys(x.civic).length) || (x.builds && x.builds.length) || (x.saves && Object.keys(x.saves).length) || x.seed);
}
const players = new Map();   // id -> joueur
let hostId = null;
let seq = 0;
const events = [];           // anneau d'événements (chat, départs…)
let lv = 1;                  // version du lobby
let pv = 1;                  // version des positions
const waiters = new Set();   // requêtes poll en attente

try {
  const saved = JSON.parse(fs.readFileSync(WORLD_FILE, "utf8"));
  if (hasContent(saved)) {
    applyLoaded(saved);
    console.log("Monde chargé depuis", path.basename(WORLD_FILE));
  }
} catch (e) { /* nouveau monde */ }

/* ---------- sauvegarde : fichier local + (optionnel) Gist GitHub ----------
   Sur un hébergement gratuit le disque est effacé à chaque redémarrage.
   Si GIST_ID et GITHUB_TOKEN sont définis, le monde est aussi sauvegardé
   dans un Gist GitHub secret et rechargé au démarrage. */
const GIST_ID = (process.env.GIST_ID || "").trim();
const GH_TOKEN = (process.env.GITHUB_TOKEN || "").trim();
const GH_API = (process.env.GITHUB_API || "https://api.github.com").replace(/\/+$/, "");
const GIST_FILE = "world.json";
const REMOTE = !!(GIST_ID && GH_TOKEN);
let remoteReady = !REMOTE;   // on n'écrit jamais en ligne avant d'avoir lu l'existant
let remoteDirty = false, remoteLast = 0;

function ghFetch(url, opts = {}) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 10000);
  return fetch(url, Object.assign({}, opts, {
    signal: ac.signal,
    headers: Object.assign({
      "Authorization": "Bearer " + GH_TOKEN,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ambre-3724-server"
    }, opts.headers || {})
  })).finally(() => clearTimeout(to));
}
async function loadRemote() {
  if (!REMOTE) return true;
  try {
    const r = await ghFetch(GH_API + "/gists/" + encodeURIComponent(GIST_ID));
    if (!r.ok) throw new Error("GitHub a répondu " + r.status + (r.status === 404 ? " (GIST_ID ou droits du jeton incorrects)" : ""));
    const g = await r.json();
    const f = g.files && (g.files[GIST_FILE] || Object.values(g.files)[0]);
    let txt = f ? f.content : "";
    if (f && (f.truncated || txt == null) && f.raw_url) txt = await (await ghFetch(f.raw_url)).text();
    let saved = null;
    try { saved = JSON.parse(txt || "{}"); } catch (e) { /* gist vide */ }
    if (hasContent(saved)) {
      if (world.cv > 0 || world.builds.length || Object.keys(world.saves).length) { console.log("Monde en ligne ignoré : le monde local a déjà du contenu."); remoteReady = false; return true; }
      applyLoaded(saved);
      if (saved.seed) world.seed = saved.seed | 0;
      console.log("Monde chargé depuis le Gist GitHub.");
    } else console.log("Gist GitHub vide : nouveau monde.");
    remoteReady = true;
    return true;
  } catch (e) {
    console.error("Lecture du Gist impossible :", e.message);
    return false;
  }
}
let inflight = null;
async function flushRemote(force) {
  if (!REMOTE) return;
  if (inflight) { if (!force) return; try { await inflight; } catch (e) {} }
  if (!remoteReady || !remoteDirty) return;
  if (!force && Date.now() - remoteLast < 15000) return;
  const body = JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(snapshot()) } } });
  remoteDirty = false;
  const job = (async () => {
    try {
      const r = await ghFetch(GH_API + "/gists/" + encodeURIComponent(GIST_ID), { method: "PATCH", body, headers: { "Content-Type": "application/json" } });
      if (!r.ok) throw new Error("GitHub a répondu " + r.status);
      remoteLast = Date.now();
    } catch (e) {
      remoteDirty = true;
      console.error("Sauvegarde en ligne impossible :", e.message);
    }
  })();
  inflight = job;
  try { await job; } finally { if (inflight === job) inflight = null; }
}

let saveTimer = null;
function saveWorld(now) {
  clearTimeout(saveTimer);
  const doSave = () => {
    try {
      fs.writeFileSync(WORLD_FILE + ".tmp", JSON.stringify(snapshot()));
      fs.renameSync(WORLD_FILE + ".tmp", WORLD_FILE);
    } catch (e) { console.error("Sauvegarde locale impossible :", e.message); }
    remoteDirty = true;
    flushRemote(false);
  };
  if (now) doSave(); else saveTimer = setTimeout(doSave, 3000);
}
/* envoi différé si un changement attend (limite : 1 envoi / 15 s) */
setInterval(() => { flushRemote(false); }, 5000);

/* ---------- utilitaires ---------- */
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);
const num = (v, d = 0) => (typeof v === "number" && isFinite(v) ? v : d);

function pushEvent(type, data) {
  seq++;
  events.push({ seq, type, data });
  if (events.length > 300) events.shift();
  wake();
}
function systemChat(text) { pushEvent("chat", { system: true, text }); }

function takenRoles() {
  const t = [];
  for (const p of players.values()) if (ROLES[p.role] && ROLES[p.role].unique) t.push(p.role);
  return t;
}
function lobbyView() {
  return {
    roles: ROLES,
    taken: takenRoles(),
    hostId,
    started: true,
    name: NAME,
    max: MAX,
    players: [...players.values()].map(p => ({
      id: p.id, name: p.name, role: p.role, roleName: ROLES[p.role].name,
      color: ROLES[p.role].color, ready: true
    }))
  };
}
function civicPatchFor(playerId, sinceCv) {
  const patch = {};
  let any = false;
  for (const k of Object.keys(world.civic)) {
    if ((world.keyV[k] || 0) > sinceCv && (sinceCv === 0 || world.keyOwner[k] !== playerId)) {
      patch[k] = world.civic[k];
      any = true;
    }
  }
  return any ? patch : null;
}
function positionsFor(playerId) {
  const out = [];
  for (const p of players.values()) {
    if (p.id === playerId || p.x == null) continue;
    out.push({ type: "peerPos", data: { id: p.id, name: p.name, color: ROLES[p.role].color, role: p.role, x: p.x, z: p.z, yaw: p.yaw } });
  }
  return out;
}

function removePlayer(id, reason) {
  const p = players.get(id);
  if (!p) return;
  players.delete(id);
  lv++; pv++;
  pushEvent("peerLeft", { id });
  systemChat(p.name + " (" + ROLES[p.role].name + ") a quitté le serveur" + (reason ? " — " + reason : "") + ".");
  if (hostId === id) {
    const next = [...players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    hostId = next ? next.id : null;
    if (next) systemChat(next.name + " devient l'hôte de la simulation.");
  }
  console.log("-", p.name, "(" + p.role + ") · joueurs :", players.size);
}

/* ---------- long-poll ---------- */
function buildPollPayload(w) {
  const evs = events.filter(e => e.seq > w.since);
  const out = evs.slice();
  const posChanged = w.pv !== pv;
  if (w.player && posChanged) out.push(...positionsFor(w.player.id));
  const payload = { events: out, seq, v: { lv, pv, cv: world.cv, clock: worldClock() } };
  if (w.lv !== lv) payload.lobby = lobbyView();
  if (w.cv !== world.cv) {
    const patch = civicPatchFor(w.player ? w.player.id : null, w.cv);
    if (patch) payload.state = { civic: patch };
  }
  return payload;
}
function hasNews(w) {
  return events.some(e => e.seq > w.since) || w.lv !== lv || w.cv !== world.cv || (w.player && w.pv !== pv && players.size > 1);
}
function flush(w) {
  clearTimeout(w.timer);
  waiters.delete(w);
  if (w.player) w.player.lastSeen = Date.now();
  send(w.res, 200, buildPollPayload(w));
}
let wakeTimer = null;
function wake() {
  if (wakeTimer) return;
  wakeTimer = setTimeout(() => {      // regroupe les réveils (≈ 10 par seconde max)
    wakeTimer = null;
    for (const w of [...waiters]) if (hasNews(w)) flush(w);
  }, 80);
}

/* ---------- HTTP ---------- */
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Player-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Max-Age", "600");
}
function send(res, code, obj) {
  if (res.writableEnded) return;
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(new Error("Requête trop volumineuse")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const txt = Buffer.concat(chunks).toString("utf8");
      if (!txt) return resolve({});
      try { resolve(JSON.parse(txt)); } catch (e) { resolve({}); }
    });
    req.on("error", reject);
  });
}
function findPlayer(req, url) {
  const id = req.headers["x-player-id"] || url.searchParams.get("id");
  return id ? players.get(String(id)) : null;
}

async function handleApi(req, res, url) {
  const route = url.pathname;
  const player = findPlayer(req, url);
  if (player) player.lastSeen = Date.now();

  if (route === "/api/status") {
    return send(res, 200, {
      name: NAME, motd: MOTD, players: players.size, max: MAX, version: VERSION,
      chapter2: !!world.civic.chapter2Active, game: "ambre-3724", world: world.seed ? world.seed.toString(36).toUpperCase() : "", persist: REMOTE ? (remoteReady ? "gist" : "gist-erreur") : "local"
    });
  }
  if (route === "/api/hello") return send(res, 200, { roles: ROLES, name: NAME, motd: MOTD, max: MAX, version: VERSION });

  if (route === "/api/poll" && req.method === "GET") {
    const q = url.searchParams;
    const w = {
      res, player,
      since: parseInt(q.get("since"), 10) || 0,
      cv: parseInt(q.get("cv"), 10) || 0,
      lv: parseInt(q.get("lv"), 10),
      pv: parseInt(q.get("pv"), 10) || 0
    };
    if (isNaN(w.lv)) w.lv = -1;
    if (hasNews(w) || w.lv === -1) return flush(w);
    w.timer = setTimeout(() => flush(w), 20000);
    waiters.add(w);
    res.on("close", () => { clearTimeout(w.timer); waiters.delete(w); });
    return;
  }

  if (route === "/api/join" && req.method === "POST") {
    const b = await readBody(req);
    const roleId = ROLES[b.role] ? b.role : "citoyen";
    const name = clean(b.name, 24) || "Joueur";
    let pid = typeof b.pid === "string" && /^[A-Za-z0-9_-]{8,48}$/.test(b.pid) ? b.pid : null;
    const worldInfo = (id) => ({
      seed: world.seed, clock: worldClock(), builds: world.builds,
      save: world.saves[id] ? { t: world.saves[id].t, data: world.saves[id].data } : null
    });
    if (b.preview) {   // simple consultation avant d'entrer : n'enregistre pas le joueur
      if (!pid) pid = crypto.randomBytes(12).toString("hex");
      return send(res, 200, Object.assign({ id: pid, preview: true, name: NAME }, worldInfo(pid)));
    }
    let existing = pid ? players.get(pid) : null;
    if (!existing && players.size >= MAX) return send(res, 403, { error: "Serveur plein (" + MAX + "/" + MAX + ")." });
    for (const p of players.values()) {
      if (p !== existing && ROLES[roleId].unique && p.role === roleId) return send(res, 409, { error: "Ce rôle est déjà pris par " + p.name + "." });
    }
    if (!pid) pid = crypto.randomBytes(12).toString("hex");
    let p = existing;
    if (p) { p.name = name; p.role = roleId; p.lastSeen = Date.now(); }
    else {
      p = { id: pid, name, role: roleId, x: null, z: null, yaw: 0, joinedAt: Date.now(), lastSeen: Date.now() };
      players.set(pid, p);
      if (!hostId || !players.has(hostId)) hostId = pid;
      systemChat(name + " a rejoint le serveur" + (roleId === "citoyen" ? "." : " en tant que " + ROLES[roleId].name + "."));
      console.log("+", name, "(" + roleId + ") · joueurs :", players.size);
    }
    lv++; wake();
    return send(res, 200, Object.assign({
      id: pid, role: roleId, roleInfo: ROLES[roleId], isHost: hostId === pid, started: true,
      civic: world.civic, cv: world.cv, name: NAME
    }, worldInfo(pid)));
  }

  if (route === "/api/leave") {
    if (player) removePlayer(player.id);
    return send(res, 200, { ok: true });
  }
  if (route === "/api/ready" || route === "/api/start") return send(res, 200, { ok: true });

  if (!player) return send(res, 401, { error: "Non connecté : rejoins le serveur d'abord." });

  if (route === "/api/save" && req.method === "POST") {
    const b = await readBody(req, 1024 * 1024);
    if (!b || typeof b.data !== "object" || !b.data) return send(res, 400, { error: "Sauvegarde invalide." });
    if (world.seed && b.data.seed !== world.seed) return send(res, 409, { error: "Cette sauvegarde vient d'un autre monde." });
    if (!world.saves[player.id] && Object.keys(world.saves).length >= 200) return send(res, 403, { error: "Trop de sauvegardes sur ce serveur." });
    world.saves[player.id] = { t: num(b.t, Date.now()), name: player.name, data: b.data };
    saveWorld();
    return send(res, 200, { ok: true });
  }

  if (route === "/api/pos" && req.method === "POST") {
    const b = await readBody(req, 4096);
    const x = num(b.x, null), z = num(b.z, null);
    if (x == null || z == null) return send(res, 400, { error: "Position invalide." });
    player.x = Math.max(-1e6, Math.min(1e6, x));
    player.z = Math.max(-1e6, Math.min(1e6, z));
    player.yaw = num(b.yaw, 0);
    pv++; wake();
    return send(res, 200, { ok: true });
  }

  if (route === "/api/action" && req.method === "POST") {
    const b = await readBody(req);
    const type = String(b.type || "");
    const data = b.data && typeof b.data === "object" ? b.data : {};
    if (type === "chat") {
      const text = clean(data.text, 200);
      if (!text) return send(res, 400, { error: "Message vide." });
      pushEvent("chat", { id: player.id, name: player.name, role: ROLES[player.role].name, text });
      return send(res, 200, { ok: true });
    }
    if (type === "setCivic" || type === "fullCivic") {
      let patch = data.patch;
      if (type === "fullCivic") patch = data;
      else if (!patch || typeof patch !== "object") { patch = Object.assign({}, data); delete patch._tab; }
      let changed = 0;
      for (const k of Object.keys(patch)) {
        if (BAD_KEYS.has(k) || k.length > 60) continue;
        if (JSON.stringify(world.civic[k]) === JSON.stringify(patch[k])) continue;
        world.civic[k] = patch[k];
        world.keyOwner[k] = player.id;
        changed++;
      }
      if (changed) {
        world.cv++;
        for (const k of Object.keys(patch)) if (!BAD_KEYS.has(k)) world.keyV[k] = world.cv;
        saveWorld();
        wake();
      }
      return send(res, 200, { ok: true, cv: world.cv });
    }
    if (type === "addBuild") {
      const nb = data.b || {};
      const id = clean(nb.id, 40);
      if (!id || typeof nb.t !== "string" || nb.t.length > 24 || !isFinite(nb.x) || !isFinite(nb.z)) return send(res, 400, { error: "Construction invalide." });
      if (world.builds.some(x => x.id === id)) return send(res, 200, { ok: true, dup: true });
      if (world.builds.length >= 6000) return send(res, 403, { error: "Limite de constructions atteinte." });
      const rec = { id, t: nb.t, x: +nb.x, z: +nb.z, r: num(nb.r, 0), o: player.name };
      if (isFinite(nb.dy)) rec.dy = +nb.dy;
      world.builds.push(rec);
      pushEvent("build", { b: rec });
      saveWorld();
      return send(res, 200, { ok: true });
    }
    if (type === "setTime") {
      const t = num(data.time, -1), d = num(data.day, 0);
      if (t >= 0 && t < 1 && d >= 1 && d < 1e6) {
        world.clock = { time: t, day: Math.floor(d), at: Date.now() };
        saveWorld(); wake();
      }
      return send(res, 200, { ok: true });
    }
    if (type === "startChapter2") {
      if (!world.civic.chapter2Active) systemChat(player.name + " lance le chapitre II.");
      return send(res, 200, { ok: true });
    }
    return send(res, 200, { ok: true });   // actions inconnues ignorées
  }

  return send(res, 404, { error: "Route inconnue." });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, "http://x"); } catch (e) { return send(res, 400, { error: "URL invalide" }); }
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }
  try {
    if (url.pathname === "/healthz") return send(res, 200, { ok: true });
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      fs.readFile(HTML_FILE, (err, buf) => {
        if (err) {
          cors(res);
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          return res.end("Page du jeu introuvable : " + path.basename(HTML_FILE) + "\nPlace Ambre-3724-multijoueur.html à côté de server.js.");
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        res.end(buf);
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Introuvable");
  } catch (e) {
    send(res, 500, { error: e.message || "Erreur serveur" });
  }
});

/* joueurs sans nouvelle depuis 30 s = déconnectés */
setInterval(() => {
  const now = Date.now();
  for (const p of [...players.values()]) if (now - p.lastSeen > 30000) removePlayer(p.id, "connexion perdue");
}, 5000);

let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  console.log("\nArrêt du serveur — sauvegarde du monde…");
  saveWorld(true);
  remoteDirty = true;
  try { await Promise.race([flushRemote(true), new Promise(r => setTimeout(r, 8000))]); } catch (e) {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

(async function boot() {
  if (REMOTE) {
    let ok = false;
    for (let n = 0; n < 4 && !ok; n++) { ok = await loadRemote(); if (!ok) await new Promise(r => setTimeout(r, 2000)); }
    if (!ok) {
      console.error("⚠ Le Gist n'est pas lisible : le monde ne sera PAS sauvegardé en ligne tant que ça ne marche pas (nouvelle tentative toutes les 30 s).");
      const retry = setInterval(async () => { if (await loadRemote()) clearInterval(retry); }, 30000);
    }
  }
  if (!world.seed) { world.seed = 1 + Math.floor(Math.random() * 2147480000); console.log("Nouveau monde, graine " + world.seed.toString(36).toUpperCase()); saveWorld(); }
  server.listen(PORT, "0.0.0.0", () => {
    console.log("\n  " + NAME + "  ·  « " + MOTD + " »");
    console.log("  Joueurs max : " + MAX + "  ·  Monde : " + path.basename(WORLD_FILE) + "\n");
    console.log("  Adresses à donner à tes amis (liste de serveurs du jeu) :");
    console.log("    localhost:" + PORT + "   (cet ordinateur)");
    for (const list of Object.values(os.networkInterfaces()))
      for (const ni of list || []) if (ni.family === "IPv4" && !ni.internal) console.log("    " + ni.address + ":" + PORT + "   (réseau local)");
    console.log("\n  Ou ouvre directement  http://localhost:" + PORT + "/  dans le navigateur.");
    console.log("  Ctrl+C pour arrêter (le monde est sauvegardé).\n");
  });
  console.log(REMOTE ? "  Sauvegarde : fichier local + Gist GitHub (" + (remoteReady ? "actif" : "en attente") + ")\n" : "  Sauvegarde : fichier local uniquement\n");
})();
