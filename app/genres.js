// Genre knowledge base — the heart of Jamarama's genre intelligence.
//
// Every musician's lobby prompt ("what are you into?") is matched against this
// curated table, and the matched genres are FUSED into one arrangement that drives
// FOUR independent things, each genre-specific (see app/taste.js arrangeJam):
//
//   1. texture  — the off-grid MRT2 atmosphere (engine/texture_engine.py). A
//      STRICTLY NON-RHYTHMIC soundscape: the genre's world (room/venue/crowd/air)
//      PLUS its sustained instrument colors (cymbal shimmer, muted-trumpet swell).
//   2. voices   — the four pre-baked instrument timbres (engine/prebake_voices.py).
//      Each is ONE iconic, genre-DEFINING instrument (jazz → Rhodes / muted trumpet /
//      upright bass / brushed kit) so the genre is unmistakable. Lead with the
//      instrument name; the prebake adds the "solo, single sustained note" framing.
//   3. progression — the genre's idiomatic base chord loop (the "chord tree"
//      default). Roman numerals from the host-renderable diatonic set: I ii iii IV V
//      vi vii° — rendered relative to the room KEY (shared.js chordMidi), so the same
//      genre progression transposes to whatever key the host picks.
//   4. scale    — major / minor for the lead keyboard + readout.
//
// FUSION (multiple musicians, different genres): each of the four instruments is
// assigned to whichever matched genre is most DEFINED by that instrument (affinity
// below), so the BAND becomes the fusion — jazz harmony over a funk rhythm section.

// affinity = how defining each instrument is for the genre (0..1). Drives fusion:
// for each instrument slot we pick the matched genre with the highest affinity for it.
const G = (o) => ({ scale: "major", ...o });

