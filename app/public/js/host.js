// Host = lobby + console. Owns the master clock (Tone.js), the groove-driven drum
// engine + harmony synth, and renders the live room view from broadcast state.
import { Bus, romanToName, chordMidi, chordNotes, diatonic, scaleNotes, parentRoot } from "/js/shared.js";
import { LeadBrain, leadFeel } from "/js/brain/lead.js";
import { HarmonyBrain } from "/js/brain/harmony.js";
import { grooveStep, FEEL_SWING, bassStep } from "/js/brain/groove.js";
import { midiName, snap, keyRoot, scaleSteps } from "/js/brain/theory.js";
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
  if (m.action === "note") onLeadNote(m.payload, m.lat || 0);
  else if (m.action === "leadrec") (m.payload?.cmd === "start" ? leadStartRec() : leadCloseLoop());
  else if (m.action === "overwrite") overwrite = !!m.payload?.on;
  else if (m.action === "leadclear") leadClear();
});
// Server finished baking THIS round's genre voices → swap them in over the built-in
// synths. The jam is already playing on the defaults: "default voice instant,
// personalized swaps in". pendingVoices guards startAudio so we only ever load a bake
// the server has confirmed for the current round (never last round's WAVs on disk).
let pendingVoices = false;
bus.on("voices", () => {
  pendingVoices = true;
  if (started && !jamLive) beginJam();          // first bake of the round → start the band on it
  else if (jamLive) applyPrebakedVoices();       // mid-jam re-bake → hot-swap the voices
});

// ---- join info ----
// While the server's cloudflared tunnel is coming up, show a "creating link…"
// state — never flash the LAN address. The final URL (tunnel, or LAN only if the
// tunnel can't start) is the first thing ever displayed. Also feeds the console's
// audience join QR (#qr2) once the link is final.
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
    const q2 = document.getElementById("qr2");           // audience join QR on the console
    if (q2) q2.src = info.qr;
  } catch { setTimeout(refreshInfo, 1200); }
}
refreshInfo();

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
  if (loaded.length) {
    const p = v.manifest?.voices || {};
    console.log(`[voices] genre-baked loaded → harmony="${p.harmony?.prompt || ""}" | lead="${p.lead?.prompt || ""}"`
      + ` | bass="${p.bass?.prompt || ""}" | drums="${v.manifest?.drums?.prompt || ""}"`);
    bakeStatus(`genre voices live: ${loaded.join(" + ")}`, true);
  }
}

// Lobby soundtrack: during onboarding/lobby the host plays this track while Magenta stays muted
// (the texture engine generates nothing until jam start). Autoplay needs a user gesture, so it
// starts on the first interaction with the host page; START THE JAM stops it.
let lobbyAudio = null;
function startLobbyMusic() {
  if (lobbyAudio || started || st?.phase !== "lobby") return;
  lobbyAudio = new Audio("/lobby.mp3");
  lobbyAudio.loop = true; lobbyAudio.volume = 0.55;
  lobbyAudio.play().catch(() => { lobbyAudio = null; });   // blocked (no gesture yet) → retry next gesture
}
function stopLobbyMusic() {
  if (!lobbyAudio) return;
  try { lobbyAudio.pause(); } catch {}
  lobbyAudio = null;
}
document.addEventListener("pointerdown", startLobbyMusic);   // first gesture unlocks playback

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
  stopLobbyMusic();               // jam starting → hand the room over to the band + texture
  // Show the console FIRST — audio init must never hold the screen hostage. A contended
  // output device (e.g. the MRT2 texture engine holding the default sink) can make
  // Tone.start()'s AudioContext.resume() hang forever; we don't want a frozen lobby.
  showConsole();
  bus.send({ type: "host", action: "start" });  // lobby → jam: phones flip to role UIs, server bakes voices
  try {
    await withTimeout(Tone.start(), 4000);   // resume the AudioContext NOW (inside the user gesture)
    initSynths();                             // built-in synths — only used if the bake fails/times out
    Tone.getTransport().bpm.value = st?.tempo || 124;
    Tone.getTransport().swing = 0;            // we apply swing explicitly per-step (swingOffsetSec), not via Transport
    // GATE: don't start the band until THIS round's genre voices are extracted. Show a loading
    // screen meanwhile (the ambient texture already plays underneath). pendingVoices = the server
    // already has the bake (we reloaded mid-jam) → go straight in.
    showBakeLoading();
    if (pendingVoices) beginJam();
    else bakeWaitTimer = setTimeout(() => {            // safety net so a failed bake can't hang forever
      note("voices took too long — starting on the built-in synths");
      beginJam();
    }, 150000);
  } catch (e) {
    console.error("audio start failed:", e);
    hideBakeLoading();
    note("AUDIO OFF — " + (e?.message || e) + " · free the output device, then reload");
  }
}

