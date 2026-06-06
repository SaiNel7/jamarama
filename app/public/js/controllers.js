// Phone controllers — rendered based on the role the server assigns.
import { Bus, diatonic, romanToName } from "/js/shared.js";

const bus = new Bus("auto");
const screen = document.getElementById("screen");
let me = null;       // {id, role, color}
let st = null;       // latest room state

bus.on("welcome", (m) => { me = m; st = m.state; document.documentElement.style.setProperty("--role", m.color); render(); });
bus.on("state", (m) => { st = m.state; refresh(); });
bus.on("beat", (m) => { onBeat(m); });

// ---------- shared chrome ----------
function topbar(label) {
  return `
  <div class="statusbar"><span class="mono">9:41</span><span class="brand mono">JAM·LAN 🔋</span></div>
  <div class="toppill">
    <div class="chip"></div><div class="name caps">${label}</div>
    <div class="live"><span class="dot" id="livedot"></span><span class="mono">LIVE</span></div>
  </div>`;
}
function onBeat(m) {
  const dot = document.getElementById("livedot");
  if (dot) { dot.classList.add("pulse"); setTimeout(() => dot.classList.remove("pulse"), 110); }
}

// ---------- router ----------
function render() {
  if (me.role === "crowd") renderCrowd();
  else if (me.role === "harmony") renderHarmony();
  else if (me.role === "lead") renderLead();
}
function refresh() {
  if (me?.role === "crowd") refreshCrowd();
  else if (me?.role === "harmony") refreshHarmony();
}

// ========================================================= CROWD
const MOODS = [
  { k: "darker",   label: "DARKER",   icon: "🌑", bg: "var(--darker)",   fg: "#fff" },
  { k: "brighter", label: "BRIGHTER", icon: "☀️", bg: "var(--brighter)", fg: "#16120D" },
  { k: "heavier",  label: "HEAVIER",  icon: "⛰️", bg: "var(--heavier)",  fg: "#fff" },
  { k: "dreamier", label: "DREAMIER", icon: "☁️", bg: "var(--dreamier)", fg: "#16120D" },
];
function renderCrowd() {
  screen.innerHTML = topbar("CROWD") + `
  <div style="padding:18px;display:grid;grid-template-columns:1fr 1fr;gap:16px">
    ${MOODS.map((m) => `
      <button class="btn mood caps" data-mood="${m.k}"
        style="background:${m.bg};color:${m.fg};aspect-ratio:1.1;display:flex;flex-direction:column;
               justify-content:flex-end;align-items:flex-start;padding:18px;font-size:30px">
        <span style="font-size:30px;margin-bottom:auto">${m.icon}</span>${m.label}
      </button>`).join("")}
  </div>
  <button id="energy" class="btn caps" style="margin:4px 18px;background:var(--crowd);color:#fff;
     padding:26px;font-size:28px;position:relative;overflow:hidden;display:flex;gap:10px;
     align-items:center;justify-content:center">
     <span id="efill" style="position:absolute;inset:0;width:0;background:var(--crowd-dk)"></span>
     <span style="position:relative;z-index:1">⚡ HOLD TO RAISE ENERGY</span>
  </button>
  <div style="padding:26px 18px 0">
    <div class="mono caps" style="font-size:14px;color:#5a564d">ROOM ENERGY
      <span id="ccount" style="float:right;color:var(--crowd)"></span></div>
    <div class="card" style="height:46px;padding:0;margin-top:8px;border-radius:14px;overflow:hidden;display:flex">
      <div id="ebar" style="height:100%;width:0;background:var(--crowd);display:flex;align-items:center;
        justify-content:flex-end;color:#fff;padding-right:14px"><span id="epct"></span></div>
    </div>
    <div class="mono caps" style="font-size:14px;color:#5a564d;margin-top:22px">JUST NOW</div>
    <div id="recent" style="display:flex;flex-wrap:wrap;gap:10px;margin-top:10px"></div>
  </div>`;

  screen.querySelectorAll(".mood").forEach((b) =>
    b.addEventListener("click", () => bus.control("mood", { mood: b.dataset.mood })));

  const eb = document.getElementById("energy");
  let hold = null;
  const start = (e) => { e.preventDefault(); eb.classList.add("held");
    hold = setInterval(() => bus.control("energy", { delta: 0.05 }), 100); };
  const stop = () => { eb.classList.remove("held"); clearInterval(hold); };
  eb.addEventListener("touchstart", start); eb.addEventListener("mousedown", start);
  ["touchend","mouseup","mouseleave","touchcancel"].forEach((ev) => eb.addEventListener(ev, stop));
  refreshCrowd();
}
function refreshCrowd() {
  if (!st) return;
  const pct = Math.round(st.energy * 100);
  const bar = document.getElementById("ebar");
  if (bar) { bar.style.width = pct + "%"; document.getElementById("epct").textContent = pct + "%"; }
  const fill = document.getElementById("efill"); if (fill) fill.style.width = pct + "%";
  const cc = document.getElementById("ccount"); if (cc) cc.textContent = "×" + (st.crowdCount ?? 0) + " in the crowd";
  const r = document.getElementById("recent");
  if (r) r.innerHTML = (st.recentMoods || []).map((m, i) => {
    const def = MOODS.find((x) => x.k === m.mood);
    const dim = i > 1 ? "filter:grayscale(.5);opacity:.7" : "";
    return `<span class="caps" style="background:${def.bg};color:${def.fg};border:var(--border);
      box-shadow:var(--shadow-sm);border-radius:999px;padding:8px 16px;font-size:14px;${dim}">${def.label}</span>`;
  }).join("");
}