export const GENRES = {
  pop: G({
    keys: ["pop", "top 40", "radio", "mainstream", "katy perry", "taylor swift", "dua lipa"],
    affinity: { harmony: 0.7, lead: 0.8, bass: 0.5, drums: 0.6 },
    texture: "bright airy modern studio shimmer, sustained warm synth pad, soft polished hall reverb, distant clean vocal sigh, glossy clean air",
    voices: {
      harmony: "bright grand piano, clean pop chord",
      lead: "bright synth lead, vocal and catchy",
      bass: "round clean electric bass guitar",
      drums: "tight modern pop drum kit, crisp kick and snare",
    },
    progression: ["I", "V", "vi", "IV"],
  }),

  rock: G({
    keys: ["rock", "classic rock", "indie rock", "alt rock", "garage", "stadium"],
    affinity: { harmony: 0.6, lead: 0.85, bass: 0.6, drums: 0.7 },
    texture: "warm live-room air, sustained electric guitar drone, glowing tube-amp hum, distant arena crowd murmur, smoky stage haze",
    voices: {
      harmony: "crunchy overdriven electric guitar, ringing open chord",
      lead: "soaring overdriven electric guitar lead",
      bass: "punchy picked electric bass guitar",
      drums: "big roomy rock drum kit, hard snare backbeat",
    },
    progression: ["I", "IV", "vi", "V"],
  }),

  punk: G({
    keys: ["punk", "hardcore", "pop punk", "skate", "ramones", "thrash punk"],
    affinity: { harmony: 0.5, lead: 0.7, bass: 0.7, drums: 0.85 },
    texture: "dim basement-show air, sustained guitar feedback drone, buzzing amp hum, restless crowd murmur, fluorescent electric buzz",
    voices: {
      harmony: "buzzsaw distorted electric guitar power chord",
      lead: "fast biting distorted punk electric guitar",
      bass: "driving overdriven electric bass guitar",
      drums: "fast raw punk drum kit, slammed snare",
    },
    progression: ["I", "IV", "V", "IV"],
  }),

  metal: G({
    keys: ["metal", "heavy metal", "death metal", "djent", "doom", "metalcore", "headbang"],
    affinity: { harmony: 0.6, lead: 0.8, bass: 0.6, drums: 0.85 },
    texture: "vast dark cathedral gloom, sustained low distorted guitar drone, ominous sub-bass air, distant thunder, cold metallic resonance",
    voices: {
      harmony: "heavy palm-muted distorted electric guitar",
      lead: "shredding high-gain electric guitar lead",
      bass: "growling distorted electric bass guitar",
      drums: "aggressive metal drum kit, double-kick and cracking snare",
    },
    progression: ["vi", "V", "IV", "V"],
    scale: "minor",
  }),

  jazz: G({
    keys: ["jazz", "swing", "bebop", "smooth jazz", "miles davis", "coltrane", "big band"],
    affinity: { harmony: 0.95, lead: 0.85, bass: 0.7, drums: 0.55 },
    texture: "smoky late-night club murmur, clinking glasses, sustained upright bass drone, brushed cymbal shimmer, muted trumpet swell, warm plate reverb, intimate room tone",
    voices: {
      harmony: "Fender Rhodes electric piano, mellow jazz chord",
      lead: "muted jazz trumpet, breathy and warm",
      bass: "upright double bass, plucked and woody",
      drums: "jazz drum kit, soft brushes and ride cymbal",
    },
    progression: ["ii", "V", "I", "vi"],
  }),

  blues: G({
    keys: ["blues", "delta blues", "rhythm and blues", "bb king", "muddy waters"],
    affinity: { harmony: 0.7, lead: 0.85, bass: 0.6, drums: 0.5 },
    texture: "humid juke-joint air, sustained slide-guitar moan, warm tube-amp hum, distant murmur, creaking wooden floorboards",
    voices: {
      harmony: "warm hollow-body electric guitar, bluesy chord",
      lead: "bending crying blues electric guitar lead",
      bass: "walking electric bass guitar",
      drums: "loose shuffling blues drum kit",
    },
    progression: ["I", "IV", "I", "V"],
  }),

  funk: G({
    keys: ["funk", "funky", "p-funk", "james brown", "groove", "parliament"],
    affinity: { harmony: 0.7, lead: 0.6, bass: 0.95, drums: 0.9 },
    texture: "warm vintage studio room, sustained clavinet and Rhodes haze, analog tape warmth, distant horn-section swell, funky air",
    voices: {
      harmony: "funky clavinet, percussive stab",
      lead: "wah-wah funk electric guitar lead",
      bass: "slap electric bass guitar, popping",
      drums: "tight funk drum kit, crisp snappy snare",
    },
    progression: ["I", "I", "IV", "I"],
  }),

  soul: G({
    keys: ["soul", "r&b", "rnb", "motown", "neo soul", "marvin gaye", "aretha"],
    affinity: { harmony: 0.8, lead: 0.75, bass: 0.7, drums: 0.6 },
    texture: "warm vintage soul-studio room, sustained Hammond organ drone, lush string swell, analog tape warmth, distant choir sigh",
    voices: {
      harmony: "warm Hammond organ, soulful chord",
      lead: "smooth soul saxophone, expressive",
      bass: "round Motown electric bass guitar",
      drums: "vintage soul drum kit, tight backbeat",
    },
    progression: ["I", "vi", "ii", "V"],
  }),

  hiphop: G({
    keys: ["hip hop", "hip-hop", "hiphop", "rap", "boom bap", "old school", "lofi hip hop", "j dilla"],
    affinity: { harmony: 0.7, lead: 0.5, bass: 0.85, drums: 0.9 },
    texture: "late-night city street ambience, distant traffic hum, warm vinyl crackle, sustained Rhodes haze, subway rumble",
    voices: {
      harmony: "dusty Rhodes electric piano, jazzy chord",
      lead: "warm muted-trumpet sample, laid-back",
      bass: "deep round 808 sub bass",
      drums: "boom-bap drum kit, fat kick and crunchy snare",
    },
    progression: ["vi", "IV", "I", "V"],
    scale: "minor",
  }),

  trap: G({
    keys: ["trap", "drill", "808", "atlanta", "mumble", "phonk"],
    affinity: { harmony: 0.6, lead: 0.6, bass: 0.9, drums: 0.9 },
    texture: "dark cavernous night air, sustained ominous synth drone, deep sub hum, distant city at night, cold hazy reverb",
    voices: {
      harmony: "dark synth bells, ominous minor chord",
      lead: "bright plucked trap synth lead",
      bass: "booming 808 sub bass, long and dark",
      drums: "trap drum kit, booming 808 kick and rolling hi-hats",
    },
    progression: ["vi", "IV", "V", "vi"],
    scale: "minor",
  }),

  house: G({
    keys: ["house", "deep house", "tech house", "edm", "electronic", "rave", "dj", "club"],
    affinity: { harmony: 0.7, lead: 0.7, bass: 0.85, drums: 0.85 },
    texture: "cavernous warehouse air, distant crowd hum, sustained warm analog synth drone, deep sub hum, hazy fog-machine reverb",
    voices: {
      harmony: "filtered analog synth house chord stab",
      lead: "plucky analog synth lead, hypnotic",
      bass: "deep round analog synth bass",
      drums: "house drum kit, thumping four-on-the-floor kick and clap",
    },
    progression: ["vi", "IV", "I", "V"],
    scale: "minor",
  }),

  techno: G({
    keys: ["techno", "minimal", "industrial techno", "berlin", "acid"],
    affinity: { harmony: 0.6, lead: 0.65, bass: 0.85, drums: 0.9 },
    texture: "vast concrete warehouse gloom, sustained dark drone, deep machine hum, distant rumble, cold misty reverb",
    voices: {
      harmony: "dark cold analog synth stab",
      lead: "acid 303 synth lead, resonant",
      bass: "deep rolling analog synth bass",
      drums: "hard techno drum kit, pounding kick and metallic clap",
    },
    progression: ["vi", "IV", "vi", "V"],
    scale: "minor",
  }),

  trance: G({
    keys: ["trance", "uplifting", "progressive house", "festival edm", "big room"],
    affinity: { harmony: 0.75, lead: 0.85, bass: 0.7, drums: 0.8 },
    texture: "vast euphoric open-air night, distant festival crowd hum, sustained soaring supersaw drone, shimmering reverb wash, bright sky air",
    voices: {
      harmony: "lush supersaw synth chord",
      lead: "soaring euphoric trance synth lead",
      bass: "rolling driving synth bass",
      drums: "festival trance drum kit, big kick and bright snare",
    },
    progression: ["vi", "IV", "I", "V"],
  }),

  synthwave: G({
    keys: ["synthwave", "retrowave", "outrun", "vaporwave", "80s", "eighties", "darksynth"],
    affinity: { harmony: 0.8, lead: 0.8, bass: 0.7, drums: 0.7 },
    texture: "neon-lit night highway air, sustained analog pad drone, retro tape shimmer, distant engine hum, purple haze",
    voices: {
      harmony: "warm analog synth pad, nostalgic 80s chord",
      lead: "bright retro analog synth lead",
      bass: "pulsing analog synth bass",
      drums: "80s drum machine, gated-reverb snare and punchy kick",
    },
    progression: ["vi", "IV", "I", "V"],
    scale: "minor",
  }),

  ambient: G({
    keys: ["ambient", "drone", "atmospheric", "soundscape", "meditation", "brian eno", "space"],
    affinity: { harmony: 0.9, lead: 0.6, bass: 0.5, drums: 0.3 },
    texture: "vast still open air, sustained glassy synth pad drone, shimmering reverb wash, distant wind, deep slow swell, weightless space",
    voices: {
      harmony: "soft glassy synth pad, ethereal chord",
      lead: "pure breathy synth pad lead, floating",
      bass: "deep soft sine sub bass",
      drums: "soft ambient mallet percussion, sparse",
    },
    progression: ["I", "iii", "vi", "IV"],
  }),

  lofi: G({
    keys: ["lofi", "lo-fi", "lo fi", "chillhop", "study beats", "bedroom", "chill"],
    affinity: { harmony: 0.85, lead: 0.6, bass: 0.7, drums: 0.7 },
    texture: "soft rainy-window patter, warm vinyl crackle, sustained mellow Rhodes haze, muffled cozy room tone, faint tape hiss",
    voices: {
      harmony: "mellow Rhodes electric piano, soft jazzy chord",
      lead: "warm muted-trumpet sample, wistful",
      bass: "warm round upright bass",
      drums: "dusty lofi drum kit, soft kick and snare",
    },
    progression: ["ii", "V", "I", "vi"],
  }),

  classical: G({
    keys: ["classical", "orchestral", "cinematic", "soundtrack", "symphony", "baroque", "piano", "film score", "epic"],
    affinity: { harmony: 0.85, lead: 0.8, bass: 0.6, drums: 0.3 },
    texture: "grand concert-hall air, distant audience hush, sustained warm string-section swell, soft wooden resonance, deep hall reverb",
    voices: {
      harmony: "grand concert piano, rich classical chord",
      lead: "expressive solo violin, legato",
      bass: "deep orchestral cello, bowed",
      drums: "orchestral timpani and cymbal swell",
    },
    progression: ["I", "V", "vi", "iii"],
  }),

  country: G({
    keys: ["country", "folk", "americana", "bluegrass", "western", "acoustic", "singer songwriter"],
    affinity: { harmony: 0.7, lead: 0.8, bass: 0.6, drums: 0.5 },
    texture: "dry wind over open plains, creaking porch wood, distant cicadas, sustained pedal-steel swell, warm dusty afternoon air",
    voices: {
      harmony: "strummed steel-string acoustic guitar",
      lead: "crying pedal-steel guitar lead",
      bass: "warm acoustic upright bass",
      drums: "soft brushed country drum kit",
    },
    progression: ["I", "IV", "V", "I"],
  }),

  reggae: G({
    keys: ["reggae", "ska", "dub", "dancehall", "rocksteady", "bob marley", "island"],
    affinity: { harmony: 0.8, lead: 0.6, bass: 0.85, drums: 0.7 },
    texture: "warm seaside air, distant lapping surf, sustained organ drone, deep dub plate reverb, rustling palm leaves, mellow haze",
    voices: {
      harmony: "reggae organ, warm skank chord",
      lead: "sweet breathy melodica lead",
      bass: "deep round dub bass guitar",
      drums: "reggae one-drop drum kit, deep rim snare",
    },
    progression: ["I", "IV", "I", "V"],
  }),

  latin: G({
    keys: ["latin", "salsa", "samba", "bossa", "bossa nova", "mambo", "afro cuban", "tango", "cumbia"],
    affinity: { harmony: 0.85, lead: 0.75, bass: 0.7, drums: 0.7 },
    texture: "warm tropical plaza evening, distant festive murmur, sustained nylon-guitar shimmer, soft brass swell, balmy night air, gentle hall reverb",
    voices: {
      harmony: "warm nylon-string guitar, latin jazz chord",
      lead: "bright salsa trumpet lead",
      bass: "syncopated upright bass, plucked",
      drums: "latin percussion, congas and shaker",
    },
    progression: ["ii", "V", "I", "vi"],
  }),

  gospel: G({
    keys: ["gospel", "choir", "spiritual", "praise", "church"],
    affinity: { harmony: 0.9, lead: 0.7, bass: 0.6, drums: 0.6 },
    texture: "grand church-hall air, distant congregation hum, sustained Hammond organ drone, warm wooden resonance, soft choir sigh, deep hall reverb",
    voices: {
      harmony: "Hammond organ, full soaring gospel chord",
      lead: "bright gospel organ lead",
      bass: "round full gospel electric bass guitar",
      drums: "gospel drum kit, big backbeat snare",
    },
    progression: ["I", "iii", "IV", "V"],
  }),

  disco: G({
    keys: ["disco", "boogie", "funk disco", "studio 54", "nu disco"],
    affinity: { harmony: 0.75, lead: 0.7, bass: 0.85, drums: 0.8 },
    texture: "shimmering mirror-ball haze, warm crowd hum, sustained lush string swell, velvet hall reverb, sparkling night air",
    voices: {
      harmony: "clean funky disco electric guitar chord",
      lead: "lush sweeping string-section lead",
      bass: "bouncing round disco electric bass guitar",
      drums: "disco drum kit, four-on-the-floor kick and open hi-hat",
    },
    progression: ["vi", "ii", "V", "I"],
  }),
};

