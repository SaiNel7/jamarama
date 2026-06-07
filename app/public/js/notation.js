// Sheet-music ("score editor") view for the JAMARAMA music readout.
//
// Companion to the piano-roll (#roll). Renders the SAME live data — generated lead loop +
// generative harmony schedule — as standard Western notation on a grand staff (lead → treble,
// harmony → bass), the way Logic Pro / GarageBand show a region in their Score Editor:
//   • clef + key signature + 4/4 time, drawn once at the head of the system
//   • chord symbols above the treble staff at each chord change
//   • metric-correct note values & rests, sixteenths/eighths beamed per beat
//   • ties across beats and barlines for held notes
//   • a thin playhead that sweeps in sync with the transport
//
// Self-contained: lazy-loads the vendored VexFlow 4.2 (Bravura, font baked in) on first use
// and pulls music-theory helpers from the stable shared/theory modules, so wiring into host.js
// is a one-line render() call. VexFlow 4.2.x uses snake_case struct fields (num_beats,
// stem_direction, first_note, …) — that is load-bearing, not a style choice.

import { chordMidi, romanToName } from "/js/shared.js";
import { midiName } from "/js/brain/theory.js";

const VEXFLOW_SRC = "/vendor/vexflow/vexflow-bravura.js";
const BARS = 4, SPB = 16, BEATS_PER_BAR = 4;          // 4 bars · 16 steps/bar · 4/4

// step-count (within a beat-aligned split) → VexFlow duration + dot count.
// splitSpan() only ever yields 1,2,3,4,8,16, so this table is total.
const STEP_DUR = {
  1:  { d: "16", dots: 0 },
  2:  { d: "8",  dots: 0 },
  3:  { d: "8",  dots: 1 },   // dotted eighth
  4:  { d: "q",  dots: 0 },
  8:  { d: "h",  dots: 0 },
  16: { d: "w",  dots: 0 },
};

const SHARP = ["c", "c#", "d", "d#", "e", "f", "f#", "g", "g#", "a", "a#", "b"];
const FLAT  = ["c", "db", "d", "eb", "e", "f", "gb", "g", "ab", "a", "bb", "b"];

// pitch-class → VexFlow major / minor key-signature string (enharmonics that VexFlow can't
// notate as a key sig, e.g. D# major, are spelled to their usable equivalent).
const KEYSIG_MAJOR = { "C":"C","C#":"C#","D":"D","D#":"Eb","E":"E","F":"F","F#":"F#","G":"G","G#":"Ab","A":"A","A#":"Bb","B":"B" };
const KEYSIG_MINOR = { "C":"Cm","C#":"C#m","D":"Dm","D#":"D#m","E":"Em","F":"Fm","F#":"F#m","G":"Gm","G#":"G#m","A":"Am","A#":"A#m","B":"Bm" };

let _loading = null;
function loadVexFlow() {
  if (window.Vex && window.Vex.Flow) return Promise.resolve(window.Vex.Flow);
  // The UMD bundle assigns window.Vex even under a side-effect ESM import().
  _loading = _loading || import(VEXFLOW_SRC).then(() => window.Vex.Flow);
  return _loading;
}

// Split a span [pos, pos+len) (steps within a bar) into beat-aligned pieces whose lengths are
// directly notatable (1,2,3,4,8,16). Notes spanning several pieces get tied; rests just sit
// in sequence. This is what makes the rhythm read correctly instead of as one fat blob.
function splitSpan(pos, len) {
  const out = [];
  while (len > 0) {
    const inBeat = pos % 4;
    let take;
    if (inBeat === 0) {
      if (pos % SPB === 0 && len >= 16) take = 16;       // whole note (bar start)
      else if (pos % 8 === 0 && len >= 8) take = 8;      // half (beat 1 or 3)
      else if (len >= 4) take = 4;                       // quarter
      else take = len;                                   // 1..3 inside the beat
    } else {
      take = Math.min(len, 4 - inBeat);                  // fill only to the next beat
    }
    out.push({ pos, steps: take });
    pos += take; len -= take;
  }
  return out;
}

