// Taste prompt ingestion — turns raw player "what are you into?" text into
// style descriptions MRT2's MusicCoCa embedding responds well to (texture, not
// a full song). Two modes, A/B-testable:
//
//   append (default) — suffix each prompt with positive texture descriptors.
//     Works offline; MusicCoCa is a contrastive embedder, so we describe what
//     TO hear ("beatless ambient texture") rather than negate ("no drums",
//     which can embed NEAR drums).
//   llm — rewrite each prompt with claude-haiku-4-5. Needs ANTHROPIC_API_KEY
//     + internet; falls back to append on any failure so a hotspot demo never
//     stalls in the lobby.
//
// Select with TASTE_MODE=append|llm. Test from the shell:
//   node taste.js "punk" "like rain on a sunday"

import Anthropic from "@anthropic-ai/sdk";

const APPEND_SUFFIX = "rendered as beatless ambient texture, sustained pads, atmospheric wash";
const LLM_MODEL = "claude-haiku-4-5";
const LLM_TIMEOUT_MS = 3000;
const LLM_SYSTEM =
  "You rewrite a person's music taste or vibe into a short comma-separated " +
  "music-style description for a music audio-embedding model (genre, " +
  "instrumentation, mood, texture adjectives). Keep the genre identity " +
  "recognizable. Describe only sustained, textural, atmospheric elements — " +
  "never mention drums, beats, percussion, or rhythm. Output the description " +
  "only, nothing else.";

const mode = () => (process.env.TASTE_MODE === "llm" ? "llm" : "append");
const hasKey = () => Boolean(process.env.ANTHROPIC_API_KEY);

const cache = new Map(); // raw prompt -> transformed (per-process; re-readying is free)
let client = null;

function appendTransform(prompt) {
  return `${prompt}, ${APPEND_SUFFIX}`;
}

async function llmTransform(prompt) {
  client ??= new Anthropic({ timeout: LLM_TIMEOUT_MS, maxRetries: 0 });
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

// Transform one prompt according to TASTE_MODE, falling back llm → append.
async function transformPrompt(prompt) {
  if (cache.has(prompt)) return cache.get(prompt);
  let out;
  if (mode() === "llm" && hasKey()) {
    try {
      out = await llmTransform(prompt);
    } catch (e) {
      console.log(`  [taste] llm rewrite failed (${e.message}) — falling back to append`);
      out = appendTransform(prompt);
    }
  } else {
    if (mode() === "llm") console.log("  [taste] TASTE_MODE=llm but no ANTHROPIC_API_KEY — using append");
    out = appendTransform(prompt);
  }
  cache.set(prompt, out);
  return out;
}

// Transform all player prompts (non-empty strings) for state.taste.
export async function transformPrompts(prompts) {
  return Promise.all(prompts.map(transformPrompt));
}

// --- CLI test mode: print both transforms side by side for quick A/B ---
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const args = process.argv.slice(2);
  if (args.length) {
    for (const p of args) {
      console.log(`\nprompt : ${p}`);
      console.log(`append : ${appendTransform(p)}`);
      if (hasKey()) {
        try {
          console.log(`llm    : ${await llmTransform(p)}`);
        } catch (e) {
          console.log(`llm    : (failed: ${e.message})`);
        }
      } else {
        console.log("llm    : (skipped — set ANTHROPIC_API_KEY to test)");
      }
    }
    console.log();
  }
}
