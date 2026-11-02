// Nova Clip cloud
//
// Nova Clip on a PC uploads clips here; the phone page (public/) shows them.
// Everyone signs in with Google. Each person has their own clips and their own
// space (QUOTA_BYTES); when it's full, their oldest clips here are deleted
// (they're still on the PC).
//
// Storage: R2 (BUCKET) holds the videos and thumbnails, D1 (DB) the people,
// sign-ins and the list of clips.

const SESSION_COOKIE = "nc_session";
const LINK_COOKIE = "nc_link";
const PART_SIZE = 50 * 1024 * 1024; // Workers take request bodies up to 100 MB
const MAX_CLIP = 4 * 1024 * 1024 * 1024;
const MAX_THUMB = 2 * 1024 * 1024;

export default {
  async fetch(request, env, ctx) {
    try {
      await ensureSchema(env);
      return await route(request, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e && e.stack || e);
      return json({ error: "Something went wrong on the server." }, 500);
    }
  },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// --------------------------------------------------------------------- routes
async function route(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname;
  const m = request.method;

  if (p === "/api/config" && m === "GET") {
    return json({ googleClientId: env.GOOGLE_CLIENT_ID || "", quota: quota(env) });
  }
  if (p === "/auth/google" && m === "POST") return googleRedirect(request, env, url);
  if (p === "/auth/logout" && m === "POST") return logout(request, env);
  if (p === "/auth/device" && m === "POST") return deviceFromSession(request, env);
  if (p === "/link" && m === "GET") return linkStart(request, env, url);
  // local testing only: wrangler dev --var DEV_LOGIN:1 (never set when deployed)
  if (p === "/auth/dev" && m === "POST" && env.DEV_LOGIN === "1") {
    const b = await request.json();
    const userId = await upsertUser(env, { sub: "dev-" + b.email, email: b.email, name: b.email.split("@")[0] });
    if (b.quota) await env.DB.prepare("UPDATE users SET quota = ? WHERE id = ?").bind(+b.quota, userId).run();
    const token = await newSession(env, userId, b.device ? "device" : "web", "dev");
    return json({ token }, 200, b.device ? {} : { "set-cookie": cookie(SESSION_COOKIE, token, 3600) });
  }

  if (p.startsWith("/api/")) {
    const who = await signedIn(request, env);
    if (!who) throw new HttpError(401, "Sign in first.");

    if (p === "/api/me" && m === "GET") return json(await me(env, who));
    if (p === "/api/clips" && m === "GET") return json({ clips: await listClips(env, who.userId) });
    if (p === "/api/uploads" && m === "POST") return startUpload(request, env, who);
    if (p === "/api/devices" && m === "DELETE") return signOutDevice(env, who);

    let r;
    if ((r = p.match(/^\/api\/uploads\/([a-f0-9]{32})\/parts\/(\d{1,4})$/)) && m === "PUT") return uploadPart(request, env, who, r[1], +r[2]);
    if ((r = p.match(/^\/api\/uploads\/([a-f0-9]{32})\/complete$/)) && m === "POST") return completeUpload(request, env, who, r[1]);
    if ((r = p.match(/^\/api\/uploads\/([a-f0-9]{32})$/)) && m === "DELETE") return abortUpload(env, who, r[1]);
    if ((r = p.match(/^\/api\/clips\/([a-f0-9]{32})\/video$/)) && (m === "GET" || m === "HEAD")) return video(request, env, who, r[1], url);
    if ((r = p.match(/^\/api\/clips\/([a-f0-9]{32})\/thumb$/)) && m === "GET") return thumb(env, who, r[1]);
    if ((r = p.match(/^\/api\/clips\/([a-f0-9]{32})\/thumb$/)) && m === "PUT") return putThumb(request, env, who, r[1]);
    if ((r = p.match(/^\/api\/clips\/([a-f0-9]{32})$/)) && m === "DELETE") return deleteClip(env, who, r[1]);
    if ((r = p.match(/^\/api\/clips\/([a-f0-9]{32})$/)) && m === "PATCH") return renameClip(request, env, who, r[1]);
    throw new HttpError(404, "Not found.");
  }
  return env.ASSETS.fetch(request);
}

// --------------------------------------------------------------------- schema
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, google_sub TEXT UNIQUE NOT NULL, email TEXT, name TEXT, picture TEXT,
      quota INTEGER, created INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, label TEXT,
      created INTEGER NOT NULL, last_used INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS clips (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, game TEXT,
      size INTEGER NOT NULL, duration REAL, width INTEGER, height INTEGER,
      recorded INTEGER, created INTEGER NOT NULL, status TEXT NOT NULL,
      upload_id TEXT, has_thumb INTEGER NOT NULL DEFAULT 0, source TEXT)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS clips_user ON clips (user_id, status, created)`),
  ]);
  schemaReady = true;
}

// ---------------------------------------------------------------------- helpers
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function quota(env) {
  const q = parseInt(env.QUOTA_BYTES, 10);
  return q > 0 ? q : 2 * 1024 * 1024 * 1024;
}

function randomHex(bytes = 16) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cookies(request) {
  const out = {};
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clean(s, max) {
  return String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

const clipKey = (userId, clipId) => `u/${userId}/${clipId}.mp4`;
const thumbKey = (userId, clipId) => `u/${userId}/${clipId}.jpg`;

// ------------------------------------------------------------- Google sign-in
// Google's "Sign in with Google" posts a signed ID token here (redirect mode,
// which also works in a home-screen app on iPhone). It's checked against
// Google's public keys, so no secret is needed.
let googleKeys = null; // { keys, until }

async function googleKey(kid) {
  if (!googleKeys || googleKeys.until < Date.now() || !googleKeys.keys[kid]) {
    const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
    if (!r.ok) throw new HttpError(502, "Couldn't reach Google to check the sign-in.");
    const age = /max-age=(\d+)/.exec(r.headers.get("cache-control") || "");
    const { keys } = await r.json();
    const map = {};
    for (const k of keys) map[k.kid] = k;
    googleKeys = { keys: map, until: Date.now() + (age ? +age[1] : 3600) * 1000 };
  }
  const jwk = googleKeys.keys[kid];
  if (!jwk) return null;
  return crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

function b64urlBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function verifyGoogleToken(env, token) {
  if (!env.GOOGLE_CLIENT_ID) throw new HttpError(503, "Google sign-in isn't set up yet.");
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new HttpError(400, "That sign-in didn't work. Try again.");
  const header = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[1])));
  if (header.alg !== "RS256") throw new HttpError(400, "That sign-in didn't work. Try again.");
  const key = await googleKey(header.kid);
  const ok = key && await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1]));
  const now = Date.now() / 1000;
  if (!ok || claims.aud !== env.GOOGLE_CLIENT_ID ||
      (claims.iss !== "accounts.google.com" && claims.iss !== "https://accounts.google.com") ||
      !(claims.exp > now) || !claims.sub) {
    throw new HttpError(401, "That sign-in didn't work. Try again.");
  }
  return claims;
}

async function upsertUser(env, claims) {
  const now = Date.now();
  const existing = await env.DB.prepare("SELECT id FROM users WHERE google_sub = ?").bind(claims.sub).first();
  if (existing) {
    await env.DB.prepare("UPDATE users SET email = ?, name = ?, picture = ? WHERE id = ?")
      .bind(claims.email || "", clean(claims.name, 120), claims.picture || "", existing.id).run();
    return existing.id;
  }
  const id = randomHex();
  await env.DB.prepare("INSERT INTO users (id, google_sub, email, name, picture, created) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, claims.sub, claims.email || "", clean(claims.name, 120), claims.picture || "", now).run();
  return id;
}

async function newSession(env, userId, kind, label) {
  const token = randomHex(32);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (hash, user_id, kind, label, created, last_used) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256(token), userId, kind, clean(label, 80), now, now).run();
  return token;
}

async function googleRedirect(request, env, url) {
  const form = await request.formData();
  // Google's double-submit check against cross-site posts
  const csrf = form.get("g_csrf_token");
  if (!csrf || csrf !== cookies(request).g_csrf_token) throw new HttpError(400, "That sign-in didn't work. Try again.");
  const claims = await verifyGoogleToken(env, form.get("credential"));
  const userId = await upsertUser(env, claims);
  const token = await newSession(env, userId, "web", request.headers.get("user-agent") || "");
  const headers = new Headers({ "set-cookie": cookie(SESSION_COOKIE, token, 400 * 86400), "cache-control": "no-store" });
  // signing in to connect Nova Clip on a PC: hand that copy its own key
  const link = parseLink(cookies(request)[LINK_COOKIE]);
  if (link) {
    headers.append("set-cookie", cookie(LINK_COOKIE, "", 0));
    const device = await newSession(env, userId, "device", "Nova Clip");
    headers.set("location", loopback(link, device));
  } else {
    headers.set("location", "/");
  }
  return new Response(null, { status: 303, headers });
}

// Nova Clip opens /link?port=…&state=… in the browser; after signing in the
// browser is sent back to Nova Clip on this PC (127.0.0.1) with a key.
function parseLink(v) {
  const m = /^(\d{4,5})\.([A-Za-z0-9]{16,64})$/.exec(v || "");
  if (!m || +m[1] < 1024 || +m[1] > 65535) return null;
  return { port: +m[1], state: m[2] };
}

function loopback(link, token) {
  return `http://127.0.0.1:${link.port}/cloud/done?state=${link.state}&token=${token}`;
}

