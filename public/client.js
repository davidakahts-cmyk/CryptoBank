"use strict";

let latestPayload = null;
let configTimer = null;
let firstLoadDone = false;

const $ = (id) => document.getElementById(id);

function fmtMoney(n){
  if(!Number.isFinite(n)) return "$0";
  const a=Math.abs(n);
  if(a>=1e15)return"$"+(n/1e15).toFixed(2)+"Q";
  if(a>=1e12)return"$"+(n/1e12).toFixed(2)+"T";
  if(a>=1e9)return"$"+(n/1e9).toFixed(2)+"B";
  if(a>=1e6)return"$"+(n/1e6).toFixed(2)+"M";
  if(a>=1e3)return"$"+(n/1e3).toFixed(2)+"K";
  return"$"+n.toFixed(2);
}

function fmtNum(n){
  if(!Number.isFinite(n))return"0";
  const a=Math.abs(n);
  if(a>=1e15)return(n/1e15).toFixed(2)+"Q";
  if(a>=1e12)return(n/1e12).toFixed(2)+"T";
  if(a>=1e9)return(n/1e9).toFixed(2)+"B";
  if(a>=1e6)return(n/1e6).toFixed(2)+"M";
  if(a>=1e3)return(n/1e3).toFixed(2)+"K";
  return n.toFixed(0);
}

function setText(id, value){
  const el=$(id);
  if(el) el.textContent=value;
}

function setInputValue(id, value){
  const el=$(id);
  if(!el) return;
  if(el.type === "checkbox"){
    el.checked = !!value;
    return;
  }
  if(document.activeElement !== el){
    el.value = value;
  }
}

function money4(n){ return "$" + (Number(n)||0).toFixed(4); }

async function fetchState(){
  try{
    const res = await fetch("/api/state", { cache:"no-store" });
    if(!res.ok) throw new Error("State request failed");
    latestPayload = await res.json();
    render(latestPayload);
  }catch(err){
    setText("speedStatus", "Connection lost");
    console.error(err);
  }
}

function render(payload){
  const s = payload.state;
  const c = payload.config;
  const d = payload.derived;

  setText("day", d.day);
  setText("hourOfDay", d.hourOfDay);
  setText("year", d.year);
  setText("speedStatus", d.speedStatus);

  setText("monoPrice", "$" + s.monoPrice.toFixed(4));
  setText("divPrice", "$" + s.divPrice.toFixed(4));
  setText("treasuryUsd", fmtMoney(s.treasuryUsd));
  setText("yieldToday", fmtMoney(s.yieldToday));
  setText("treasuryMono", fmtNum(s.treasuryMono));
  setText("treasuryDiv", fmtNum(s.treasuryDiv));
  setText("circMono", fmtNum(s.circMono));
  setText("circDiv", fmtNum(s.circDiv));
  setText("monoListed", fmtNum(s.monoListed));
  setText("divListed", fmtNum(s.divListed));
  setText("monoMiddle", money4(d.monoMiddle));
  setText("divMiddle", money4(d.divMiddle));
  setText("lastDividend", fmtNum(s.lastDividendDiv || 0) + " DIV");
  setText("totalDividends", fmtNum(s.totalDividendDiv || 0) + " DIV");
  setText("dividend365Pct", (d.dividend365Pct || 0).toFixed(2) + "%");

  setText("monoListedPctTable", (Number(c.monoListPct)||0).toFixed(1)+"%");
  setText("divListedPctTable", (Number(c.divListPct)||0).toFixed(1)+"%");
  setText("monoListedTable", fmtNum(s.monoListed));
  setText("divListedTable", fmtNum(s.divListed));
  setText("monoBuyTable", money4(c.monoBuy));
  setText("monoMidTable", money4(d.monoMiddle));
  setText("monoSellTable", money4(c.monoSell));
  setText("divBuyTable", money4(c.divBuy));
  setText("divMidTable", money4(d.divMiddle));
  setText("divSellTable", money4(c.divSell));

  setInputValue("monoBuy", Number(c.monoBuy).toFixed(4));
  setInputValue("monoSell", Number(c.monoSell).toFixed(4));
  setInputValue("monoMidInput", d.monoMiddle.toFixed(4));
  setInputValue("divBuy", Number(c.divBuy).toFixed(4));
  setInputValue("divSell", Number(c.divSell).toFixed(4));
  setInputValue("divMidInput", d.divMiddle.toFixed(4));
  setInputValue("divGrowthOn", c.divGrowthOn);
  setInputValue("divGrowthPct", c.divGrowthPct);
  setInputValue("divGrowthDaily", (d.divGrowthDailyPct || 0).toFixed(5)+"% / day");
  setInputValue("divFloorBuy", Number(c.divFloorBuy).toFixed(4));
  setInputValue("divFloorSell", Number(c.divFloorSell).toFixed(4));
  setInputValue("divFloorMiddle", d.divFloorMiddle.toFixed(4));
  setInputValue("strictStaticFloorEnabled", c.strictStaticFloorEnabled);
  setInputValue("strictRisingFloorEnabled", c.strictRisingFloorEnabled);
  setInputValue("strictFloorGrowthPct", c.strictFloorGrowthPct);
  setInputValue("floorModeReadout", d.floorMode);
  setInputValue("divLoweringOn", c.divLoweringOn);
  setInputValue("divLowerThreshold", Number(c.divLowerThreshold).toFixed(4));
  setInputValue("divLowerPct", c.divLowerPct);
  setInputValue("divLowerGrowthTriggerPct", c.divLowerGrowthTriggerPct);
  setInputValue("div365GrowthReadout", (d.div365GrowthPct || 0).toFixed(2)+"%");
  setInputValue("monoListPct", c.monoListPct);
  setInputValue("divListPct", c.divListPct);
  setInputValue("dividendPct", c.dividendPct);
  setInputValue("dividendAutomationEnabled", c.dividendAutomationEnabled);
  setInputValue("autoDividendPerMono", c.autoDividendPerMono);
  setInputValue("autoDividendGoalPct", c.autoDividendGoalPct);

  const buyEl=$("divFloorBuy"), sellEl=$("divFloorSell");
  if(buyEl && sellEl){
    buyEl.readOnly = !!c.strictStaticFloorEnabled;
    sellEl.readOnly = !!c.strictStaticFloorEnabled;
  }

  renderLog(payload.logs || []);
  drawCharts(payload);
  firstLoadDone = true;
}

