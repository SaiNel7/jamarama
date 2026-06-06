# JAMARAMA — Design System

Extracted from the 4 reference screens (CROWD/violet, HARMONY/teal, LEAD/coral phones + GROOVE/host desktop). **Neo-brutalist:** warm cream canvas, thick black outlines, hard offset shadows (no blur), heavy display type + monospace labels, one bold color per role.

## Brand
- Wordmark: **JAMARAMA** (host), **JAM·LAN** (phone status bar) — the LAN = host + phones on one WiFi.
- Every player screen is themed by its **role color** (top pill, accents, active states).

## Color tokens
```css
:root {
  /* canvas + ink */
  --cream:      #ECE4CF;   /* page background */
  --card:       #F7F1E0;   /* light cards / inactive pills */
  --ink:        #16120D;   /* borders, text, shadows (near-black) */
  --gray:       #9AA0A0;   /* inactive / muted pills */

  /* role colors */
  --harmony:    #1BA88A;   /* teal */
  --harmony-lt: #5FD0A8;   /* mint accent / playhead glow */
  --lead:       #F4533A;   /* coral */
  --crowd:      #9B7BE6;   /* violet */
  --crowd-dk:   #7C4DD0;   /* held / fill */
  --groove:     #F5B82E;   /* yellow (host / drums / BRIGHTER) */

  /* crowd mood accents */
  --darker:     #1E2A3A;   /* navy  (moon) */
  --brighter:   #F5B82E;   /* yellow (sun) */
  --heavier:    #F4533A;   /* coral (mountain) */
  --dreamier:   #ABE0C4;   /* mint  (cloud) */

  /* structure */
  --border:     3px solid var(--ink);
  --border-thick: 4px solid var(--ink);
  --shadow:     6px 6px 0 var(--ink);      /* hard, no blur */
  --shadow-sm:  4px 4px 0 var(--ink);
  --shadow-lg:  8px 8px 0 var(--ink);
  --radius:     20px;     /* cards */
  --radius-lg:  28px;
  --pill:       999px;
}
```

## Type
- **Display** (headings, buttons, big labels): a heavy grotesque — **Archivo Black / weight 900**, ALL CAPS, tight tracking. (`JAMARAMA`, `DARKER`, `NOW PLAYING`, role names.)
- **Mono** (secondary labels, readouts, hints, status): **Space Mono** — used for `KEY · A MAJ`, `JAM·LAN`, `drag between chords…`, `x.64 · y.58`, numbers.
- Load via Google Fonts: `Archivo:wght@800;900` + `Space+Mono:wght@400;700`.

## Components
- **Top status pill:** rounded pill, `--border`, `--shadow-sm`; left = colored role square chip + role name (display caps); right = `● LIVE` (role color dot). Beside it: 4 small rounded squares = players in room (filled in that player's color when present/active). Phone shows battery + `JAM·LAN`.
- **Cards / buttons:** rounded rect, `--border-thick`, `--shadow`, solid fill. Press = translate by shadow offset (shadow shrinks) for a tactile "push."
- **Big action button** (HOLD TO RAISE ENERGY): violet, with a brighter fill overlay showing hold progress; ⚡ + display caps.
- **Mood buttons:** 2×2 grid, each its accent color + icon (moon/sun/mountain/cloud) + display label.
- **Meters/bars:** rounded-rect track (`--card` + border), filled in role color, big mono % / value.
- **Pills "JUST NOW":** small rounded pills in the mood's color (recent inactive = gray).

## Per-screen layout
- **HARMONY (teal):** chord wheel — 6 diatonic nodes (I/ii/iii/IV/V/vi with letter names) on a dotted ring; active/in-progression nodes filled teal, others white+border; drawn lines = the progression; orange playhead dot retraces the stroke; node-cross flash. Big `NOW PLAYING` card (current chord letter). `CLEAR` + `↻ REDO`. Hint: "drag between chords to build your loop."
- **LEAD (coral):** `● YOUR PHRASE IS LOOPING` banner ("locks on downbeat"); `CAPTURED MOTIF` mini piano-roll; one-octave+ **keyboard** (white+black keys, pressed key coral); `OCTAVE − N +` selector; hint "tap keys to answer the call — it loops till you do."
- **CROWD (violet):** 2×2 mood grid; `⚡ HOLD TO RAISE ENERGY`; `ROOM ENERGY` bar + `×N in the crowd`; `JUST NOW` recent-mood pills.
- **GROOVE / HOST (desktop, yellow):** wordmark + `HOST` pill; `ROOM` name, `KEY`, `TEMPO BPM`; top-right player squares + **G/H/L/C** role dots ("BAR HEARTBEAT"). Left: HARMONY wheel mirror. Center: **MUSIC READOUT** piano-roll, BAR 1–4, harmony (teal) + lead (coral) notes, playhead line. Right: LEAD keyboard + RESPONSE + CAPTURED MOTIF. Bottom-left: CROWD live poll + COLLECTIVE ENERGY. Bottom-center: **GROOVE X/Y pad** (host's instrument: CHILL↔HYPE × SPARSE↔DENSE, readout `x.NN · y.NN`). Bottom-right: CROWD→THE MIX vertical faders (BRIGHT/WEIGHT/SPACE/ENERGY/TONE).

## Motion
- Bar heartbeat: role dots / player squares pulse on the downbeat.
- Re-root: node flash + a wash of the role color across the readout on the next downbeat.
- Button press: hard-shadow "push" (translate + shrink shadow).
