// Taste prompt ingestion — translates raw player "what are you into?" text into
// the SOUNDSCAPE descriptions MRT2's texture layer responds well to.
//
// Soundscape translation, NOT genre naming: genre words make the model PLAY that
// genre (rhythmic, song-like) — even with a texture suffix bolted on, the raw
// prompt leaks performance into the bed (verified by ear via engine/sweep_blend.py).
// So claude-haiku-4-5 rewrites every prompt into the world the vibe lives in
// ("country" → wind over plains, horse whinny, rattlesnake hiss), and there is
// deliberately NO raw-prompt fallback: if the LLM is unavailable, the prompt is
// dropped from the texture blend (the bed plays the default ambient) — the
// player's vibe still reaches the instrument one-shots via voicePrompts below,
// which is where genre identity belongs.
//
// Needs ANTHROPIC_API_KEY (app/.env, loaded by npm start). Test from the shell:
//   node --env-file=.env taste.js "punk" "like rain on a sunday"

import Anthropic from "@anthropic-ai/sdk";

const LLM_MODEL = "claude-haiku-4-5";
const LLM_TIMEOUT_MS = 5000;
const LLM_SYSTEM =
  "You translate a person's music taste or vibe into a short comma-separated " +
  "description of an atmospheric SOUNDSCAPE for a music audio-embedding model. " +
  "Never name the genre and never describe songs, melodies, riffs, or anyone " +
  "playing music. Instead evoke the world that vibe lives in: ambient spaces, " +
  "environmental sounds, sustained drones and textures. Example: 'country' → " +
  "'dry wind over open plains, distant horse whinny, creaking porch wood, " +
  "rattlesnake hiss, warm dusty air'. Only sustained, non-rhythmic elements — " +
  "never drums, beats, percussion, or pulse. Output the description only.";

const hasKey = () => Boolean(process.env.ANTHROPIC_API_KEY);

const cache = new Map(); // raw prompt -> soundscape (per-process; re-readying is free)
let client = null;

async function llmTransform(prompt) {
  client ??= new Anthropic({ timeout: LLM_TIMEOUT_MS, maxRetries: 1 });
  const msg = await client.messages.create({
    model: LLM_MODEL,
    max_tokens: 200,
    system: LLM_SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  const text = msg.content.find((b) => b.type === "text")?.text.trim();
  if (!text) throw new Error("empty LLM response");
  return text;
}

// Soundscape for one prompt, or null when the LLM is unavailable (no key /
// call failed) — null means "leave this prompt out of the texture blend".
async function transformPrompt(prompt) {
  if (cache.has(prompt)) return cache.get(prompt);
  if (!hasKey()) {
    console.log("  [taste] no ANTHROPIC_API_KEY — prompt left out of the texture blend");
    return null;
  }
  try {
    const out = await llmTransform(prompt);
    cache.set(prompt, out);
    return out;
  } catch (e) {
    console.log(`  [taste] soundscape rewrite failed (${e.message}) — prompt left out of the texture blend`);
    return null;
  }
}

// Soundscapes for all player prompts. May return fewer than given (failed/keyless
// prompts are dropped); the caller falls back to the default bed when empty.
export async function transformPrompts(prompts) {
  const out = await Promise.all(prompts.map(transformPrompt));
  return out.filter(Boolean);
}

// Prompts for the MRT2 one-shot voice prebake (engine/prebake_voices.py): the
// harmony/lead Tone.Sampler timbres. Unlike state.taste these use the RAW player
// prompts — instrument one-shots should carry the genre identity ("punk" → bright/
// edgy, per the oneshot spike FINDINGS); the soundscape translation belongs only
// to the off-grid atmosphere layer.
const VOICE_DEFAULTS = {
  harmony: "warm analog synth pad, soft mellow sustained",   // prebake_voices.py defaults
  lead: "bright expressive lead synth, singing",
};
export function voicePrompts(tastes) {
  if (!tastes.length) return VOICE_DEFAULTS;
  const blend = tastes.join(", ").slice(0, 160);
  return {
    harmony: `${blend}, sustained chord pad, soft mellow`,
    lead: `${blend}, bright expressive lead, singing`,
  };
}

// --- CLI test mode ---
// `--json` emits machine-readable output (used by engine/sweep_blend.py --llm
// so offline renders test the SAME strings the live lobby produces).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const args = process.argv.slice(2);
  if (args[0] === "--json") {
    const out = [];
    for (const p of args.slice(1)) out.push({ prompt: p, llm: await transformPrompt(p) });
    console.log(JSON.stringify(out));
  } else if (args.length) {
    for (const p of args) {
      console.log(`\nprompt     : ${p}`);
      console.log(`soundscape : ${(await transformPrompt(p)) ?? "(unavailable — would be left out of the blend)"}`);
    }
    console.log();
  }
}
