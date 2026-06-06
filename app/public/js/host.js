// Host = lobby + console. Owns the master clock (Tone.js), the groove-driven drum
// engine + harmony synth, and renders the live room view from broadcast state.
import { Bus, romanToName, chordMidi, chordNotes, diatonic } from "/js/shared.js";
const Tone = window.Tone;

const bus = new Bus("host");
let st = null, roster = [];
const ROLE_ORDER = ["groove", "harmony", "lead", "crowd"];
const ROLE_LETTER = { groove: "G", harmony: "H", lead: "L", crowd: "C" };
const ROLE_COLOR = { groove: "#F5B82E", harmony: "#1BA88A", lead: "#F4533A", crowd: "#9B7BE6" };

bus.on("welcome", (m) => { st = m.state; roster = m.roster || []; paintAll(); });
bus.on("state", (m) => { st = m.state; roster = m.roster || roster; paintAll(); });
bus.on("roster", (m) => { roster = m.roster; if (st) st.crowdCount = m.crowdCount; paintRoster(); });
bus.on("beat", () => {}); // host generates its own beat locally
bus.on("control", (m) => { if (m.action === "note") onLeadNote(m.payload); });

// ---- join info ----
fetch("/info").then((r) => r.json()).then((info) => {
  document.getElementById("qr").src = info.qr;
  document.getElementById("joinurl").textContent = info.joinUrl;
});

// =================================================================== AUDIO ENGINE
// Synths are created lazily inside startAudio (after the user gesture / Tone.start),
// so a bad option can't break module load and silently kill the start button.
let kick, snare, hat, chordSynth;
let bar = 0, progIdx = -1, s16 = 0;
const groove = { x: 0.5, y: 0.5 };   // X = sparse↔dense, Y = chill↔hype

function initSynths() {
  kick = new Tone.MembraneSynth({ octaves: 6, pitchDecay: 0.05, volume: -2 }).toDestination();
  snare = new Tone.NoiseSynth({ envelope: { attack: 0.001, decay: 0.12, sustain: 0 }, volume: -16 }).toDestination();
  hat = new Tone.NoiseSynth({ envelope: { attack: 0.001, decay: 0.03, sustain: 0 }, volume: -24 }).toDestination();
  const verb = new Tone.Reverb({ decay: 2.4, wet: 0.28 }).toDestination();
  chordSynth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "fatsawtooth", count: 2, spread: 16 },
    envelope: { attack: 0.03, decay: 0.4, sustain: 0.5, release: 0.5 }, volume: -13,
  }).connect(verb);
}

let started = false;
async function startAudio() {
  if (started) return;            // ignore double-taps (would double-schedule the clock)
  started = true;
  // Show the console FIRST — audio init must never hold the screen hostage. A contended
  // output device (e.g. the MRT2 texture engine holding the default sink) can make
  // Tone.start()'s AudioContext.resume() hang forever; we don't want a frozen lobby.
  showConsole();
  try {
    await withTimeout(Tone.start(), 4000);   // resume the AudioContext (bounded)
    initSynths();
    const t = Tone.getTransport();
    t.bpm.value = st?.tempo || 124;
    t.scheduleRepeat(onSixteenth, "16n");
    t.start();
  } catch (e) {
    console.error("audio start failed:", e);
    note("AUDIO OFF — " + (e?.message || e) + " · free the output device, then reload");
  }
}

function showConsole() {
  // Fall back to sane defaults so an early click (before the WS welcome) can't crash the build.
  st = st || { room: "JAMARAMA", key: "A", scale: "major", tempo: 124, chord: "I",
               progression: ["I", "IV", "V", "vi"], mood: {}, energy: 0, crowdCount: 0 };
  document.getElementById("lobby").hidden = true;
  document.getElementById("console").hidden = false;
  buildConsole();
  paintAll();
}

