// Shared WebSocket client + message protocol for host and phones.
export class Bus {
  constructor(role = "auto") {
    this.role = role;
    this.handlers = {};
    this.id = null;
    this.connect();
  }
  connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws"; // match page protocol (tunnel-safe)
    const url = `${proto}://${location.host}`;
    this.ws = new WebSocket(url);
    this.ws.onopen = () => this.send({ type: "hello", role: this.role });
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "welcome") this.id = msg.id;
      (this.handlers[msg.type] || []).forEach((fn) => fn(msg));
    };
    this.ws.onclose = () => setTimeout(() => this.connect(), 800); // auto-reconnect on LAN
  }
  on(type, fn) { (this.handlers[type] ||= []).push(fn); return this; }
  send(obj) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  control(action, payload) { this.send({ type: "control", action, payload }); }
}

export const ROLE_COLOR = { groove:"#F5B82E", harmony:"#1BA88A", lead:"#F4533A", crowd:"#9B7BE6" };

// Diatonic chord names per major key (degree -> {roman, name}).
const SHARP = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const MAJOR_STEPS = [0,2,4,5,7,9,11];
const QUALITY = ["","m","m","","","m","dim"];
const ROMAN = ["I","ii","iii","IV","V","vi","vii°"];
export function diatonic(key) {
  const root = SHARP.indexOf(key);
  return MAJOR_STEPS.map((s, i) => ({
    roman: ROMAN[i],
    name: SHARP[(root + s) % 12] + QUALITY[i],
  }));
}
export function romanToName(key, roman) {
  return diatonic(key).find((c) => c.roman === roman)?.name || roman;
}

// The 7 IN-KEY notes for the lead keyboard (host + phone share this so they always match).
// Returns [{ name, pc, step, black }] ascending from the root — `step` = semitones above the root
// (keeps the keyboard ascending), `black` = it's an accidental (renders as a black key).
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];
export function scaleNotes(key, scale = "major") {
  const root = SHARP.indexOf(key);
  if (root < 0) return [];
  const steps = scale === "minor" ? MINOR_STEPS : MAJOR_STEPS;
  return steps.map((step) => {
    const name = SHARP[(root + step) % 12];
    return { name, pc: (root + step) % 12, step, black: name.includes("#") };
  });
}

// Diatonic triad as MIDI note numbers (C-1 = 0). baseOct = octave of the root.
export function chordMidi(key, roman, baseOct = 3) {
  const root = SHARP.indexOf(key);
  const d = ROMAN.indexOf(roman);
  if (root < 0 || d < 0) return [];
  return [0, 2, 4].map((t) => {
    const idx = d + t;
    const semis = MAJOR_STEPS[idx % 7] + 12 * Math.floor(idx / 7);
    return 12 * (baseOct + 1) + root + semis;
  });
}
// Same triad as Tone.js note names, e.g. ["A3","C#4","E4"].
export function chordNotes(key, roman, baseOct = 3) {
  return chordMidi(key, roman, baseOct).map((m) => SHARP[m % 12] + (Math.floor(m / 12) - 1));
}
