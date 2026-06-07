// Genre-aware groove engine for the deterministic drum brain.
//
// The BASE beat changes with GENRE — jazz swings a ride, house is four-on-the-floor, reggae is a
// one-drop, hip-hop is boom-bap, funk is syncopated. The groove pad's COMPLEXITY (x) reshapes the
// actual PATTERN (syncopated kicks, ghost snares, fills) — not just hi-hat speed. ENERGY (y) drives
// intensity (velocity + extra hits). Output is velocities for the 3-piece kit (kick/snare/hat);
// ride folds into hat, clap into snare. Swing TIMING is applied globally by Tone.Transport (see
// FEEL_SWING) so the whole band swings together; here we only decide which pieces hit and how hard.

// Tone.Transport.swing amount (0..1, on the 8th grid) per feel. 0 = straight.
export const FEEL_SWING = {
  swing: 0.55, shuffle: 0.5, boombap: 0.28, trap: 0.16, funk: 0.1,
  backbeat: 0, driving: 0, fourfloor: 0, reggae: 0, latin: 0, sparse: 0,
};

const V = (base, y) => Math.max(0, Math.min(1, base * (0.55 + 0.55 * y)));  // energy scales velocity

// Each feel: (sub 0..15, bar, x=complexity 0..1, y=energy 0..1) -> {kick,snare,hat} velocities (0 = no hit).
const FEELS = {
  backbeat(sub, bar, x, y) {                       // pop / rock / country
    let k = 0, s = 0, h = 0;
    if (sub === 0) k = 1;
    if (sub === 8) k = 0.9;
    if (x > 0.5 && sub === 10) k = 0.7;            // syncopated kick (the "and" of 3)
    if (x > 0.75 && sub === 6) k = 0.6;
    if (sub === 4 || sub === 12) s = 1;            // backbeat on 2 & 4
    if (x > 0.6 && (sub === 7 || sub === 14)) s = 0.3;            // ghost snares
    if (x > 0.82 && bar % 4 === 3 && sub >= 12 && sub % 2 === 0) s = 0.7;  // end-of-phrase fill
    const dens = x < 0.3 ? 4 : (x < 0.65 ? 2 : 1); // quarter → 8th → 16th hats
    if (sub % dens === 0) h = 0.6;
    return { kick: V(k, y), snare: V(s, y), hat: V(h, y) };
  },
  driving(sub, bar, x, y) {                         // punk / metal — fast & straight
    let k = 0, s = 0, h = 0;
    if (sub === 0 || sub === 8) k = 1;
    if (x > 0.4 && (sub === 4 || sub === 12)) k = 0.8;            // drive toward four-on-floor
    if (x > 0.78 && sub % 2 === 0) k = Math.max(k, 0.6);         // metal-ish double-kick
    if (sub === 4 || sub === 12) s = 1;
    const dens = x < 0.5 ? 2 : 1;
    if (sub % dens === 0) h = 0.6;
    return { kick: V(k, y), snare: V(s, y), hat: V(h, y) };
  },
  fourfloor(sub, bar, x, y) {                       // house / techno / trance / disco / synthwave
    let k = 0, s = 0, h = 0;
    if (sub % 4 === 0) k = 1;                       // four-on-the-floor
    if (sub === 4 || sub === 12) s = 0.8;          // clap on 2 & 4
    if (sub % 4 === 2) h = 0.6;                     // open hat on the off-beats
    if (x > 0.55 && sub % 2 === 1) h = Math.max(h, 0.35);        // 16th hats with complexity
    if (x > 0.8 && sub === 14) k = 0.7;            // rolling kick into the 1
    return { kick: V(k, y), snare: V(s, y), hat: V(h, y) };
  },
  swing(sub, bar, x, y) {                           // jazz — ride "spang-a-lang" (Transport swings it)
    let k = 0, s = 0, h = 0;
    if (sub % 4 === 0) h = 0.6;                     // ride on every beat
    if (sub === 6 || sub === 14) h = 0.5;          // + the swung "let" of 2 & 4
    if (x > 0.5 && (sub === 2 || sub === 10)) h = 0.4;
    if (sub === 4 || sub === 12) s = 0.32;         // soft brush comp on 2 & 4
    if (x > 0.5 && (sub === 7 || sub === 11)) s = 0.25;          // comping accents
    if (sub % 4 === 0) k = 0.2;                     // feathered kick on the beats
    return { kick: V(k, y), snare: V(s, y), hat: V(h, y * 0.85) };
  },
  shuffle(sub, bar, x, y) {                         // blues shuffle (Transport swings the 8ths)
    let k = 0, s = 0, h = 0;
    if (sub === 0) k = 1; if (sub === 8) k = 0.85;
    if (x > 0.6 && sub === 10) k = 0.6;
    if (sub === 4 || sub === 12) s = 1;
    if (sub % 2 === 0) h = 0.5;                     // shuffled 8ths
    return { kick: V(k, y), snare: V(s, y), hat: V(h, y) };
  },
  boombap(sub, bar, x, y) {                         // hip-hop / lofi (laid-back swing)
    let k = 0, s = 0, h = 0;
    if (sub === 0) k = 1; if (sub === 10) k = 0.8; // classic boom-bap kick on the "and" of 3
    if (x > 0.55 && sub === 6) k = 0.6;
    if (sub === 4 || sub === 12) s = 1;
    if (x > 0.5 && sub === 14) s = 0.3;            // ghost
    const dens = x < 0.4 ? 4 : 2;
    if (sub % dens === 0) h = 0.45;
    return { kick: V(k, y), snare: V(s, y), hat: V(h, y) };
  },
  trap(sub, bar, x, y) {                            // half-time, rolling hats
    let k = 0, s = 0, h = 0;
    if (sub === 0) k = 1;
    if (x > 0.5 && sub === 6) k = 0.7;
    if (x > 0.8 && sub === 11) k = 0.6;
    if (sub === 8) s = 1;                           // half-time clap on beat 3
    h = 0.4;                                         // 16th hats base
    if (x > 0.5 && sub % 2 === 1) h = 0.3;          // rolls fill in
    if (x > 0.8 && (sub === 7 || sub === 15)) h = 0.55;          // roll accents
    return { kick: V(k, y), snare: V(s, y), hat: V(h, y) };
  },
  funk(sub, bar, x, y) {                            // funk / soul / gospel — syncopated, 16th hats
    let k = 0, s = 0, h = 0;
    if (sub === 0) k = 1; if (sub === 6) k = 0.6; if (sub === 10) k = 0.7;
    if (x > 0.6 && sub === 3) k = 0.5;
    if (sub === 4 || sub === 12) s = 1;
    if (x > 0.4 && sub % 4 === 2) s = 0.25;         // ghost snares
    if (sub % 2 === 0) h = 0.5;
    if (x > 0.5 && sub % 2 === 1) h = 0.3;          // 16th hats
    return { kick: V(k, y), snare: V(s, y), hat: V(h, y) };
  },
  reggae(sub, bar, x, y) {                          // one drop — NO downbeat kick
    let k = 0, s = 0, h = 0;
    if (sub === 8) { k = 1; s = 0.9; }             // kick + rim together on beat 3
    if (sub % 4 === 2) h = 0.5;                     // skank on the off-beats
    if (x > 0.6 && sub % 2 === 0) h = Math.max(h, 0.3);
    return { kick: V(k, y), snare: V(s, y), hat: V(h, y) };
  },
  latin(sub, bar, x, y) {                           // son-clave-ish kick + busy percussion
    let k = 0, s = 0, h = 0;
    if (sub === 0 || sub === 6 || sub === 10) k = 0.9;           // 3-side of the clave
    if (sub === 4 || sub === 12) s = 0.7;
    if (x > 0.6 && (sub === 3 || sub === 11)) s = 0.3;
    if (sub % 2 === 0) h = 0.5;
    if (x > 0.5 && sub % 2 === 1) h = 0.3;
    return { kick: V(k, y), snare: V(s, y), hat: V(h, y) };
  },
  sparse(sub, bar, x, y) {                          // ambient / classical — soft pulse, mostly air
    let k = 0, s = 0, h = 0;
    if (y > 0.15 && sub === 0) k = 0.4;
    if (y > 0.5 && sub === 8) k = 0.35;
    if (y > 0.6 && sub === 8) s = 0.25;
    if (x > 0.5 && sub % 4 === 0) h = 0.2;
    return { kick: V(k, y), snare: V(s, y), hat: V(h, y) };
  },
};

