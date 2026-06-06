// Phone controllers — rendered per assigned role. Fixed viewport, no scroll.
import { Bus, diatonic } from "/js/shared.js";

const bus = new Bus("auto");
const screen = document.getElementById("screen");
// Best-effort native portrait lock (works in standalone/fullscreen on Android);
// everywhere else phone.css counter-rotates the UI in landscape instead.
try { window.screen.orientation?.lock?.("portrait").catch(() => {}); } catch {}
let me = null, st = null, roster = [];

bus.on("welcome", (m) => {
  me = m; st = m.state; roster = m.roster || [];
  document.documentElement.style.setProperty("--role", m.color);
  // Pre-jam: onboard in the lobby. Late joiners (phase already "jam") skip
  // straight to their role UI — personalization is an upgrade, never a gate.
  if (st.phase === "lobby") renderLobby(); else render();
});
bus.on("state", (m) => {
  const wasLobby = st?.phase === "lobby";
  st = m.state; roster = m.roster || roster;
  if (wasLobby && st.phase === "jam" && me) { closeAvPick(); render(); return; }  // host started → flip to role UI
  if (st.phase === "lobby") refreshLobby(); else refresh();
});
bus.on("roster", (m) => { roster = m.roster || roster; if (st?.phase === "lobby") refreshLobby(); });
bus.on("beat", (m) => onBeat(m));

// ===================================================== chord theory (local — keeps shared.js untouched)
const NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const QUAL = [
  { id:"maj", suf:"",     iv:[0,4,7] },     { id:"min", suf:"m",   iv:[0,3,7] },
  { id:"7",   suf:"7",    iv:[0,4,7,10] },  { id:"maj7",suf:"maj7",iv:[0,4,7,11] },
  { id:"m7",  suf:"m7",   iv:[0,3,7,10] },  { id:"dim", suf:"dim", iv:[0,3,6] },
  { id:"aug", suf:"aug",  iv:[0,4,8] },     { id:"sus2",suf:"sus2",iv:[0,2,7] },
  { id:"sus4",suf:"sus4", iv:[0,5,7] },     { id:"add9",suf:"add9",iv:[0,4,7,14] },
  { id:"m7b5",suf:"m7♭5", iv:[0,3,6,10] },
];
const qOf = (id) => QUAL.find((q) => q.id === id) || QUAL[0];
const chordLabel = (root, qid) => NAMES[root] + qOf(qid).suf;
const chordMidiNotes = (root, qid, oct = 4) => qOf(qid).iv.map((iv) => 12 * (oct + 1) + root + iv);
const DSTEP = [0,2,4,5,7,9,11], DQUAL = ["maj","min","min","maj","maj","min","dim"], ROMANS = ["I","ii","iii","IV","V","vi","vii°"];
function diatonicSlot(key, deg) {
  const root = (NAMES.indexOf(key) + DSTEP[deg]) % 12;
  return { root, quality: DQUAL[deg], roman: ROMANS[deg] };
}

// ===================================================== shared chrome
// Slim header only — no fake status bar, no player squares (removed per design).
function slimHeader(label) {
  return `<div class="ph-top"><div class="chip"></div><div class="role caps">${label}</div>
    <span class="live"><span class="dot" id="livedot"></span></span></div>`;
}
function onBeat(m) {
  document.querySelectorAll("#livedot,.banner .dot").forEach((d) => { d.classList.add("pulse"); setTimeout(() => d.classList.remove("pulse"), 110); });
  if (me?.role === "lead") leadStep = (leadStep + 1) % 16;
  if (me?.role === "harmony") harmonyOnBeat(m);   // soft phase-lock; rAF animates the playhead
}

