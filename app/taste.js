// Jam arranger — turns the musicians' lobby prompts ("what are you into?") into one genre-fused
// arrangement that drives FOUR instrument voices + an atmospheric texture, plus the base chord
// progression / drum feel / scale.
//
// TWO brains, best of both:
//   • EXPERT CLAUDE AGENT (expertArrange, claude-opus-4-8) — when ANTHROPIC_API_KEY is set, a
//     world-class sound-designer/prompt-engineer that knows genres, instrumentation, synthesis AND
//     how Magenta RealTime 2 / MusicCoCa actually respond. It authors the per-instrument MRT2
//     prompts (engine/prebake_voices.py) and the beatless texture (engine/texture_engine.py),
//     tuned for the maximal, most realistic, most genre-true result.
//   • DETERMINISTIC GENRE KB (genres.js) — the structural backbone (chord progression, drum feel,
//     scale) AND the offline fallback (works with no API key; instant; expert-curated).
//
// Set ANTHROPIC_API_KEY in app/.env to enable the expert agent. Test from the shell:
//   node --env-file=.env app/taste.js "jazz" "funk"     # expert per-instrument prompts, printed
//   node app/taste.js "jazz" "funk"                      # deterministic KB (no key needed)

import Anthropic from "@anthropic-ai/sdk";
import { arrangeFromGenres } from "./genres.js";

// claude-opus-4-8: the most capable model — this is the part that most determines how good the jam
// sounds, so it runs on the top tier. One cached call per unique taste-set; the jam-start bake is
// gated by a loading screen, so its latency is hidden.
const EXPERT_MODEL = "claude-opus-4-8";
const EXPERT_TIMEOUT_MS = 15000;

// The expert. This system prompt is the product — it encodes deep, exploitable knowledge of how
// MRT2/MusicCoCa turn text into sound, so every prompt it writes lands as close as possible to a
// real, genre-defining instrument.
const EXPERT_SYSTEM = `You are the sound designer and prompt engineer for Jamarama, a live multiplayer jam. You are a world-class expert in three domains at once:
  (1) MUSIC — genres, their defining instruments, playing techniques, eras, and tone.
  (2) SOUND DESIGN & SYNTHESIS — how real and electronic instruments are voiced, mic'd, and produced.
  (3) MAGENTA REALTIME 2 (MRT2) and its MusicCoCa text→style embedder — the model you write prompts FOR.

Given the musicians' stated tastes, write the single best text prompt for each of FOUR solo instrument voices plus an atmospheric texture, so MRT2 renders them maximally realistic and unmistakably genre-true.

HOW MRT2 / MusicCoCa ACTUALLY WORKS — exploit every point:
• MusicCoCa is a CONTRASTIVE text↔audio embedder trained on a huge corpus of REAL recordings. Your words land in the same space as real instrument timbres: the closer your phrasing is to how a real recording of that exact instrument would be captioned, the closer the embedding lands to the real thing. Write like a record-label tag or a sample-library description, not like prose.
• POSITIVE-ONLY. Never write "no X", "without X", "not Y" — negation embeds NEAR the negated thing (saying "no drums" pulls drums in). Describe only what SHOULD be heard.
• Each voice is rendered SOLO: ONE instrument, alone, holding a sustained note at high style-commitment (cfg_musiccoca≈5) and a light note constraint, with its ATTACK preserved, then sliced into a sampler one-shot. Therefore:
   – Name exactly ONE iconic, genre-DEFINING instrument per voice. Never blend two instruments in one prompt. Lead with the instrument's proper name (e.g. "Fender Rhodes electric piano", "Moog analog bass synth", "muted jazz trumpet", "808 sub bass").
   – Add the DEFINING timbre + the playing TECHNIQUE that gives that instrument its identity, especially in the attack (a Rhodes' bell tine, a trumpet's breathy bloom, an upright bass's woody pluck, a Strat's spanky pick, a Moog's resonant filter sweep).
   – Add real-recording cues — close-mic, studio/room, warm, expressive, rich full harmonics, the player's touch — to pull toward a real performance and away from a sterile synth tone.
   – Keep each voice ~4–9 words of dense, evocative tag-like description. No sentences, no tempo/rhythm words, no key/chord words.
   – Do NOT call an electronic instrument "acoustic". A Moog, an 808, a supersaw must read as their own real electronic selves; only acoustic instruments get acoustic/recorded-in-a-room language.
• The four voices have distinct musical ROLES — pick the most genre-defining instrument for each:
   – harmony: the chordal/comping instrument (Rhodes, grand piano, Hammond organ, clean or crunchy electric guitar, nylon guitar, lush pad, supersaw).
   – lead: the singing melodic voice (muted/open trumpet, saxophone, overdriven or clean lead guitar, analog synth lead, violin, melodica).
   – bass: the low end (upright double bass, fingered/picked/slap electric bass, 808 sub, Moog/analog synth bass).
   – drums: describe the KIT and its FEEL — this prompt drives MRT2's drum track, so name the kit and its character (brushed jazz kit, punchy rock kit, 808 trap kit with crisp hats, boom-bap kit, four-on-the-floor house kit, one-drop reggae kit). Feel words are fine here; never a tempo/BPM.
• TEXTURE is a separate OFF-GRID atmospheric bed that plays UNDER the band. It must be STRICTLY NON-RHYTHMIC: evoke the genre's WORLD (its rooms, venues, crowds, weather, air, space) PLUS sustained instrument colors (cymbal shimmer, organ drone, muted-horn swell, string-pad wash, vinyl warmth). Absolutely no drums, beats, pulse, groove, or rhythm words. Provide 1–3 comma-separated soundscapes.

GENRE EXPERTISE:
• Choose the instruments a top producer of that genre would actually track, with era-correct tone. Jazz → Fender Rhodes / muted trumpet / upright bass / brushed kit. House → filtered analog synth stab / plucky synth / deep sub / four-on-the-floor kit. Metal → palm-muted high-gain guitar / shredding lead / growling bass / double-kick kit. Lofi → dusty Rhodes / warm muted trumpet / upright bass / soft dusty kit.
• FUSION (multiple tastes): blend like a real crossover band — give each instrument to whichever genre defines it best (jazz harmony + lead over a funk bass + drums = jazz-funk), so the band is a genuine, tasteful fusion rather than a mush.
• For a vibe/feeling rather than a named genre, infer the instrumentation, era, and world that best embodies it.

Make every prompt count — this is the difference between a generic synth patch and an instrument that sounds alive, real, and exactly like the genre. Return ONLY via the set_arrangement tool.`;