// Decide the kit hits for this 16th step under the genre's feel.
export function grooveStep(feel, sub, bar, x, y) {
  return (FEELS[feel] || FEELS.backbeat)(sub, bar, x, y);
}

// ============================================================ HARMONY COMP (genre rhythm)
// Per-feel comping RHYTHM — when the chord articulates, the voicing (block vs arpeggio), and how
// long it rings. The host always ALSO states the chord on a chord change; this adds the genre's
// groove on top (reggae skank, funk stabs, house off-beat stabs, jazz syncopated comping, ambient
// pad). Returns { hit, arp:0|0.5|1, dur (steps) }. x=complexity, y=energy.
export function compStep(feel, sub, bar, x, y) {
  switch (feel) {
    case "reggae":    return { hit: sub % 4 === 2, arp: 0, dur: 1 };                         // skank: staccato off-beats
    case "funk":      return { hit: [0, 3, 6, 10].includes(sub) || (x > 0.6 && sub % 2 === 1), arp: 0, dur: 1 }; // 16th stabs
    case "fourfloor": return { hit: sub % 4 === 2, arp: 0, dur: 2 };                         // off-beat house stabs
    case "swing":     return { hit: sub === 6 || sub === 14 || (x > 0.5 && sub === 10), arp: 0, dur: 3 }; // jazz comping
    case "driving":   return { hit: sub % 4 === 0 || (x > 0.6 && sub % 2 === 0), arp: 0, dur: 2 };
    case "shuffle":   return { hit: sub % 4 === 0, arp: 0, dur: 3 };
    case "boombap":   return { hit: sub === 0 || (x > 0.5 && sub === 8), arp: 0, dur: 8 };   // sparse, sustained
    case "trap":      return { hit: sub === 0, arp: 0, dur: 16 };                            // long dark sustain
    case "latin":     return { hit: [0, 3, 6, 8, 11, 14].includes(sub), arp: 1, dur: 2 };    // montuno arpeggio
    case "sparse":    return { hit: false, arp: 0, dur: 16 };                                // pad: only on chord change
    default:          return { hit: sub === 0 || sub === 8 || (x > 0.5 && (sub === 4 || sub === 12)), arp: 0, dur: x > 0.5 ? 4 : 8 }; // backbeat
  }
}