// Start the actual band — called once this round's genre voices are loaded (or the wait timed out).
let jamLive = false, bakeWaitTimer = null;
async function beginJam() {
  if (jamLive) return;
  jamLive = true;
  clearTimeout(bakeWaitTimer);
  await applyPrebakedVoices();              // load this round's baked voices before a single note plays
  const t = Tone.getTransport();
  t.scheduleRepeat(onSixteenth, "16n");
  t.start();
  startWaves();                            // background waves now driven by the REAL master output
  hideBakeLoading();
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

// Voice-bake status pill (amber while THIS round's genre voices bake → green when they swap in).
// Makes the loading time visible and proves the swap happened (Dylan: proof, not guesses).
let bakeStatusTimer = null;
function bakeStatus(msg, done = false) {
  let el = document.getElementById("bakestatus");
  if (!el) {
    el = document.createElement("div");
    el.id = "bakestatus";
    el.style.cssText = "position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:9999;" +
      "font:700 12px/1.3 ui-monospace,monospace;padding:8px 15px;border-radius:999px;color:#0b0b0b;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.28);max-width:92vw;text-align:center;transition:opacity .5s";
    document.body.appendChild(el);
  }
  clearTimeout(bakeStatusTimer);
  el.textContent = (done ? "✓ " : "🎛 ") + msg;
  el.style.background = done ? "#5FD0A8" : "#F5B82E";
  el.style.opacity = "1";
  if (done) bakeStatusTimer = setTimeout(() => { el.style.opacity = "0"; }, 5000);
}

// Full-screen loading gate: shown while THIS round's genre voices extract from MRT2, so the band
// never opens on the built-in/stale fallback. The ambient texture plays underneath while it waits.
function showBakeLoading() {
  let el = document.getElementById("bakeload");
  if (!el) {
    el = document.createElement("div");
    el.id = "bakeload";
    el.style.cssText = "position:fixed;inset:0;z-index:10000;display:flex;flex-direction:column;" +
      "align-items:center;justify-content:center;gap:18px;background:rgba(8,8,10,.96);color:#fff;" +
      "font-family:ui-monospace,monospace;text-align:center;padding:24px";
    document.body.appendChild(el);
  }
  const genre = (st?.genres?.length ? st.genres.join(" + ") : "your");
  el.innerHTML =
    `<div style="font:700 13px/1.4 ui-monospace;letter-spacing:.14em;color:#F5B82E">EXTRACTING INSTRUMENTS</div>` +
    `<div style="font:800 30px/1.15 ui-monospace;max-width:90vw;text-transform:uppercase">${genre} band</div>` +
    `<div style="display:flex;gap:10px;margin-top:6px">${["HARMONY","LEAD","BASS","DRUMS"].map((n,i)=>
      `<span style="font:700 11px/1 ui-monospace;padding:7px 11px;border-radius:999px;background:#1a1a1f;` +
      `color:#9aa;animation:bakepulse 1.2s ${i*0.18}s infinite ease-in-out">${n}</span>`).join("")}</div>` +
    `<div style="font:500 12px/1.5 ui-monospace;color:#888;max-width:34ch;margin-top:8px">` +
    `baking each instrument from your genre on MRT2 — the ambient bed is already playing. ~40s.</div>` +
    `<style>@keyframes bakepulse{0%,100%{opacity:.35}50%{opacity:1;color:#5FD0A8}}</style>`;
  el.style.display = "flex";
}
function hideBakeLoading() {
  const el = document.getElementById("bakeload");
  if (el) { el.style.transition = "opacity .5s"; el.style.opacity = "0"; setTimeout(() => { el.style.display = "none"; el.style.opacity = "1"; }, 500); }
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
  // REAL swing: shift THIS step's time off the straight grid (swingOffsetSec), and play EVERY
  // instrument at the shifted time `at`. This genuinely changes the grid (jazz/blues/hip-hop feel)
  // for drums + comp + bass + lead — not a per-sample effect. Downbeats stay put (offset 0).
  const at = time + swingOffsetSec(sub);
  leadTick(at);                                 // tempo-synced lead looper (overdub + playback)
  harmonyTick(at);                              // generative harmony comp (genre-driven, room-shaped)
  bassTick(at);                                 // generative bass — genre pattern
  const { x, y } = groove;
  // --- genre-aware drums (brain/groove.js): FEEL = base beat; x reshapes the kick/snare pattern;
  //     y = intensity. Prebaked kit if present, else built-in synths. All hits land on the swung `at`.
  const kik = (t, v) => drumKit ? drumKit.hit("kick", t, v) : kick.triggerAttackRelease("C1", "8n", t, v);
  const snr = (t, v) => drumKit ? drumKit.hit("snare", t, v) : snare.triggerAttackRelease("16n", t, v);
  const hht = (t, v) => drumKit ? drumKit.hit("hat", t, v) : hat.triggerAttackRelease("32n", t, v);
  const g = grooveStep(st?.feel || "backbeat", sub, bar, x, y);
  if (g.kick  > 0.03) { kik(at, g.kick);  duckBed(at, 0.5, 0.18); recorder.logNote("drums", "kick", 0.2, g.kick, at); }
  if (g.snare > 0.03) { snr(at, g.snare); duckBed(at, 0.7, 0.12); recorder.logNote("drums", "snare", 0.12, g.snare, at); }
  if (g.hat   > 0.03) { hht(at, g.hat);   recorder.logNote("drums", "hat", 0.05, g.hat, at); }
  // --- quarter-note events --- (downbeats: offset is 0, so at === time)
  if (sub % 4 === 0) {
    if (beat === 0) bar = (Tone.getTransport().position.split(":")[0] | 0);
    bus.send({ type: "beat", bar, beat });
    Tone.getDraw().schedule(pulseHeartbeat, time);
  }
  // one shared 16th-resolution position drives BOTH readouts so the playheads stay in lockstep.
  const rdStep = ((s16 % (BARS * 16)) + (BARS * 16)) % (BARS * 16);
  Tone.getDraw().schedule(() => { movePlayhead(rdStep); if (viewMode === "sheet") notation?.setPlayhead(rdStep); }, at);
  s16++;
}
// REAL swing: how far to delay this 16th step (seconds) so off-beats fall toward the triplet and the
// whole grid swings. FEEL_SWING is per genre (0 = straight). The off-8th (the "and") swings most;
// in-between 16ths swing lighter; downbeats stay on the grid. Applied to every instrument's time.
function swingOffsetSec(sub) {
  const sw = FEEL_SWING[st?.feel || "backbeat"] || 0;
  if (!sw) return 0;
  const T = Tone.Time("16n").toSeconds();
  if (sub % 4 === 2) return sw * (4 / 3) * T;   // off-beat 8th → toward triplet (sw ≈ .5 is a true triplet)
  if (sub % 2 === 1) return sw * (2 / 3) * T;   // 16th subdivisions: lighter
  return 0;
}

// =================================================================== HARMONY (generative comp)
// The harmony phone sends the chord progression (a beat-schedule). The host does NOT play
// those chords back verbatim — it runs them through the harmony brain (rhythmic comping /
// arpeggiation / syncopation, driven by the room), so what the room hears is generative,
// inspired by their input. The player hears their own chords live on their phone.
const harmonyBrain = new HarmonyBrain();
let harmonyComp = [], harmonyLen = 16, harmonyIdx = 0, lastSchedKey = "", lastChordKey = null;

// The drawn schedule. Chords (and bass) come in ONLY once the harmony player draws their first
// progression — before that this is EMPTY, so the band plays drums + lead + texture and waits. The
// genre's default progression still shows on the harmony phone's wheel (controllers.js seeds it) as
// the starting point, but nothing harmonic SOUNDS until they draw. Returns [{notes,roman,label}].
function effectiveSchedule() {
  const sched = st?.schedule;
  return (sched && sched.length) ? sched : [];
}
// Comp params come from the GENRE feel + the room: GROOVE X (+ crowd energy) = complexity,
// GROOVE Y = energy. The genre's comp pattern (groove.js) decides the actual rhythm/voicing.
function harmonyParams() {
  return { feel: st?.feel || "backbeat",
           x: clamp((groove.x || 0) + 0.3 * (st?.energy || 0)), y: clamp(groove.y || 0) };
}
// Clock tick (every 16th): play the generative comp; broadcast chord changes for the readout.
function harmonyTick(time) {
  const sched = effectiveSchedule();
  if (!sched.length) return;                               // no chords until the harmony player draws
  harmonyLen = sched.length * 4;                            // 4 sixteenth-steps per beat
  const ph = ((s16 % harmonyLen) + harmonyLen) % harmonyLen;
  const schedKey = (st?.feel || "") + "|" + sched.map((s) => s.label || s.roman).join("|");
  if (ph === 0 || schedKey !== lastSchedKey) {             // new loop / edited progression / genre change → regenerate
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

// =================================================================== BASS (generative, GENRE-driven)
// The bass has NO player — it's generated from the chord + the genre FEEL (brain/groove.js bassStep).
// Genuinely genre-shaped: jazz WALKS in quarters (toward the next chord), funk is a syncopated
// octave-pop with ghost notes, house pumps the root, reggae is a sparse dub one-drop, trap is a long
// 808, driving is an eighth-note pedal. Runs every 16th; bassStep decides when/what/how-long.
function bassTick(time) {
  if (!bassSynth) return;
  const sched = effectiveSchedule();
  if (!sched.length) return;                          // bass waits for the drawn progression too
  const len = sched.length * 4;
  const ph = ((s16 % len) + len) % len;
  const beatIdx = Math.floor(ph / 4) % sched.length;
  const slot = sched[beatIdx] || sched[0];
  const nslot = sched[(beatIdx + 1) % sched.length] || slot;
  const chord = (slot.notes && slot.notes.length) ? slot.notes : chordMidi(st?.key || "A", slot.roman || "I", 4, st?.scale);
  const nextChord = (nslot.notes && nslot.notes.length) ? nslot.notes : chordMidi(st?.key || "A", nslot.roman || "I", 4, st?.scale);
  const b = bassStep(st?.feel || "backbeat", ph % 16, Math.floor(ph / 16), groove.x || 0, groove.y || 0, chord, nextChord);
  if (b && Number.isFinite(b.midi)) {
    const dr = Math.max(0.05, b.dur * Tone.Time("16n").toSeconds());
    bassSynth.triggerAttackRelease(midiName(b.midi), dr, time, b.vel);
    recorder.logNote("bass", b.midi, dr, b.vel, time);
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

// Wildness → transform params. At 0 it's a faithful loop (exactly what the player played). Up to
// ~0.85 it stays call-&-response (your phrase returns every other loop = reactive); only past that
// does it develop every loop. harmonize only colours DEVELOPMENTS — the faithful call is untouched.
function leadParams() {
  const w = leadWild;
  const f = leadFeel(st?.feel);                     // genre phrasing — shapes HOW developments move
  const cl = (v) => clamp(v, -1, 1);
  return {
    // how often the player's EXACT phrase returns scales with wildness: ~0 faithful always,
    // low → only 1-in-4 loops vary (mostly your phrase), mid → call/response, high → develop every loop.
    responseEvery: w < 0.02 ? 0 : w < 0.33 ? 4 : w < 0.7 ? 2 : 1,
    // genre biases the development knobs (jazz ornaments, funk syncopates, ambient thins, …).
    retro: cl(0.5 * w * f.retro),
    shift: cl(0.5 * w * f.shift + (f.shiftBase || 0)),
    density: cl(0.4 * w * f.density + (f.densityBase || 0)),
    invert: cl(0.5 * w * f.invert),
    harmonize: 0.4, wild: w,
    // ...and within developments, low wildness re-anchors to the phrase often (stays recognizable);
    // high re-anchors rarely; past ~0.92 never (free evolution).
    reAnchor: w > 0.92 ? Infinity : Math.max(2, Math.round(2 + w * 6)),
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
  leadBrain.setChord(chordMidi(st?.key || "A", st?.chord || "I", 4, st?.scale));
  // Per-beat chord schedule so the lead solos OVER the changes, not over one chord for the loop.
  const sched = effectiveSchedule();
  leadBrain.setChordSchedule(sched && sched.length
    ? sched.map((slot) => {
        const m = (slot.notes && slot.notes.length) ? slot.notes : chordMidi(st?.key || "A", slot.roman || "I", 4, st?.scale);
        return [...new Set(m.map((x) => ((x % 12) + 12) % 12))];
      })
    : null);
  const gen = recLoop.length ? leadBrain.generate(leadLoopIdx++, leadParams()) : [];
  // Hard guarantee in-key: snap every note to the song scale. Catches chromatic artifacts from
  // harmonize's fractional move and any out-of-key input.
  const root = keyRoot(st?.key || "A"), scale = scaleSteps(st?.scale);
  playLoop = gen.map((n) => ({ ...n, p: snap(n.p, root, scale) }));
}
function leadCloseLoop() {                         // lock the loop to the readout window (4 bars)
  if (leadState !== "recording") return;
  loopLen = BARS * SPB;                            // length == readout length (kept in sync)
  recLoop = recLoop.map((n) => ({ ...n, t: ((n.t % loopLen) + loopLen) % loopLen }));
  leadBrain.len = loopLen; leadLoopIdx = 0;
  leadSetState("looping");
  leadGenerate(); renderLeadLoop(); renderRoll(); // play & draw both panels immediately (no silent gap)
  if (leadNotified) pushLeadToTexture(true);      // generated loop ready → hand off from the held seed
}
function leadClear() { recLoop = []; playLoop = []; leadSetState("idle"); renderLeadLoop(); renderRoll(); leadNotified = false; pushLeadToTexture(false); }

// Lead → MRT2 texture (the bed reacts to THE LEAD, never to raw local taps). Two stages:
//   1. The lead turns on (player's first note arrives): wake the texture to the lead and HOLD
//      that first pitch as the MIDI seed — sustained across the model's generation latency.
//   2. The generated loop locks/plays: feed its MIDI instead, so the texture follows the
//      generative lead. Clearing the lead drops it back to the ambient bed.
let leadNotified = false;
function leadPitchSet() {
  const src = playLoop.length ? playLoop : recLoop;     // the generated lead loop
  return [...new Set(src.map((n) => n.p))].sort((a, b) => a - b).slice(0, 6);
}
function pushLeadToTexture(active, pitches) {
  bus.send({ type: "host", action: "leadNotes", payload: { active, pitches: active ? (pitches || leadPitchSet()) : [] } });
}

// Record a played note at the (host-quantized) playhead. Auto-arms on the first note.
// latMs = the player's one-way network latency (server-measured RTT/2): the finger was
// on the beat, the MESSAGE arrived late — especially through the cloudflare tunnel
// (80–250ms ≈ 1–2 sixteenths at 124bpm). Subtract it before quantizing to the grid.
function leadRecordNote(p, latMs = 0) {
  if (leadState === "idle") leadStartRec();
  const stepMs = (60000 / (st?.tempo || 124)) / 4;            // one 16th, in ms
  const now = Math.max(0, nowStep() - Math.round(latMs / stepMs));
  const rel = now - loopStart;
  const t = leadState === "looping" ? ((rel % loopLen) + loopLen) % loopLen : Math.max(0, rel);
  if (overwrite) recLoop = recLoop.filter((n) => n.t !== t);   // replace what's at this step
  const note = { t, p: midiOf(p), d: 2, v: 0.9 };              // d is provisional → set on release (note length)
  recLoop.push(note);
  lastNoteStep = now;
  return note;
}

// Clock tick (every 16th, with the precise audio `time`): auto-lock, sweep playhead, play loop.
function leadTick(time) {
  // auto-lock ~1 bar after the player stops → it loops without any button (length = what was played)
  // auto-lock uses the SAME (real-time) clock that stamped lastNoteStep, so it fires after a true
  // bar of silence (not ~1 step early as it did when comparing the look-ahead s16 to a nowStep value).
  if (leadState === "recording" && recLoop.length && (nowStep() - lastNoteStep) >= AUTO_LOCK) leadCloseLoop();
  if (leadState !== "looping" || !loopLen) return;
  const ph = (((s16 - loopStart) % loopLen) + loopLen) % loopLen;
  // Loop boundary: fresh variation → middle readout, and feed the GENERATED lead MIDI to the
  // texture (this replaces the held first-note seed once the generated loop is available).
  if (ph === 0) { leadGenerate(); if (leadNotified) pushLeadToTexture(true); Tone.getDraw().schedule(renderRoll, time); }
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
  if (v === "") { lbKey.value = ""; bus.send({ type: "host", action: "key", payload: "" }); return; }  // cleared → auto/blank
  if (!KEYS.includes(v)) { lbKey.value = st?.key || ""; return; }   // bad note → revert to current
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
  if (v === "" || v == null || Number.isNaN(+v)) {                  // cleared → auto/blank
    lbTempo.value = ""; bus.send({ type: "host", action: "tempo", payload: "" }); return;
  }
  v = Math.max(60, Math.min(200, Math.round(+v)));
  lbTempo.value = v;
  bus.send({ type: "host", action: "tempo", payload: v });
}
lbTempo.addEventListener("change", () => sendTempo(lbTempo.value));   // raw string so "" is detected as cleared
// scroll anywhere on the tempo box to jog the BPM
document.getElementById("lb-tempo-box").addEventListener("wheel", (e) => {
  e.preventDefault();
  sendTempo((+lbTempo.value || st?.tempo || 124) + (e.deltaY < 0 ? 1 : -1));
}, { passive: false });

function paintAll() {
  paintInfo(); paintRoster();
  if (st?.phase && st.phase !== "lobby") stopLobbyMusic();   // jam started → ensure the lobby track is off
  if (document.getElementById("console").hidden) return;
  if (started && st?.tempo) Tone.getTransport().bpm.value = st.tempo;   // keep the clock on the genre/host tempo
  if (leadKeysKey !== (st?.key || "A") + (st?.scale || "major")) buildLeadKeys();   // re-stick keys to a new key
  paintWheel(); paintPoll(); paintMix(); renderRoll(); paintLeadFromState();
}
function paintInfo() {
  if (!st) return;
  if (!roomTimer) setVal(lbRoom, st.room);   // an in-flight edit beats a stale echo
  setText("room", st.room);
  setVal(lbKey, st.key || "");                                 // blank until set by genre or host
  lbScale.textContent = st.scale ? (SCALE_ABBR[st.scale] || st.scale.toUpperCase()) : "—";
  scaleMenu.querySelectorAll("button").forEach((b) => b.classList.toggle("sel", b.dataset.s === st.scale));
  setText("key", st.key ? `${st.key}${st.scale ? " " + (SCALE_ABBR[st.scale] || "MAJ") : ""}` : "—");
  setVal(lbTempo, st.tempo || ""); setText("tempo", st.tempo || "—");
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
// The recommended chord tree for the host wheel: diatonic triads + the genre's extended chords
// (jazz 7ths etc., from state.progressionQuals) — so the 7ths show on the HOST even before a
// harmony player has connected and sent their palette.
const QUAL_SUFFIX = { maj: "", min: "m", "7": "7", maj7: "maj7", m7: "m7", dim: "dim", aug: "aug", sus2: "sus2", sus4: "sus4", add9: "add9", m7b5: "m7♭5" };
const DEG_STEP = [0, 2, 4, 5, 7, 9, 11], DEG_ROMAN = ["I", "ii", "iii", "IV", "V", "vi", "vii°"];
const NOTE12 = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function genrePalette() {
  const base = diatonic(st?.key || "A", st?.scale).slice(0, 6).map((c) => ({ roman: c.roman, display: c.name }));
  const prog = st?.progression || [], quals = st?.progressionQuals || [];
  if (!quals.length) return base;
  const out = [...base];
  prog.forEach((roman, i) => {
    const deg = DEG_ROMAN.indexOf(roman); if (deg < 0 || !quals[i]) return;
    const rootPc = (parentRoot(st?.key || "A", st?.scale) + DEG_STEP[deg]) % 12;
    const display = NOTE12[rootPc] + (QUAL_SUFFIX[quals[i]] ?? "");
    if (!out.some((c) => c.display === display)) out.push({ roman, display });
  });
  return out;
}
// Mirror the harmony phone's wheel: [0]=I centered, the rest ring around it. Rebuilt from
// st.palette on every state update, so chords the phone adds via "+" appear here in real time.
function paintWheel() {
  const W = document.getElementById("wheel"); if (!W || !st) return;
  const pal = (st.palette && st.palette.length) ? st.palette : genrePalette();
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
      const src = (slot.notes && slot.notes.length) ? slot.notes : chordMidi(st.key, slot.roman, 4, st.scale);
      const pcs = src.map((m) => ((m % 12) + 12) % 12);
      const used = new Set();
      pcs.forEach((_, j) => { const ri = rowOf(used, pcs, "chord"); if (ri < 0) return;
        addNote(roll, "h", LABELW + i * beatW + 3, ri * rh + 4, run * beatW - 6, rh - 8, j === 0 ? key : ""); }); // chord NAME on the top block (e.g. Cmaj7)
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
const heldLeadNotes = new Map();   // note id → the recorded note object (its DURATION is set on release)
function onLeadNote(p, latMs = 0) {
  // The host does NOT echo raw taps — the player hears those live on their own phone.
  // The host only plays the QUANTIZED, generative loop (see leadTick). Here we just record.
  if (p.on === false) {                                   // RELEASE → set how long the note was held
    const note = heldLeadNotes.get(p.id);
    if (note) {
      heldLeadNotes.delete(p.id);
      const stepMs = (60000 / (st?.tempo || 124)) / 4;    // one 16th in ms
      note.d = Math.max(1, Math.min(loopLen || BARS * 16, Math.round((p.heldMs || 0) / stepMs)));
      renderLeadLoop(); renderRoll();                     // longer notes now draw wider
    }
    return;
  }
  const note = leadRecordNote(p, latMs);                  // ONSET (length filled in on release)
  if (note && p.id != null) heldLeadNotes.set(p.id, note);
  // Lead turning on: the player's FIRST note wakes the texture and is held as the MIDI seed
  // (sustained by the engine) until the generated loop is ready to feed in (leadCloseLoop).
  if (!leadNotified) { leadNotified = true; pushLeadToTexture(true, [midiOf(p)]); }
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