async function linkStart(request, env, url) {
  const v = `${url.searchParams.get("port")}.${url.searchParams.get("state")}`;
  if (!parseLink(v)) throw new HttpError(400, "Open this from Nova Clip on your PC.");
  const page = await env.ASSETS.fetch(new Request(new URL("/", url), request)); // the page itself sees it's on /link
  const r = new Response(page.body, page);
  r.headers.append("set-cookie", cookie(LINK_COOKIE, v, 900));
  r.headers.set("cache-control", "no-store");
  return r;
}

// "Continue as …": already signed in on this browser, so connect the PC.
async function deviceFromSession(request, env) {
  const who = await signedIn(request, env);
  const link = parseLink(cookies(request)[LINK_COOKIE]);
  if (!who || !link) return new Response(null, { status: 303, headers: { location: "/" } });
  const device = await newSession(env, who.userId, "device", "Nova Clip");
  const headers = new Headers({ location: loopback(link, device), "cache-control": "no-store" });
  headers.append("set-cookie", cookie(LINK_COOKIE, "", 0));
  return new Response(null, { status: 303, headers });
}

async function signedIn(request, env) {
  let token = "";
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) token = auth.slice(7).trim();
  else token = cookies(request)[SESSION_COOKIE] || "";
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const hash = await sha256(token);
  const row = await env.DB.prepare("SELECT user_id, kind, last_used FROM sessions WHERE hash = ?").bind(hash).first();
  if (!row) return null;
  if (Date.now() - row.last_used > 3600 * 1000) {
    await env.DB.prepare("UPDATE sessions SET last_used = ? WHERE hash = ?").bind(Date.now(), hash).run();
  }
  return { userId: row.user_id, kind: row.kind, hash };
}