function renderLog(logs){
  const el=$("log");
  if(!el) return;
  if(!logs.length){
    el.innerHTML='<div class="small">No news yet.</div>';
    return;
  }
  el.innerHTML = logs.map(x => {
    const cls = x.type === "bad" ? "badText" : x.type === "warn" ? "warnText" : x.type === "good" ? "good" : "";
    return `<div class="logItem"><strong class="${cls}">${escapeHtml(x.t)}</strong><br>${escapeHtml(x.msg)}</div>`;
  }).join("");
}

function escapeHtml(value){
  return String(value).replace(/[&<>"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[ch]));
}

function collectConfig(){
  const updates = {};
  document.querySelectorAll("[data-config]").forEach(el => {
    const key = el.getAttribute("data-config");
    if(el.type === "checkbox") updates[key] = el.checked;
    else updates[key] = Number(el.value);
  });
  return updates;
}

function sendConfigDebounced(){
  if(configTimer) clearTimeout(configTimer);
  configTimer = setTimeout(sendConfigNow, 300);
}

async function sendConfigNow(){
  if(configTimer) clearTimeout(configTimer);
  configTimer = null;
  const updates = collectConfig();
  try{
    const res = await fetch("/api/config", {
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({ updates })
    });
    latestPayload = await res.json();
    render(latestPayload);
  }catch(err){ console.error(err); }
}

async function action(type, extra={}){
  try{
    const res = await fetch("/api/action", {
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({ type, ...extra })
    });
    const payload = await res.json();
    if(!res.ok) throw new Error(payload.error || "Action failed");
    latestPayload = payload;
    render(payload);
  }catch(err){
    console.error(err);
    alert(err.message || "Action failed");
  }
}

function setSpeed(mode){ action("setSpeed", { mode }); }
function pauseGame(){ action("pause"); }
function advanceHoursInstant(hours){ action("advanceHours", { hours }); }
function applyListings(){ action("applyListings"); }
function clearListings(){ action("clearListings"); }
function releaseDividend(){ action("releaseDividend"); }
function clearLog(){ action("clearLog"); }

function syncPoints(coin){
  const buyEl=$(coin+"Buy"), sellEl=$(coin+"Sell"), midEl=$(coin+"MidInput");
  if(!buyEl || !sellEl || !midEl) return;
  let buy=Math.max(0.0001, Number(buyEl.value)||0.0001);
  let sell=Math.max(0.0001, Number(sellEl.value)||0.0001);
  if(buy>sell){ sell=buy; sellEl.value=sell.toFixed(4); }
  midEl.value=((buy+sell)/2).toFixed(4);
  sendConfigDebounced();
}

function syncDivFloorV2(){
  const buyEl=$("divFloorBuy"), sellEl=$("divFloorSell"), midEl=$("divFloorMiddle");
  if(!buyEl || !sellEl || !midEl) return;
  let buy=Math.max(0.0001, Number(buyEl.value)||0.0001);
  let sell=Math.max(0.0001, Number(sellEl.value)||0.0001);
  if(buy>sell){ sell=buy; sellEl.value=sell.toFixed(4); }
  midEl.value=((buy+sell)/2).toFixed(4);
  sendConfigDebounced();
}

function updateDivGrowthReadout(){
  const el=$("divGrowthDaily");
  const pct=Number($("divGrowthPct")?.value)||0;
  if(el) el.value=((Math.pow(1+pct/100,1/365)-1)*100).toFixed(5)+"% / day";
}

function toggleStrictStaticFloorV3(){
  const staticOn = !!$("strictStaticFloorEnabled")?.checked;
  const buyEl=$("divFloorBuy"), sellEl=$("divFloorSell");
  if(buyEl && sellEl){
    buyEl.readOnly = staticOn;
    sellEl.readOnly = staticOn;
  }
  sendConfigNow();
}

function drawCharts(payload){
  if(!payload) return;
  drawChart('monoCanvas', payload.histories.mono, '#72ddff', payload.derived.monoMiddle, 'Mono');
  drawChart('divCanvas', payload.histories.div, '#dab3ff', payload.derived.divMiddle, 'DIV');
}

function drawChart(id,history,color,middle,label){
  const canvas=$(id);
  if(!canvas || !history || !history.length) return;
  const ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height,p=38;
  ctx.clearRect(0,0,w,h);
  const values=history.concat([middle]);
  let min=Math.min(...values)*.985,max=Math.max(...values)*1.015;
  if(max-min<.01){max+=.01;min-=.01}
  const span=max-min,xFor=i=>p+(w-p*2)*i/Math.max(1,history.length-1),yFor=v=>h-p-((v-min)/span)*(h-p*2);
  ctx.strokeStyle='rgba(159,176,208,.18)';ctx.lineWidth=1;ctx.beginPath();
  for(let i=0;i<5;i++){const y=p+(h-p*2)*i/4;ctx.moveTo(p,y);ctx.lineTo(w-p,y)}ctx.stroke();
  ctx.setLineDash([7,7]);ctx.strokeStyle='rgba(255,209,102,.72)';ctx.beginPath();ctx.moveTo(p,yFor(middle));ctx.lineTo(w-p,yFor(middle));ctx.stroke();ctx.setLineDash([]);
  ctx.fillStyle='rgba(255,209,102,.88)';ctx.font='12px system-ui';ctx.fillText('middle $'+middle.toFixed(4),p+6,yFor(middle)-7);
  const grad=ctx.createLinearGradient(0,p,0,h-p);grad.addColorStop(0,color);grad.addColorStop(1,'rgba(255,255,255,.7)');ctx.strokeStyle=grad;ctx.lineWidth=3;ctx.beginPath();
  history.forEach((v,i)=>{const x=xFor(i),y=yFor(v);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)});ctx.stroke();
  ctx.fillStyle='rgba(238,244,255,.75)';ctx.font='12px system-ui';ctx.fillText('$'+max.toFixed(4),8,p+4);ctx.fillText('$'+min.toFixed(4),8,h-p+4);ctx.fillText(label+' market price',p,h-12);
}

window.setSpeed=setSpeed;
window.pauseGame=pauseGame;
window.advanceHoursInstant=advanceHoursInstant;
window.applyListings=applyListings;
window.clearListings=clearListings;
window.releaseDividend=releaseDividend;
window.clearLog=clearLog;
window.syncPoints=syncPoints;
window.syncDivFloorV2=syncDivFloorV2;
window.sendConfigDebounced=sendConfigDebounced;
window.sendConfigNow=sendConfigNow;
window.updateDivGrowthReadout=updateDivGrowthReadout;
window.toggleStrictStaticFloorV3=toggleStrictStaticFloorV3;
window.action=action;

fetchState();
setInterval(fetchState, 1000);