// Reduce a set of {t,p,d} notes to a monophonic-with-chords event list: notes sharing an onset
// merge into one chord; each event is then clamped so it doesn't run past the next onset.
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

// Tile a lead loop across the whole readout window so the staff reads continuously even when
// the loop is shorter than 4 bars (mirrors how the piano roll fills the width).
function tileLead(playLoop, loopLen, total) {
  if (!playLoop || !playLoop.length || !loopLen) return [];
  const out = [];
  for (let off = 0; off < total; off += loopLen)
    for (const n of playLoop) {
      const t = off + n.t;
      if (t < total) out.push({ t, p: n.p, d: Math.min(n.d, total - t) });
    }
  return out;
}

// Harmony schedule (per-beat slots) → merged chord events with real MIDI notes.
function harmonyEvents(schedule, key, scale) {
  const beats = Math.min(schedule.length, BARS * BEATS_PER_BAR);
  const ev = [];
  for (let i = 0; i < beats;) {
    const slot = schedule[i], k = slot.label || slot.roman;
    let run = 1;
    while (i + run < beats && (schedule[i + run].label || schedule[i + run].roman) === k) run++;
    const keys = (slot.notes && slot.notes.length) ? slot.notes : chordMidi(key, slot.roman, 4, scale);
    ev.push({ start: i * 4, dur: run * 4, keys });
    i += run;
  }
  return ev;
}

// Chord-change labels (for the symbols above the treble staff): one per merged run.
function chordLabels(schedule, key, scale) {
  const beats = Math.min(schedule.length, BARS * BEATS_PER_BAR);
  const out = [];
  for (let i = 0; i < beats;) {
    const slot = schedule[i], k = slot.label || slot.roman;
    let run = 1;
    while (i + run < beats && (schedule[i + run].label || schedule[i + run].roman) === k) run++;
    let name = slot.label;
    if (!name && slot.roman) { try { name = romanToName(key, slot.roman, scale); } catch { name = slot.roman; } }
    out.push({ step: i * 4, text: name || slot.roman || "" });
    i += run;
  }
  return out;
}

export class NotationView {
  constructor(container) {
    this.el = container;
    this.el.style.position = "relative";
    this._visible = false;
    this._ready = false;
    this._last = null;
    this.barGeom = [];
    this._injectStyle();
    // Persistent overlay playhead — lives outside the VexFlow <svg> so it can sweep at 60fps
    // without re-laying-out the score.
    this.cursor = document.createElement("div");
    this.cursor.className = "score-cursor";
    this.cursor.style.display = "none";
    this.el.appendChild(this.cursor);
  }

  _injectStyle() {
    if (document.getElementById("notation-style")) return;
    const s = document.createElement("style");
    s.id = "notation-style";
    s.textContent = `
      .score { background:var(--card,#fffdf7); }
      .score svg { display:block; }
      .score .score-cursor { position:absolute; top:0; bottom:0; width:3px;
        background:var(--groove,#F5B82E); z-index:4; pointer-events:none;
        box-shadow:0 0 0 1px rgba(0,0,0,.15); transition:left .05s linear; }
      .score .score-empty { position:absolute; inset:0; display:flex; align-items:center;
        justify-content:center; font-family:"Space Mono",monospace; font-size:13px; color:#9a8f74; }
      .readout-toggle { align-self:flex-start; display:inline-flex; width:max-content; gap:0;
        border:var(--border,2px solid #1c1812); border-radius:999px; overflow:hidden;
        box-shadow:var(--shadow-sm,2px 2px 0 #1c1812); }
      .readout-toggle .vbtn { font-family:"Space Mono",monospace; font-weight:700; font-size:12px;
        letter-spacing:.04em; padding:5px 14px; border:0; background:var(--card,#fffdf7);
        color:#5a564d; cursor:pointer; }
      .readout-toggle .vbtn.active { background:var(--ink,#1c1812); color:var(--cream,#f6efde); }`;
    document.head.appendChild(s);
  }

  setVisible(v) {
    this._visible = v;
    this.cursor.style.display = v ? "" : "none";
    if (v && this._last) this.render(...this._last);
  }

