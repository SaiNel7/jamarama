// Host = lobby + console. Owns the master clock (Tone.js), the groove-driven drum
// engine + harmony synth, and renders the live room view from broadcast state.
import { Bus, romanToName, chordMidi, chordNotes, diatonic } from "/js/shared.js";
import { LeadBrain } from "/js/brain/lead.js";
import { HarmonyBrain } from "/js/brain/harmony.js";
import { midiName, snap, keyRoot, MAJOR, MINOR } from "/js/brain/theory.js";
import { loadVoices } from "/js/voices.js";
import { NotationView } from "/js/notation.js";
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
bus.on("control", (m) => {
  if (m.action === "note") onLeadNote(m.payload);
  else if (m.action === "leadrec") (m.payload?.cmd === "start" ? leadStartRec() : leadCloseLoop());
  else if (m.action === "overwrite") overwrite = !!m.payload?.on;
  else if (m.action === "leadclear") leadClear();
});
// Server finished baking the taste-derived MRT2 voices (~7s after jam start) →
// swap them in over the built-in synths. The jam is already playing on the
// defaults by then: "default voice instant, personalized swaps in".
bus.on("voices", () => { if (started) applyPrebakedVoices(); });

// ---- join info ----
// While the server's cloudflared tunnel is coming up, show a "creating link…"
// state — never flash the LAN address. The final URL (tunnel, or LAN only if the
// tunnel can't start) is the first thing ever displayed.
async function refreshInfo() {
  try {
    const info = await (await fetch("/info")).json();
    if (info.pending) {
      document.getElementById("joinurl").textContent = "creating join link…";
      document.getElementById("qr").style.visibility = "hidden";   // no broken-img flash, no LAN QR
      setTimeout(refreshInfo, 1200);
      return;
    }
    document.getElementById("qr").src = info.qr;
    document.getElementById("qr").style.visibility = "visible";
    document.getElementById("joinurl").textContent = info.joinUrl;
  } catch { setTimeout(refreshInfo, 1200); }
}
refreshInfo();

// =================================================================== AUDIO ENGINE
// Synths are created lazily inside startAudio (after the user gesture / Tone.start),
// so a bad option can't break module load and silently kill the start button.
let kick, snare, hat, chordSynth, leadSynth;
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
  // LEAD voice — the melody, sits on top but balanced with the band. Bright mono synth
  // through a touch of delay/reverb (their dry passthrough carries the body, so one path —
  // no separate dry connect that would double the level).
  const leadFx = new Tone.Reverb({ decay: 1.6, wet: 0.18 }).toDestination();
  const leadEcho = new Tone.FeedbackDelay({ delayTime: "8n.", feedback: 0.18, wet: 0.15 }).connect(leadFx);
  leadSynth = new Tone.MonoSynth({
    oscillator: { type: "sawtooth" },
    envelope: { attack: 0.005, decay: 0.18, sustain: 0.45, release: 0.25 },
    filterEnvelope: { attack: 0.005, decay: 0.12, sustain: 0.6, baseFrequency: 600, octaves: 3 },
    volume: -8,
  }).connect(leadEcho);
}

// If the user's taste was pre-baked into MRT2 voices, swap the built-in chord/lead synths for
// the prompt-shaped Tone.Samplers (identical triggerAttackRelease API, so the brain/clock code
// is untouched). Pure drop-in; silently keeps the synths when there's no prebake. Zero runtime
// neural cost — these are sampled one-shots, the brain still chooses the notes.
async function applyPrebakedVoices() {
  let v = null;
  try { v = await loadVoices("/voices/"); } catch { /* no prebake → keep synths */ }
  if (!v || !v.samplers) return;
  const swap = (cur, sampler, vol) => {
    if (!sampler) return cur;
    sampler.volume.value = vol;
    sampler.toDestination();
    try { cur?.dispose?.(); } catch {}
    return sampler;
  };
  chordSynth = swap(chordSynth, v.samplers.harmony, -12);   // harmony voice
  leadSynth  = swap(leadSynth,  v.samplers.lead,    -8);    // lead voice (matches prior balance)
  const loaded = ["harmony", "lead"].filter((n) => v.samplers[n]);
  if (loaded.length) console.log(`[voices] prompt-baked voices loaded: ${loaded.join(" + ")}`);
}