async function logout(request, env) {
  const who = await signedIn(request, env);
  if (who) await env.DB.prepare("DELETE FROM sessions WHERE hash = ?").bind(who.hash).run();
  return json({ ok: true }, 200, { "set-cookie": cookie(SESSION_COOKIE, "", 0) });
}

// Nova Clip's "Sign out": forget this PC's key.
async function signOutDevice(env, who) {
  await env.DB.prepare("DELETE FROM sessions WHERE hash = ?").bind(who.hash).run();
  return json({ ok: true });
}

// --------------------------------------------------------------------- clips
async function usedBytes(env, userId) {
  const r = await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS used FROM clips WHERE user_id = ? AND status = 'ready'").bind(userId).first();
  return r.used;
}

async function userQuota(env, userId) {
  const u = await env.DB.prepare("SELECT quota FROM users WHERE id = ?").bind(userId).first();
  return (u && u.quota > 0) ? u.quota : quota(env);
}

async function me(env, who) {
  const u = await env.DB.prepare("SELECT email, name, picture FROM users WHERE id = ?").bind(who.userId).first();
  return { email: u.email, name: u.name, picture: u.picture, used: await usedBytes(env, who.userId), quota: await userQuota(env, who.userId) };
}

function clipOut(c) {
  return { id: c.id, name: c.name, game: c.game || "", size: c.size, duration: c.duration || 0,
    width: c.width || 0, height: c.height || 0, recorded: c.recorded || c.created, created: c.created,
    hasThumb: !!c.has_thumb, source: c.source || "" };
}

async function listClips(env, userId) {
  const { results } = await env.DB.prepare("SELECT * FROM clips WHERE user_id = ? AND status = 'ready' ORDER BY recorded DESC, created DESC LIMIT 1000").bind(userId).all();
  return results.map(clipOut);
}

