// Record + export the HOST's generative music — drums + harmony + lead. NONE of the players'
// phone-local audio is here: phones sound their own taps locally and never route to the host's
// audio graph, so capturing the host buses captures only the generated band, exactly as wanted.
//
// Two parallel captures while recording:
//   1) audio — Tone.Recorder taps the master bus (full mix) + each stem bus (drums/harmony/lead)
//      → WebM/opus blobs (full track + stems).
//   2) notes — every triggered note is logged with a timestamp (host calls logNote) → a Standard
//      MIDI File (type-1, one track per voice) and the sheet view.
const Tone = window.Tone;

const DRUM_MIDI = { kick: 36, snare: 38, hat: 42 };   // GM percussion map (channel 10/idx 9)

export class HostRecorder {
  constructor() {
    this.recording = false;
    this.events = [];           // {track, midi, t (s from start), d (s), v}
    this.recs = null;           // { master, drums, harmony, lead } Tone.Recorders
    this.blobs = null;
    this.t0 = 0;
    this.bpm = 124;
    this.elapsed = 0;
  }

  // Host passes the four bus Gain nodes it routes audio through.
  attach(buses) {
    this.recs = {
      master: new Tone.Recorder(), drums: new Tone.Recorder(),
      harmony: new Tone.Recorder(), bass: new Tone.Recorder(), lead: new Tone.Recorder(),
    };
    buses.master.connect(this.recs.master);
    buses.drums.connect(this.recs.drums);
    buses.harmony.connect(this.recs.harmony);
    if (buses.bass) buses.bass.connect(this.recs.bass);
    buses.lead.connect(this.recs.lead);
  }

  // Called at every note trigger (drums/harmony/lead). midiOrDrum: a MIDI int, or "kick"/"snare"/"hat".
  // atTime = the scheduled audio time of the hit (so onset timing matches what's heard).
  logNote(track, midiOrDrum, durSec, vel = 0.9, atTime = null) {
    if (!this.recording) return;
    const midi = typeof midiOrDrum === "string" ? (DRUM_MIDI[midiOrDrum] ?? 36) : midiOrDrum;
    const t = (atTime != null ? atTime : Tone.now()) - this.t0;
    this.events.push({ track, midi, t: Math.max(0, t), d: Math.max(0.05, durSec), v: vel });
  }

  async start(bpm) {
    if (this.recording || !this.recs) return;
    this.recording = true;                    // set FIRST so a fast re-click can't double-start
    this.events = []; this.blobs = null; this.bpm = bpm || 124; this.t0 = Tone.now();
    // Each Tone.Recorder can only be start()ed from "stopped"; reset any that's lingering
    // (started/paused) and swallow per-recorder errors so one bad stem can't abort the take.
    await Promise.all(Object.values(this.recs).map(async (r) => {
      try {
        if (r.state !== "stopped") await r.stop();
        await r.start();
      } catch (e) { console.warn("[rec] recorder start skipped:", e?.message); }
    }));
  }

  async stop() {
    if (!this.recording) return null;
    this.recording = false;
    this.elapsed = Tone.now() - this.t0;
    const blobs = {};
    for (const [k, r] of Object.entries(this.recs)) {
      try { blobs[k] = r.state !== "stopped" ? await r.stop() : null; } catch { blobs[k] = null; }
    }
    this.blobs = blobs;
    return blobs;
  }

  hasTake() { return !!(this.blobs || this.events.length); }

  // ---- exports ----
  // Audio + stems export as real 16-bit WAV: the recorder captures WebM/opus, which we decode to
  // PCM and re-encode to WAV at export time (universal, lossless-from-here, editable in any DAW).
  async exportAudio() { dl(await blobToWav(this.blobs?.master), "jamarama-track.wav"); }
  async exportStems() {
    let n = 0;
    for (const k of ["drums", "harmony", "bass", "lead"]) {
      const w = await blobToWav(this.blobs?.[k]);
      if (w) { dl(w, `jamarama-${k}.wav`, n * 200); n++; }
    }
    return n;
  }
  exportMidi() {
    if (!this.events.length) return false;
    dl(buildSMF(this.events, this.bpm), "jamarama.mid"); return true;
  }
  // Sheet = render the WHOLE recorded take to standard notation (independent of the live view).
  async exportSheet(meta = {}) {
    if (!this.events.length) return false;
    const { renderTakeSVG } = await import("/js/take_score.js");
    const svg = await renderTakeSVG(this.events, { bpm: this.bpm, key: meta.key || "C", scale: meta.scale || "major" });
    if (!svg) return false;
    dl(new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + svg], { type: "image/svg+xml" }), "jamarama-sheet.svg");
    return true;
  }
}

