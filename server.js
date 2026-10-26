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
const world = { civic: {}, cv: 0, keyV: {}, keyOwner: {} };
const players = new Map();   // id -> joueur
let hostId = null;
let seq = 0;
const events = [];           // anneau d'événements (chat, départs…)
let lv = 1;                  // version du lobby
let pv = 1;                  // version des positions
const waiters = new Set();   // requêtes poll en attente

try {
  const saved = JSON.parse(fs.readFileSync(WORLD_FILE, "utf8"));
  if (saved && saved.civic && typeof saved.civic === "object") {
    world.civic = saved.civic;
    world.cv = saved.cv | 0;
    for (const k of Object.keys(world.civic)) world.keyV[k] = world.cv;
    console.log("Monde chargé depuis", path.basename(WORLD_FILE), "(version " + world.cv + ")");
  }
} catch (e) { /* nouveau monde */ }

let saveTimer = null;
function saveWorld(now) {
  clearTimeout(saveTimer);
  const doSave = () => {
    try {
      fs.writeFileSync(WORLD_FILE + ".tmp", JSON.stringify({ civic: world.civic, cv: world.cv }));
      fs.renameSync(WORLD_FILE + ".tmp", WORLD_FILE);
    } catch (e) { console.error("Sauvegarde impossible :", e.message); }
  };
  if (now) doSave(); else saveTimer = setTimeout(doSave, 3000);
}

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
  const payload = { events: out, seq, v: { lv, pv, cv: world.cv } };
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
      chapter2: !!world.civic.chapter2Active, game: "ambre-3724"
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
    const roleId = ROLES[b.role] ? b.role : null;
    if (!roleId) return send(res, 400, { error: "Rôle inconnu." });
    const name = clean(b.name, 24) || "Joueur";
    let pid = typeof b.pid === "string" && /^[A-Za-z0-9_-]{8,48}$/.test(b.pid) ? b.pid : null;
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
      systemChat(name + " a rejoint le serveur en tant que " + ROLES[roleId].name + ".");
      console.log("+", name, "(" + roleId + ") · joueurs :", players.size);
    }
    lv++; wake();
    return send(res, 200, {
      id: pid, role: roleId, roleInfo: ROLES[roleId], isHost: hostId === pid, started: true,
      civic: world.civic, cv: world.cv, name: NAME
    });
  }

  if (route === "/api/leave") {
    if (player) removePlayer(player.id);
    return send(res, 200, { ok: true });
  }
  if (route === "/api/ready" || route === "/api/start") return send(res, 200, { ok: true });

  if (!player) return send(res, 401, { error: "Non connecté : rejoins le serveur d'abord." });

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

function shutdown() {
  console.log("\nArrêt du serveur — sauvegarde du monde…");
  saveWorld(true);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

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
