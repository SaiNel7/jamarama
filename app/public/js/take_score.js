// Render a recorded TAKE (the host's note log) to standard notation as a standalone SVG —
// independent of the live #score view and spanning the WHOLE recording, wrapped into 4-bar
// systems stacked down the page (like a printed lead sheet). Same VexFlow approach as the live
// NotationView (lead → treble melody; harmony → braced grand staff), generalized past 4 bars.
const Tone = window.Tone;
const VEXFLOW_SRC = "/vendor/vexflow/vexflow-bravura.js";
const SPB = 16, SYS_BARS = 4, MAX_BARS = 64;        // cap render at 64 bars (16 systems)

const SHARP = ["c","c#","d","d#","e","f","f#","g","g#","a","a#","b"];
const FLAT  = ["c","db","d","eb","e","f","gb","g","ab","a","bb","b"];
const STEP_DUR = { 1:{d:"16",dots:0}, 2:{d:"8",dots:0}, 3:{d:"8",dots:1}, 4:{d:"q",dots:0}, 8:{d:"h",dots:0}, 16:{d:"w",dots:0} };
const KEYSIG_MAJOR = { "C":"C","C#":"C#","D":"D","D#":"Eb","E":"E","F":"F","F#":"F#","G":"G","G#":"Ab","A":"A","A#":"Bb","B":"B" };
const KEYSIG_MINOR = { "C":"Cm","C#":"C#m","D":"Dm","D#":"D#m","E":"Em","F":"Fm","F#":"F#m","G":"Gm","G#":"G#m","A":"Am","A#":"A#m","B":"Bm" };

function loadVexFlow() {
  if (window.Vex && window.Vex.Flow) return Promise.resolve(window.Vex.Flow);
  return import(VEXFLOW_SRC).then(() => window.Vex.Flow);
}

// Split a span [pos,pos+len) (steps within a bar) into beat-aligned, notatable pieces (1,2,3,4,8,16).
function splitSpan(pos, len) {
  const out = [];
  while (len > 0) {
    const inBeat = pos % 4; let take;
    if (inBeat === 0) {
      if (pos % SPB === 0 && len >= 16) take = 16;
      else if (pos % 8 === 0 && len >= 8) take = 8;
      else if (len >= 4) take = 4; else take = len;
    } else take = Math.min(len, 4 - inBeat);
    out.push({ pos, steps: take }); pos += take; len -= take;
  }
  return out;
}

// {t(step),p,d(steps)} notes → monophonic-with-chords events (same onset merges; clamp to next onset).
function reduceMono(notes) {
  const sorted = [...notes].sort((a, b) => a.t - b.t || a.p - b.p);
  const ev = [];
  for (const n of sorted) {
    const last = ev[ev.length - 1];
    if (last && last.start === n.t) { last.keys.push(n.p); last.dur = Math.max(last.dur, n.d); }
    else ev.push({ start: n.t, dur: n.d, keys: [n.p] });
  }
  for (let i = 0; i < ev.length; i++) {
    if (i + 1 < ev.length) ev[i].dur = Math.min(ev[i].dur, ev[i + 1].start - ev[i].start);
    ev[i].dur = Math.max(1, ev[i].dur);
  }
  return ev;
}

// Build per-bar VexFlow notes for one staff across [0,totalBars). mode "rhythm"=melody (visible
// rests), "chords"=harmony (ghost fillers). Ties within a bar; cross-bar/system ties are omitted
// for the static export (kept simple + robust).
function buildStaff(V, events, totalBars, clef, restKey, mode, useFlats) {
  const { StaveNote, GhostNote, Dot } = V;
  const tbl = useFlats ? FLAT : SHARP;
  const byBar = Array.from({ length: totalBars }, () => []);
  const mkNote = (keys, steps) => {
    const { d, dots } = STEP_DUR[steps];
    const ks = keys.map((m) => tbl[((m % 12) + 12) % 12] + "/" + (Math.floor(m / 12) - 1));
    const n = new StaveNote({ keys: ks, duration: d, clef, auto_stem: true });
    for (let i = 0; i < dots; i++) Dot.buildAndAttach([n], { all: true });
    return n;
  };
  const mkRest = (steps) => { const { d, dots } = STEP_DUR[steps]; const n = new StaveNote({ keys: [restKey], duration: d + "r", clef }); for (let i = 0; i < dots; i++) Dot.buildAndAttach([n], { all: true }); return n; };
  const mkGhost = (steps) => { const { d, dots } = STEP_DUR[steps]; const n = new GhostNote({ duration: d }); for (let i = 0; i < dots; i++) Dot.buildAndAttach([n], { all: true }); return n; };
  const filler = (steps) => mode === "chords" ? mkGhost(steps) : mkRest(steps);

  // fragment events into per-bar pieces
  const barEvents = Array.from({ length: totalBars }, () => []);
  for (const ev of events) {
    let s = ev.start; const end = ev.start + ev.dur;
    while (s < end) {
      const bar = Math.floor(s / SPB); if (bar >= totalBars) break;
      const segEnd = Math.min(end, (bar + 1) * SPB);
      barEvents[bar].push({ start: s - bar * SPB, dur: segEnd - s, keys: ev.keys });
      s = segEnd;
    }
  }
  for (let bar = 0; bar < totalBars; bar++) {
    const evs = barEvents[bar].sort((a, b) => a.start - b.start);
    const out = byBar[bar];
    if (!evs.length) { out.push(mkGhost(16)); continue; }
    let cur = 0;
    for (const fe of evs) {
      if (fe.start > cur) for (const g of splitSpan(cur, fe.start - cur)) out.push(filler(g.steps));
      for (const pc of splitSpan(fe.start, fe.dur)) out.push(mkNote(fe.keys, pc.steps));
      cur = fe.start + fe.dur;
    }
    if (cur < SPB && mode !== "chords") for (const g of splitSpan(cur, SPB - cur)) out.push(filler(g.steps));
  }
  return byBar;
}

