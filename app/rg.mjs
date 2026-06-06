import puppeteer from "puppeteer-core";
import WebSocket from "ws";
const b = await puppeteer.launch({ executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless:"new", args:["--no-sandbox","--autoplay-policy=no-user-gesture-required"] });
const host = await b.newPage(); const herr=[]; host.on("pageerror",e=>herr.push(e.message));
await host.goto("http://localhost:3006/",{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,400));
await host.click("#start"); await new Promise(r=>setTimeout(r,300));
console.log("readout rows:", await host.evaluate(()=>document.querySelectorAll("#roll .rrow").length));
console.log("row labels:", await host.evaluate(()=>[...document.querySelectorAll("#roll .rlabel")].map(r=>r.textContent).join(" ")));
// harmony phone draws a loop
const ph = await b.newPage(); await ph.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
await ph.goto("http://localhost:3006/join",{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,600));
const boxes = await ph.evaluate(()=>[...document.querySelectorAll(".hnode")].map(n=>{const r=n.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};}));
await ph.mouse.move(boxes[0].x,boxes[0].y); await ph.mouse.down();
for(const i of [1,3]){ await ph.mouse.move(boxes[i].x,boxes[i].y,{steps:6}); await new Promise(r=>setTimeout(r,30)); }
await ph.mouse.up(); await new Promise(r=>setTimeout(r,500));
// inject a lead note via raw WS (server broadcasts → host shows it)
const ws = new WebSocket("ws://localhost:3006");
await new Promise(res=>ws.on("open",res)); ws.send(JSON.stringify({type:"hello",role:"auto"}));
await new Promise(r=>setTimeout(r,200));
ws.send(JSON.stringify({type:"control",action:"note",payload:{note:"E",oct:5}}));
ws.send(JSON.stringify({type:"control",action:"note",payload:{note:"A",oct:5}}));
await new Promise(r=>setTimeout(r,600));
const r = await host.evaluate(()=>{
  const roll=document.getElementById("roll"), H=roll.clientHeight, mid=H/2;
  const h=[...document.querySelectorAll("#roll .note.h")].map(n=>parseFloat(n.style.top));
  const l=[...document.querySelectorAll("#roll .note.l")].map(n=>parseFloat(n.style.top));
  return { H, mid, hMin:Math.min(...h), hMax:Math.max(...h), lMin:Math.min(...l), lMax:Math.max(...l), hN:h.length, lN:l.length };
});
console.log("roll height:", Math.round(r.H), "mid:", Math.round(r.mid));
console.log("harmony blocks:", r.hN, "y-range:", Math.round(r.hMin),"-",Math.round(r.hMax), "(should be LOWER half, > mid)");
console.log("lead blocks:", r.lN, "y-range:", Math.round(r.lMin),"-",Math.round(r.lMax), "(should be UPPER half, < mid)");
console.log("lead above chords:", r.lMax < r.hMin, "| harmony in lower half:", r.hMin >= r.mid-1, "| lead in upper half:", r.lMax < r.mid);
console.log("errors:", herr.length?herr.join("|"):"none");
await b.close();
