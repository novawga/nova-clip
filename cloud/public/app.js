"use strict";
// Nova Clip phone page: sign in with Google, watch clips sent from the PC,
// save them to Photos.

const $ = (id) => document.getElementById(id);
const linkMode = location.pathname === "/link";
const state = { config: null, me: null, clips: [], open: null, saved: null };

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: "same-origin", ...opts });
  if (r.status === 401) { const e = new Error("Sign in first."); e.signedOut = true; throw e; }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

let toastTimer;
function toast(text, bad) {
  const t = $("toast");
  t.textContent = text;
  t.classList.toggle("bad", !!bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

const fmtSize = (b) => b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`;
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
function fmtWhen(ms) {
  const d = new Date(ms), now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= day) return `Today, ${time}`;
  if (ms >= day - 86400000) return `Yesterday, ${time}`;
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

function show(view) {
  for (const v of ["viewWelcome", "viewLink", "viewClips"]) $(v).hidden = v !== view;
}

// ------------------------------------------------------------------ sign-in
function googleButton(el) {
  const go = () => {
    if (!window.google || !google.accounts) return setTimeout(go, 150);
    google.accounts.id.initialize({
      client_id: state.config.googleClientId,
      ux_mode: "redirect",
      login_uri: location.origin + "/auth/google",
      auto_select: false,
    });
    el.innerHTML = "";
    google.accounts.id.renderButton(el, { theme: "filled_black", size: "large", shape: "pill", text: "continue_with", width: Math.min(340, el.clientWidth || 340) });
  };
  go();
}

function renderMe() {
  const m = state.me;
  $("meBtn").hidden = !m;
  if (!m) return;
  $("meImg").src = m.picture || "";
  $("meInitial").textContent = m.picture ? "" : (m.name || m.email || "?").slice(0, 1).toUpperCase();
  $("meName").textContent = m.name || "Signed in";
  $("meEmail").textContent = m.email || "";
  $("spaceUsed").textContent = fmtSize(m.used);
  $("spaceOf").textContent = `of ${fmtSize(m.quota)} used`;
  $("spaceBar").style.width = `${Math.min(100, (m.used / m.quota) * 100).toFixed(1)}%`;
}

$("meBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = $("menu").hidden;
  $("menu").hidden = !open;
  $("meBtn").setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (e) => { if (!e.target.closest("#menu")) $("menu").hidden = true; });
$("signOutBtn").addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
  if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
  location.replace("/");
});

// -------------------------------------------------------------------- clips
function clipCard(c) {
  const b = document.createElement("button");
  b.className = "clip";
  b.innerHTML = `<span class="thumb">${c.hasThumb ? `<img loading="lazy" alt="">` : `<span class="ph"><svg><use href="#i-film"/></svg></span>`}<span class="dur"></span></span><span class="clip-name"></span><span class="clip-meta"></span>`;
  if (c.hasThumb) b.querySelector("img").src = `/api/clips/${c.id}/thumb`;
  b.querySelector(".dur").textContent = fmtDur(c.duration || 0);
  b.querySelector(".clip-name").textContent = c.name;
  b.querySelector(".clip-meta").textContent = [c.game, fmtWhen(c.recorded)].filter(Boolean).join(", ");
  b.addEventListener("click", () => openClip(c));
  return b;
}

function renderClips() {
  const g = $("grid");
  g.innerHTML = "";
  $("clipCount").textContent = state.clips.length ? String(state.clips.length) : "";
  if (!state.clips.length) {
    g.innerHTML = `<div class="empty"><b>No clips here yet</b>In Nova Clip on your PC, open a clip and press Send to phone. Or turn on sending every new clip in Settings → Phone.</div>`;
    return;
  }
  for (const c of state.clips) g.appendChild(clipCard(c));
}

async function load() {
  try {
    const [me, list] = await Promise.all([api("/api/me"), api("/api/clips")]);
    state.me = me;
    state.clips = list.clips;
    renderMe();
    renderClips();
    return true;
  } catch (e) {
    if (e.signedOut) return false;
    toast(e.message, true);
    return true;
  }
}

$("refreshBtn").addEventListener("click", async () => { await load(); toast("Up to date"); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !$("viewClips").hidden && $("sheet").hidden) load();
});

// ------------------------------------------------------------------- player
function openClip(c) {
  state.open = c;
  state.saved = null;
  $("sheetTitle").textContent = c.name;
  $("sheetMeta").textContent = [c.game, fmtWhen(c.recorded), fmtDur(c.duration || 0), fmtSize(c.size)].filter(Boolean).join(", ");
  $("video").src = `/api/clips/${c.id}/video`;
  $("downloadBtn").href = `/api/clips/${c.id}/video?download=1`;
  $("saveLabel").textContent = canShareFiles() ? "Save to Photos" : "Save";
  $("saveBtn").disabled = false;
  $("saveHelp").hidden = true;
  $("sheet").hidden = false;
  document.body.style.overflow = "hidden";
  history.pushState({ clip: c.id }, "");
}

function closeClip(fromHistory) {
  if ($("sheet").hidden) return;
  const v = $("video");
  v.pause();
  v.removeAttribute("src");
  v.load();
  $("sheet").hidden = true;
  document.body.style.overflow = "";
  state.open = null;
  state.saved = null;
  if (!fromHistory && history.state && history.state.clip) history.back();
}
$("sheetClose").addEventListener("click", () => closeClip(false));
window.addEventListener("popstate", () => closeClip(true));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeClip(false); });

function canShareFiles() {
  try {
    return !!(navigator.canShare && navigator.canShare({ files: [new File([""], "x.mp4", { type: "video/mp4" })] }));
  } catch { return false; }
}

function fileName(c) {
  const n = c.name.replace(/[\\/:*?"<>|]/g, "").trim() || "clip";
  return n.toLowerCase().endsWith(".mp4") ? n : n + ".mp4";
}

// Save to Photos: iPhone only offers "Save Video" from the share sheet, and
// the share sheet has to open right after a tap, so it takes two taps when
// the clip is big: one to get it, one to save it.
$("saveBtn").addEventListener("click", async () => {
  const c = state.open;
  if (!c) return;
  if (!canShareFiles()) { $("downloadBtn").click(); return; }
  if (state.saved && state.saved.id === c.id) return share(state.saved.file);
  const btn = $("saveBtn");
  btn.disabled = true;
  try {
    const r = await fetch(`/api/clips/${c.id}/video`, { credentials: "same-origin" });
    if (!r.ok) throw new Error("Couldn't get the clip.");
    const total = c.size;
    const reader = r.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      $("saveLabel").textContent = `Getting it… ${Math.min(99, Math.floor((got / total) * 100))}%`;
    }
    if (state.open !== c) return;
    const file = new File(chunks, fileName(c), { type: "video/mp4" });
    state.saved = { id: c.id, file };
    $("saveLabel").textContent = "Tap to save";
    $("saveHelp").textContent = "Then choose “Save Video”.";
    $("saveHelp").hidden = false;
    btn.disabled = false;
    if (navigator.userActivation && navigator.userActivation.isActive) share(file);
  } catch (e) {
    btn.disabled = false;
    $("saveLabel").textContent = "Save to Photos";
    toast(e.message || "Couldn't save it.", true);
  }
});

async function share(file) {
  try {
    await navigator.share({ files: [file], title: file.name });
  } catch (e) {
    if (e && e.name === "AbortError") return;
    toast("Couldn't open the share sheet. Use Download instead.", true);
  }
}

$("deleteBtn").addEventListener("click", async () => {
  const c = state.open;
  if (!c || !confirm(`Delete “${c.name}” from your phone? It stays on your PC.`)) return;
  try {
    await api(`/api/clips/${c.id}`, { method: "DELETE" });
    closeClip(false);
    await load();
    toast("Deleted");
  } catch (e) { toast(e.message, true); }
});

// --------------------------------------------------------------------- start
(async function start() {
  try {
    state.config = await api("/api/config");
  } catch {
    state.config = { googleClientId: "" };
  }
  const signedIn = await load();
  if (linkMode) {
    show("viewLink");
    if (signedIn && state.me) {
      $("continueAs").textContent = state.me.email || state.me.name;
      $("continueForm").hidden = false;
      $("gbtnLink").hidden = true;
      $("otherAccount").addEventListener("click", () => {
        $("continueForm").hidden = true;
        $("gbtnLink").hidden = false;
        googleButton($("gbtnLink"));
      });
    } else if (state.config.googleClientId) {
      googleButton($("gbtnLink"));
    } else {
      $("setupNoteLink").hidden = false;
    }
    return;
  }
  if (signedIn) { show("viewClips"); return; }
  show("viewWelcome");
  if (state.config.googleClientId) googleButton($("gbtn"));
  else $("setupNote").hidden = false;
})();