// Reject if `p` hasn't settled within `ms` — keeps a hung resume() from freezing start.
function withTimeout(p, ms) {
  return Promise.race([p,
    new Promise((_, rej) => setTimeout(() => rej(new Error("audio device busy (timed out)")), ms))]);
}

// Non-blocking banner for audio problems (the console is already usable underneath).
function note(msg) {
  let el = document.getElementById("audionote");
  if (!el) {
    el = document.createElement("div");
    el.id = "audionote";
    el.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9999;" +
      "background:#F4533A;color:#fff;font:600 13px/1.3 ui-monospace,monospace;padding:10px 16px;" +
      "border-radius:999px;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:90vw;text-align:center";
    document.body.appendChild(el);
  }
  el.textContent = msg;
}

function onSixteenth(time) {
  const sub = s16 % 16, beat = (sub / 4) | 0;
  const { x, y } = groove;
  // --- drums driven by the groove X/Y ---
  if (sub === 0 || (sub === 8 && y > 0.3)) kick.triggerAttackRelease("C1", "8n", time, 0.55 + 0.45 * y);
  if ((sub === 4 || sub === 12) && y > 0.32) snare.triggerAttackRelease("16n", time, 0.5 + 0.5 * y);
  const hatHit = x < 0.34 ? sub % 4 === 0 : x < 0.7 ? sub % 2 === 0 : true;
  if (hatHit) hat.triggerAttackRelease("32n", time, 0.5 + 0.4 * y);
  // --- quarter-note events ---
  if (sub % 4 === 0) {
    if (beat === 0) { bar = (Tone.getTransport().position.split(":")[0] | 0); playChord(time); }
    bus.send({ type: "beat", bar, beat });
    Tone.getDraw().schedule(() => { pulseHeartbeat(); movePlayhead(beat); }, time);
  }
  s16++;
}

function playChord(time) {
  const prog = (st?.progression?.length ? st.progression : ["I"]);
  progIdx = (progIdx + 1) % prog.length;
  const notes = chordNotes(st.key, prog[progIdx], 3);
  if (notes.length) chordSynth.triggerAttackRelease(notes, "1m", time);
  bus.send({ type: "host", action: "chord", payload: prog[progIdx] });
  Tone.getDraw().schedule(() => { renderRoll(); flashRoll(); }, time);
}

// =================================================================== INIT / LOBBY
document.getElementById("start").addEventListener("click", startAudio);
function paintAll() {
  paintInfo(); paintRoster();
  if (document.getElementById("console").hidden) return;
  paintWheel(); paintPoll(); paintMix(); renderRoll(); paintLeadFromState();
}
function paintInfo() {
  if (!st) return;
  for (const id of ["lb-room", "room"]) setText(id, st.room);
  for (const id of ["lb-key", "key"]) setText(id, st.key + " MAJ");
  for (const id of ["lb-tempo", "tempo"]) setText(id, st.tempo);
}
function paintRoster() {
  const phones = roster.filter((r) => r.role !== "groove");
  const lb = document.getElementById("lb-roster");
  if (lb) lb.innerHTML = roster.length
    ? roster.map((r) => chip(r.role, "#" + r.id)).join("")
    : `<span class="mono" style="color:#5a564d">waiting for players…</span>`;
  // heartbeat squares = up to 4 phone players
  const sq = document.getElementById("squares");
  if (sq) sq.innerHTML = [0, 1, 2, 3].map((i) =>
    `<div class="sq" style="${phones[i] ? "background:" + ROLE_COLOR[phones[i].role] : ""}"></div>`).join("");
  // G H L C dots
  const present = new Set(roster.map((r) => r.role));
  const dots = document.getElementById("dots");
  if (dots) dots.innerHTML = ROLE_ORDER.map((role) =>
    `<div class="rdot" style="background:${present.has(role) ? ROLE_COLOR[role] : "var(--gray)"}">${ROLE_LETTER[role]}</div>`).join("");
}
function chip(role, tag) {
  return `<span class="mono caps" style="background:${ROLE_COLOR[role]};color:#fff;border:var(--border);box-shadow:var(--shadow-sm);border-radius:999px;padding:8px 16px;font-size:14px">${role} ${tag}</span>`;
}