async function ownClip(env, who, clipId, status = "ready") {
  const c = await env.DB.prepare("SELECT * FROM clips WHERE id = ? AND user_id = ?").bind(clipId, who.userId).first();
  if (!c || (status && c.status !== status)) throw new HttpError(404, "That clip isn't here anymore.");
  return c;
}

// Make room: delete this person's oldest clips until they fit in their space.
async function makeRoom(env, userId, need, keepId) {
  const limit = await userQuota(env, userId);
  let used = await usedBytes(env, userId);
  if (used + need <= limit) return [];
  const { results } = await env.DB.prepare("SELECT id, size FROM clips WHERE user_id = ? AND status = 'ready' AND id != ? ORDER BY recorded ASC, created ASC").bind(userId, keepId || "").all();
  const removed = [];
  for (const c of results) {
    if (used + need <= limit) break;
    await env.BUCKET.delete([clipKey(userId, c.id), thumbKey(userId, c.id)]);
    await env.DB.prepare("DELETE FROM clips WHERE id = ?").bind(c.id).run();
    used -= c.size;
    removed.push(c.id);
  }
  return removed;
}

async function cleanupStale(env, userId) {
  const old = Date.now() - 24 * 3600 * 1000;
  const { results } = await env.DB.prepare("SELECT id, upload_id FROM clips WHERE user_id = ? AND status = 'uploading' AND created < ?").bind(userId, old).all();
  for (const c of results) {
    try { await env.BUCKET.resumeMultipartUpload(clipKey(userId, c.id), c.upload_id).abort(); } catch {}
    await env.BUCKET.delete(thumbKey(userId, c.id));
    await env.DB.prepare("DELETE FROM clips WHERE id = ?").bind(c.id).run();
  }
}

