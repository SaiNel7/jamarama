// Host = lobby + console. Owns the master clock (Tone.js), the groove-driven drum
// engine + harmony synth, and renders the live room view from broadcast state.
import { Bus, romanToName, chordMidi, chordNotes, diatonic, scaleNotes } from "/js/shared.js";
import { LeadBrain } from "/js/brain/lead.js";
import { HarmonyBrain } from "/js/brain/harmony.js";
import { midiName, snap, keyRoot, MAJOR, MINOR } from "/js/brain/theory.js";
import { loadVoices } from "/js/voices.js";
import { NotationView } from "/js/notation.js";
import { HostRecorder } from "/js/record.js";
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

// ---- join info ----
fetch("/info").then((r) => r.json()).then((info) => {
  document.getElementById("qr").src = info.qr;
  document.getElementById("joinurl").textContent = info.joinUrl;
  const q2 = document.getElementById("qr2");           // audience join QR on the console
  if (q2) q2.src = info.qr;
});

// =================================================================== AUDIO ENGINE
// Synths are created lazily inside startAudio (after the user gesture / Tone.start),
// so a bad option can't break module load and silently kill the start button.
let kick, snare, hat, chordSynth, leadSynth, bassSynth;
let drumKit = null;                                 // MRT2 auto-chopped sample kit (null → built-in synths)
let masterBus, drumBus, harmonyBus, leadBus, bassBus;   // record/export buses (per-stem → master → speakers)
let bedDuck = null;                                 // sidechain: harmony+bass bed, ducked by kick/snare
const recorder = new HostRecorder();
let bar = 0, progIdx = -1, s16 = 0;
const groove = { x: 0.5, y: 0.5 };   // X = sparse↔dense, Y = chill↔hype