// WebM/opus blob → 16-bit PCM WAV blob (decoded via the live AudioContext).
async function blobToWav(blob) {
  if (!blob) return null;
  const ctx = Tone.getContext().rawContext;
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  const nch = buf.numberOfChannels, sr = buf.sampleRate, n = buf.length;
  const chans = []; for (let c = 0; c < nch; c++) chans.push(buf.getChannelData(c));
  const blockAlign = nch * 2, dataLen = n * blockAlign;
  const ab = new ArrayBuffer(44 + dataLen), dv = new DataView(ab);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF"); dv.setUint32(4, 36 + dataLen, true); wstr(8, "WAVE");
  wstr(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nch, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * blockAlign, true); dv.setUint16(32, blockAlign, true); dv.setUint16(34, 16, true);
  wstr(36, "data"); dv.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) {
    const s = Math.max(-1, Math.min(1, chans[c][i]));
    dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true); off += 2;
  }
  return new Blob([ab], { type: "audio/wav" });
}

function dl(blob, name, delay = 0) {
  if (!blob) return;
  setTimeout(() => {
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = u; a.download = name; a.style.display = "none";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 2000);
  }, delay);
}

// ---- minimal Standard MIDI File (type-1) encoder ------------------------------------------
const PPQ = 480;
const CH = { drums: 9, harmony: 0, bass: 2, lead: 1 };   // drums on channel 10 (idx 9) = GM percussion
const PROGRAM = { harmony: 0, bass: 33, lead: 81 };       // acoustic grand / fingered bass / synth lead (hint only)

function varlen(n) {
  const out = [n & 0x7f];
  n >>= 7;
  while (n > 0) { out.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return out;
}
function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function str(s) { return [...s].map((c) => c.charCodeAt(0)); }

function trackChunk(name, events, bpm, withTempo) {
  const sec2tick = (s) => Math.max(0, Math.round(s * (bpm / 60) * PPQ));
  // build absolute on/off list
  const abs = [];
  if (withTempo) {
    const us = Math.round(60000000 / bpm);
    abs.push({ tick: 0, meta: [0xff, 0x51, 0x03, (us >> 16) & 255, (us >> 8) & 255, us & 255] });
  }
  const ch = CH[name];
  if (PROGRAM[name] != null) abs.push({ tick: 0, msg: [0xc0 | ch, PROGRAM[name]] });
  for (const e of events) {
    const on = sec2tick(e.t), off = on + Math.max(1, sec2tick(e.d));
    const vel = Math.max(1, Math.min(127, Math.round(e.v * 127)));
    abs.push({ tick: on, msg: [0x90 | ch, e.midi & 127, vel] });
    abs.push({ tick: off, msg: [0x80 | ch, e.midi & 127, 0] });
  }
  abs.sort((a, b) => a.tick - b.tick);
  let last = 0; const data = [];
  for (const ev of abs) {
    data.push(...varlen(ev.tick - last)); last = ev.tick;
    data.push(...(ev.meta || ev.msg));
  }
  data.push(0x00, 0xff, 0x2f, 0x00);   // end of track
  // optional track name meta at the front would need its own delta; keep it lean.
  return [...str("MTrk"), ...u32(data.length), ...data];
}

function buildSMF(events, bpm) {
  const byTrack = { drums: [], harmony: [], bass: [], lead: [] };
  for (const e of events) (byTrack[e.track] || byTrack.lead).push(e);
  const tracks = [
    trackChunk("harmony", byTrack.harmony, bpm, true),   // track 0 carries the tempo
    trackChunk("bass", byTrack.bass, bpm, false),
    trackChunk("lead", byTrack.lead, bpm, false),
    trackChunk("drums", byTrack.drums, bpm, false),
  ];
  const header = [...str("MThd"), ...u32(6), 0x00, 0x01, 0x00, tracks.length, (PPQ >> 8) & 255, PPQ & 255];
  const bytes = new Uint8Array([...header, ...tracks.flat()]);
  return new Blob([bytes], { type: "audio/midi" });
}