const ARRANGE_TOOL = {
  name: "set_arrangement",
  description: "Provide the MRT2 prompts for the four solo instrument voices and the atmospheric texture bed.",
  input_schema: {
    type: "object",
    properties: {
      harmony: { type: "string", description: "Solo chordal/comping instrument — one iconic genre-defining instrument with its defining timbre + technique." },
      lead: { type: "string", description: "Solo melodic lead instrument — one iconic genre-defining instrument." },
      bass: { type: "string", description: "Solo bass instrument — one iconic genre-defining low-end instrument." },
      drums: { type: "string", description: "The drum KIT and its feel for this genre (no tempo)." },
      texture: {
        type: "array", items: { type: "string" },
        description: "1-3 strictly non-rhythmic soundscapes: the genre's world + sustained instrument colors. No beats/drums/rhythm words.",
      },
    },
    required: ["harmony", "lead", "bass", "drums", "texture"],
  },
};

const hasKey = () => Boolean(process.env.ANTHROPIC_API_KEY);
const cache = new Map();   // sorted taste-set -> arrangement (server hits this for texture + prebake)
let client = null;

// Generic per-instrument fallback when no genre matched AND no expert available (raw vibe words
// still color the timbre — MRT2 reads "punk" as bright/edgy).
const VOICE_DEFAULTS = {
  harmony: "warm electric piano, soft sustained chord",
  lead: "expressive synth lead, singing",
  bass: "deep round electric bass guitar",
  drums: "clean acoustic drum kit, tight kick and snare",
};
function genericVoices(tastes) {
  if (!tastes.length) return { ...VOICE_DEFAULTS };
  const blend = tastes.join(", ").slice(0, 100);
  return {
    harmony: `${blend}, warm sustained chord instrument`,
    lead: `${blend}, expressive melodic lead`,
    bass: `${blend}, deep round bass`,
    drums: `${blend}, drum kit, tight and clean`,
  };
}