function initSynths() {
  // Routing: each voice → its stem bus → master bus → speakers; the recorder taps all four buses,
  // so export captures ONLY the host's generative band (drums/harmony/lead). Phone-local taps never
  // enter this graph, so they're naturally excluded from every export.
  // Master chain: stems → masterBus → brickwall limiter → speakers. The limiter is a hard safety net
  // so the summed band can NEVER clip the output (clipping a low-heavy mix is what read as harsh noise).
  masterBus = new Tone.Gain(0.7);                       // master trim so the limiter is never slammed
  masterBus.chain(new Tone.Limiter(-1), Tone.getDestination());
  // Sidechain bed: harmony + bass route through bedDuck, which is dipped on every kick/snare so the
  // sustained instruments "pump" under the drums (kick/bass stop fighting in the low end, snare cuts
  // through). Lead and drums bypass the duck — the melody stays steady and the drums DRIVE the duck.
  bedDuck = new Tone.Gain(1).connect(masterBus);
  // Per-stem EQ so each instrument owns its band. The decisive one: harmony LOW-PASS at 3.2 kHz —
  // ~70% of the raw pad energy was >3 kHz noise/hash (flatness ~0.7), the "noise in the chords."
  const eq = (...stages) => { const n = stages.map((s) => new Tone.Filter(s)); for (let i=0;i<n.length-1;i++) n[i].connect(n[i+1]); return n; };
  const HP = (f, rolloff=-12) => ({ type: "highpass", frequency: f, rolloff });
  const LP = (f, rolloff=-24) => ({ type: "lowpass", frequency: f, rolloff });
  const wire = (busGain, dest, stages) => {            // busGain (stem tap) → EQ chain → dest
    const n = eq(...stages); busGain.connect(n[0]); n[n.length-1].connect(dest); return busGain;
  };
  drumBus    = wire(new Tone.Gain(1.2), masterBus, [HP(35)]);                  // drums forward + loud (limiter guards)
  harmonyBus = wire(new Tone.Gain(),    bedDuck,   [HP(150), LP(3200, -24)]);  // warm pad, kill >3k noise
  bassBus    = wire(new Tone.Gain(),    bedDuck,   [HP(35),  LP(2500)]);       // round low end, no fizz
  leadBus    = wire(new Tone.Gain(),    masterBus, [HP(220), LP(9000)]);       // present mids, not ducked
  recorder.attach({ master: masterBus, drums: drumBus, harmony: harmonyBus, lead: leadBus, bass: bassBus });

  kick = new Tone.MembraneSynth({ octaves: 6, pitchDecay: 0.05, volume: -2 }).connect(drumBus);
  snare = new Tone.NoiseSynth({ envelope: { attack: 0.001, decay: 0.12, sustain: 0 }, volume: -16 }).connect(drumBus);
  hat = new Tone.NoiseSynth({ envelope: { attack: 0.001, decay: 0.03, sustain: 0 }, volume: -24 }).connect(drumBus);
  const verb = new Tone.Reverb({ decay: 2.4, wet: 0.28 }).connect(harmonyBus);
  chordSynth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "fatsawtooth", count: 2, spread: 16 },
    envelope: { attack: 0.03, decay: 0.4, sustain: 0.5, release: 0.5 }, volume: -13,
  }).connect(verb);
  // LEAD voice — the melody, sits on top but balanced with the band. Bright mono synth
  // through a touch of delay/reverb (their dry passthrough carries the body, so one path —
  // no separate dry connect that would double the level).
  const leadFx = new Tone.Reverb({ decay: 1.6, wet: 0.18 }).connect(leadBus);
  const leadEcho = new Tone.FeedbackDelay({ delayTime: "8n.", feedback: 0.18, wet: 0.15 }).connect(leadFx);
  leadSynth = new Tone.MonoSynth({
    oscillator: { type: "sawtooth" },
    envelope: { attack: 0.005, decay: 0.18, sustain: 0.45, release: 0.25 },
    filterEnvelope: { attack: 0.005, decay: 0.12, sustain: 0.6, baseFrequency: 600, octaves: 3 },
    volume: -8,
  }).connect(leadEcho);
  // BASS voice — generative, host-owned, NO player controls it: it just locks to the harmony and
  // plays chord tones (root/fifth), always monophonic. Fallback mono synth = round sub (sine +
  // gentle lowpass); swapped for the prebaked MRT2 bass sampler when a prebake exists.
  bassSynth = new Tone.MonoSynth({
    oscillator: { type: "sine" },
    envelope: { attack: 0.008, decay: 0.18, sustain: 0.7, release: 0.18 },
    filter: { type: "lowpass", Q: 1 },
    filterEnvelope: { attack: 0.008, decay: 0.12, sustain: 0.5, baseFrequency: 110, octaves: 2.2 },
    volume: -9,
  }).connect(bassBus);
}

