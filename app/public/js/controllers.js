// Phone controllers — rendered per assigned role. Fixed viewport, no scroll.
import { Bus, diatonic } from "/js/shared.js";

const bus = new Bus("auto");
const screen = document.getElementById("screen");
let me = null, st = null, roster = [];

bus.on("welcome", (m) => { me = m; st = m.state; roster = m.roster || []; document.documentElement.style.setProperty("--role", m.color); render(); });
bus.on("state", (m) => { st = m.state; roster = m.roster || roster; refresh(); });
bus.on("roster", (m) => { roster = m.roster || roster; refreshSquares(); });
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
function topbar(label) {
  return `
  <div class="statusbar"><span class="mono">9:41</span><span class="brand mono">JAM·LAN 🔋</span></div>
  <div style="display:flex;align-items:center;gap:10px">
    <div class="toppill" style="flex:1">
      <div class="chip"></div><div class="name caps">${label}</div>
      <div class="live"><span class="dot" id="livedot"></span><span class="mono">LIVE</span></div>
    </div>
    <div class="players" id="players" style="margin:14px 18px 0 0"></div>
  </div>`;
}
function refreshSquares() {
  const el = document.getElementById("players"); if (!el) return;
  const order = ["harmony", "lead", "crowd", "crowd"];
  const present = roster.filter((r) => r.role !== "groove");
  const COL = { harmony:"#1BA88A", lead:"#F4533A", crowd:"#9B7BE6" };
  el.innerHTML = [0,1,2,3].map((i) => `<div class="sq" style="${present[i] ? "background:" + COL[present[i].role] : ""}"></div>`).join("");
}
function onBeat(m) {
  document.querySelectorAll("#livedot,.banner .dot").forEach((d) => { d.classList.add("pulse"); setTimeout(() => d.classList.remove("pulse"), 110); });
  if (me?.role === "lead") leadStep = (leadStep + 1) % 16;
  if (me?.role === "harmony") { hBeat = m.bar * 4 + m.beat; harmonyTick(); }
}

// ===================================================== router
function render() {
  if (me.role === "crowd") renderCrowd();
  else if (me.role === "harmony") renderHarmony();
  else if (me.role === "lead") renderLead();
  refreshSquares();
}
function refresh() {
  if (me?.role === "crowd") refreshCrowd();
  else if (me?.role === "harmony") refreshHarmony();
  refreshSquares();
}