  async _ensure() {
    if (this._ready) return true;
    await loadVexFlow();
    this._ready = !!(window.Vex && window.Vex.Flow);
    return this._ready;
  }

  // Build VexFlow StaveNotes for one staff across all bars: splits notes at beat/bar boundaries
  // (tying the pieces), records each note's absolute start step for the playhead, and fills gaps
  // per `mode`. Returns { byBar:[{notes,steps}], ties:[{first,last,n}] }.
  // mode "rhythm" (melody): gaps inside a bar with notes become visible rests; a fully empty bar
  // is blanked with an invisible GhostNote (no whole-rest rectangle). mode "chords" (harmony):
  // gaps/empty bars are filled with GhostNotes only — never a visible rest — so the line reads as
  // "just the chords". GhostNotes consume the right number of ticks so chords still land on-beat.
  _buildStaff(events, clef, restKey, mode) {
    const { StaveNote, GhostNote, Dot } = window.Vex.Flow;
    const byBar = Array.from({ length: BARS }, () => ({ notes: [], steps: [] }));
    const ties = [];
    const tbl = this._useFlats ? FLAT : SHARP;

    const mkNote = (keys, steps) => {
      const { d, dots } = STEP_DUR[steps];
      const ks = keys.map((m) => tbl[((m % 12) + 12) % 12] + "/" + (Math.floor(m / 12) - 1));
      const n = new StaveNote({ keys: ks, duration: d, clef, auto_stem: true });
      for (let i = 0; i < dots; i++) Dot.buildAndAttach([n], { all: true });
      return n;
    };
    const mkRest = (steps) => {
      const { d, dots } = STEP_DUR[steps];
      const n = new StaveNote({ keys: [restKey], duration: d + "r", clef });
      for (let i = 0; i < dots; i++) Dot.buildAndAttach([n], { all: true });
      return n;
    };
    const mkGhost = (steps) => {
      const { d, dots } = STEP_DUR[steps];
      const n = new GhostNote({ duration: d });
      for (let i = 0; i < dots; i++) Dot.buildAndAttach([n], { all: true });
      return n;
    };
    const filler = (steps) => mode === "chords" ? mkGhost(steps) : mkRest(steps);

    // Fragment every event into per-bar pieces (cont = a continuation of a held event).
    const barEvents = Array.from({ length: BARS }, () => []);
    for (const ev of events) {
      const end = ev.start + ev.dur;
      let s = ev.start;
      while (s < end) {
        const bar = Math.floor(s / SPB);
        if (bar >= BARS) break;
        const barEnd = (bar + 1) * SPB;
        const segEnd = Math.min(end, barEnd);
        barEvents[bar].push({ start: s - bar * SPB, dur: segEnd - s, keys: ev.keys, cont: s > ev.start });
        s = segEnd;
      }
    }

    let pendingTie = null;                                  // last note of the previous bar's held event
    for (let bar = 0; bar < BARS; bar++) {
      const evs = barEvents[bar].sort((a, b) => a.start - b.start);
      const bb = byBar[bar];
      const push = (note, step) => { bb.notes.push(note); bb.steps.push(bar * SPB + step); };
      if (!evs.length) { push(mkGhost(16), 0); pendingTie = null; continue; }   // empty bar → blank
      let cur = 0;
      for (const fe of evs) {
        if (fe.start > cur) for (const g of splitSpan(cur, fe.start - cur)) push(filler(g.steps), g.pos);
        const pieces = splitSpan(fe.start, fe.dur);
        let firstOfFrag = null, prev = null;
        pieces.forEach((pc, i) => {
          const note = mkNote(fe.keys, pc.steps);
          push(note, pc.pos);
          if (i === 0) firstOfFrag = note;
          if (prev) ties.push({ first: prev, last: note, n: fe.keys.length });
          prev = note;
        });
        if (fe.cont && pendingTie) ties.push({ first: pendingTie, last: firstOfFrag, n: fe.keys.length });
        pendingTie = prev;
        cur = fe.start + fe.dur;
      }
      // trailing gap: melody gets rests (rhythm clarity); chords stop (soft voice) — no rectangle.
      if (cur < SPB && mode !== "chords") for (const g of splitSpan(cur, SPB - cur)) push(filler(g.steps), g.pos);
    }
    return { byBar, ties };
  }