// ===================================================== LOBBY (pre-jam onboarding)
// Avatars are images (assets/pfps) held EXCLUSIVELY: the server hands each player a
// random free one on join; the pen opens a picker where taken ones are dimmed. The
// server is the source of truth — we claim optimistically and the roster echo
// confirms (or reverts, if someone else grabbed it first).
const AVATARS = ["pickle","duck","frog","dog","cat","rocker","alien","cow","pig","rasta","cantor","baba"];
const avImg = (a) => a ? `<img src="/assets/pfps/${a}.png" alt="${a}" draggable="false">` : "";
let myName = "", myAvatar = "", amReady = false;
let profileTimer = null;
function sendProfile() {
  clearTimeout(profileTimer);
  profileTimer = setTimeout(() => bus.control("profile", { name: myName }), 250);
}
function syncMyAvatar() {           // server roster = truth (handles rejected claims + reassigns)
  const mine = roster.find((r) => r.id === me?.id);
  if (mine) myAvatar = mine.avatar || "";
}
function renderLobby() {
  // default name comes from the server (silly alliterative pick, e.g. "KILLER KANGAROO")
  myName ||= roster.find((r) => r.id === me.id)?.name || `PLAYER ${me.id}`;
  syncMyAvatar();
  screen.innerHTML = slimHeader(me.role.toUpperCase()) + `
    <div class="lobby">
      <div class="lb-lbl caps">your name</div>
      <input id="lbname" class="lb-input" maxlength="24" autocomplete="off" />
      <div class="lb-lbl caps">your avatar</div>
      <div class="lb-me">
        <div class="lb-avbig" id="lbavbig">${avImg(myAvatar)}</div>
        <button class="lb-pen" id="lbpen" aria-label="edit avatar">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
            stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 3l4 4L8 20l-5 1 1-5L17 3z"/><path d="M14.5 5.5l4 4"/>
          </svg>
        </button>
      </div>
      <div class="lb-lbl caps">what are you into?</div>
      <textarea id="lbtaste" class="lb-taste" maxlength="200" rows="2"
        placeholder="a genre, a vibe, a feeling — or leave blank and ride the blend"></textarea>
      <button id="lbready" class="lb-ready caps">I'M READY</button>
      <div class="lb-lbl caps">in the lobby · <span id="lbcount"></span></div>
      <div class="lb-roster" id="lbroster"></div>
    </div>`;
  const nameEl = document.getElementById("lbname");
  nameEl.value = myName;
  nameEl.addEventListener("input", () => { myName = nameEl.value; sendProfile(); });
  document.getElementById("lbpen").addEventListener("click", openAvPick);
  document.getElementById("lbready").addEventListener("click", () => {
    amReady = !amReady;
    bus.control("ready", { ready: amReady, taste: document.getElementById("lbtaste").value });
    paintReady();
  });
  sendProfile();           // claim the default name immediately
  paintReady();
  refreshLobby();
}
function paintReady() {
  const b = document.getElementById("lbready"); if (!b) return;
  b.classList.toggle("on", amReady);
  b.textContent = amReady ? "✓ READY — TAP TO EDIT" : "I'M READY";
}
function refreshLobby() {
  syncMyAvatar();
  const big = document.getElementById("lbavbig");
  if (big) big.innerHTML = avImg(myAvatar);
  paintAvPick();                       // live-dim freshly taken avatars if the picker is open
  const list = document.getElementById("lbroster"); if (!list) return;
  const players = roster.filter((r) => r.role !== "groove");
  const ready = players.filter((p) => p.ready).length;
  setText("lbcount", `${ready}/${players.length} ready`);
  list.innerHTML = players.map((p) => `
    <div class="lb-row${p.ready ? " rdy" : ""}">
      <span class="av">${avImg(p.avatar) || "·"}</span>
      <span class="nm-col">
        <span class="nm">${esc(p.name || "PLAYER " + p.id)}</span>
        ${p.taste ? `<span class="sub">“${esc(p.taste)}”</span>` : ""}
      </span>
      <span class="role mono" style="color:${p.color}">${p.role}</span>
      <span class="ck">${p.ready ? "✓" : "…"}</span>
    </div>`).join("");
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`); }

// avatar picker — neobrutalist bottom sheet; taken avatars dimmed + unclickable
function openAvPick() {
  if (document.getElementById("avpick")) return;
  const ov = document.createElement("div"); ov.className = "avpick"; ov.id = "avpick";
  ov.innerHTML = `<div class="sheet">
    <h3 class="caps">Pick your avatar</h3>
    <div class="grid" id="avgrid">
      ${AVATARS.map((a) => `<button class="opt" data-a="${a}">${avImg(a)}</button>`).join("")}
    </div>
    <div class="hint" style="padding:10px 0 0">grayed out = taken by another player</div>
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener("pointerdown", (e) => { if (e.target === ov) closeAvPick(); });
  ov.querySelectorAll(".opt").forEach((b) => b.addEventListener("click", () => {
    if (b.classList.contains("taken")) return;
    myAvatar = b.dataset.a;                            // optimistic; roster echo confirms/reverts
    bus.control("profile", { avatar: b.dataset.a });
    const big = document.getElementById("lbavbig");
    if (big) big.innerHTML = avImg(myAvatar);
    closeAvPick();
  }));
  paintAvPick();
}
function paintAvPick() {
  const grid = document.getElementById("avgrid"); if (!grid) return;
  const taken = new Set(roster.filter((r) => r.id !== me?.id && r.avatar).map((r) => r.avatar));
  grid.querySelectorAll(".opt").forEach((b) => {
    b.classList.toggle("taken", taken.has(b.dataset.a));
    b.classList.toggle("sel", b.dataset.a === myAvatar);
  });
}
function closeAvPick() { document.getElementById("avpick")?.remove(); }