// If the user's taste was pre-baked, swap the built-in chord/lead synths for the prompt-shaped
// MultiSamplers (identical triggerAttackRelease API, so the brain/clock code is untouched) and
// install the MRT2-chopped drum kit. Pure drop-in; silently keeps the synths/synth-drums when
// there's no prebake. Zero runtime neural cost — these are sampled one-shots, the brain still
// chooses the notes/hits.
async function applyPrebakedVoices() {
  let v = null;
  try { v = await loadVoices("/voices/"); } catch { /* no prebake → keep synths */ }
  if (!v) return;
  const swap = (cur, node, vol, bus) => {
    if (!node) return cur;
    node.volume.value = vol;
    node.connect(bus || Tone.getDestination());      // route to the stem bus so exports capture it
    try { cur?.dispose?.(); } catch {}
    return node;
  };
  if (v.harmony) chordSynth = swap(chordSynth, v.harmony, -7, harmonyBus);    // harmony voice (present, under the drums)
  if (v.lead)    leadSynth  = swap(leadSynth,  v.lead,    -9,  leadBus);       // lead voice
  if (v.bass)    bassSynth  = swap(bassSynth,  v.bass,    -13, bassBus);       // bass voice — sits below the loud drums
  if (v.drums)   drumKit    = v.drums.connect(drumBus);                       // sampled kit → drum stem
  const loaded = [v.harmony && "harmony", v.lead && "lead", v.bass && "bass", v.drums && "drums"].filter(Boolean);
  if (loaded.length) console.log(`[voices] prompt-baked instruments loaded: ${loaded.join(" + ")}`);
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
    applyPrebakedVoices();                    // swap in MRT2 prompt-baked voices if a prebake exists
    startWaves();                             // background waves now driven by the REAL master output
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

// Sidechain duck: dip the harmony+bass bed on a kick/snare hit, then recover — synced exactly to the
// scheduled hit `time` (we know it precisely), so it pumps cleanly without an audio-driven detector.
function duckBed(time, amount, rel) {
  if (!bedDuck) return;
  const g = bedDuck.gain;
  g.cancelScheduledValues(time);
  g.setValueAtTime(1.0, time);
  g.linearRampToValueAtTime(amount, time + 0.006);   // fast dip (sidechain attack)
  g.linearRampToValueAtTime(1.0, time + rel);         // release back up
}

function onSixteenth(time) {
  const sub = s16 % 16, beat = (sub / 4) | 0;
  leadTick(time);                               // tempo-synced lead looper (overdub + playback)
  harmonyTick(time);                            // generative harmony comp (brain-driven, room-shaped)
  bassTick(time);                               // generative bass — chord-locked, mono (no player input)
  const { x, y } = groove;
  // --- drums driven by the groove X/Y ---
  // When a prebaked kit is present, fire its sampled one-shots (random variation per hit);
  // otherwise fall back to the built-in synth drums. Same trigger schedule either way.
  const kik = (t, v) => drumKit ? drumKit.hit("kick", t, v) : kick.triggerAttackRelease("C1", "8n", t, v);
  const snr = (t, v) => drumKit ? drumKit.hit("snare", t, v) : snare.triggerAttackRelease("16n", t, v);
  const hht = (t, v) => drumKit ? drumKit.hit("hat", t, v) : hat.triggerAttackRelease("32n", t, v);
  if (sub === 0 || (sub === 8 && y > 0.3)) { const v = 0.55 + 0.45 * y; kik(time, v); duckBed(time, 0.5, 0.18); recorder.logNote("drums", "kick", 0.2, v, time); }
  if ((sub === 4 || sub === 12) && y > 0.32) { const v = 0.5 + 0.5 * y; snr(time, v); duckBed(time, 0.7, 0.12); recorder.logNote("drums", "snare", 0.12, v, time); }
  const hatHit = x < 0.34 ? sub % 4 === 0 : x < 0.7 ? sub % 2 === 0 : true;
  if (hatHit) { const v = 0.5 + 0.4 * y; hht(time, v); recorder.logNote("drums", "hat", 0.05, v, time); }
  // --- quarter-note events ---
  if (sub % 4 === 0) {
    if (beat === 0) bar = (Tone.getTransport().position.split(":")[0] | 0);
    bus.send({ type: "beat", bar, beat });
    Tone.getDraw().schedule(pulseHeartbeat, time);
  }
  // one shared 16th-resolution position drives BOTH readouts so the playheads stay in lockstep.
  // Derived from the scheduler counter s16 — the SAME base as the lead loop phase (ph = (s16 -
  // loopStart) % loopLen with loopStart aligned to this window) — so the readout, the lead audio,
  // and the playhead are all in exact lockstep.
  const rdStep = ((s16 % (BARS * 16)) + (BARS * 16)) % (BARS * 16);
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
    if (n.t === ph) { const dr = Math.max(0.08, n.d * sixteenth); chordSynth.triggerAttackRelease(midiName(n.p), dr, time, n.v ?? 0.8); recorder.logNote("harmony", n.p, dr, n.v ?? 0.8, time); }
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

// =================================================================== BASS (generative, chord-locked)
// The bass has NO player — it's purely generative from the harmony. On every beat it plays a CHORD
// TONE (root on strong beats, fifth on weak beats) in a low register, always MONOPHONIC. Strict by
// design: it only ever plays notes that are in the current chord, and never overlaps itself
// (each note is shorter than a beat). It rides the same schedule the harmony/readout use.
function bassTick(time) {
  if (!bassSynth || s16 % 4 !== 0) return;            // one note per beat (quarter-note pulse)
  const sched = effectiveSchedule();
  const beatIdx = (s16 / 4) | 0;
  const slot = sched[beatIdx % sched.length] || sched[0];
  const chord = (slot.notes && slot.notes.length) ? slot.notes : chordMidi(st?.key || "A", slot.roman || "I", 4);
  if (!chord.length) return;
  const sorted = [...chord].sort((a, b) => a - b);
  const rootPc = ((sorted[0] % 12) + 12) % 12;                       // chord root
  const fifthPc = ((sorted[Math.min(2, sorted.length - 1)] % 12) + 12) % 12;   // chord fifth (or top tone)
  const pc = (beatIdx % 2 === 0) ? rootPc : fifthPc;                 // root on strong beats, fifth on weak
  const bassMidi = 36 + pc;                                          // C2..B2 — solid, audible bass register
  const dr = Tone.Time("4n").toSeconds() * 0.9;                      // < one beat → naturally monophonic
  bassSynth.triggerAttackRelease(midiName(bassMidi), dr, time, 0.9);
  recorder.logNote("bass", bassMidi, dr, 0.9, time);
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
  // Align the loop to the readout's WHOLE 4-bar window (not just the current bar) so the loop, the
  // music readout, and the playhead all share ONE time base — the readout then shows exactly what
  // the host plays, in lockstep with the playhead.
  loopLen = BARS * SPB;                            // loop length == readout length
  loopStart = Math.floor(nowStep() / loopLen) * loopLen;
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
function leadCloseLoop() {                         // lock the loop to the readout window (4 bars)
  if (leadState !== "recording") return;
  loopLen = BARS * SPB;                            // length == readout length (kept in sync)
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
      if (n.t === ph) { const dr = Math.max(0.05, n.d * sixteenth); leadSynth.triggerAttackRelease(midiName(n.p), dr, time, n.v ?? 0.9); recorder.logNote("lead", n.p, dr, n.v ?? 0.9, time); }
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
function paintAll() {
  paintInfo(); paintRoster();
  if (document.getElementById("console").hidden) return;
  if (leadKeysKey !== (st?.key || "A") + (st?.scale || "major")) buildLeadKeys();   // re-stick keys to a new key
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
  wireExport();
  paintAll();
}

// Record/export panel (left). Record taps the host buses (drums+harmony+lead = generative only);
// export produces full-mix audio, per-voice stems, a MIDI file from the note log, and the sheet.
let recTimer = null;
function wireExport() {
  const btn = document.getElementById("recbtn"); if (!btn) return;
  const xs = { audio: "x-audio", stems: "x-stems", midi: "x-midi", sheet: "x-sheet" };
  const setExports = (on) => Object.values(xs).forEach((id) => { const e = document.getElementById(id); if (e) e.disabled = !on; });
  const fmt = (s) => `${(s / 60) | 0}:${String((s | 0) % 60).padStart(2, "0")}`;

  btn.onclick = async () => {
    if (!recorder.recording) {
      // Flip the UI FIRST so the button always responds — never left stuck on a slow/rejected start.
      btn.classList.add("on"); btn.textContent = "■ STOP";
      setExports(false); setText("rechint", "recording the generated set…");
      const t0 = Tone.now();
      recTimer = setInterval(() => setText("rectime", fmt(Tone.now() - t0)), 250);
      try { await recorder.start(Tone.getTransport().bpm.value); }
      catch (e) { console.error("record start failed:", e); setText("rechint", "record error: " + (e?.message || e)); }
    } else {
      clearInterval(recTimer); recTimer = null;
      btn.classList.remove("on"); btn.textContent = "● RECORD"; setText("rechint", "saving take…");
      try { await recorder.stop(); } catch (e) { console.error("record stop failed:", e); }
      setExports(recorder.hasTake()); setText("rechint", recorder.hasTake() ? "take ready — export below" : "nothing captured — try again");
    }
  };
  const on = (id, fn) => { const e = document.getElementById(id); if (e) e.onclick = fn; };
  on(xs.audio, () => recorder.exportAudio());
  on(xs.stems, () => recorder.exportStems());
  on(xs.midi, () => recorder.exportMidi());
  on(xs.sheet, async () => { const ok = await recorder.exportSheet({ key: st?.key, scale: st?.scale }); if (!ok) setText("rechint", "record a take first, then export sheet"); });
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
  const rh = roll.clientHeight / ROWS.length;
  const pcOf = (m) => ((m % 12) + 12) % 12;
  const rowOf = (used, pcs, region) => { for (let i = 0; i < ROWS.length; i++) if (ROWS[i].region === region && pcs.includes(pcOf(ROWS[i].m)) && !used.has(i)) { used.add(i); return i; } return -1; };
  // harmony: render the SAME schedule the audio plays (effectiveSchedule — drawn progression, or
  // the default loop when no phone has drawn one) at FIXED beat positions. The chord blocks are
  // static across the loop window; only the playhead moves. (Previously the no-schedule fallback
  // rotated chords by progIdx every bar, so the blocks shifted out from under the playhead.)
  const sched = effectiveSchedule();
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

let leadKeysKey = "";                              // last key/scale the lead keyboard was built for
function buildLeadKeys() {
  const kb = document.getElementById("leadkeys"); if (!kb) return;
  // Stuck to the song key: show ONLY the 7 in-key notes (white naturals + black accidentals),
  // matching the phone's lead keyboard exactly (both from shared scaleNotes).
  const notes = scaleNotes(st?.key || "A", st?.scale || "major");
  leadKeysKey = (st?.key || "A") + (st?.scale || "major");
  kb.innerHTML = notes.map((n) =>
    `<div class="lk${n.black ? " blk" : ""}" data-note="${n.name}"><span class="kn">${n.name}</span><span class="d"></span></div>`).join("");
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

// background waves — static placeholder before audio starts (see startWaves for the live version)
const WAVE_COLS = ["#9B7BE6", "#5FD0A8", "#F4533A", "#F5B82E"];
const WAVE_Y = [200, 330, 460, 590];
function drawWaves() {
  const svg = document.getElementById("waves"); if (!svg) return;
  svg.innerHTML = WAVE_COLS.map((c, i) => {
    let d = `M0 ${WAVE_Y[i]} `;
    for (let x = 0; x <= 1200; x += 30) d += `L${x} ${WAVE_Y[i] + Math.sin((x / 130) + i) * 40} `;
    return `<path d="${d}" fill="none" stroke="${c}" stroke-width="5" opacity="0.25"/>`;
  }).join("");
}

// REAL background waveform — taps the master output. Each of the 4 lines is a SMOOTH sine wave
// whose height is driven by the energy in one frequency band (lows→highs), so the lines swell with
// the music (kick/bass move the lower lines, hats the top) while staying clean and fluid.
let fftAnalyser = null;
const WAVE_BANDS = [[20, 200], [200, 800], [800, 3000], [3000, 13000]];   // Hz per line (low→high)
const waveAmp = [0, 0, 0, 0];      // temporally-smoothed amplitude per line
let wavePhase = 0;

// Average normalized magnitude of the FFT bins inside [lo,hi) Hz (0..~1).
function bandLevel(buf, sr, lo, hi) {
  const n = buf.length, nyq = sr / 2; let s = 0, c = 0;
  for (let i = 0; i < n; i++) {
    const hz = i * nyq / n;
    if (hz >= lo && hz < hi) { s += Math.min(1, Math.max(0, (buf[i] + 100) / 70)); c++; }
  }
  return c ? s / c : 0;
}
// Smooth SVG path through points via quadratic curves to midpoints (no jagged segments).
function smoothPath(pts) {
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    d += ` Q${a[0].toFixed(1)} ${a[1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  const L = pts[pts.length - 1];
  return d + ` L${L[0].toFixed(1)} ${L[1].toFixed(1)}`;
}

function startWaves() {
  const svg = document.getElementById("waves"); if (!svg || !masterBus || fftAnalyser) return;
  fftAnalyser = new Tone.Analyser("fft", 256);
  fftAnalyser.smoothing = 0.85;                          // built-in temporal smoothing → fluid
  masterBus.connect(fftAnalyser);                        // passive tap (doesn't alter the audio)
  setupMiniViz();
  const N = 22, W = 1200, sr = Tone.getContext().rawContext.sampleRate;
  const draw = () => {
    const cons = document.getElementById("console");
    if (cons && !cons.hidden) {
      const buf = fftAnalyser.getValue();
      wavePhase += 0.02;                                 // gentle drift so the lines flow
      svg.innerHTML = WAVE_COLS.map((c, li) => {
        const lvl = bandLevel(buf, sr, WAVE_BANDS[li][0], WAVE_BANDS[li][1]);
        const target = lvl * (300 + li * 50);            // jumps high on loud bands
        waveAmp[li] = waveAmp[li] * 0.8 + target * 0.2;  // smooth the amplitude over time
        const amp = waveAmp[li], cyc = 1.5 + li * 0.5;   // a few smooth cycles across the screen
        const pts = [];
        for (let i = 0; i <= N; i++) {
          const x = (i / N) * W;
          const y = WAVE_Y[li] + Math.sin((i / N) * Math.PI * 2 * cyc + wavePhase + li * 1.3) * amp;
          pts.push([x, y]);
        }
        return `<path d="${smoothPath(pts)}" fill="none" stroke="${c}" stroke-width="6" opacity="0.45" stroke-linecap="round"/>`;
      }).join("");
      drawMini(buf, sr);
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}

// Mini corner visualizer (bottom-left): a compact spectrum. Two modes — YELLOW idle, RED while the
// host is recording a take (recorder.recording) — so you can see at a glance that a take is rolling.
let miniCanvas = null, miniCtx = null;
function setupMiniViz() {
  if (miniCanvas) return;
  miniCanvas = document.createElement("canvas");
  miniCanvas.id = "miniviz"; miniCanvas.width = 320; miniCanvas.height = 150;
  miniCanvas.style.cssText = "position:fixed;left:20px;bottom:20px;z-index:6;width:320px;height:150px;" +
    "border:3px solid var(--ink);border-radius:14px;background:rgba(20,18,13,.55);box-shadow:var(--shadow-sm);" +
    "pointer-events:none";   // overlay only — never intercept clicks on the controls beneath it
  document.body.appendChild(miniCanvas);
  miniCtx = miniCanvas.getContext("2d");
}
function drawMini(buf, sr) {
  if (!miniCtx) return;
  const rec = !!recorder?.recording;
  const col = rec ? "#F4533A" : "#F5B82E";              // red recording · yellow idle
  const W = miniCanvas.width, H = miniCanvas.height, pad = 10, NB = 30;
  const bw = (W - 2 * pad) / NB;
  miniCtx.clearRect(0, 0, W, H);
  for (let b = 0; b < NB; b++) {                         // log-spaced bars 40 Hz → ~16 kHz
    const lo = 40 * Math.pow(1.225, b), hi = 40 * Math.pow(1.225, b + 1);
    const lvl = bandLevel(buf, sr, lo, Math.min(hi, sr / 2));
    const h = Math.max(3, lvl * (H - 2 * pad));
    miniCtx.fillStyle = col;
    miniCtx.fillRect(pad + b * bw + 1, H - pad - h, bw - 2, h);
  }
  if (rec) { miniCtx.beginPath(); miniCtx.arc(W - 16, 16, 6, 0, 7); miniCtx.fillStyle = "#F4533A"; miniCtx.fill(); }
}

// utils
function setText(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }
function clamp(v) { return Math.max(0, Math.min(1, v)); }
function pad2(v) { return String(Math.round(v * 100)).padStart(2, "0"); }
window.addEventListener("resize", () => { if (!document.getElementById("console").hidden) { buildRoll(); renderRoll(); } });