let started = false;
let lobbyReady = false;           // all players ready (or no players) — updated by paintRoster
async function startAudio() {
  if (started) return;            // ignore double-taps (would double-schedule the clock)
  if (!lobbyReady) {              // HARD GATE: can't start until the whole lobby is ready
    const b = document.getElementById("start");
    b.classList.remove("shake"); void b.offsetWidth;  // restart the animation
    b.classList.add("shake");
    return;
  }
  started = true;
  // Show the console FIRST — audio init must never hold the screen hostage. A contended
  // output device (e.g. the MRT2 texture engine holding the default sink) can make
  // Tone.start()'s AudioContext.resume() hang forever; we don't want a frozen lobby.
  showConsole();
  bus.send({ type: "host", action: "start" });  // lobby → jam: phones flip to role UIs, taste blend finalizes
  try {
    await withTimeout(Tone.start(), 4000);   // resume the AudioContext (bounded)
    initSynths();
    const t = Tone.getTransport();
    t.bpm.value = st?.tempo || 124;
    t.scheduleRepeat(onSixteenth, "16n");
    t.start();
    applyPrebakedVoices();                    // swap in MRT2 prompt-baked voices if a prebake exists
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
  leadTick(time);                               // tempo-synced lead looper (overdub + playback)
  harmonyTick(time);                            // generative harmony comp (brain-driven, room-shaped)
  const { x, y } = groove;
  // --- drums driven by the groove X/Y ---
  if (sub === 0 || (sub === 8 && y > 0.3)) kick.triggerAttackRelease("C1", "8n", time, 0.55 + 0.45 * y);
  if ((sub === 4 || sub === 12) && y > 0.32) snare.triggerAttackRelease("16n", time, 0.5 + 0.5 * y);
  const hatHit = x < 0.34 ? sub % 4 === 0 : x < 0.7 ? sub % 2 === 0 : true;
  if (hatHit) hat.triggerAttackRelease("32n", time, 0.5 + 0.4 * y);
  // --- quarter-note events ---
  if (sub % 4 === 0) {
    if (beat === 0) bar = (Tone.getTransport().position.split(":")[0] | 0);
    bus.send({ type: "beat", bar, beat });
    Tone.getDraw().schedule(pulseHeartbeat, time);
  }
  // one shared 16th-resolution position drives BOTH readouts so the playheads stay in lockstep
  const rdStep = ((bar % BARS) * 16 + sub) % (BARS * 16);
  Tone.getDraw().schedule(() => { movePlayhead(rdStep); if (viewMode === "sheet") notation?.setPlayhead(rdStep); }, time);
  s16++;
}

// =================================================================== HARMONY (generative comp)
// The harmony phone sends the chord progression (a beat-schedule). The host does NOT play
// those chords back verbatim — it runs them through the harmony brain (rhythmic comping /
// arpeggiation / syncopation, driven by the room), so what the room hears is generative,
// inspired by their input. The player hears their own chords live on their phone.
const harmonyBrain = new HarmonyBrain();
let harmonyComp = [], harmonyLen = 16, harmonyIdx = 0, lastSchedKey = "", lastChordKey = null;

// The drawn schedule; before anything is drawn, fall back to the default progression so the
// room still has harmony. Returns beat-slots [{notes:[midi], roman, label}].
function effectiveSchedule() {
  const sched = st?.schedule;
  if (sched && sched.length) return sched;
  const prog = (st?.progression?.length ? st.progression : ["I", "IV", "V", "vi"]);
  return prog.flatMap((roman) => {
    const slot = { notes: chordMidi(st?.key || "A", roman, 4), roman, label: roman };
    return [slot, slot, slot, slot];                       // 1 bar (4 beats) per chord
  });
}
// Comp rhythm is driven by the room: crowd energy + GROOVE X → density, GROOVE Y → swing/arp.
function harmonyParams() {
  const e = st?.energy || 0, gx = groove.x || 0, gy = groove.y || 0;
  return { density: clamp(0.3 + 0.4 * e + 0.25 * gx), syncopate: clamp(0.35 * gy), arp: clamp(0.5 * gy) };
}
// Clock tick (every 16th): play the generative comp; broadcast chord changes for the readout.
function harmonyTick(time) {
  const sched = effectiveSchedule();
  harmonyLen = sched.length * 4;                            // 4 sixteenth-steps per beat
  const ph = ((s16 % harmonyLen) + harmonyLen) % harmonyLen;
  const schedKey = sched.map((s) => s.label || s.roman).join("|");
  if (ph === 0 || schedKey !== lastSchedKey) {             // new loop or edited progression → regenerate
    lastSchedKey = schedKey;
    harmonyComp = harmonyBrain.comp(sched, harmonyParams(), harmonyIdx++);
  }
  const sixteenth = Tone.Time("16n").toSeconds();
  if (chordSynth) for (const n of harmonyComp)
    if (n.t === ph) chordSynth.triggerAttackRelease(midiName(n.p), Math.max(0.08, n.d * sixteenth), time, n.v ?? 0.8);
  // chord-change → music-readout sync + state broadcast (checked on beats)
  if (s16 % 4 === 0) {
    const bi = (s16 / 4 | 0) % sched.length;
    const slot = sched[bi] || sched[0];
    const key = slot.label || slot.roman;
    if (key !== lastChordKey) {
      lastChordKey = key;
      let ri = 0; for (let i = 1; i <= bi; i++) if ((sched[i].label || sched[i].roman) !== (sched[i - 1].label || sched[i - 1].roman)) ri++;
      progIdx = ri;
      bus.send({ type: "host", action: "chord", payload: slot.roman || slot.label });
      Tone.getDraw().schedule(() => { renderRoll(); flashRoll(); }, time);
    }
  }
}

// =================================================================== LEAD LOOPER (host-owned)
// A tempo-synced live-looping overdub recorder. The lead phone sends RAW notes; the host
// quantizes them to the 16th grid and writes them into a loop at the playhead. The loop
// LENGTH is set by how long the player records the first pass (snapped to whole bars).
// OVERWRITE/LAYER (phone) picks replace-vs-overdub. WILDNESS (host slider) remixes the
// PLAYBACK — rhythmic retrograde/shift + occasional melodic inversion; at 0 the loop plays
// back exactly as recorded, so overdubbing stays coherent.
const SPB = 16;                                  // 16th-note steps per bar
const leadBrain = new LeadBrain({ bars: 4 });
const NOTE_PC = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
let leadState = "idle";                          // idle | recording | looping
let recLoop = [];                                // {t,p,d,v} canonical recording (t in steps)
let playLoop = [];                               // generated playback for the current iteration
let loopLen = 4 * SPB;                            // dynamic — set when the first pass closes
let loopStart = 0;                               // global step (s16) of the loop's bar 0
let overwrite = true;                            // overdub mode (from the phone)
let leadWild = 0.3;                              // wildness (host slider) — audible remix by default
let leadLoopIdx = 0;
let lastNoteStep = -999;                          // last step a note arrived (for auto-lock on silence)
const AUTO_LOCK = SPB;                            // ~1 bar of silence → lock the loop & start looping

const midiOf = (p) => 12 * ((p.oct ?? 5) + 1) + NOTE_PC.indexOf(p.note);
// Current 16th-step in REAL time (transport position), NOT the look-ahead s16 used to schedule
// audio. Recording on this = notes land on the step the player actually heard → in time.
const nowStep = () => { const p = Tone.getTransport().position.split(":"); return Math.round((+p[0]) * 16 + (+p[1]) * 4 + (+p[2])); };

// Wildness → transform params. At 0 it's a faithful loop (no variation).
function leadParams() {
  const w = leadWild;
  return {
    responseEvery: w > 0.02 ? 1 : 0,             // 0 = faithful; 1 = vary every loop
    retro: 0.55 * w, shift: 0.5 * w, density: 0.5 * w,
    invert: 0.6 * w, harmonize: 0.4,
  };
}
function leadSetState(s) { leadState = s; setText("leadloopstate", s); }
function leadStartRec() {                          // begin defining a new loop
  recLoop = []; playLoop = []; leadLoopIdx = 0;
  loopStart = Math.floor(nowStep() / SPB) * SPB;  // snap to the top of the current bar (real-time)
  leadSetState("recording");
}
// Build the playback for this iteration (the wildness remix of the recording). Called on lock
// AND every loop boundary, so playback starts immediately and never has a silent gap.
function leadGenerate() {
  leadBrain.len = loopLen;
  leadBrain.setPhrase(recLoop);
  leadBrain.setKey(st?.key || "A", st?.scale || "major");
  leadBrain.setChord(chordMidi(st?.key || "A", st?.chord || "I", 4));
  const gen = recLoop.length ? leadBrain.generate(leadLoopIdx++, leadParams()) : [];
  // Hard guarantee in-key: snap every note to the song scale. Catches chromatic artifacts from
  // harmonize's fractional move and any out-of-key input.
  const root = keyRoot(st?.key || "A"), scale = (st?.scale === "minor") ? MINOR : MAJOR;
  playLoop = gen.map((n) => ({ ...n, p: snap(n.p, root, scale) }));
}
function leadCloseLoop() {                         // lock length to the recorded span (whole bars)
  if (leadState !== "recording") return;
  const span = Math.max(0, lastNoteStep - loopStart);
  loopLen = Math.max(SPB, Math.ceil((span + 1) / SPB) * SPB);
  recLoop = recLoop.map((n) => ({ ...n, t: ((n.t % loopLen) + loopLen) % loopLen }));
  leadBrain.len = loopLen; leadLoopIdx = 0;
  leadSetState("looping");
  leadGenerate(); renderLeadLoop(); renderRoll(); // play & draw both panels immediately (no silent gap)
}
function leadClear() { recLoop = []; playLoop = []; leadSetState("idle"); renderLeadLoop(); renderRoll(); }

// Record a played note at the (host-quantized) playhead. Auto-arms on the first note.
function leadRecordNote(p) {
  if (leadState === "idle") leadStartRec();
  const now = nowStep();
  const rel = now - loopStart;
  const t = leadState === "looping" ? ((rel % loopLen) + loopLen) % loopLen : Math.max(0, rel);
  if (overwrite) recLoop = recLoop.filter((n) => n.t !== t);   // replace what's at this step
  recLoop.push({ t, p: midiOf(p), d: 2, v: 0.9 });
  lastNoteStep = now;
}

// Clock tick (every 16th, with the precise audio `time`): auto-lock, sweep playhead, play loop.
function leadTick(time) {
  // auto-lock ~1 bar after the player stops → it loops without any button (length = what was played)
  if (leadState === "recording" && recLoop.length && (s16 - lastNoteStep) >= AUTO_LOCK) leadCloseLoop();
  if (leadState !== "looping" || !loopLen) return;
  const ph = (((s16 - loopStart) % loopLen) + loopLen) % loopLen;
  if (ph === 0) { leadGenerate(); Tone.getDraw().schedule(renderRoll, time); }   // fresh variation → middle readout
  if (playLoop.length && leadSynth) {
    const sixteenth = Tone.Time("16n").toSeconds();
    for (const n of playLoop)
      if (n.t === ph) leadSynth.triggerAttackRelease(midiName(n.p), Math.max(0.05, n.d * sixteenth), time, n.v ?? 0.9);
  }
  Tone.getDraw().schedule(() => moveLeadPlayhead(ph), time);   // sweep the visual playhead
}

// --- lead loop visualization (host LEAD panel): notes as bars + a sweeping playhead ---
function renderLeadLoop() {
  const el = document.getElementById("leadloop"); if (!el) return;
  const notes = recLoop;                            // LEAD panel = the ORIGINAL INPUT you played
  if (!notes.length) { el.innerHTML = `<div class="llph" id="llph"></div>`; return; }
  const lo = Math.min(...notes.map((n) => n.p)), hi = Math.max(...notes.map((n) => n.p)), span = Math.max(1, hi - lo);
  el.innerHTML = notes.map((n) => {
    const x = (n.t / loopLen) * 100, w = Math.max(2, (n.d / loopLen) * 100), y = (1 - (n.p - lo) / span) * 74 + 12;
    return `<div class="lln" style="left:${x}%;top:${y}%;width:${w}%"></div>`;
  }).join("") + `<div class="llph" id="llph"></div>`;
}
function moveLeadPlayhead(ph) {
  const el = document.getElementById("llph"); if (el) el.style.left = ((ph / loopLen) * 100) + "%";
}

// =================================================================== INIT / LOBBY
document.getElementById("start").addEventListener("click", startAudio);

// --- editable lobby info: room (text), key (dropdown), tempo (number + scroll-jog).
// Host-authoritative: edits go to the server, the state echo repaints everyone.
const KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const lbRoom = document.getElementById("lb-room");
const lbKey = document.getElementById("lb-key");
const lbTempo = document.getElementById("lb-tempo");
let roomTimer = null;
lbRoom.addEventListener("input", () => {
  const v = lbRoom.value;     // capture now — a state echo may repaint the field before we fire
  clearTimeout(roomTimer);
  roomTimer = setTimeout(() => { roomTimer = null; bus.send({ type: "host", action: "room", payload: v }); }, 250);
});
// key tonic: type a note (A, F#, …) or scroll the box to cycle the circle of semitones
lbKey.addEventListener("change", () => sendKey(lbKey.value));
function sendKey(v) {
  v = String(v).trim().toUpperCase().replace("♯", "#");
  if (!KEYS.includes(v)) { lbKey.value = st?.key || "A"; return; }  // bad note → revert
  lbKey.value = v;
  bus.send({ type: "host", action: "key", payload: v });
}
document.getElementById("lb-key-box").addEventListener("wheel", (e) => {
  e.preventDefault();
  const cur = KEYS.indexOf((lbKey.value || st?.key || "A").toUpperCase());
  sendKey(KEYS[(Math.max(0, cur) + (e.deltaY < 0 ? 1 : 11)) % 12]);
}, { passive: false });

// scale/mode dropdown (a native <select>'s popup can't be styled — this menu is neobrutalist)
const SCALES = ["major", "minor", "dorian", "phrygian", "lydian", "mixolydian", "locrian", "chromatic", "pentatonic"];
const SCALE_ABBR = { major: "MAJ", minor: "MIN", dorian: "DOR", phrygian: "PHR", lydian: "LYD",
                     mixolydian: "MIXO", locrian: "LOC", chromatic: "CHROM", pentatonic: "PENTA" };
const lbScale = document.getElementById("lb-scale");
const scaleMenu = document.getElementById("lb-scale-menu");
scaleMenu.innerHTML = SCALES.map((s) => `<button type="button" data-s="${s}">${s.toUpperCase()}</button>`).join("");
lbScale.addEventListener("click", (e) => { e.stopPropagation(); scaleMenu.hidden = !scaleMenu.hidden; });
scaleMenu.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
  bus.send({ type: "host", action: "scale", payload: b.dataset.s });
  scaleMenu.hidden = true;
}));
document.addEventListener("click", () => { scaleMenu.hidden = true; });   // click-away closes
function sendTempo(v) {
  v = Math.max(60, Math.min(200, Math.round(v) || st?.tempo || 124));
  lbTempo.value = v;
  bus.send({ type: "host", action: "tempo", payload: v });
}
lbTempo.addEventListener("change", () => sendTempo(+lbTempo.value));
// scroll anywhere on the tempo box to jog the BPM
document.getElementById("lb-tempo-box").addEventListener("wheel", (e) => {
  e.preventDefault();
  sendTempo((+lbTempo.value || st?.tempo || 124) + (e.deltaY < 0 ? 1 : -1));
}, { passive: false });