// ========================================================= HARMONY
let drawn = [];           // progression as degree romans (the host plays it back)
function renderHarmony() {
  const chords = diatonic(st.key);                 // [{roman,name}] index 0..6
  const wheel = chords.slice(0, 6);                // I..vi
  screen.innerHTML = topbar("HARMONY") + `
  <div class="mono caps" style="text-align:right;padding:0 18px;font-size:14px;color:#5a564d">KEY · ${st.key} MAJ</div>
  <div id="wheel" style="position:relative;width:330px;height:330px;margin:10px auto"></div>
  <div class="card" style="margin:8px 18px;background:var(--harmony);color:#fff;text-align:center;padding:22px">
    <div class="mono caps" style="font-size:15px;opacity:.85">NOW PLAYING</div>
    <div id="nowchord" style="font-size:88px;font-weight:900;line-height:1"></div>
  </div>
  <div style="display:flex;gap:12px;padding:6px 18px;align-items:center">
    <span class="hint" style="padding:0;flex:1">drag/tap chords to build your loop</span>
    <button id="clear" class="btn caps" style="padding:14px 22px">CLEAR</button>
  </div>`;
  const W = document.getElementById("wheel"), R = 120, C = 165;
  wheel.forEach((c, i) => {
    const a = (-90 + i * 60) * Math.PI / 180;
    const x = C + R * Math.cos(a), y = C + R * Math.sin(a);
    const n = document.createElement("button");
    n.className = "btn node caps"; n.dataset.roman = c.roman;
    n.style.cssText = `position:absolute;left:${x-46}px;top:${y-46}px;width:92px;height:92px;border-radius:50%;
      display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--card)`;
    n.innerHTML = `<span style="font-size:26px">${c.roman}</span><span class="mono" style="font-size:15px">${c.name}</span>`;
    n.addEventListener("click", () => addChord(c.roman));
    W.appendChild(n);
  });
  document.getElementById("clear").addEventListener("click", () => {
    drawn = []; bus.control("progression", { degrees: [] }); refreshHarmony();
  });
  refreshHarmony();
}
function addChord(roman) {                           // build the loop; the host plays it back on the grid
  drawn.push(roman);
  bus.control("progression", { degrees: drawn });
  refreshHarmony();
}
function refreshHarmony() {
  if (me?.role !== "harmony") return;
  const cur = st.chord;
  document.querySelectorAll(".node").forEach((n) => {
    const active = drawn.includes(n.dataset.roman);
    n.style.background = active ? "var(--harmony)" : "var(--card)";
    n.style.color = active ? "#fff" : "var(--ink)";
    n.style.outline = n.dataset.roman === cur ? "5px solid var(--brighter)" : "none";
    n.style.outlineOffset = "3px";
  });
  const nc = document.getElementById("nowchord");
  if (nc) nc.textContent = romanToName(st.key, cur).replace("m", "");
}

// ========================================================= LEAD
function renderLead() {
  const keys = ["C","C#","D","D#","E","F","F#","G","A","A#","B"];
  screen.innerHTML = topbar("LEAD") + `
  <div class="card caps" style="margin:14px 18px;background:var(--lead);color:#fff;padding:20px;
    display:flex;align-items:center;gap:12px;font-size:22px">
    <span class="dot" style="width:14px;height:14px;border-radius:50%;background:#fff"></span>YOUR PHRASE IS LOOPING
  </div>
  <div class="mono caps" style="padding:18px 18px 0;color:#5a564d">HIGH REGISTER · play to change</div>
  <div id="keys" style="display:flex;gap:6px;padding:14px 18px;height:260px"></div>
  <div class="hint">tap keys to answer the call — it loops till you do</div>`;
  const kb = document.getElementById("keys");
  ["C","D","E","F","G","A","B"].forEach((note, i) => {
    const k = document.createElement("button");
    k.className = "btn"; k.style.cssText = "flex:1;background:var(--card);display:flex;align-items:flex-end;justify-content:center;padding-bottom:14px";
    k.innerHTML = `<span style="width:12px;height:12px;border-radius:50%;background:var(--gray)"></span>`;
    k.addEventListener("pointerdown", () => { k.style.background = "var(--lead)"; tone(261.6 * Math.pow(2, i/7));
      bus.control("note", { note, oct: 5 }); setTimeout(() => k.style.background = "var(--card)", 160); });
    kb.appendChild(k);
  });
}
let actx;
function tone(f) {                                   // instant local test-tone (<20ms feedback)
  actx ||= new (window.AudioContext || window.webkitAudioContext)();
  const o = actx.createOscillator(), g = actx.createGain();
  o.frequency.value = f; o.type = "sawtooth"; g.gain.value = 0.0001;
  o.connect(g).connect(actx.destination); o.start();
  g.gain.exponentialRampToValueAtTime(0.25, actx.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.3);
  o.stop(actx.currentTime + 0.32);
}