// ===================================================== CROWD
const MOODS = [
  { k:"darker",   label:"DARKER",   ic:"🌑", bg:"var(--darker)",   fg:"#fff" },
  { k:"brighter", label:"BRIGHTER", ic:"☀️", bg:"var(--brighter)", fg:"#16120D" },
  { k:"heavier",  label:"HEAVIER",  ic:"⛰️", bg:"var(--heavier)",  fg:"#fff" },
  { k:"dreamier", label:"DREAMIER", ic:"☁️", bg:"var(--dreamier)", fg:"#16120D" },
];
function renderCrowd() {
  screen.innerHTML = topbar("CROWD") + `
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
let slots = [];      // 6 wheel nodes: [0]=I center, [1..5]=ii,iii,IV,V,vi around
let drawn = [];      // the loop: array of chord objects {root,quality,roman,display,beats}
let hBeat = 0;       // current global beat (from host), for the timeline playhead
function renderHarmony() {
  slots = [0,1,2,3,4,5].map((d) => { const s = diatonicSlot(st.key, d); return { ...s, display: chordLabel(s.root, s.quality) }; });
  screen.innerHTML = topbar("HARMONY") + `
    <div class="h-keyline"><span class="mono" style="font-size:13px;color:#5a564d">KEY · ${st.key} MAJ</span></div>
    <div class="hwheel" id="wheel"><svg class="wlines" id="wlines" viewBox="0 0 100 100" preserveAspectRatio="none"></svg></div>
    <div class="htl">
      <div class="htl-head"><span class="lbl">LOOP · 4 BARS</span><span class="now" id="nowchord">—</span></div>
      <div class="htl-strip" id="timeline">
        <div class="htl-grid" style="left:25%"></div><div class="htl-grid" style="left:50%"></div><div class="htl-grid" style="left:75%"></div>
        <div class="htl-ph" id="tlph"></div>
      </div>
    </div>
    <div class="h-bottom">
      <span class="hint" style="padding:0;flex:1">tap wheel to add · tap a block to swap / remove</span>
      <button id="clear" class="btn caps" style="padding:12px 20px">CLEAR</button>
    </div>`;
  buildWheelNodes();
  document.getElementById("clear").addEventListener("click", () => { drawn = []; sendProg(); refreshHarmony(); });
  document.getElementById("timeline").addEventListener("click", (e) => {   // tap a chord block to swap/remove it
    const b = e.target.closest(".htl-block"); if (!b) return;
    const idx = [...document.querySelectorAll(".htl-block")].indexOf(b);
    if (idx >= 0) openSwap(idx);
  });
  refreshHarmony();
}
function buildWheelNodes() {
  const W = document.getElementById("wheel");
  W.querySelectorAll(".hnode").forEach((n) => n.remove());
  const place = (i, x, y, center) => {
    const s = slots[i];
    const n = document.createElement("button");
    n.className = "hnode" + (center ? " center" : ""); n.dataset.i = i;
    n.style.left = x + "%"; n.style.top = y + "%";
    n.style.width = (center ? 92 : 78) + "px"; n.style.height = (center ? 92 : 78) + "px";
    n.innerHTML = `<span class="r">${s.roman ?? ""}</span><span class="n">${s.display}</span>`;
    bindNode(n, i);
    W.appendChild(n);
  };
  place(0, 50, 46, true);                                  // I in the middle
  for (let k = 0; k < 5; k++) {                             // ii,iii,IV,V,vi around it
    const a = (-90 + k * 72) * Math.PI / 180;
    place(k + 1, 50 + 37 * Math.cos(a), 46 + 37 * Math.sin(a), false);
  }
}
function bindNode(n, i) {
  n.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    n.classList.add("pressed"); setTimeout(() => n.classList.remove("pressed"), 120);
    addToLoop(i);                                 // wheel = tap to add to the loop
  });
}
function addToLoop(i) {
  if (drawn.length >= 16) return;              // 16 beats = 4 bars at ¼-bar min
  const s = slots[i];
  drawn.push({ root: s.root, quality: s.quality, roman: s.roman, display: s.display, beats: 4 });
  sendProg(); refreshHarmony();
}
// The loop is ALWAYS 4 bars (16 beats). Default 1 bar/chord; if they don't fit,
// halve the longest (1 bar→½→¼) until they do; if there's room, grow the shortest.
function fitDurations() {
  const N = drawn.length; if (!N) return;
  drawn.forEach((c) => (c.beats = 4));
  const sum = () => drawn.reduce((a, c) => a + c.beats, 0);
  let g = 0;
  while (sum() > 16 && g++ < 999) {            // too many → halve the longest
    let mi = 0; drawn.forEach((c, i) => { if (c.beats > drawn[mi].beats) mi = i; });
    if (drawn[mi].beats <= 1) break;
    drawn[mi].beats /= 2;
  }
  g = 0;
  while (sum() < 16 && g++ < 999) {            // room left → grow the shortest
    let mi = 0; drawn.forEach((c, i) => { if (c.beats < drawn[mi].beats) mi = i; });
    const add = Math.min(drawn[mi].beats, 16 - sum());
    drawn[mi].beats += add;
  }
}
function buildSchedule() {                       // 16 beat-slots → chord playing on each beat
  const sched = [];
  drawn.forEach((c) => {
    const o = { label: c.display, roman: c.roman || c.display, notes: chordMidiNotes(c.root, c.quality, 4), beats: c.beats };
    for (let b = 0; b < c.beats; b++) sched.push(o);
  });
  while (sched.length < 16 && sched.length) sched.push(sched[sched.length - 1]);
  return sched.slice(0, 16);
}
function currentIdx() {                          // which chord the phone's 4-bar model is on now
  if (!drawn.length) return -1;
  let acc = 0, lb = hBeat % 16;
  for (let i = 0; i < drawn.length; i++) { acc += drawn[i].beats; if (lb < acc) return i; }
  return drawn.length - 1;
}
function sendProg() {
  fitDurations();
  bus.control("progression", {
    degrees: drawn.map((d) => d.roman || d.display),
    chords: drawn.map((d) => ({ label: d.display, notes: chordMidiNotes(d.root, d.quality, 4), beats: d.beats })),
    schedule: buildSchedule(),
    bars: 4,
  });
}
function refreshHarmony() {
  if (me?.role !== "harmony") return;
  const drawnKeys = new Set(drawn.map((d) => d.display));
  document.querySelectorAll(".hnode").forEach((n) => {
    n.classList.toggle("active", drawnKeys.has(slots[n.dataset.i].display));
  });
  drawWheelLines();
  renderTimeline();
  harmonyTick();
}
const DURLBL = { 16: "4 bars", 8: "2 bars", 4: "1 bar", 2: "½ bar", 1: "¼ bar" };
function renderTimeline() {
  const tl = document.getElementById("timeline"); if (!tl) return;
  tl.querySelectorAll(".htl-block").forEach((b) => b.remove());
  const ph = document.getElementById("tlph");
  if (!drawn.length) { setText("nowchord", "tap a chord"); return; }
  let acc = 0; const html = drawn.map((c) => {
    const left = acc / 16 * 100, w = c.beats / 16 * 100; acc += c.beats;
    return `<div class="htl-block" style="left:${left}%;width:${w}%">
      <span class="lab">${c.display}</span><span class="dur">${DURLBL[c.beats] || ""}</span></div>`;
  }).join("");
  ph.insertAdjacentHTML("beforebegin", html);
}
function harmonyTick() {
  if (me?.role !== "harmony") return;
  const ci = currentIdx();
  document.querySelectorAll(".htl-block").forEach((b, i) => b.classList.toggle("cur", i === ci));
  const ph = document.getElementById("tlph"); if (ph) ph.style.left = (hBeat % 16) / 16 * 100 + "%";
  const cur = curDisplay();
  setText("nowchord", cur);
  document.querySelectorAll(".hnode").forEach((n) => n.classList.toggle("cur", slots[n.dataset.i]?.display === cur && cur !== "—"));
}
function curDisplay() { const i = currentIdx(); return i >= 0 ? drawn[i].display : "—"; }
function drawWheelLines() {
  const svg = document.getElementById("wlines"); if (!svg) return;
  const at = (disp) => { const i = slots.findIndex((s) => s.display === disp); if (i < 0) return null;
    if (i === 0) return [50, 46]; const a = (-90 + (i - 1) * 72) * Math.PI / 180; return [50 + 37 * Math.cos(a), 46 + 37 * Math.sin(a)]; };
  svg.innerHTML = drawn.slice(1).map((d, idx) => {
    const p1 = at(drawn[idx].display), p2 = at(d.display); if (!p1 || !p2) return "";
    return `<line x1="${p1[0]}" y1="${p1[1]}" x2="${p2[0]}" y2="${p2[1]}" stroke="#1BA88A" stroke-width="2.5" stroke-linecap="round"/>`;
  }).join("");
}
// chord swapper — tap a timeline chord to swap it for ANY root+quality, or remove it
let pick = { root: 0, qid: "maj", idx: 0 };
function openSwap(idx) {
  const c = drawn[idx]; if (!c) return;
  pick = { root: c.root, qid: c.quality, idx };
  const ov = document.createElement("div"); ov.className = "picker"; ov.id = "picker";
  ov.innerHTML = `<div class="sheet">
    <h3>Chord ${idx + 1} of ${drawn.length} · ${DURLBL[c.beats] || ""}</h3>
    <div class="preview" id="pkprev"></div>
    <div class="grid" id="pkroots">${NAMES.map((nm, r) => `<div class="chip" data-r="${r}">${nm}</div>`).join("")}</div>
    <div class="quals" id="pkquals">${QUAL.map((q) => `<div class="qual" data-q="${q.id}">${q.suf || "maj"}</div>`).join("")}</div>
    <div class="row"><button class="btn caps" id="pkremove" style="background:var(--lead);color:#fff">REMOVE</button>
      <button class="btn caps" id="pkcancel">CANCEL</button>
      <button class="btn caps" id="pkset" style="background:var(--harmony);color:#fff">SET</button></div>
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener("pointerdown", (e) => { if (e.target === ov) closePicker(); });
  ov.querySelectorAll("#pkroots .chip").forEach((c2) => c2.addEventListener("click", () => { pick.root = +c2.dataset.r; paintPicker(); }));
  ov.querySelectorAll("#pkquals .qual").forEach((c2) => c2.addEventListener("click", () => { pick.qid = c2.dataset.q; paintPicker(); }));
  document.getElementById("pkcancel").addEventListener("click", closePicker);
  document.getElementById("pkremove").addEventListener("click", () => {
    drawn.splice(pick.idx, 1); sendProg(); refreshHarmony(); closePicker();
  });
  document.getElementById("pkset").addEventListener("click", () => {
    drawn[pick.idx] = { root: pick.root, quality: pick.qid, roman: undefined,
      display: chordLabel(pick.root, pick.qid), beats: drawn[pick.idx].beats };
    sendProg(); refreshHarmony(); closePicker();
  });
  paintPicker();
}
function paintPicker() {
  setText("pkprev", chordLabel(pick.root, pick.qid));
  document.querySelectorAll("#pkroots .chip").forEach((c) => c.classList.toggle("sel", +c.dataset.r === pick.root));
  document.querySelectorAll("#pkquals .qual").forEach((c) => c.classList.toggle("sel", c.dataset.q === pick.qid));
}
function closePicker() { document.getElementById("picker")?.remove(); }