function paintAll() {
  paintInfo(); paintRoster();
  if (document.getElementById("console").hidden) return;
  paintWheel(); paintPoll(); paintMix(); renderRoll(); paintLeadFromState();
}
function paintInfo() {
  if (!st) return;
  if (!roomTimer) setVal(lbRoom, st.room);   // an in-flight edit beats a stale echo
  setText("room", st.room);
  setVal(lbKey, st.key);
  lbScale.textContent = SCALE_ABBR[st.scale] || (st.scale || "major").toUpperCase();
  scaleMenu.querySelectorAll("button").forEach((b) => b.classList.toggle("sel", b.dataset.s === st.scale));
  setText("key", `${st.key} ${SCALE_ABBR[st.scale] || "MAJ"}`);
  setVal(lbTempo, st.tempo); setText("tempo", st.tempo);
  setText("taste", (st.taste || []).join("  +  ") || "—");
}
// write a control's value from state — but never clobber the field mid-edit
function setVal(el, v) { if (el && document.activeElement !== el) el.value = v; }
function paintRoster() {
  const phones = roster.filter((r) => r.role !== "groove");
  const lb = document.getElementById("lb-roster");
  if (lb) lb.innerHTML = phones.length
    ? phones.map((r) => chip(r)).join("")
    : `<span class="mono" style="color:#5a564d">waiting for players…</span>`;
  // ready indicator (never a gate — START stays live, just turns green when everyone's set)
  const ready = phones.filter((p) => p.ready).length;
  setText("lb-ready", `${ready}/${phones.length} ready`);
  // full yellow + unlocked when the lobby is set (or nobody to wait for); translucent + gated while readying
  lobbyReady = phones.length === 0 || ready === phones.length;
  document.getElementById("start")?.classList.toggle("allready", lobbyReady);
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
function chip(r) {
  const name = esc(r.name || "#" + r.id);
  const sub = r.taste ? `<span class="sub">“${esc(r.taste)}”</span>` : "";
  // r.avatar is a server-validated slug from the pfp pool (assets/pfps/<slug>.png)
  const av = r.avatar ? `<img class="chip-av" src="/assets/pfps/${r.avatar}.png" alt="">` : "";
  return `<span class="lb-chip${r.ready ? " rdy" : ""}" style="background:${ROLE_COLOR[r.role]}">` +
    `<span class="mono caps top">${av}${name} <i>${r.role}</i> ${r.ready ? "✓" : "…"}</span>${sub}</span>`;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`); }

// =================================================================== CONSOLE BUILD
// Readout ladder = TWO diatonic octaves of the key. Upper octave = LEAD region, lower =
// CHORD region, so the lead always renders an octave above the chords on the visualizer.
const PCN = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const SCALE_MAJ = [0, 2, 4, 5, 7, 9, 11], BLACK_PC = new Set([1, 3, 6, 8, 10]);
function makeRows(key) {
  const root = PCN.indexOf(key) < 0 ? 9 : PCN.indexOf(key), rows = [];
  for (const oct of [5, 4])                                  // oct5 (lead) on top, oct4 (chords) below
    for (let i = SCALE_MAJ.length - 1; i >= 0; i--) {
      const m = 12 * (oct + 1) + root + SCALE_MAJ[i];
      rows.push({ m, n: midiName(m), blk: BLACK_PC.has(((m % 12) + 12) % 12) ? 1 : 0, region: oct === 5 ? "lead" : "chord" });
    }
  return rows;
}
let ROWS = makeRows("A");
const LABELW = 46, BARS = 4;
let leadNotes = []; // {pc, bar, x}

// Music-readout view mode: "midi" = piano roll (#roll), "sheet" = standard notation (#score).
// The sheet view is a self-contained module reading the same live state.
let viewMode = "midi";
let notation = null;
function setupReadout() {
  if (!notation) notation = new NotationView(document.getElementById("score"));
  const mb = document.getElementById("view-midi"), sb = document.getElementById("view-sheet");
  const roll = document.getElementById("roll"), score = document.getElementById("score");
  if (!mb || !sb || mb._wired) return; mb._wired = true;
  const set = (mode) => {
    viewMode = mode;
    const sheet = mode === "sheet";
    roll.hidden = sheet; score.hidden = !sheet;
    mb.classList.toggle("active", !sheet); sb.classList.toggle("active", sheet);
    notation.setVisible(sheet);
    if (sheet) notation.render(st, playLoop, loopLen, progIdx);
  };
  mb.onclick = () => set("midi"); sb.onclick = () => set("sheet");
}

function buildConsole() {
  drawWaves();
  buildWheel();
  buildRoll();
  setupReadout();
  buildXY();
  buildLeadKeys();
  paintAll();
}

function buildWheel() { paintWheel(); }   // the wheel is fully (re)rendered from state each paint
// Mirror the harmony phone's wheel: [0]=I centered, the rest ring around it. Rebuilt from
// st.palette on every state update, so chords the phone adds via "+" appear here in real time.
function paintWheel() {
  const W = document.getElementById("wheel"); if (!W || !st) return;
  const pal = (st.palette && st.palette.length) ? st.palette
    : diatonic(st.key).slice(0, 6).map((c) => ({ roman: c.roman, display: c.name }));
  const C = 150, R = 110, total = Math.max(1, pal.length - 1);
  const pos = (i) => { if (i === 0) return [C, C]; const a = (-90 + (i - 1) * 360 / total) * Math.PI / 180; return [C + R * Math.cos(a), C + R * Math.sin(a)]; };
  const prog = st.progression || [], cur = st.chord;
  const active = (c) => prog.includes(c.roman) || prog.includes(c.display);
  const isCur = (c) => c.roman === cur || c.display === cur;
  let html = `<svg class="wedge" viewBox="0 0 300 300" id="wedgesvg"></svg>`;
  pal.forEach((c, i) => {
    const [x, y] = pos(i), sz = i === 0 ? 92 : total <= 6 ? 80 : total <= 9 ? 66 : 56;
    html += `<div class="wnode${i === 0 ? " center" : ""}${active(c) ? " active" : ""}${isCur(c) ? " cur" : ""}" ` +
      `style="left:${x - sz / 2}px;top:${y - sz / 2}px;width:${sz}px;height:${sz}px">` +
      `<span class="r">${c.roman || ""}</span><span class="n">${c.display || ""}</span></div>`;
  });
  W.innerHTML = html;
  // progression path lines (consecutive chords in the drawn loop), matched by degree or name
  const posByDeg = (d) => { const i = pal.findIndex((c) => c.roman === d || c.display === d); return i < 0 ? null : pos(i); };
  const svg = document.getElementById("wedgesvg");
  if (svg) svg.innerHTML = prog.slice(1).map((d, i) => {
    const a = posByDeg(prog[i]), b = posByDeg(d); if (!a || !b) return "";
    return `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#1BA88A" stroke-width="6" stroke-linecap="round"/>`;
  }).join("");
}