async function startUpload(request, env, who) {
  const b = await request.json().catch(() => ({}));
  const size = Math.floor(+b.size || 0);
  if (!(size > 0) || size > MAX_CLIP) throw new HttpError(400, "That clip is too big to send.");
  const limit = await userQuota(env, who.userId);
  if (size > limit) throw new HttpError(413, `That clip is bigger than your ${fmtGB(limit)} of space. Trim it first.`);
  await cleanupStale(env, who.userId);
  // the same clip again (same name and size): it's already here
  const name = clean(b.name, 160) || "Clip";
  const dupe = await env.DB.prepare("SELECT id FROM clips WHERE user_id = ? AND status = 'ready' AND name = ? AND size = ?").bind(who.userId, name, size).first();
  if (dupe) return json({ id: dupe.id, already: true });
  const id = randomHex();
  const mpu = await env.BUCKET.createMultipartUpload(clipKey(who.userId, id), { httpMetadata: { contentType: "video/mp4" } });
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO clips (id, user_id, name, game, size, duration, width, height, recorded, created, status, upload_id, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)`)
    .bind(id, who.userId, name, clean(b.game, 80), size, +b.duration || 0, Math.floor(+b.width || 0), Math.floor(+b.height || 0),
      Math.floor(+b.recorded || 0) || now, now, mpu.uploadId, clean(b.source, 40)).run();
  return json({ id, partSize: PART_SIZE, parts: Math.ceil(size / PART_SIZE) });
}

async function uploadPart(request, env, who, clipId, n) {
  const c = await ownClip(env, who, clipId, "uploading");
  if (n < 1 || n > Math.ceil(c.size / PART_SIZE)) throw new HttpError(400, "Bad part number.");
  const len = +request.headers.get("content-length");
  if (!(len > 0) || len > PART_SIZE) throw new HttpError(400, "Bad part size.");
  const mpu = env.BUCKET.resumeMultipartUpload(clipKey(who.userId, clipId), c.upload_id);
  const part = await mpu.uploadPart(n, request.body);
  return json({ partNumber: part.partNumber, etag: part.etag });
}

async function completeUpload(request, env, who, clipId) {
  const c = await ownClip(env, who, clipId, "uploading");
  const b = await request.json().catch(() => ({}));
  const parts = (Array.isArray(b.parts) ? b.parts : []).map((p) => ({ partNumber: +p.partNumber, etag: String(p.etag) }))
    .sort((a, z) => a.partNumber - z.partNumber);
  if (parts.length !== Math.ceil(c.size / PART_SIZE)) throw new HttpError(400, "Some of the clip is missing.");
  const mpu = env.BUCKET.resumeMultipartUpload(clipKey(who.userId, clipId), c.upload_id);
  const obj = await mpu.complete(parts);
  if (obj.size !== c.size) {
    await env.BUCKET.delete(clipKey(who.userId, clipId));
    await env.DB.prepare("DELETE FROM clips WHERE id = ?").bind(clipId).run();
    throw new HttpError(400, "The clip didn't arrive whole. Try again.");
  }
  const removed = await makeRoom(env, who.userId, c.size, clipId);
  await env.DB.prepare("UPDATE clips SET status = 'ready', upload_id = NULL WHERE id = ?").bind(clipId).run();
  return json({ id: clipId, removed, used: await usedBytes(env, who.userId), quota: await userQuota(env, who.userId) });
}

async function abortUpload(env, who, clipId) {
  const c = await ownClip(env, who, clipId, "uploading");
  try { await env.BUCKET.resumeMultipartUpload(clipKey(who.userId, clipId), c.upload_id).abort(); } catch {}
  await env.BUCKET.delete(thumbKey(who.userId, clipId));
  await env.DB.prepare("DELETE FROM clips WHERE id = ?").bind(clipId).run();
  return json({ ok: true });
}

async function putThumb(request, env, who, clipId) {
  const c = await ownClip(env, who, clipId, null);
  const len = +request.headers.get("content-length");
  if (!(len > 0) || len > MAX_THUMB) throw new HttpError(400, "Bad thumbnail.");
  await env.BUCKET.put(thumbKey(who.userId, clipId), request.body, { httpMetadata: { contentType: "image/jpeg" } });
  await env.DB.prepare("UPDATE clips SET has_thumb = 1 WHERE id = ?").bind(c.id).run();
  return json({ ok: true });
}

async function thumb(env, who, clipId) {
  await ownClip(env, who, clipId);
  const obj = await env.BUCKET.get(thumbKey(who.userId, clipId));
  if (!obj) throw new HttpError(404, "No thumbnail.");
  return new Response(obj.body, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" } });
}

function safeFileName(name) {
  const base = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim() || "clip";
  return base.toLowerCase().endsWith(".mp4") ? base : base + ".mp4";
}

async function video(request, env, who, clipId, url) {
  const c = await ownClip(env, who, clipId);
  const key = clipKey(who.userId, clipId);
  const headers = new Headers({
    "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "private, max-age=3600",
  });
  if (url.searchParams.get("download")) {
    const fname = safeFileName(c.name);
    headers.set("content-disposition", `attachment; filename="${fname.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  }
  if (request.method === "HEAD") {
    headers.set("content-length", String(c.size));
    return new Response(null, { headers });
  }
  const range = parseRange(request.headers.get("range"), c.size);
  if (range === false) {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${c.size}` } });
  }
  const obj = await env.BUCKET.get(key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : {});
  if (!obj) throw new HttpError(404, "That clip isn't here anymore.");
  if (range) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${c.size}`);
    headers.set("content-length", String(range.end - range.start + 1));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(c.size));
  return new Response(obj.body, { headers });
}

function parseRange(h, size) {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start, end;
  if (m[1] === "") { // last N bytes
    const n = +m[2];
    if (!n) return false;
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = +m[1]; end = m[2] === "" ? size - 1 : Math.min(+m[2], size - 1);
  }
  if (start >= size || start > end) return false;
  return { start, end };
}

async function deleteClip(env, who, clipId) {
  await ownClip(env, who, clipId);
  await env.BUCKET.delete([clipKey(who.userId, clipId), thumbKey(who.userId, clipId)]);
  await env.DB.prepare("DELETE FROM clips WHERE id = ?").bind(clipId).run();
  return json({ ok: true, used: await usedBytes(env, who.userId) });
}

async function renameClip(request, env, who, clipId) {
  await ownClip(env, who, clipId);
  const b = await request.json().catch(() => ({}));
  const name = clean(b.name, 160);
  if (!name) throw new HttpError(400, "Give it a name.");
  await env.DB.prepare("UPDATE clips SET name = ? WHERE id = ?").bind(name, clipId).run();
  return json({ ok: true });
}

function fmtGB(b) {
  return b >= 1024 ** 3 ? `${+(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`;
}