// ===================================================== LEAD
let octave = 5, leadStep = 0, phrase = [];
const WHITE = [0,2,4,5,7,9,11], BLACK = [{ pc:1, b:1 },{ pc:3, b:2 },{ pc:6, b:4 },{ pc:8, b:5 },{ pc:10, b:6 }];
function renderLead() {
  screen.innerHTML = topbar("LEAD") + `
    <div class="banner"><span class="dot"></span>YOUR PHRASE IS LOOPING</div>
    <div class="l-sub"><span class="a">CAPTURED MOTIF</span><span class="b">locks on downbeat</span></div>
    <div class="motif" id="motif"></div>
    <div class="spacer"></div>
    <div class="l-sub"><span class="a">HIGH REGISTER · play to change</span></div>
    <div class="kb" id="kb"></div>
    <div class="l-foot">
      <div class="octave"><button id="octdn">−</button>
        <div class="val"><div class="k">OCTAVE</div><div class="v" id="octval">${octave}</div></div>
        <button id="octup">+</button></div>
      <span class="hint" style="padding:0;flex:1">tap keys to answer the call — it loops till you do</span>
    </div>`;
  buildKeys();
  document.getElementById("octdn").addEventListener("click", () => { octave = Math.max(3, octave - 1); setText("octval", octave); });
  document.getElementById("octup").addEventListener("click", () => { octave = Math.min(7, octave + 1); setText("octval", octave); });
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
function bindKey(k, pc) {
  k.addEventListener("pointerdown", (e) => {
    e.preventDefault(); k.classList.add("on"); setTimeout(() => k.classList.remove("on"), 180);
    const midi = 12 * (octave + 1) + pc;
    tone(440 * Math.pow(2, (midi - 69) / 12));
    bus.control("note", { note: NAMES[pc], oct: octave });
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
function tone(f) {
  actx ||= new (window.AudioContext || window.webkitAudioContext)();
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = "sawtooth"; o.frequency.value = f; g.gain.value = 0.0001;
  o.connect(g).connect(actx.destination); o.start();
  g.gain.exponentialRampToValueAtTime(0.25, actx.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.3);
  o.stop(actx.currentTime + 0.32);
}

// ===================================================== utils
function setText(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }
function setW(id, pct) { const e = document.getElementById(id); if (e) e.style.width = pct + "%"; }