// ===================================================== router
function render() {
  if (me.role === "crowd") renderCrowd();
  else if (me.role === "harmony") renderHarmony();
  else if (me.role === "lead") renderLead();
}
function refresh() {
  if (me?.role === "crowd") refreshCrowd();
  else if (me?.role === "harmony") refreshHarmony();
}

// ===================================================== CROWD
const MOODS = [
  { k:"darker",   label:"DARKER",   ic:"🌑", bg:"var(--darker)",   fg:"#fff" },
  { k:"brighter", label:"BRIGHTER", ic:"☀️", bg:"var(--brighter)", fg:"#16120D" },
  { k:"heavier",  label:"HEAVIER",  ic:"⛰️", bg:"var(--heavier)",  fg:"#fff" },
  { k:"dreamier", label:"DREAMIER", ic:"☁️", bg:"var(--dreamier)", fg:"#16120D" },
];
function renderCrowd() {
  screen.innerHTML = slimHeader("CROWD") + `
    <div class="moodgrid">
      ${MOODS.map((m) => `<button class="mood caps" data-mood="${m.k}" style="background:${m.bg};color:${m.fg}">
        <span class="ic">${m.ic}</span>${m.label}</button>`).join("")}
    </div>
    <button id="energy" class="energybtn caps"><span class="fill" id="efill"></span>
      <span class="t">⚡ HOLD TO RAISE ENERGY</span></button>
    <div class="spacer"></div>
    <div class="c-bottom">
      <div class="roomenergy"><div class="lbl">ROOM ENERGY <span class="ct" id="ccount"></span></div>
        <div class="ebar"><div id="ebar"><span id="epct"></span></div></div></div>
      <div class="justnow"><div class="lbl">JUST NOW</div><div class="pills" id="recent"></div></div>
    </div>`;
  screen.querySelectorAll(".mood").forEach((b) => b.addEventListener("click", () => bus.control("mood", { mood: b.dataset.mood })));
  const eb = document.getElementById("energy"); let hold = null;
  const start = (e) => { e.preventDefault(); eb.classList.add("held"); hold = setInterval(() => bus.control("energy", { delta: 0.05 }), 100); };
  const stop = () => { eb.classList.remove("held"); clearInterval(hold); };
  eb.addEventListener("touchstart", start, { passive: false }); eb.addEventListener("mousedown", start);
  ["touchend","mouseup","mouseleave","touchcancel"].forEach((ev) => eb.addEventListener(ev, stop));
  refreshCrowd();
}
function refreshCrowd() {
  if (!st) return;
  const pct = Math.round((st.energy || 0) * 100);
  setW("ebar", pct); setText("epct", pct + "%"); setW("efill", pct);
  setText("ccount", "×" + (st.crowdCount ?? 0) + " in the crowd");
  const r = document.getElementById("recent");
  if (r) r.innerHTML = (st.recentMoods || []).map((m, i) => {
    const d = MOODS.find((x) => x.k === m.mood);
    return `<span class="pill-m caps" style="background:${d.bg};color:${d.fg};${i > 1 ? "filter:grayscale(.6);opacity:.75" : ""}">${d.label}</span>`;
  }).join("");
}

// ===================================================== HARMONY
// Wheel = a chord palette + a DRAW surface: drag your finger across chords to draw the
// loop (each drag clears + recreates). I is centered; the rest + a "+" node ring around.
// Tap a timeline block to swap the chord / set its length / remove.
let palette = [];    // chord options: [0]=I (center), [1..]=ring; user can add via "+"
let nodeEls = [];    // {i, el, cx, cy, isAdd}
let drawn = [];      // the loop: [{root,quality,roman,display,beats,pinned,pi}]
let hBeat = 0;
let drawing = false, lastDrawNode = -1;
const LEN_OPTS = [1, 2, 4, 8, 16];                 // ¼ · ½ · 1 · 2 · 4 bars (in quarter-beats)
const loopBeats = () => drawn.reduce((a, c) => a + c.beats, 0) || 1;