// The expert agent: raw tastes -> { voices:{harmony,lead,bass,drums}, texture:[...] }, or null on
// failure (caller falls back to the deterministic KB). Forced tool use guarantees structured output.
async function expertArrange(tastes) {
  if (!hasKey()) return null;
  try {
    client ??= new Anthropic({ timeout: EXPERT_TIMEOUT_MS, maxRetries: 1 });
    const msg = await client.messages.create({
      model: EXPERT_MODEL,
      max_tokens: 1024,
      system: EXPERT_SYSTEM,
      tools: [ARRANGE_TOOL],
      tool_choice: { type: "tool", name: "set_arrangement" },
      messages: [{ role: "user", content:
        `The musicians are into: ${tastes.map((t) => `"${t}"`).join(", ")}. Design the band — pick the most genre-defining instrument for each voice and write the maximal MRT2 prompt for each.` }],
    });
    const a = msg.content.find((b) => b.type === "tool_use")?.input;
    const ok = a && ["harmony", "lead", "bass", "drums"].every((k) => typeof a[k] === "string" && a[k].trim());
    if (!ok) return null;
    const texture = Array.isArray(a.texture) ? a.texture.filter((t) => typeof t === "string" && t.trim()).slice(0, 3) : [];
    return {
      voices: { harmony: a.harmony.trim(), lead: a.lead.trim(), bass: a.bass.trim(), drums: a.drums.trim() },
      texture,
    };
  } catch (e) {
    console.log(`  [taste] expert arrange failed (${e.message}) — using the genre knowledge base`);
    return null;
  }
}

// THE arranger. Returns { genres, texture:[string], voices:{harmony,lead,bass,drums},
// progression:[roman]|null, scale:string|null, feel:string|null }. The expert authors voices +
// texture when a key is present; the deterministic KB supplies the structure (progression/feel/
// scale) and the full fallback.
export async function arrangeJam(rawTastes) {
  const tastes = (rawTastes || []).map((t) => String(t || "").trim()).filter(Boolean);
  const ckey = [...tastes].sort().join(" || ");
  if (cache.has(ckey)) return cache.get(ckey);

  const genre = arrangeFromGenres(tastes);          // deterministic: progression/feel/scale + fallback voices/texture
  const expert = tastes.length ? await expertArrange(tastes) : null;

  let voices, texture, source;
  if (expert) {
    voices = expert.voices;
    texture = expert.texture.length ? expert.texture : (genre?.texture || []);
    source = "expert";
  } else if (genre) {
    voices = genre.voices; texture = genre.texture; source = "genre-kb";
  } else {
    voices = genericVoices(tastes); texture = []; source = "generic";
  }

  const result = {
    genres: genre?.genres || [],
    voices, texture,
    progression: genre?.progression || null,
    progQuals: genre?.progQuals || null,     // per-chord qualities (jazz 7ths etc.) for the seed
    scale: genre?.scale || null,
    feel: genre?.feel || null,
    tempo: genre?.tempo || null,             // genre default tempo (blank if no genre)
    key: genre?.key || null,                 // genre default tonic (blank if no genre)
    source,
  };
  cache.set(ckey, result);
  console.log(`  [taste] arrange ${JSON.stringify(tastes)} via ${source} → genres=${JSON.stringify(result.genres)} `
    + `feel=${result.feel} prog=${JSON.stringify(result.progression)}`);
  return result;
}

// --- CLI test mode --- node app/taste.js "jazz" "funk"   (add --json for raw)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const args = process.argv.slice(2);
  if (args[0] === "--json") {
    console.log(JSON.stringify(await arrangeJam(args.slice(1))));
  } else if (args.length) {
    const a = await arrangeJam(args);
    console.log("\nprompts    :", JSON.stringify(args));
    console.log("source     :", a.source, "(expert = Claude agent; genre-kb/generic = offline)");
    console.log("genres     :", JSON.stringify(a.genres));
    console.log("scale      :", a.scale, "| feel:", a.feel, "| progression:", JSON.stringify(a.progression));
    console.log("texture    :");
    a.texture.forEach((t) => console.log("   •", t));
    console.log("voices     :");
    for (const [k, v] of Object.entries(a.voices)) console.log(`   ${k.padEnd(8)}: ${v}`);
    console.log();
  }
}