// vibe/mood words that aren't genres but shade the result. They (a) override the
// scale (minor for dark/sad), and (b) supply a fallback genre when nothing else
// matched, so "something chill" still lands somewhere sensible.
const MOODS = [
  { keys: ["sad", "melancholy", "melancholic", "somber", "dark", "moody", "gloomy", "lonely", "cry"], scale: "minor", genre: "ambient" },
  { keys: ["dreamy", "ethereal", "floaty", "hazy", "nostalgic"], genre: "synthwave" },
  { keys: ["chill", "relaxed", "calm", "mellow", "cozy", "sleepy", "study"], genre: "lofi" },
  { keys: ["hype", "energetic", "party", "dance", "pumped", "wild", "banger"], genre: "house" },
  { keys: ["happy", "upbeat", "sunny", "bright", "joyful", "feel good"], scale: "major", genre: "pop" },
  { keys: ["epic", "cinematic", "dramatic", "grand"], genre: "classical" },
];

// genre → drum FEEL (the base groove; see brain/groove.js). In a fusion the feel comes from the
// most drum-defining matched genre, so jazz+funk grooves like funk under jazz harmony.
const FEEL = {
  pop: "backbeat", rock: "backbeat", country: "backbeat",
  punk: "driving", metal: "driving",
  jazz: "swing", blues: "shuffle",
  funk: "funk", soul: "funk", gospel: "funk",
  hiphop: "boombap", lofi: "boombap", trap: "trap",
  house: "fourfloor", techno: "fourfloor", trance: "fourfloor", disco: "fourfloor", synthwave: "fourfloor",
  reggae: "reggae", latin: "latin",
  ambient: "sparse", classical: "sparse",
};