function initPalette() {
  if (palette.length) return;
  palette = [0, 1, 2, 3, 4, 5].map((d) => { const s = diatonicSlot(st.key, d); return { ...s, display: chordLabel(s.root, s.quality) }; });
}
function renderHarmony() {
  initPalette();
  screen.innerHTML = `
    <div class="h-key"><span class="mono">KEY · ${st.key} MAJ</span></div>
    <div class="hwheel" id="wheel"><svg class="wlines" id="wlines" viewBox="0 0 100 100" preserveAspectRatio="none">
      <line id="draghint" stroke="#5FD0A8" stroke-width="2" stroke-dasharray="3 3" stroke-linecap="round"/></svg></div>
    <div class="htl">
      <div class="htl-head"><span class="lbl" id="loophead">LOOP</span><span class="now" id="nowchord">—</span></div>
      <div class="htl-strip" id="timeline"><div class="htl-ph" id="tlph"></div></div>
    </div>
    <div class="h-bottom">
      <span class="hint" style="padding:0;flex:1">drag across chords to draw your loop · tap a block to edit · + adds a chord</span>
      <button id="clear" class="btn caps" style="padding:12px 18px">CLEAR</button>
    </div>`;
  buildWheel();
  bindWheelDrag();
  sendPalette();                                   // host wheel mirrors the phone (I centered)
  document.getElementById("clear").addEventListener("click", () => { drawn = []; sendProg(); refreshHarmony(); });
  document.getElementById("timeline").addEventListener("click", (e) => {
    const b = e.target.closest(".htl-block"); if (!b) return;
    const idx = [...document.querySelectorAll(".htl-block")].indexOf(b);
    if (idx >= 0) openPicker(idx);
  });
  refreshHarmony();
}
function buildWheel() {
  const W = document.getElementById("wheel");
  W.querySelectorAll(".hnode,.haddnode").forEach((n) => n.remove());
  nodeEls = [];
  const ringChords = palette.length - 1, total = ringChords + 1;  // ring = other chords + "+"
  const size = total <= 6 ? 74 : total <= 9 ? 62 : 52;
  const R = 37;
  addNodeEl(0, 50, 46, 90, false);                                 // I centered
  for (let k = 0; k < total; k++) {
    const a = (-90 + k * 360 / total) * Math.PI / 180;
    const x = 50 + R * Math.cos(a), y = 46 + R * Math.sin(a);
    if (k < ringChords) addNodeEl(k + 1, x, y, size, false);
    else addAddEl(x, y, size);
  }
}
function addNodeEl(i, x, y, sizePx, _c) {
  const s = palette[i], n = document.createElement("div");
  n.className = "hnode" + (i === 0 ? " center" : ""); n.dataset.i = i;
  n.style.cssText = `left:${x}%;top:${y}%;width:${sizePx}px;height:${sizePx}px`;
  n.innerHTML = `<span class="r">${s.roman ?? ""}</span><span class="n">${s.display}</span>`;
  document.getElementById("wheel").appendChild(n);
  nodeEls.push({ i, el: n, cx: x, cy: y, isAdd: false });
}
function addAddEl(x, y, sizePx) {
  const n = document.createElement("div");
  n.className = "haddnode"; n.style.cssText = `left:${x}%;top:${y}%;width:${sizePx}px;height:${sizePx}px`;
  n.textContent = "+";
  document.getElementById("wheel").appendChild(n);
  nodeEls.push({ i: -1, el: n, cx: x, cy: y, isAdd: true });
}
function nodeAt(x, y) {
  for (const n of nodeEls) {
    const r = n.el.getBoundingClientRect();
    if (Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2)) < r.width * 0.62) return n;
  }
  return null;
}
function bindWheelDrag() {
  const W = document.getElementById("wheel");
  W.addEventListener("pointerdown", (e) => {
    const hit = nodeAt(e.clientX, e.clientY);
    if (hit?.isAdd) { openAdd(); return; }
    e.preventDefault(); try { W.setPointerCapture(e.pointerId); } catch {}
    drawing = true; drawn = []; lastDrawNode = -1;
    if (hit) pushDraw(hit.i);
    liveDraw(e);
  });
  W.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const hit = nodeAt(e.clientX, e.clientY);
    if (hit && !hit.isAdd && hit.i !== lastDrawNode) pushDraw(hit.i);
    liveDraw(e);
  });
  const end = () => { if (!drawing) return; drawing = false; clearDragHint(); fitDurations(); sendProg(); refreshHarmony(); };
  W.addEventListener("pointerup", end);
  W.addEventListener("pointercancel", end);
}
function pushDraw(i) {
  const s = palette[i];
  drawn.push({ root: s.root, quality: s.quality, roman: s.roman, display: s.display, beats: 4, pinned: false, pi: i });
  lastDrawNode = i;
  flashNode(i);
  chordTone(chordMidiNotes(s.root, s.quality, 4));   // local preview — hear the chord you drew
}
function flashNode(i) { const n = nodeEls.find((e) => e.i === i && !e.isAdd); if (n) { n.el.classList.add("hit"); setTimeout(() => n.el.classList.remove("hit"), 160); } }
function liveDraw(e) { drawWheelLines(); renderTimeline(); highlightNodes(); if (e) dragHintTo(e.clientX, e.clientY); }
function dragHintTo(x, y) {
  const W = document.getElementById("wheel").getBoundingClientRect(), ln = document.getElementById("draghint");
  const last = drawn.length ? nodeEls.find((n) => n.i === drawn[drawn.length - 1].pi && !n.isAdd) : null;
  if (!last || !ln) return;
  ln.setAttribute("x1", last.cx); ln.setAttribute("y1", last.cy);
  ln.setAttribute("x2", (x - W.left) / W.width * 100); ln.setAttribute("y2", (y - W.top) / W.height * 100);
}
function clearDragHint() { const ln = document.getElementById("draghint"); if (ln) { ln.setAttribute("x2", ln.getAttribute("x1") || 0); ln.setAttribute("y2", ln.getAttribute("y1") || 0); } }

