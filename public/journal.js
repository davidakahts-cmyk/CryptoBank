"use strict";

const $ = (id) => document.getElementById(id);

function setText(id, value){
  const el = $(id);
  if(el) el.textContent = value;
}

function escapeHtml(value){
  return String(value).replace(/[&<>"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[ch]));
}

async function fetchJournal(){
  try{
    const res = await fetch("/api/journal?limit=1000", { cache:"no-store" });
    if(!res.ok) throw new Error("Journal request failed");
    const payload = await res.json();
    renderJournal(payload);
  }catch(err){
    const el = $("journalConsole");
    if(el) el.innerHTML = `<div class="small">Could not load journal: ${escapeHtml(err.message)}</div>`;
    console.error(err);
  }
}

function renderJournal(payload){
  const d = payload.derived || {};
  setText("day", d.day ?? 0);
  setText("hourOfDay", d.hourOfDay ?? 0);
  setText("year", d.year ?? 0);
  setText("speedStatus", d.speedStatus || "");
  setText("journalCount", payload.count || 0);

  const el = $("journalConsole");
  const items = payload.items || [];
  if(!el) return;
  if(!items.length){
    el.innerHTML = '<div class="small">No journal entries yet.</div>';
    return;
  }

  el.innerHTML = items.map(item => {
    const cls = item.color === "peer" ? "jPeer" : item.color === "bought" ? "jBought" : item.color === "sold" ? "jSold" : "jWhite";
    const time = `D${item.day} H${item.hourOfDay}`;
    return `<div class="journalLine ${cls}"><div class="jTime">${escapeHtml(time)}</div><div class="jText">- ${escapeHtml(item.text)}</div><div class="jValue">${escapeHtml(item.value)}</div></div>`;
  }).join("");
}

async function clearJournal(){
  try{
    const res = await fetch("/api/action", {
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({ type:"clearJournal" })
    });
    if(!res.ok) throw new Error("Clear failed");
    await fetchJournal();
  }catch(err){
    alert(err.message || "Clear failed");
  }
}

window.fetchJournal = fetchJournal;
window.clearJournal = clearJournal;

fetchJournal();
setInterval(fetchJournal, 1500);