// genre → typical TEMPO (BPM). The room's tempo defaults to this (from the groove-defining genre)
// unless the host sets one. Key defaults to C (major) / A (minor) — see fuseGenres.
const TEMPO = {
  pop: 120, rock: 128, punk: 172, metal: 140,
  jazz: 120, blues: 100, funk: 108, soul: 96, gospel: 100,
  hiphop: 90, lofi: 82, trap: 140,
  house: 124, techno: 130, trance: 138, disco: 120, synthwave: 110,
  reggae: 75, latin: 102, ambient: 78, classical: 90, country: 110,
};

// genre → chord QUALITIES (parallel to `progression`), as picker quality ids (maj/min/7/maj7/m7…).
// This is what makes a jazz default actually read as ii-m7 / V7 / I-maj7 / vi-m7 instead of bare
// triads. Genres without an entry use the diatonic triad of each degree. The harmony phone seeds
// these onto the wheel + loop (controllers.js); playing them sends the real extended-chord MIDI.
const QUALS = {
  jazz:   ["m7", "7", "maj7", "m7"],     // ii-V-I-vi → Dm7 G7 Cmaj7 Am7
  lofi:   ["m7", "7", "maj7", "m7"],     // ii-V-I-vi
  latin:  ["m7", "7", "maj7", "m7"],     // ii-V-I-vi (latin jazz)
  blues:  ["7", "7", "7", "7"],          // I-IV-I-V dominant 7ths
  funk:   ["7", "7", "7", "7"],          // dominant-7 funk vamp
  soul:   ["maj7", "m7", "m7", "7"],     // I-vi-ii-V
  gospel: ["maj7", "m7", "maj7", "7"],   // I-iii-IV-V
  disco:  ["m7", "m7", "7", "maj7"],     // vi-ii-V-I
  hiphop: ["m7", "maj7", "maj7", "7"],   // vi-IV-I-V (jazzy boom-bap)
};

