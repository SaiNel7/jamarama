// Shared WebSocket client + message protocol for host and phones.
export class Bus {
  constructor(role = "auto") {
    this.role = role;
    this.handlers = {};
    this.binHandlers = [];     // raw binary frames (e.g. streamed texture PCM)
    this.id = null;
    // Stable per-tab session id: reconnects (and page reloads) reclaim the same
    // player on the server instead of churning the roster as a new one each time.
    // sessionStorage is per-tab, so two tabs on one phone stay separate players.
    try {
      let sid = sessionStorage.getItem("jam-sid");
      if (!sid) { sid = crypto.randomUUID(); sessionStorage.setItem("jam-sid", sid); }
      this.sid = sid;
    } catch { this.sid = Math.random().toString(36).slice(2) + Date.now().toString(36); }
    this.connect();
  }
  connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws"; // match page protocol (tunnel-safe)
    const url = `${proto}://${location.host}`;
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => this.send({ type: "hello", role: this.role, sid: this.sid });
    this.ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) { this.binHandlers.forEach((fn) => fn(e.data)); return; }  // streamed PCM
      const msg = JSON.parse(e.data);
      if (msg.type === "welcome") this.id = msg.id;
      (this.handlers[msg.type] || []).forEach((fn) => fn(msg));
    };
    this.ws.onclose = () => setTimeout(() => this.connect(), 800); // auto-reconnect on LAN
  }
  on(type, fn) { (this.handlers[type] ||= []).push(fn); return this; }
  onBinary(fn) { this.binHandlers.push(fn); return this; }
  send(obj) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  control(action, payload) { this.send({ type: "control", action, payload }); }
}

export const ROLE_COLOR = { groove:"#F5B82E", harmony:"#1BA88A", lead:"#F4533A", crowd:"#9B7BE6" };

// ---- Keys, scales, modes ----------------------------------------------------
// Every diatonic mode is a ROTATION of some major (parent) scale, so a mode's
// seven chords ARE the parent major's seven chords — the mode only changes which
// note feels like "home" (and where the lead keyboard starts). So all chord math
// runs against the parent major and chords are looked up by parent-relative roman
// numerals — which is exactly how genres.js authors its progressions (a minor
// genre's "vi" is its home chord = the relative major's vi). `parent` below is the
// semitones from a mode's tonic up to its parent-major tonic (A aeolian → C = +3).
// pentatonic/chromatic are lead-only note sets; their chords fall back to major.
const SHARP = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const MAJOR_STEPS = [0,2,4,5,7,9,11];
const QUALITY = ["","m","m","","","m","dim"];
const ROMAN = ["I","ii","iii","IV","V","vi","vii°"];
const MODES = {
  major:      { steps:[0,2,4,5,7,9,11],            parent:0  },
  ionian:     { steps:[0,2,4,5,7,9,11],            parent:0  },
  minor:      { steps:[0,2,3,5,7,8,10],            parent:3  },   // aeolian
  aeolian:    { steps:[0,2,3,5,7,8,10],            parent:3  },
  dorian:     { steps:[0,2,3,5,7,9,10],            parent:10 },
  phrygian:   { steps:[0,1,3,5,7,8,10],            parent:8  },
  lydian:     { steps:[0,2,4,6,7,9,11],            parent:7  },
  mixolydian: { steps:[0,2,4,5,7,9,10],            parent:5  },
  locrian:    { steps:[0,1,3,5,6,8,10],            parent:1  },
  pentatonic: { steps:[0,2,4,7,9],                 parent:0  },   // major pentatonic (lead notes)
  chromatic:  { steps:[0,1,2,3,4,5,6,7,8,9,10,11], parent:0  },
};
export function modeOf(scale) { return MODES[scale] || MODES.major; }
// Pitch class of the parent-major tonic for key+mode — all chord math anchors here.
export function parentRoot(key, scale = "major") {
  const r = SHARP.indexOf(key); if (r < 0) return 0;
  return (r + modeOf(scale).parent) % 12;
}

// Diatonic chord names for the key's parent major (degree -> {roman, name}).
export function diatonic(key, scale = "major") {
  const proot = parentRoot(key, scale);
  return MAJOR_STEPS.map((s, i) => ({
    roman: ROMAN[i],
    name: SHARP[(proot + s) % 12] + QUALITY[i],
  }));
}
export function romanToName(key, roman, scale = "major") {
  return diatonic(key, scale).find((c) => c.roman === roman)?.name || roman;
}

// The IN-KEY notes for the lead keyboard (host + phone share this so they always match).
// Returns [{ name, pc, step, black }] ascending from the tonic — `step` = semitones above the
// tonic (keeps the keyboard ascending), `black` = it's an accidental (renders as a black key).
export function scaleNotes(key, scale = "major") {
  const root = SHARP.indexOf(key);
  if (root < 0) return [];
  return modeOf(scale).steps.map((step) => {
    const name = SHARP[(root + step) % 12];
    return { name, pc: (root + step) % 12, step, black: name.includes("#") };
  });
}

// Diatonic triad as MIDI note numbers (C-1 = 0), looked up by parent-relative roman.
// baseOct = octave of the chord root.
export function chordMidi(key, roman, baseOct = 3, scale = "major") {
  const proot = parentRoot(key, scale);
  const d = ROMAN.indexOf(roman);
  if (SHARP.indexOf(key) < 0 || d < 0) return [];
  return [0, 2, 4].map((t) => {
    const idx = d + t;
    const semis = MAJOR_STEPS[idx % 7] + 12 * Math.floor(idx / 7);
    return 12 * (baseOct + 1) + proot + semis;
  });
}
// Same triad as Tone.js note names, e.g. ["A3","C#4","E4"].
export function chordNotes(key, roman, baseOct = 3, scale = "major") {
  return chordMidi(key, roman, baseOct, scale).map((m) => SHARP[m % 12] + (Math.floor(m / 12) - 1));
}