function buildRoll() {
  const roll = document.getElementById("roll"); if (!roll) return;
  ROWS = makeRows(st?.key || "A");                  // 2-octave ladder for the current key
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
  const pcOf = (m) => ((m % 12) + 12) % 12;
  const rowOf = (used, pcs, region) => { for (let i = 0; i < ROWS.length; i++) if (ROWS[i].region === region && pcs.includes(pcOf(ROWS[i].m)) && !used.has(i)) { used.add(i); return i; } return -1; };
  // harmony: render the ACTUAL schedule — chord runs at their real (sub-bar) durations,
  // voiced from the sent notes so any chord (incl. non-diatonic) shows correctly.
  const sched = st.schedule;
  if (sched && sched.length) {
    const beatW = (roll.clientWidth - LABELW) / sched.length;     // one slot per beat
    for (let i = 0; i < sched.length;) {
      const slot = sched[i], key = slot.label || slot.roman;
      let run = 1; while (i + run < sched.length && (sched[i + run].label || sched[i + run].roman) === key) run++;
      const src = (slot.notes && slot.notes.length) ? slot.notes : chordMidi(st.key, slot.roman, 4);
      const pcs = src.map((m) => ((m % 12) + 12) % 12);
      const used = new Set();
      pcs.forEach(() => { const ri = rowOf(used, pcs, "chord"); if (ri < 0) return;
        addNote(roll, "h", LABELW + i * beatW + 3, ri * rh + 4, run * beatW - 6, rh - 8, ""); });
      i += run;
    }
  } else {                                                         // fallback: per-bar (no schedule yet)
    for (let b = 0; b < BARS; b++) {
      const deg = prog[(progIdx + b) % prog.length] || "I";
      const pcs = chordMidi(st.key, deg, 4).map((m) => m % 12);
      const used = new Set();
      pcs.forEach(() => { const ri = rowOf(used, pcs, "chord"); if (ri < 0) return;
        addNote(roll, "h", LABELW + b * gw + 4, ri * rh + 4, gw - 8, rh - 8, ""); });
    }
  }
  // lead = the GENERATED loop (playLoop), in the upper (lead) rows, mapped across the readout
  // by loop position. (The original input you played is shown in the LEAD panel on the right.)
  if (playLoop.length && loopLen) {
    const W = roll.clientWidth - LABELW;
    playLoop.forEach((n) => {
      let ri = ROWS.findIndex((r) => r.region === "lead" && pcOf(r.m) === pcOf(n.p));
      if (ri < 0) ri = ROWS.findIndex((r) => r.region === "lead");
      addNote(roll, "l", LABELW + (n.t / loopLen) * W, ri * rh + 4, Math.max(14, (n.d / loopLen) * W), rh - 8, "");
    });
  }
  // mirror the same data into the sheet-music view when it's the active readout
  if (viewMode === "sheet") notation?.render(st, playLoop, loopLen, progIdx);
}
function addNote(roll, cls, x, y, w, h, label) {
  const d = document.createElement("div");
  d.className = "note " + cls; d.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
  d.textContent = label; roll.appendChild(d);
}
// step = 16th-note position within the readout window (0 .. BARS*16). Linear mapping over the
// note area, matching the sheet view's mapping so the two playheads stay musically in sync.
function movePlayhead(step) {
  const roll = document.getElementById("roll"), ph = document.getElementById("playhead"); if (!ph) return;
  ph.style.left = (LABELW + (step / (BARS * 16)) * (roll.clientWidth - LABELW)) + "px";
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
  // WILDNESS — host-owned remix amount for the lead loop playback.
  const ws = document.getElementById("leadwild");
  if (ws) { ws.value = Math.round(leadWild * 100); setText("leadwildval", ws.value + "%");
    ws.oninput = () => { leadWild = clamp(+ws.value / 100); setText("leadwildval", ws.value + "%"); }; }
  setText("leadloopstate", leadState);
  renderLeadLoop();
}
function onLeadNote(p) {
  // The host does NOT echo raw taps — the player hears those live on their own phone.
  // The host only plays the QUANTIZED, generative loop (see leadTick). Here we just record.
  leadRecordNote(p);    // record into the loop at the playhead (host-quantized)
  // light the key + refresh the LEAD panel (which now shows YOUR raw input loop)
  const k = document.querySelector(`.lk[data-note="${p.note}"]`);
  if (k) { k.classList.add("on"); setTimeout(() => k.classList.remove("on"), 220); }
  renderLeadLoop();
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