// =================================================================== CONSOLE BUILD
const ROWS = [ // top → bottom (matches reference)
  { n: "E5", m: 76, blk: 0 }, { n: "D5", m: 74, blk: 0 }, { n: "C#5", m: 73, blk: 1 },
  { n: "B4", m: 71, blk: 0 }, { n: "A4", m: 69, blk: 0 }, { n: "F#4", m: 66, blk: 1 },
  { n: "E4", m: 64, blk: 0 }, { n: "C#4", m: 61, blk: 1 },
];
const LABELW = 46, BARS = 4;
let leadNotes = []; // {pc, bar, x}

function buildConsole() {
  drawWaves();
  buildWheel();
  buildRoll();
  buildXY();
  buildLeadKeys();
  paintAll();
}

function buildWheel() {
  const W = document.getElementById("wheel"); if (!W) return;
  const wheel = diatonic(st.key).slice(0, 6);
  const R = 110, C = 150;
  W.innerHTML = `<svg class="wedge" viewBox="0 0 300 300" id="wedgesvg"></svg>` +
    wheel.map((c, i) => {
      const a = (-90 + i * 60) * Math.PI / 180, x = C + R * Math.cos(a), y = C + R * Math.sin(a);
      return `<div class="wnode" data-roman="${c.roman}" style="left:${x - 42}px;top:${y - 42}px">
        <span class="r">${c.roman}</span><span class="n">${c.name}</span></div>`;
    }).join("");
}
function paintWheel() {
  const W = document.getElementById("wheel"); if (!W || !W.children.length) return;
  const prog = st.progression || [];
  W.querySelectorAll(".wnode").forEach((n) => {
    n.classList.toggle("active", prog.includes(n.dataset.roman));
    n.classList.toggle("cur", n.dataset.roman === st.chord);
  });
  // progression path lines
  const svg = document.getElementById("wedgesvg");
  const pos = (roman) => { const i = ["I","ii","iii","IV","V","vi"].indexOf(roman); const a = (-90 + i * 60) * Math.PI / 180; return [150 + 110 * Math.cos(a), 150 + 110 * Math.sin(a)]; };
  if (svg) svg.innerHTML = prog.slice(1).map((r, i) => {
    const [x1, y1] = pos(prog[i]), [x2, y2] = pos(r);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#1BA88A" stroke-width="6" stroke-linecap="round"/>`;
  }).join("");
}