// Fresh-draw default: fit the loop to 4 bars (halve longest / grow shortest). Manual
// length edits in the picker override this and the loop length becomes their sum.
function fitDurations() {
  if (!drawn.length) return;
  drawn.forEach((c) => { c.beats = 4; c.pinned = false; });
  const sum = () => drawn.reduce((a, c) => a + c.beats, 0);
  let g = 0;
  while (sum() > 16 && g++ < 999) { let mi = 0; drawn.forEach((c, i) => { if (c.beats > drawn[mi].beats) mi = i; }); if (drawn[mi].beats <= 1) break; drawn[mi].beats /= 2; }
  g = 0;
  while (sum() < 16 && g++ < 999) { let mi = 0; drawn.forEach((c, i) => { if (c.beats < drawn[mi].beats) mi = i; }); drawn[mi].beats += Math.min(drawn[mi].beats, 16 - sum()); }
}
function romanFor(root, quality) {                 // diatonic roman (if any) → keeps host from going silent on edits
  for (let d = 0; d < 7; d++) { const s = diatonicSlot(st.key, d); if (s.root === root && s.quality === quality) return s.roman; }
  return undefined;
}
function refitProtect(idx) {                        // keep loop EXACTLY 16 beats; protect edited chord, adjust others
  const total = () => drawn.reduce((a, c) => a + c.beats, 0);
  let g = 0;
  while (total() > 16 && g++ < 9999) { let mi = -1; drawn.forEach((c, i) => { if (i !== idx && c.beats > 1 && (mi < 0 || c.beats > drawn[mi].beats)) mi = i; }); if (mi < 0) { if (drawn[idx].beats > 1) drawn[idx].beats--; else break; } else drawn[mi].beats--; }
  g = 0;
  while (total() < 16 && g++ < 9999) { let mi = -1; drawn.forEach((c, i) => { if (i !== idx && (mi < 0 || c.beats < drawn[mi].beats)) mi = i; }); if (mi < 0) drawn[idx].beats++; else drawn[mi].beats++; }
}
function buildSchedule() {                          // exactly 16 beat-slots (always 4 bars, no gaps)
  const sched = [];
  drawn.forEach((c) => { const o = { label: c.display, roman: c.roman || c.display, notes: chordMidiNotes(c.root, c.quality, 4), beats: c.beats }; for (let b = 0; b < c.beats; b++) sched.push(o); });
  while (sched.length && sched.length < 16) sched.push(sched[sched.length - 1]);
  return sched.slice(0, 16);
}
function currentIdx() {
  if (!drawn.length) return -1;
  let acc = 0, lb = hBeat % loopBeats();
  for (let i = 0; i < drawn.length; i++) { acc += drawn[i].beats; if (lb < acc) return i; }
  return drawn.length - 1;
}
function sendProg() {
  bus.control("progression", {
    degrees: drawn.map((d) => d.roman || d.display),
    chords: drawn.map((d) => ({ label: d.display, notes: chordMidiNotes(d.root, d.quality, 4), beats: d.beats })),
    schedule: buildSchedule(),
    loopBeats: loopBeats(),
  });
}
// Mirror the wheel to the host: [0]=I (center), the rest ring around it. Added nodes too.
function sendPalette() {
  bus.control("palette", { nodes: palette.map((p) => ({ roman: p.roman || null, display: p.display })) });
}
function refreshHarmony() {
  if (me?.role !== "harmony") return;
  highlightNodes(); drawWheelLines(); renderTimeline(); lastCi = -2; startPlayhead();
}
function highlightNodes() {
  const used = new Set(drawn.map((d) => d.display));
  nodeEls.forEach((n) => { if (!n.isAdd) n.el.classList.toggle("active", used.has(palette[n.i].display)); });
}
function durLabel(beats) {
  const b = beats / 4;
  if (beats === 1) return "¼ bar"; if (beats === 2) return "½ bar"; if (beats === 3) return "¾ bar";
  return (Number.isInteger(b) ? b : b.toFixed(2)) + (b === 1 ? " bar" : " bars");
}
function renderTimeline() {
  const tl = document.getElementById("timeline"); if (!tl) return;
  tl.querySelectorAll(".htl-block,.htl-grid").forEach((b) => b.remove());
  const ph = document.getElementById("tlph");
  const LB = loopBeats(), bars = Math.max(1, Math.round(LB / 4));
  setText("loophead", `LOOP · ${bars} BAR${bars > 1 ? "S" : ""}`);
  if (!drawn.length) { setText("nowchord", "draw a loop"); return; }
  let html = "";
  for (let b = 1; b < bars; b++) html += `<div class="htl-grid" style="left:${b * 4 / LB * 100}%"></div>`;
  let acc = 0;
  drawn.forEach((c) => {
    const left = acc / LB * 100, w = c.beats / LB * 100; acc += c.beats;
    html += `<div class="htl-block" style="left:${left}%;width:${w}%"><span class="lab">${c.display}</span><span class="dur">${durLabel(c.beats)}</span></div>`;
  });
  ph.insertAdjacentHTML("beforebegin", html);
}
// Smooth playhead: a local requestAnimationFrame clock running at the host tempo, soft
// phase-locked to incoming network beats (a tiny PLL). 60fps motion, no waiting on jittery
// beats, no backward jumps — fixes the laggy/choppy playhead.
let phaseBeat = 0, lastFrameT = 0, rafOn = false, lastCi = -2;
function startPlayhead() {
  if (rafOn) return; rafOn = true; lastFrameT = performance.now();
  const loop = (now) => {
    if (me?.role === "harmony") {
      const ph = document.getElementById("tlph");
      if (!drawn.length) {                                   // nothing drawn → no loop, so no playhead
        phaseBeat = 0;                                       // (was sweeping the strip every beat: LB fell back to 1)
        if (ph) ph.style.opacity = "0";
      } else {
        if (ph) ph.style.opacity = "";
        const LB = loopBeats(), spb = 60 / (st?.tempo || 124);
        phaseBeat += ((now - lastFrameT) / 1000) / spb;     // advance at host tempo
        phaseBeat = ((phaseBeat % LB) + LB) % LB;
        renderPlayhead(phaseBeat, LB);
      }
    }
    lastFrameT = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
function harmonyOnBeat(m) {                                  // ease toward the network beat (no hard snap)
  if (!drawn.length) return;                                 // no loop yet → nothing to phase-lock
  const LB = loopBeats();
  let err = ((((m.bar * 4 + m.beat) % LB) - phaseBeat) % LB + LB) % LB;
  if (err > LB / 2) err -= LB;                              // correct in the shorter direction
  phaseBeat += err * 0.25;
}
function renderPlayhead(beatPos, LB) {
  const ph = document.getElementById("tlph"); if (ph) ph.style.left = (beatPos % LB) / LB * 100 + "%";
  let acc = 0, ci = drawn.length - 1;
  for (let i = 0; i < drawn.length; i++) { acc += drawn[i].beats; if (beatPos < acc) { ci = i; break; } }
  if (ci === lastCi) return;                                // repaint highlights only on chord change
  lastCi = ci;
  document.querySelectorAll(".htl-block").forEach((b, i) => b.classList.toggle("cur", i === ci));
  const cur = drawn[ci]?.display || "—"; setText("nowchord", cur);
  nodeEls.forEach((n) => { if (!n.isAdd) n.el.classList.toggle("cur", palette[n.i]?.display === cur && cur !== "—"); });
}
function curDisplay() { return drawn[currentIdx()]?.display || "—"; }
function drawWheelLines() {
  const svg = document.getElementById("wlines"); if (!svg) return;
  const center = (pi) => { const n = nodeEls.find((e) => !e.isAdd && e.i === pi); return n ? [n.cx, n.cy] : null; };
  const lines = drawn.slice(1).map((d, idx) => {
    const a = center(drawn[idx].pi), b = center(d.pi); if (!a || !b) return "";
    return `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#1BA88A" stroke-width="2.5" stroke-linecap="round"/>`;
  }).join("");
  svg.querySelectorAll("line:not(#draghint)").forEach((l) => l.remove());
  document.getElementById("draghint").insertAdjacentHTML("beforebegin", lines);
}

// ---- chord picker: swap (root+quality) + length, or remove; also "add a chord" mode ----
let pick = { root: 0, qid: "maj", idx: 0, beats: 4, add: false };
function openPicker(idx) { const c = drawn[idx]; if (!c) return; pick = { root: c.root, qid: c.quality, idx, beats: c.beats, add: false }; sheet(); }
function openAdd() { pick = { root: 0, qid: "maj", idx: -1, beats: 4, add: true }; sheet(); }
function sheet() {
  const ov = document.createElement("div"); ov.className = "picker"; ov.id = "picker";
  ov.innerHTML = `<div class="sheet">
    <h3>${pick.add ? "Add a chord" : `Chord ${pick.idx + 1} of ${drawn.length}`}</h3>
    <div class="preview" id="pkprev"></div>
    <div class="grid" id="pkroots">${NAMES.map((nm, r) => `<div class="chip" data-r="${r}">${nm}</div>`).join("")}</div>
    <div class="quals" id="pkquals">${QUAL.map((q) => `<div class="qual" data-q="${q.id}">${q.suf || "maj"}</div>`).join("")}</div>
    ${pick.add ? "" : `<div class="lenrow"><span class="lenlbl mono">LENGTH</span>
      <div class="lens" id="pklens">${LEN_OPTS.map((b) => `<div class="len" data-b="${b}">${durLabel(b)}</div>`).join("")}</div></div>`}
    <div class="row">
      ${pick.add ? "" : `<button class="btn caps" id="pkremove" style="background:var(--lead);color:#fff">REMOVE</button>`}
      <button class="btn caps" id="pkcancel">CANCEL</button>
      <button class="btn caps" id="pkset" style="background:var(--harmony);color:#fff">${pick.add ? "ADD" : "SET"}</button>
    </div></div>`;
  document.body.appendChild(ov);
  ov.addEventListener("pointerdown", (e) => { if (e.target === ov) closePicker(); });
  ov.querySelectorAll("#pkroots .chip").forEach((c) => c.addEventListener("click", () => { pick.root = +c.dataset.r; paintPicker(); }));
  ov.querySelectorAll("#pkquals .qual").forEach((c) => c.addEventListener("click", () => { pick.qid = c.dataset.q; paintPicker(); }));
  ov.querySelectorAll("#pklens .len").forEach((c) => c.addEventListener("click", () => { pick.beats = +c.dataset.b; paintPicker(); }));
  document.getElementById("pkcancel").addEventListener("click", closePicker);
  document.getElementById("pkset").addEventListener("click", () => {
    const roman = romanFor(pick.root, pick.qid);   // keep diatonic roman so the chord never goes silent
    if (pick.add) {
      palette.push({ root: pick.root, quality: pick.qid, roman, display: chordLabel(pick.root, pick.qid) });
      buildWheel(); sendPalette();                  // new node appears on the host wheel in real time
    } else {
      const pi = palette.findIndex((p) => p.root === pick.root && p.quality === pick.qid);
      const beats = Math.max(1, Math.min(pick.beats, 16 - (drawn.length - 1)));   // leave ≥1 beat for others
      drawn[pick.idx] = { root: pick.root, quality: pick.qid, roman, display: chordLabel(pick.root, pick.qid), beats, pinned: true, pi };
      refitProtect(pick.idx);                       // others adapt → loop stays exactly 4 bars
      sendProg();
    }
    refreshHarmony(); closePicker();
  });
  const rm = document.getElementById("pkremove");
  if (rm) rm.addEventListener("click", () => { drawn.splice(pick.idx, 1); fitDurations(); sendProg(); refreshHarmony(); closePicker(); });
  paintPicker();
}
function paintPicker() {
  setText("pkprev", chordLabel(pick.root, pick.qid) + (pick.add ? "" : ` · ${durLabel(pick.beats)}`));
  document.querySelectorAll("#pkroots .chip").forEach((c) => c.classList.toggle("sel", +c.dataset.r === pick.root));
  document.querySelectorAll("#pkquals .qual").forEach((c) => c.classList.toggle("sel", c.dataset.q === pick.qid));
  document.querySelectorAll("#pklens .len").forEach((c) => c.classList.toggle("sel", +c.dataset.b === pick.beats));
}
function closePicker() { document.getElementById("picker")?.remove(); }

// ===================================================== LEAD
// A tempo-synced live looper. The phone only PLAYS (raw notes) + sets the loop: START arms,
// playing records, CLOSE locks the length (= how long you recorded), then keep playing to
// overdub. OVERWRITE replaces under the playhead; LAYER overdubs. Quantize + remix (WILDNESS)
// are host-side.
let octave = 5, leadStep = 0, phrase = [], overwriteUi = true;
// Semitone OFFSETS from the song key root (the keyboard is transposed into the key): white =
// major scale (always in key), black = chromatic passing tones. b = white key the black sits after.
const WHITE = [0,2,4,5,7,9,11], BLACK = [{ pc:1, b:1 },{ pc:3, b:2 },{ pc:6, b:4 },{ pc:8, b:5 },{ pc:10, b:6 }];
function renderLead() {
  screen.innerHTML = slimHeader("LEAD") + `
    <div class="banner"><span class="dot"></span>PLAY — YOUR LINE LOOPS &amp; THE ROOM REMIXES IT</div>
    <div class="motif" id="motif"></div>
    <div class="leadrow" style="display:flex;gap:10px;margin:12px 0 2px">
      <button id="ovtg" class="btn caps" style="flex:1;padding:14px">OVERWRITE</button>
      <button id="leadnew" class="btn caps" style="flex:1;padding:14px">CLEAR</button>
    </div>
    <span class="hint" style="padding:0">play a phrase then pause — it locks to your length &amp; loops · OVERWRITE replaces under the playhead, LAYER stacks</span>
    <div class="spacer"></div>
    <div class="kb" id="kb"></div>
    <div class="l-foot">
      <div class="octave"><button id="octdn">−</button>
        <div class="val"><div class="k">OCTAVE</div><div class="v" id="octval">${octave}</div></div>
        <button id="octup">+</button></div>
    </div>`;
  buildKeys();
  document.getElementById("octdn").addEventListener("click", () => { octave = Math.max(3, octave - 1); setText("octval", octave); });
  document.getElementById("octup").addEventListener("click", () => { octave = Math.min(7, octave + 1); setText("octval", octave); });
  const ov = document.getElementById("ovtg");
  ov.addEventListener("click", () => { overwriteUi = !overwriteUi; ov.textContent = overwriteUi ? "OVERWRITE" : "LAYER"; bus.control("overwrite", { on: overwriteUi }); });
  document.getElementById("leadnew").addEventListener("click", () => { phrase = []; renderMotif(); bus.control("leadclear", {}); });
  bus.control("overwrite", { on: overwriteUi });   // sync initial overdub mode to the host
  renderMotif();
}
function buildKeys() {
  const kb = document.getElementById("kb"); kb.innerHTML = "";
  const w = 100 / 7;
  WHITE.forEach((pc, idx) => {
    const k = document.createElement("button"); k.className = "wk";
    k.style.left = (idx * w) + "%"; k.style.width = w + "%";
    k.innerHTML = `<span class="d"></span>`;
    bindKey(k, pc); kb.appendChild(k);
  });
  BLACK.forEach(({ pc, b }) => {
    const k = document.createElement("button"); k.className = "bk";
    k.style.width = (w * 0.6) + "%"; k.style.left = (b * w - w * 0.3) + "%";
    bindKey(k, pc); kb.appendChild(k);
  });
}
function bindKey(k, off) {
  k.addEventListener("pointerdown", (e) => {
    e.preventDefault(); k.classList.add("on"); setTimeout(() => k.classList.remove("on"), 180);
    const root = NAMES.indexOf(st?.key || "A");
    const midi = 12 * (octave + 1) + root + off;          // transpose the keyboard into the song key
    const pc = ((midi % 12) + 12) % 12, oct = Math.floor(midi / 12) - 1;
    tone(440 * Math.pow(2, (midi - 69) / 12));
    bus.control("note", { note: NAMES[pc], oct });
    phrase.push({ pc }); phrase = phrase.slice(-9); renderMotif();
  });
}
function renderMotif() {
  const m = document.getElementById("motif"); if (!m) return;
  const bars = [1,2,3].map((b) => `<div class="ph-bar" style="left:${b / 4 * 100}%"></div>`).join("");
  const notes = phrase.map((n, i) => {
    const x = 4 + i * (92 / 9), y = 10 + (11 - n.pc) / 11 * 72;
    return `<div class="mn" style="left:${x}%;top:${y}%;width:9%"></div>`;
  }).join("");
  m.innerHTML = bars + notes;
}
let actx;
function tone(f, peak = 0.25) {
  actx ||= new (window.AudioContext || window.webkitAudioContext)();
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = "sawtooth"; o.frequency.value = f; g.gain.value = 0.0001;
  o.connect(g).connect(actx.destination); o.start();
  g.gain.exponentialRampToValueAtTime(peak, actx.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.3);
  o.stop(actx.currentTime + 0.32);
}
// Local chord preview (harmony phone) — the player hears what they're drawing in real time.
function chordTone(midis) { (midis || []).forEach((m) => tone(440 * Math.pow(2, (m - 69) / 12), 0.12)); }

// ===================================================== utils
function setText(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }
function setW(id, pct) { const e = document.getElementById(id); if (e) e.style.width = pct + "%"; }