  render(st, playLoop = [], loopLen = BARS * SPB, progIdx = 0) {
    this._last = [st, playLoop, loopLen, progIdx];
    if (!this._visible || !st) return;
    if (!this._ready) { this._ensure().then((ok) => { if (ok) this.render(...this._last); }); return; }

    const V = window.Vex.Flow;
    const { Renderer, Stave, StaveConnector, Voice, Formatter, Beam, Accidental, Fraction, Barline, StaveTie } = V;

    const minor = (st.scale || "major").toLowerCase().startsWith("min");
    const keySig = (minor ? KEYSIG_MINOR : KEYSIG_MAJOR)[st.key] || "C";
    this._useFlats = keySig.includes("b") && keySig.length > 1;   // flat key sig → spell flats

    // --- assemble the three staves' data from live state ---
    // Top: MELODY (the generated lead). Below: HARMONY as a braced grand staff — chord notes split
    // at middle C into a right hand (treble) and left hand (bass), shown as sustained chords only.
    const schedule = (st.schedule && st.schedule.length) ? st.schedule
      : (st.progression && st.progression.length ? st.progression : ["I", "IV", "V", "vi"])
          .flatMap((roman) => Array(4).fill({ notes: chordMidi(st.key, roman, 4, st.scale), roman, label: roman }));
    const leadEv = reduceMono(tileLead(playLoop, loopLen, BARS * SPB));
    const harmEv = harmonyEvents(schedule, st.key, st.scale);
    const labels = chordLabels(schedule, st.key, st.scale);

    const SPLIT = 60;                                   // middle C → right/left hand split
    const hiEv = harmEv.map((e) => ({ ...e, keys: e.keys.filter((m) => m >= SPLIT) })).filter((e) => e.keys.length);
    const loEv = harmEv.map((e) => ({ ...e, keys: e.keys.filter((m) => m < SPLIT) })).filter((e) => e.keys.length);

    const melody = this._buildStaff(leadEv, "treble", "b/4", "rhythm");
    const harmHi = this._buildStaff(hiEv, "treble", "b/4", "chords");
    const harmLo = this._buildStaff(loEv, "bass", "d/3", "chords");

    // --- geometry: three stacked staves, sized to fit the available height ---
    const W = Math.max(320, this.el.clientWidth), H = Math.max(190, this.el.clientHeight);
    const left = 8, right = 10;
    const head = 86;                                   // extra width on bar 0 for clef+key+time
    const usable = W - left - right;
    const barW = Math.max(90, (usable - head) / BARS);
    const xOf = (bar) => bar === 0 ? left : left + head + bar * barW;
    const widthOf = (bar) => bar === 0 ? barW + head : barW;
    // distribute the two inter-staff gaps to the height; the harmony grand staff sits a touch
    // tighter than the melody→harmony gap, and the whole block is vertically centered.
    const lastBody = 36;                               // drawn height below the bottom staff's top line
    const avail = Math.max(116, H - 66);
    const gapGrand = Math.max(44, Math.min(66, avail * 0.46));
    const gapMel = Math.max(46, Math.min(82, avail - gapGrand));
    const usedSpan = gapMel + gapGrand + lastBody;
    const topY = Math.max(22, (H - usedSpan) / 2 + 6); // leave room above for chord symbols
    const yMel = topY, yHi = topY + gapMel, yLo = topY + gapMel + gapGrand;

    // --- (re)create the renderer/svg, preserve the cursor overlay ---
    const old = this.el.querySelector("svg"); if (old) old.remove();
    const oldEmpty = this.el.querySelector(".score-empty"); if (oldEmpty) oldEmpty.remove();
    const renderer = new Renderer(this.el, Renderer.Backends.SVG);
    renderer.resize(W, H);
    const ctx = renderer.getContext();

    const allTies = [...melody.ties, ...harmHi.ties, ...harmLo.ties];
    this.barGeom = [];

    const lines = [
      { data: melody, clef: "treble", y: yMel },
      { data: harmHi, clef: "treble", y: yHi },
      { data: harmLo, clef: "bass",   y: yLo },
    ];

    for (let bar = 0; bar < BARS; bar++) {
      const x = xOf(bar), w = widthOf(bar);
      const staves = lines.map((ln) => {
        const s = new Stave(x, ln.y, w);
        if (bar === 0) s.addClef(ln.clef).addKeySignature(keySig).addTimeSignature("4/4");
        if (bar === BARS - 1) s.setEndBarType(Barline.type.END);
        s.setContext(ctx).draw();
        return s;
      });
      const [sMel, sHi, sLo] = staves;

      // brace + joining lines around the HARMONY grand staff only (melody stands alone on top)
      if (bar === 0) {
        new StaveConnector(sHi, sLo).setType(StaveConnector.type.BRACE).setContext(ctx).draw();
        new StaveConnector(sHi, sLo).setType(StaveConnector.type.SINGLE_LEFT).setContext(ctx).draw();
      }
      if (bar === BARS - 1)
        new StaveConnector(sHi, sLo).setType(StaveConnector.type.SINGLE_RIGHT).setContext(ctx).draw();

      const mkVoice = (notes) => new Voice({ num_beats: 4, beat_value: 4 }).setStrict(false).addTickables(notes);
      const vMel = mkVoice(melody.byBar[bar].notes);
      const vHi = mkVoice(harmHi.byBar[bar].notes);
      const vLo = mkVoice(harmLo.byBar[bar].notes);
      // accidental memory is per-measure & per-staff group: melody independent of the harmony pair
      Accidental.applyAccidentals([vMel], keySig);
      Accidental.applyAccidentals([vHi, vLo], keySig);
      const wNote = Math.max(40, sMel.getNoteEndX() - sMel.getNoteStartX() - 8);
      new Formatter().joinVoices([vMel]).format([vMel], wNote);
      new Formatter().joinVoices([vHi]).joinVoices([vLo]).format([vHi, vLo], wNote);
      vMel.draw(ctx, sMel); vHi.draw(ctx, sHi); vLo.draw(ctx, sLo);

      for (const notes of [melody.byBar[bar].notes, harmHi.byBar[bar].notes, harmLo.byBar[bar].notes])
        Beam.generateBeams(notes, { groups: [new Fraction(1, 4)] }).forEach((b) => b.setContext(ctx).draw());

      this.barGeom.push({ x0: sMel.getNoteStartX(), x1: sMel.getNoteEndX() });
    }

    // ties (drawn after every measure is formatted so cross-bar x-positions are final)
    for (const t of allTies) {
      const idx = Array.from({ length: t.n || 1 }, (_, i) => i);
      new StaveTie({ first_note: t.first, last_note: t.last, first_indices: idx, last_indices: idx })
        .setContext(ctx).draw();
    }

    // chord symbols above the melody staff
    const svg = this.el.querySelector("svg");
    const NS = "http://www.w3.org/2000/svg";
    for (const lab of labels) {
      if (!lab.text) continue;
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", this._xForStep(lab.step));
      t.setAttribute("y", yMel - 6);
      t.setAttribute("font-family", "Space Mono, monospace");
      t.setAttribute("font-size", "13");
      t.setAttribute("font-weight", "700");
      t.setAttribute("fill", "#1BA88A");
      t.textContent = lab.text;
      svg.appendChild(t);
    }

    this.el.appendChild(this.cursor);                  // keep cursor on top of the fresh svg
    this.setPlayhead(this._lastStep || 0);
  }

  _xForStep(step) {
    const bar = Math.min(BARS - 1, Math.floor(step / SPB));
    const g = this.barGeom[bar]; if (!g) return 0;
    return g.x0 + ((step % SPB) / SPB) * (g.x1 - g.x0);
  }

  setPlayhead(step) {
    this._lastStep = step;
    if (!this._visible || !this.barGeom.length) return;
    this.cursor.style.left = this._xForStep(step) + "px";
  }
}