function buildRoll() {
  const roll = document.getElementById("roll"); if (!roll) return;
  roll.innerHTML = ROWS.map((r, i) =>
    `<div class="rrow" style="top:${i / ROWS.length * 100}%;height:${100 / ROWS.length}%">
      <div class="rlabel ${r.blk ? "blk" : "wht"}">${r.n}</div></div>`).join("") +
    [1, 2, 3].map((b) => `<div class="barline" style="left:calc(${LABELW}px + ${b / BARS} * (100% - ${LABELW}px))"></div>`).join("") +
    [1, 2, 3, 4].map((b) => `<div class="barnum" style="left:calc(${LABELW}px + ${(b - 1) / BARS} * (100% - ${LABELW}px) + 8px)">BAR ${b}</div>`).join("") +
    `<div class="playhead" id="playhead" style="left:${LABELW}px"></div>`;
}
function renderRoll() {
  const roll = document.getElementById("roll"); if (!roll || !roll.querySelector(".rrow")) return;
  roll.querySelectorAll(".note").forEach((n) => n.remove());
  const prog = (st.progression?.length ? st.progression : ["I"]);
  const rh = roll.clientHeight / ROWS.length, gw = (roll.clientWidth - LABELW) / BARS;
  const rowOf = (used, pcs) => { for (let i = 0; i < ROWS.length; i++) if (pcs.includes(ROWS[i].m % 12) && !used.has(i)) { used.add(i); return i; } return -1; };
  // harmony: each upcoming bar's chord triad
  for (let b = 0; b < BARS; b++) {
    const deg = prog[(progIdx + b) % prog.length] || "I";
    const pcs = chordMidi(st.key, deg, 4).map((m) => m % 12);
    const used = new Set();
    pcs.forEach(() => {
      const ri = rowOf(used, pcs); if (ri < 0) return;
      addNote(roll, "h", LABELW + b * gw + 4, ri * rh + 4, gw - 8, rh - 8, "");
    });
  }
  // lead notes
  leadNotes.forEach((ln) => {
    let ri = ROWS.findIndex((r) => r.m % 12 === ln.pc); if (ri < 0) ri = 0;
    addNote(roll, "l", LABELW + ln.bar * gw + ln.x * gw, ri * rh + 4, Math.max(26, gw * 0.18), rh - 8, ln.name || "");
  });
}
function addNote(roll, cls, x, y, w, h, label) {
  const d = document.createElement("div");
  d.className = "note " + cls; d.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
  d.textContent = label; roll.appendChild(d);
}
function movePlayhead(beat) {
  const roll = document.getElementById("roll"), ph = document.getElementById("playhead"); if (!ph) return;
  const gw = (roll.clientWidth - LABELW) / BARS, b = bar % BARS;
  ph.style.left = (LABELW + (b + beat / 4) * gw) + "px";
}
function flashRoll() {
  const roll = document.getElementById("roll"); if (!roll) return;
  roll.animate([{ filter: "brightness(1.25)" }, { filter: "brightness(1)" }], { duration: 300 });
}

// groove XY pad (the host's instrument)
function buildXY() {
  const xy = document.getElementById("xy"); if (!xy) return;
  const dot = document.getElementById("xydot");
  const place = (cx, cy) => {
    const r = xy.getBoundingClientRect();
    groove.x = clamp((cx - r.left) / r.width); groove.y = clamp(1 - (cy - r.top) / r.height);
    dot.style.left = groove.x * 100 + "%"; dot.style.top = (1 - groove.y) * 100 + "%";
    document.getElementById("xyrd").textContent = `x.${pad2(groove.x)} · y.${pad2(groove.y)}`;
    bus.send({ type: "host", action: "groove", payload: { x: groove.x, y: groove.y } });
  };
  let down = false;
  const md = (e) => { down = true; place(e.clientX ?? e.touches[0].clientX, e.clientY ?? e.touches[0].clientY); };
  const mm = (e) => { if (down) place(e.clientX ?? e.touches[0].clientX, e.clientY ?? e.touches[0].clientY); };
  xy.addEventListener("pointerdown", md); window.addEventListener("pointermove", mm);
  window.addEventListener("pointerup", () => down = false);
  dot.style.left = "50%"; dot.style.top = "50%";
}

function buildLeadKeys() {
  const kb = document.getElementById("leadkeys"); if (!kb) return;
  kb.innerHTML = ["C","D","E","F","G","A","B"].map((n) => `<div class="lk" data-note="${n}"><span class="d"></span></div>`).join("");
}
function onLeadNote(p) {
  // light the key + add to readout/motif
  const k = document.querySelector(`.lk[data-note="${p.note}"]`);
  if (k) { k.classList.add("on"); setTimeout(() => k.classList.remove("on"), 220); }
  const pc = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"].indexOf(p.note);
  leadNotes.push({ pc, name: p.note, bar: bar % BARS, x: 0.1 + Math.random() * 0.6 });
  leadNotes = leadNotes.slice(-8);
  renderRoll(); renderMotif();
}
function paintLeadFromState() { renderMotif(); }
function renderMotif() {
  const m = document.getElementById("motif"); if (!m) return;
  m.innerHTML = leadNotes.map((ln, i) =>
    `<div class="mn" style="left:${6 + i * 12}%;top:${20 + (11 - ln.pc) / 11 * 55}%;width:8%"></div>`).join("");
}