const INSTRUMENTS = ["harmony", "lead", "bass", "drums"];

function norm(s) {
  return ` ${String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ")} `;
}

// Match raw taste strings → ordered list of genre keys (first match wins ordering;
// dedup). Longer keyword matches win so "pop punk" picks punk over pop. Mood words
// only contribute a fallback genre + a scale override (see matchScale).
export function matchGenres(rawTastes) {
  const hay = rawTastes.map(norm);
  const hits = []; // {genre, rank, len}
  for (const [genre, def] of Object.entries(GENRES)) {
    for (const kw of def.keys) {
      const needle = ` ${kw} `;
      for (let h = 0; h < hay.length; h++) {
        const pos = hay[h].indexOf(needle);
        if (pos >= 0) { hits.push({ genre, rank: h * 1000 + pos, len: kw.length }); break; }
      }
    }
  }
  const best = new Map();
  for (const h of hits) {
    const cur = best.get(h.genre);
    if (!cur || h.len > cur.len) best.set(h.genre, h);
  }
  const ordered = [...best.values()].sort((a, b) => a.rank - b.rank).map((h) => h.genre);
  if (ordered.length) return ordered;
  for (const m of MOODS) {
    if (m.keys.some((kw) => hay.some((h) => h.includes(` ${kw} `)))) return [m.genre];
  }
  return [];
}