// ============================================================ BASS (genre rhythm + pattern)
const _pc = (m) => ((m % 12) + 12) % 12;
function chordPcs(chord) {
  const s = [...(chord || [])].sort((a, b) => a - b);
  if (!s.length) return { root: 0, third: 0, fifth: 7 };
  return { root: _pc(s[0]), third: _pc(s[Math.min(1, s.length - 1)]), fifth: _pc(s[Math.min(2, s.length - 1)]) };
}
const approach = (toRoot) => (toRoot + 11) % 12;   // chromatic approach: a semitone below the next root

// Per-feel bass PATTERN for this 16th step. Returns { midi, dur (steps), vel } or null (no note).
// Genuinely genre-shaped: jazz WALKS in quarters, funk is syncopated octave-pops, house pumps the
// root, reggae is a sparse dub one-drop, trap is a long 808, driving is an eighth-note pedal.
// chord/nextChord are MIDI arrays of the current/next beat's chord (nextChord drives the jazz walk).
export function bassStep(feel, sub, bar, x, y, chord, nextChord) {
  const c = chordPcs(chord);
  const LO = 36, SUB = 24;                           // C2 register, or C1 for 808/dub sub-bass
  const v = (base) => Math.max(0.45, Math.min(1, base * (0.6 + 0.5 * y)));
  const n = (pc, oct, dur, vel) => ({ midi: oct + pc, dur, vel: v(vel) });
  switch (feel) {
    case "swing": {                                  // walking bass — a quarter note every beat
      if (sub % 4 !== 0) return null;
      const beat = (sub / 4) | 0, nc = chordPcs(nextChord);
      const walk = [c.root, c.third, c.fifth, approach(nc.root)];
      return n(walk[beat], LO, 4, 0.7);
    }
    case "shuffle": {
      if (sub % 4 !== 0) return null;
      return n(((sub / 4) | 0) % 2 === 0 ? c.root : c.fifth, LO, 4, 0.8);
    }
    case "driving": {                                // eighth-note (or 16th) root pedal
      const step = x > 0.6 ? 1 : 2;
      return sub % step === 0 ? n(c.root, LO, step, 0.85) : null;
    }
    case "fourfloor": {                              // pumping root on the beat + offbeat octave
      if (sub % 4 === 0) return n(c.root, LO, 2, 0.85);
      if (x > 0.5 && sub % 4 === 2) return n(c.root, LO + 12, 2, 0.55);
      return null;
    }
    case "funk": {                                   // syncopated octave-pop with ghost notes
      if (sub === 0) return n(c.root, LO, 2, 1);
      if (sub === 6) return n(c.root, LO + 12, 1, 0.7);
      if (sub === 10) return n(c.fifth, LO, 1, 0.8);
      if (sub === 14) return n(c.root, LO, 1, 0.7);
      if (x > 0.6 && sub % 2 === 1) return n(c.root, LO, 1, 0.4);   // ghosts
      return null;
    }
    case "boombap": {                                // sparse, laid-back
      if (sub === 0) return n(c.root, LO, 6, 0.9);
      if (sub === 10) return n(c.fifth, LO, 4, 0.7);                // the "and of 3"
      if (x > 0.5 && sub === 6) return n(c.root, LO, 2, 0.6);
      return null;
    }
    case "trap": {                                   // long booming 808
      if (sub === 0) return n(c.root, SUB, x > 0.5 ? 6 : 14, 0.95);
      if (x > 0.6 && sub === 10) return n(c.root, SUB, 4, 0.7);
      return null;
    }
    case "reggae": {                                 // dub one-drop — root on 1 and the 3, with space
      if (sub === 0) return n(c.root, LO, 3, 0.95);
      if (sub === 8) return n(c.root, LO, 3, 0.9);
      if (x > 0.5 && sub === 6) return n(c.fifth, LO, 1, 0.6);
      return null;
    }
    case "latin": {                                  // tumbao — root, "and of 2", "4"
      if (sub === 0) return n(c.root, LO, 2, 0.85);
      if (sub === 6) return n(c.fifth, LO, 2, 0.8);
      if (sub === 12) return n(c.root, LO, 2, 0.8);
      return null;
    }
    case "sparse": {                                 // ambient — a soft sustained root
      return sub === 0 ? n(c.root, LO, 16, 0.5) : null;
    }
    default:                                          // backbeat — root on 1 & 3, fifth on 2 & 4
      if (sub === 0 || sub === 8) return n(c.root, LO, 4, 0.85);
      if (x > 0.4 && (sub === 4 || sub === 12)) return n(c.fifth, LO, 2, 0.6);
      return null;
  }
}