// crowd poll (left)
const POLL = [
  { k: "brighter", nm: "BRIGHTER", c: "var(--brighter)" }, { k: "heavier", nm: "HEAVIER", c: "var(--heavier)" },
  { k: "dreamier", nm: "DREAMIER", c: "var(--dreamier)" }, { k: "_energy", nm: "+ENERGY", c: "#F2A7D0" },
  { k: "darker", nm: "DARKER", c: "var(--darker)" },
];
function paintPoll() {
  const el = document.getElementById("poll"); if (!el) return;
  const vals = POLL.map((p) => p.k === "_energy" ? Math.round(st.energy * 50) : (st.mood?.[p.k] || 0));
  const max = Math.max(1, ...vals);
  el.innerHTML = POLL.map((p, i) =>
    `<div class="prow"><span class="nm">${p.nm}</span>
      <span class="track"><div style="width:${vals[i] / max * 100}%;background:${p.c}"></div></span>
      <span class="val">${vals[i]}</span></div>`).join("");
  setText("voting", st.crowdCount ?? 0);
  const coll = document.getElementById("coll");
  if (coll) { const pct = Math.round((st.energy || 0) * 100); coll.style.width = pct + "%"; coll.textContent = pct + "%"; }
}

// crowd → the mix (right)
const FADERS = [
  { nm: "BRIGHT", c: "var(--groove)", f: (s) => 20 + Math.min(80, (s.mood?.brighter || 0) * 8) },
  { nm: "WEIGHT", c: "var(--lead)", f: (s) => 20 + Math.min(80, (s.mood?.heavier || 0) * 8) },
  { nm: "SPACE", c: "var(--dreamier)", f: (s) => 20 + Math.min(80, (s.mood?.dreamier || 0) * 8) },
  { nm: "ENERGY", c: "#F2A7D0", f: (s) => Math.round((s.energy || 0) * 100) },
  { nm: "TONE", c: "var(--darker)", f: (s) => 10 + Math.min(80, (s.mood?.darker || 0) * 8) },
];
function paintMix() {
  const el = document.getElementById("mix"); if (!el) return;
  el.innerHTML = FADERS.map((fd) => {
    const v = Math.round(fd.f(st));
    return `<div class="fader"><div class="val">${v}</div>
      <div class="tube"><div class="fill" style="height:${v}%;background:${fd.c}"></div>
        <div class="cap" style="bottom:calc(${v}% - 3px)"></div></div>
      <div class="nm">${fd.nm}</div></div>`;
  }).join("");
}

// header heartbeat
function pulseHeartbeat() {
  document.querySelectorAll(".rdot,.sq").forEach((d) => { d.classList.add("pulse"); setTimeout(() => d.classList.remove("pulse"), 110); });
}

// decorative sine waves
function drawWaves() {
  const svg = document.getElementById("waves"); if (!svg) return;
  const cols = ["#9B7BE6", "#5FD0A8", "#F4533A", "#F5B82E"];
  svg.innerHTML = cols.map((c, i) => {
    let d = `M0 ${200 + i * 130} `;
    for (let x = 0; x <= 1200; x += 30) d += `L${x} ${200 + i * 130 + Math.sin((x / 130) + i) * 40} `;
    return `<path d="${d}" fill="none" stroke="${c}" stroke-width="5" opacity="0.35"/>`;
  }).join("");
}

// utils
function setText(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }
function clamp(v) { return Math.max(0, Math.min(1, v)); }
function pad2(v) { return String(Math.round(v * 100)).padStart(2, "0"); }
window.addEventListener("resize", () => { if (!document.getElementById("console").hidden) { buildRoll(); renderRoll(); } });