export async function renderTakeSVG(rawEvents, { bpm = 124, key = "C", scale = "major" } = {}) {
  const V = await loadVexFlow();
  if (!V) return null;
  const { Renderer, Stave, StaveConnector, Voice, Formatter, Beam, Accidental, Fraction, Barline } = V;

  // seconds → 16th-step grid
  const toStep = (s) => Math.round(s * (bpm / 60) * 4);
  const conv = (track) => rawEvents.filter((e) => e.track === track)
    .map((e) => ({ t: Math.max(0, toStep(e.t)), p: e.midi, d: Math.max(1, toStep(e.d)) }));
  const lead = reduceMono(conv("lead"));
  const harm = reduceMono(conv("harmony"));
  if (!lead.length && !harm.length) return null;

  const endStep = Math.max(0, ...[...lead, ...harm].map((e) => e.start + e.dur));
  const totalBars = Math.min(MAX_BARS, Math.max(1, Math.ceil(endStep / SPB)));

  const minor = (scale || "major").toLowerCase().startsWith("min");
  const keySig = (minor ? KEYSIG_MINOR : KEYSIG_MAJOR)[key] || "C";
  const useFlats = keySig.includes("b") && keySig.length > 1;

  const SPLIT = 60;
  const hi = harm.map((e) => ({ ...e, keys: e.keys.filter((m) => m >= SPLIT) })).filter((e) => e.keys.length);
  const lo = harm.map((e) => ({ ...e, keys: e.keys.filter((m) => m < SPLIT) })).filter((e) => e.keys.length);
  const melodyBars = buildStaff(V, lead.map((e) => ({ start: e.start, dur: e.dur, keys: e.keys })), totalBars, "treble", "b/4", "rhythm", useFlats);
  const hiBars = buildStaff(V, hi, totalBars, "treble", "b/4", "chords", useFlats);
  const loBars = buildStaff(V, lo, totalBars, "bass", "d/3", "chords", useFlats);

  // geometry: systems of SYS_BARS bars, stacked
  const systems = Math.ceil(totalBars / SYS_BARS);
  const left = 10, head = 90, barW = 150, sysH = 230;
  const W = left + head + SYS_BARS * barW + 10;
  const H = systems * sysH + 20;

  const host = document.createElement("div");
  host.style.cssText = "position:absolute;left:-99999px;top:0;background:#fffdf7;";
  document.body.appendChild(host);
  let svgOut = null;
  try {
    const renderer = new Renderer(host, Renderer.Backends.SVG);
    renderer.resize(W, H);
    const ctx = renderer.getContext();

    for (let sys = 0; sys < systems; sys++) {
      const bar0 = sys * SYS_BARS, nbars = Math.min(SYS_BARS, totalBars - bar0);
      const yTop = 16 + sys * sysH;
      const yMel = yTop, yHi = yTop + 70, yLo = yTop + 140;
      for (let b = 0; b < nbars; b++) {
        const bar = bar0 + b;
        const x = b === 0 ? left : left + head + b * barW;
        const w = b === 0 ? head + barW : barW;
        const rows = [
          { notes: melodyBars[bar], clef: "treble", y: yMel },
          { notes: hiBars[bar], clef: "treble", y: yHi },
          { notes: loBars[bar], clef: "bass", y: yLo },
        ];
        const staves = rows.map((r) => {
          const s = new Stave(x, r.y, w);
          if (b === 0) s.addClef(r.clef).addKeySignature(keySig).addTimeSignature("4/4");
          if (bar === totalBars - 1) s.setEndBarType(Barline.type.END);
          s.setContext(ctx).draw();
          return s;
        });
        if (b === 0) {
          new StaveConnector(staves[1], staves[2]).setType(StaveConnector.type.BRACE).setContext(ctx).draw();
          new StaveConnector(staves[1], staves[2]).setType(StaveConnector.type.SINGLE_LEFT).setContext(ctx).draw();
        }
        const mkVoice = (notes) => new Voice({ num_beats: 4, beat_value: 4 }).setStrict(false).addTickables(notes);
        const vMel = mkVoice(rows[0].notes), vHi = mkVoice(rows[1].notes), vLo = mkVoice(rows[2].notes);
        Accidental.applyAccidentals([vMel], keySig);
        Accidental.applyAccidentals([vHi, vLo], keySig);
        const wNote = Math.max(40, staves[0].getNoteEndX() - staves[0].getNoteStartX() - 8);
        new Formatter().joinVoices([vMel]).format([vMel], wNote);
        new Formatter().joinVoices([vHi]).joinVoices([vLo]).format([vHi, vLo], wNote);
        vMel.draw(ctx, staves[0]); vHi.draw(ctx, staves[1]); vLo.draw(ctx, staves[2]);
        for (const notes of rows.map((r) => r.notes))
          Beam.generateBeams(notes, { groups: [new Fraction(1, 4)] }).forEach((bm) => bm.setContext(ctx).draw());
      }
    }
    const svg = host.querySelector("svg");
    if (svg) { svg.setAttribute("xmlns", "http://www.w3.org/2000/svg"); svgOut = svg.outerHTML; }
  } finally {
    host.remove();
  }
  return svgOut;
}