// Scale override from mood words (e.g. "dark", "sad" → minor), else null.
function matchScale(rawTastes) {
  const hay = rawTastes.map(norm);
  for (const m of MOODS) {
    if (m.scale && m.keys.some((kw) => hay.some((h) => h.includes(` ${kw} `)))) return m.scale;
  }
  return null;
}

// Fuse matched genres into one arrangement. The four instrument voices are each
// assigned to the matched genre most DEFINED by that instrument (affinity), so a
// jazz+funk room gives jazz harmony/lead over a funk bass/drums — real fusion.
// The texture layers every matched genre's world. Progression + scale come from the
// most harmony-defining matched genre.
export function fuseGenres(genreKeys, scaleOverride = null) {
  const defs = genreKeys.map((k) => GENRES[k]).filter(Boolean);
  if (!defs.length) return null;

  const voices = {};
  for (const inst of INSTRUMENTS) {
    let pick = defs[0];
    for (const d of defs) if (d.affinity[inst] > pick.affinity[inst]) pick = d;
    voices[inst] = pick.voices[inst];
  }
  const texture = [...new Set(defs.map((d) => d.texture))].slice(0, 3);
  // progression + chord qualities come from the most HARMONY-defining matched genre; groove/tempo
  // from the most DRUM-defining one.
  let leaderKey = genreKeys[0], drumKey = genreKeys[0];
  for (const k of genreKeys) {
    if (GENRES[k] && GENRES[k].affinity.harmony > GENRES[leaderKey].affinity.harmony) leaderKey = k;
    if (GENRES[k] && GENRES[k].affinity.drums > GENRES[drumKey].affinity.drums) drumKey = k;
  }
  const leader = GENRES[leaderKey];

  const scale = scaleOverride || leader.scale;
  return {
    genres: genreKeys,
    texture,
    voices,
    progression: leader.progression,
    progQuals: QUALS[leaderKey] || null,     // extended-chord qualities for the genre (else triads)
    scale,
    feel: FEEL[drumKey] || "backbeat",
    tempo: TEMPO[drumKey] || 120,            // groove-defining genre sets the room tempo
    key: scale === "minor" ? "A" : "C",      // sensible tonic for the scale (host can override)
  };
}

// One-shot: raw taste strings → fused arrangement, or null if nothing matched.
export function arrangeFromGenres(rawTastes) {
  const tastes = (rawTastes || []).filter((t) => t && t.trim());
  if (!tastes.length) return null;
  const keys = matchGenres(tastes);
  if (!keys.length) return null;
  return fuseGenres(keys, matchScale(tastes));
}
