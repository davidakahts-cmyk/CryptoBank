"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = process.env.STATE_FILE || path.join(DATA_DIR, "mono-div-state.json");

const TRILLION = 1_000_000_000_000;
const INITIAL_TREASURY_COINS = 100 * TRILLION;
const HOURS_PER_YEAR = 24 * 365;
const MAX_HISTORY = 520;
const MAX_LOG_ITEMS = 500;
const MAX_JOURNAL_ITEMS = 10_000;

const SPEEDS = {
  "60s_hour": { label: "60 seconds = 1 hour", intervalMs: 60_000, tickHours: 1 },
  "10s_hour": { label: "10 seconds = 1 hour", intervalMs: 10_000, tickHours: 1 },
  "1s_hour": { label: "1 second = 1 hour", intervalMs: 1_000, tickHours: 1 },
  "1s_day": { label: "1 second = 1 day", intervalMs: 125, tickHours: 3 },
  "1s_week": { label: "1 second = 1 week", intervalMs: 285.714, tickHours: 48 },
  "1s_month": { label: "1 second = 1 month", intervalMs: 233.333, tickHours: 168 },
  "1s_year": { label: "1 second = 1 year", intervalMs: 164.384, tickHours: 1460 }
};

const DEFAULT_CONFIG = {
  monoBuy: 0.99,
  monoSell: 1.01,
  divBuy: 0.99,
  divSell: 1.01,

  divGrowthOn: true,
  divGrowthPct: 10,

  divLoweringOn: true,
  divLowerThreshold: 2.00,
  divLowerPct: 10,
  divLowerGrowthTriggerPct: 20,

  monoListPct: 70,
  divListPct: 70,

  dividendPct: 4,

  divFloorBuy: 0.90,
  divFloorSell: 1.00,

  dividendAutomationEnabled: false,
  autoDividendPerMono: 0.001,
  autoDividendGoalPct: 4.10,

  strictStaticFloorEnabled: false,
  strictRisingFloorEnabled: false,
  strictFloorGrowthPct: 0.00
};

let s;
let config;
let monoHistory;
let divHistory;
let logItems;
let journalItems;
let divPriceSnapshotsV2;
let dividendEventsV2;
let topPointWasTriggeredV2;
let growthTriggerWasTriggeredV2;
let strictFloorLockedV3;
let lastAutoDividendLogDayV3;
let currentMode = "60s_hour";
let timer = null;
let saveTimer = null;
let dirty = false;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function round4(n) {
  return Math.round((Number(n) || 0) * 10_000) / 10_000;
}

function asBool(v) {
  return v === true || v === "true" || v === 1 || v === "1" || v === "on";
}

function makeInitialState() {
  return {
    hour: 0,
    treasuryUsd: 1_000_000,
    treasuryMono: INITIAL_TREASURY_COINS,
    treasuryDiv: INITIAL_TREASURY_COINS,
    circMono: 300_000,
    circDiv: 300_000,
    monoPrice: 1,
    divPrice: 1,
    monoListed: 0,
    divListed: 0,
    yieldToday: 0,
    totalDividendDiv: 0,
    lastDividendDiv: 0,
    floorMinV3: null
  };
}

function resetAll() {
  s = makeInitialState();
  config = { ...DEFAULT_CONFIG };
  monoHistory = Array.from({ length: 90 }, () => s.monoPrice);
  divHistory = Array.from({ length: 90 }, () => s.divPrice);
  logItems = [];
  journalItems = [];
  divPriceSnapshotsV2 = [{ hour: s.hour, price: s.divPrice }];
  dividendEventsV2 = [];
  topPointWasTriggeredV2 = false;
  growthTriggerWasTriggeredV2 = false;
  strictFloorLockedV3 = null;
  lastAutoDividendLogDayV3 = -1;
  syncAllPoints();
  applyListings(false);
  addLog("Game started: 100T Mono and 100T DIV in treasury, $300k of each coin circulating, and $1M treasury USD.", "good");
  markDirty();
}

function day() {
  return Math.floor(s.hour / 24);
}

function hourOfDay() {
  return Math.floor(s.hour % 24);
}

function year() {
  return Math.floor(day() / 365);
}

function timeLabel() {
  return `Day ${day()}, Hour ${hourOfDay()}`;
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return "0";
  const a = Math.abs(n);
  if (a >= 1e15) return (n / 1e15).toFixed(2) + "Q";
  if (a >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(0);
}

function fmtWhole(n) {
  if (!Number.isFinite(n)) return "0";
  return Math.round(n).toLocaleString("en-US").replace(/,/g, "");
}

function fmtMoneyText(n) {
  if (!Number.isFinite(n)) return "$ 0";
  return `$ ${fmtWhole(n)}`;
}

function fmtJournalNumber(n) {
  if (!Number.isFinite(n)) return "0.00000";
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);

  if (a > 0 && a < 0.00001) return sign + a.toExponential(5).replace("e+", "e");
  if (a < 10) return sign + a.toFixed(5);
  if (a < 100) return sign + a.toFixed(4);
  if (a < 1_000) return sign + a.toFixed(3);
  if (a < 10_000) return sign + a.toFixed(2);
  if (a < 100_000) return sign + a.toFixed(1);
  if (a < 1_000_000) return sign + a.toFixed(0) + ".";

  const exp = Math.floor(Math.log10(a));
  const mantissa = a / Math.pow(10, exp);
  return `${sign}${mantissa.toFixed(4)}e${exp}`;
}

function getPoint(coin, side) {
  const key = coin + (side === "buy" ? "Buy" : "Sell");
  return Math.max(0.0001, Number(config[key]) || 0.0001);
}

function getMiddle(coin) {
  return (getPoint(coin, "buy") + getPoint(coin, "sell")) / 2;
}

function setMiddlePreserveSpread(coin, newMiddle) {
  const buyKey = coin + "Buy";
  const sellKey = coin + "Sell";
  let buy = Math.max(0.0001, Number(config[buyKey]) || 0.0001);
  let sell = Math.max(buy, Number(config[sellKey]) || buy);
  const oldMiddle = (buy + sell) / 2;
  const delta = newMiddle - oldMiddle;
  buy = Math.max(0.0001, buy + delta);
  sell = Math.max(buy, sell + delta);
  config[buyKey] = round4(buy);
  config[sellKey] = round4(sell);
  syncPoint(coin);
}

function syncPoint(coin) {
  const buyKey = coin + "Buy";
  const sellKey = coin + "Sell";
  let buy = Math.max(0.0001, Number(config[buyKey]) || 0.0001);
  let sell = Math.max(0.0001, Number(config[sellKey]) || 0.0001);
  if (buy > sell) sell = buy;
  config[buyKey] = round4(buy);
  config[sellKey] = round4(sell);
}

function syncDivFloorV2() {
  let buy = Math.max(0.0001, Number(config.divFloorBuy) || 0.0001);
  let sell = Math.max(0.0001, Number(config.divFloorSell) || 0.0001);
  if (buy > sell) sell = buy;
  config.divFloorBuy = round4(buy);
  config.divFloorSell = round4(sell);
}

function syncAllPoints() {
  syncPoint("mono");
  syncPoint("div");
  syncDivFloorV2();
}

function divFloorBuyV2() {
  return Math.max(0.0001, Number(config.divFloorBuy) || 0.90);
}

function divFloorSellV2() {
  return Math.max(divFloorBuyV2(), Number(config.divFloorSell) || 1.00);
}

function divFloorMiddleV2() {
  return (divFloorBuyV2() + divFloorSellV2()) / 2;
}

function divTopPointV2() {
  return Math.max(divFloorSellV2() + 0.0001, Number(config.divLowerThreshold) || 2);
}

function divBandMidPointV2() {
  return (divTopPointV2() + divFloorMiddleV2()) / 2;
}

function getFloorValuesV3() {
  return { buy: divFloorBuyV2(), sell: divFloorSellV2(), mid: divFloorMiddleV2() };
}

function setFloorValuesV3(buy, sell) {
  buy = Math.max(0.0001, buy);
  sell = Math.max(buy, sell);
  config.divFloorBuy = round4(buy);
  config.divFloorSell = round4(sell);
  syncDivFloorV2();
}

function shiftDivBandByPointV2(delta) {
  const beforeFloor = getFloorValuesV3();

  let newFloorBuy = Math.max(0.0001, divFloorBuyV2() + delta);
  let newFloorSell = Math.max(newFloorBuy, divFloorSellV2() + delta);
  let newTop = Math.max(newFloorSell + 0.0001, divTopPointV2() + delta);
  let newDivBuy = Math.max(0.0001, getPoint("div", "buy") + delta);
  let newDivSell = Math.max(newDivBuy, getPoint("div", "sell") + delta);

  config.divFloorBuy = round4(newFloorBuy);
  config.divFloorSell = round4(newFloorSell);
  config.divLowerThreshold = round4(newTop);
  config.divBuy = round4(newDivBuy);
  config.divSell = round4(newDivSell);
  syncAllPoints();

  if (config.strictStaticFloorEnabled && strictFloorLockedV3) {
    setFloorValuesV3(strictFloorLockedV3.buy, strictFloorLockedV3.sell);
  }

  if (config.strictRisingFloorEnabled) {
    const after = getFloorValuesV3();
    setFloorValuesV3(
      Math.max(after.buy, beforeFloor.buy, s.floorMinV3?.buy || 0),
      Math.max(after.sell, beforeFloor.sell, s.floorMinV3?.sell || 0)
    );
    const finalFloor = getFloorValuesV3();
    s.floorMinV3 = {
      buy: Math.max(s.floorMinV3?.buy || 0, finalFloor.buy),
      sell: Math.max(s.floorMinV3?.sell || 0, finalFloor.sell),
      mid: Math.max(s.floorMinV3?.mid || 0, finalFloor.mid)
    };
  }
}

function addLog(msg, type = "") {
  logItems.unshift({ id: crypto.randomUUID(), t: timeLabel(), hour: s.hour, msg, type });
  if (logItems.length > MAX_LOG_ITEMS) logItems.length = MAX_LOG_ITEMS;
  markDirty();
}

function addJournal(entry) {
  const normalized = {
    id: crypto.randomUUID(),
    hour: s.hour,
    day: day(),
    hourOfDay: hourOfDay(),
    year: year(),
    ...entry
  };
  journalItems.unshift(normalized);
  if (journalItems.length > MAX_JOURNAL_ITEMS) journalItems.length = MAX_JOURNAL_ITEMS;
  markDirty();
}

function journalTrade({ source, coin, action, amount, usd, price }) {
  const properCoin = coin === "mono" ? "Mono" : "Div";
  const sourceLabel = source === "treasury" ? "Treasury" : "Peer";
  const code = source === "treasury"
    ? (coin === "mono" ? "TM$" : "TD$")
    : (coin === "mono" ? "PM$" : "PD$");
  const text = `[${sourceLabel}] ${fmtWhole(amount)} ${properCoin} ${action} for ${fmtMoneyText(usd)}`;
  const color = source === "peer" ? "peer" : action === "bought" ? "bought" : "sold";
  addJournal({
    source: sourceLabel,
    asset: properCoin,
    kind: action,
    code,
    price,
    value: `${code} ${fmtJournalNumber(price)}`,
    text,
    color
  });
}

function journalDividend({ paid, circMono, divPerMono }) {
  addJournal({
    source: "Treasury",
    asset: "Div",
    kind: "dividend",
    code: "TDi",
    price: divPerMono,
    value: `TDi ${fmtJournalNumber(divPerMono)}`,
    text: `[Treasury] ${fmtWhole(paid)} Div given to ${fmtWhole(circMono)} mono (all in circulation)`,
    color: "white"
  });
}

function journalInterest({ earned, rate }) {
  addJournal({
    source: "Treasury",
    asset: "USD",
    kind: "interest",
    code: "TIn",
    price: rate,
    value: `TIn ${fmtJournalNumber(rate)}`,
    text: `[Treasury] ${fmtMoneyText(earned)} in interest received for treasury`,
    color: "white"
  });
}

function randomNormal() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function applyTreasuryYield(hours) {
  const before = s.treasuryUsd;
  const rate = Math.pow(1.03, hours / HOURS_PER_YEAR) - 1;
  const yieldEarned = before * rate;
  s.treasuryUsd += yieldEarned;
  s.yieldToday += yieldEarned;
  if (hourOfDay() === 0) s.yieldToday = yieldEarned;

  if (yieldEarned > 0) {
    journalInterest({ earned: yieldEarned, rate });
  }
}

function applyDivMiddleGrowth(hours) {
  if (!config.divGrowthOn) return;
  const annualPct = Math.max(0, Number(config.divGrowthPct) || 0);
  if (annualPct <= 0) return;

  const oldBandMid = divBandMidPointV2();
  const rate = Math.pow(1 + annualPct / 100, hours / HOURS_PER_YEAR) - 1;
  const newBandMid = oldBandMid * (1 + rate);
  const delta = newBandMid - oldBandMid;
  shiftDivBandByPointV2(delta);
}

function marketStep(hours, coin) {
  const mid = getMiddle(coin);
  const priceKey = coin === "mono" ? "monoPrice" : "divPrice";
  const vol = coin === "mono" ? 0.0012 : 0.012;
  const pull = Math.min(0.30, 0.035 * (hours / 24));
  const noise = randomNormal() * vol * Math.sqrt(Math.max(0.05, hours / 24));
  let price = s[priceKey];

  price = price + (mid - price) * pull;
  price = price * (1 + noise);

  if (coin === "div") {
    const reserve = s.treasuryUsd / Math.max(1, (s.circMono * s.monoPrice + s.circDiv * s.divPrice));
    const push = clamp((reserve - 1) * 0.0008 * (hours / 24), -0.01, 0.02);
    price *= 1 + push;
  }

  s[priceKey] = Math.max(0.0001, price);

  if (coin === "div") {
    matchDivMiddleToMarketInMidZoneV2();
  }
}

function matchDivMiddleToMarketInMidZoneV2() {
  const floor = divFloorMiddleV2();
  const top = divTopPointV2();
  if (s.divPrice > floor && s.divPrice < top) {
    setMiddlePreserveSpread("div", s.divPrice);
  }
}

function processTreasuryDesk(hours, coin) {
  if (coin === "div") {
    processDivTreasuryDesk(hours);
    return;
  }

  const buy = getPoint("mono", "buy");
  const sell = getPoint("mono", "sell");
  let marketPrice = s.monoPrice;

  if (marketPrice >= sell && s.monoListed > 0 && s.treasuryMono > 0) {
    const excess = Math.max(0, marketPrice / sell - 1);
    const demand = Math.max(100, s.circMono * excess * 0.35 + s.monoListed * Math.min(0.035, excess * 0.20)) * (hours / 24);
    const sold = Math.min(s.monoListed, s.treasuryMono, demand);
    if (sold > 0) {
      const usd = sold * sell;
      s.monoListed -= sold;
      s.treasuryMono -= sold;
      s.circMono += sold;
      s.treasuryUsd += usd;
      s.monoPrice *= Math.max(0.90, 1 - Math.min(0.08, excess * 0.18));
      journalTrade({ source: "treasury", coin: "mono", action: "sold", amount: sold, usd, price: sell });
      if (sold > 1000) addLog(`Treasury sold ${fmtNum(sold)} MONO at the selling point of $${sell.toFixed(4)}.`, "good");
    }
  }

  marketPrice = s.monoPrice;

  if (marketPrice <= buy && s.circMono > 0 && s.treasuryUsd > buy) {
    const weakness = Math.max(0, buy / Math.max(0.0001, marketPrice) - 1);
    const desiredBuy = Math.max(50, s.circMono * weakness * 0.40) * (hours / 24);
    const affordable = s.treasuryUsd / buy;
    const bought = Math.min(s.circMono, affordable, desiredBuy);
    if (bought > 0) {
      const usd = bought * buy;
      s.circMono -= bought;
      s.treasuryMono += bought;
      s.treasuryUsd -= usd;
      s.monoPrice *= 1 + Math.min(0.08, weakness * 0.25);
      journalTrade({ source: "treasury", coin: "mono", action: "bought", amount: bought, usd, price: buy });
      if (bought > 1000) addLog(`Treasury bought back ${fmtNum(bought)} MONO at the buying point of $${buy.toFixed(4)}.`, "warn");
    }
  }
}

function processDivTreasuryDesk(hours) {
  const useFloor = s.divPrice <= divFloorSellV2();
  const buy = useFloor ? divFloorBuyV2() : getPoint("div", "buy");
  const sell = useFloor ? divFloorSellV2() : getPoint("div", "sell");

  let marketPrice = s.divPrice;

  if (marketPrice >= sell && s.divListed > 0 && s.treasuryDiv > 0) {
    const excess = Math.max(0, marketPrice / sell - 1);
    const demand = Math.max(100, s.circDiv * excess * 0.35 + s.divListed * Math.min(0.035, excess * 0.20)) * (hours / 24);
    const sold = Math.min(s.divListed, s.treasuryDiv, demand);

    if (sold > 0) {
      const usd = sold * sell;
      s.divListed -= sold;
      s.treasuryDiv -= sold;
      s.circDiv += sold;
      s.treasuryUsd += usd;
      s.divPrice *= Math.max(0.90, 1 - Math.min(0.08, excess * 0.18));
      journalTrade({ source: "treasury", coin: "div", action: "sold", amount: sold, usd, price: sell });
      if (sold > 1000) addLog(`Treasury sold ${fmtNum(sold)} DIV at ${useFloor ? "floor" : "mid-zone"} selling point $${sell.toFixed(4)}.`, "good");
    }
  }

  marketPrice = s.divPrice;

  if (marketPrice <= buy && s.circDiv > 0 && s.treasuryUsd > buy) {
    const weakness = Math.max(0, buy / Math.max(0.0001, marketPrice) - 1);
    const desiredBuy = Math.max(50, s.circDiv * weakness * 0.40) * (hours / 24);
    const affordable = s.treasuryUsd / buy;
    const bought = Math.min(s.circDiv, affordable, desiredBuy);

    if (bought > 0) {
      const usd = bought * buy;
      s.circDiv -= bought;
      s.treasuryDiv += bought;
      s.treasuryUsd -= usd;
      s.divPrice *= 1 + Math.min(0.08, weakness * 0.25);
      journalTrade({ source: "treasury", coin: "div", action: "bought", amount: bought, usd, price: buy });
      if (bought > 1000) addLog(`Treasury bought back ${fmtNum(bought)} DIV at ${useFloor ? "floor" : "mid-zone"} buying point $${buy.toFixed(4)}.`, "warn");
    }
  }
}

function processPeerTrades(hours) {
  processPeerTradeForCoin(hours, "mono");
  processPeerTradeForCoin(hours, "div");
}

function processPeerTradeForCoin(hours, coin) {
  const priceKey = coin === "mono" ? "monoPrice" : "divPrice";
  const circKey = coin === "mono" ? "circMono" : "circDiv";
  const baseChance = coin === "mono" ? 0.18 : 0.24;
  const chance = clamp(baseChance * Math.sqrt(Math.max(0.02, hours / 24)), 0.015, 0.70);

  if (Math.random() > chance) return;

  const volatility = coin === "mono" ? 0.0025 : 0.018;
  const tradePrice = Math.max(0.0001, s[priceKey] * (1 + randomNormal() * volatility));
  const volumePct = (coin === "mono" ? 0.0015 : 0.0035) * (0.35 + Math.random() * 1.65) * Math.sqrt(Math.max(0.05, hours / 24));
  const amount = Math.max(1, Math.min(s[circKey] * 0.08, s[circKey] * volumePct));
  const usd = amount * tradePrice;
  const direction = Math.random() < 0.5 ? -1 : 1;
  const impact = clamp((amount / Math.max(1, s[circKey])) * (coin === "mono" ? 0.015 : 0.045), 0, 0.018);
  s[priceKey] = Math.max(0.0001, s[priceKey] * (1 + direction * impact));

  journalTrade({ source: "peer", coin, action: "sold", amount, usd, price: tradePrice });
}

function trailingDivGrowth365V2() {
  const cutoff = s.hour - HOURS_PER_YEAR;
  if (cutoff < 0) return 0;

  let old = divPriceSnapshotsV2[0];
  for (const snap of divPriceSnapshotsV2) {
    if (snap.hour <= cutoff) old = snap;
    else break;
  }

  if (!old || old.price <= 0) return 0;
  return (s.divPrice / old.price) - 1;
}

function lowerDivBandV2(reason) {
  const lowerPct = clamp(Number(config.divLowerPct) || 0, 0, 99);
  const oldBandMid = divBandMidPointV2();
  const newBandMid = oldBandMid * (1 - lowerPct / 100);
  const delta = newBandMid - oldBandMid;

  shiftDivBandByPointV2(delta);
  addLog(`${reason}: DIV midpoint band lowered by ${lowerPct.toFixed(1)}%. Band midpoint moved from $${oldBandMid.toFixed(4)} to $${newBandMid.toFixed(4)}.`, "warn");
}

function processDivLoweringRule() {
  const enabled = config.divLoweringOn;
  if (!enabled) {
    topPointWasTriggeredV2 = s.divPrice >= divTopPointV2();
    growthTriggerWasTriggeredV2 = trailingDivGrowth365V2() >= ((Number(config.divLowerGrowthTriggerPct) || 20) / 100);
    return;
  }

  const top = divTopPointV2();
  const growthTrigger = (Number(config.divLowerGrowthTriggerPct) || 20) / 100;
  const growth365 = trailingDivGrowth365V2();

  if (s.divPrice >= top && !topPointWasTriggeredV2) {
    lowerDivBandV2(`Top-point triggered because DIV market price crossed $${top.toFixed(4)}`);
    topPointWasTriggeredV2 = true;
  }

  if (s.divPrice < top) topPointWasTriggeredV2 = false;

  if (growth365 >= growthTrigger && !growthTriggerWasTriggeredV2) {
    lowerDivBandV2(`Top-point growth trigger fired because DIV market price rose ${(growth365 * 100).toFixed(2)}% over 365 days`);
    growthTriggerWasTriggeredV2 = true;
  }

  if (growth365 < growthTrigger * 0.85) growthTriggerWasTriggeredV2 = false;
}

function pruneDividendEventsV2() {
  const cutoff = s.hour - HOURS_PER_YEAR;
  dividendEventsV2 = dividendEventsV2.filter(x => x.hour >= cutoff);
}

function dividendPct365V2() {
  pruneDividendEventsV2();
  return dividendEventsV2.reduce((a, x) => a + (x.pct || 0), 0);
}

function releaseDividendAmountPerMonoV3(divPerMono, source, options = {}) {
  divPerMono = Math.max(0, Number(divPerMono) || 0);
  if (divPerMono <= 0 || s.circMono <= 0) return 0;

  const circMonoAtPayment = s.circMono;
  const desired = circMonoAtPayment * divPerMono;
  const paid = Math.min(desired, s.treasuryDiv);
  if (paid <= 0) return 0;

  s.treasuryDiv -= paid;
  s.circDiv += paid;
  s.lastDividendDiv = paid;
  s.totalDividendDiv += paid;

  const pct = divPerMono * 100;
  dividendEventsV2.push({ hour: s.hour, pct, divPaid: paid, divPerMono });
  pruneDividendEventsV2();

  s.divPrice *= Math.max(0.92, 1 - Math.min(0.04, paid / Math.max(1, s.circDiv) * 0.20));
  journalDividend({ paid, circMono: circMonoAtPayment, divPerMono });

  if (!options.silent) {
    addLog(`${source || "Dividend"} released: ${fmtNum(paid)} DIV total, equal to ${divPerMono.toFixed(6)} DIV per 1 Mono (${pct.toFixed(4)}%).`, "good");
  }

  markDirty();
  return paid;
}

function processDividendAutomationV3() {
  if (!config.dividendAutomationEnabled) return;

  const goalPct = Math.max(0, Number(config.autoDividendGoalPct) || 0);
  const perMono = Math.max(0, Number(config.autoDividendPerMono) || 0);
  if (goalPct <= 0 || perMono <= 0) return;

  const currentPct = dividendPct365V2();
  if (currentPct >= goalPct) return;

  const remainingPct = Math.max(0, goalPct - currentPct);
  const payoutPerMono = Math.min(perMono, remainingPct / 100);
  const paid = releaseDividendAmountPerMonoV3(payoutPerMono, "Dividend automation", { silent: true });

  if (paid > 0) {
    const d = day();
    if (d !== lastAutoDividendLogDayV3) {
      lastAutoDividendLogDayV3 = d;
      addLog(`Dividend automation active: paid ${fmtNum(paid)} DIV today toward the ${goalPct.toFixed(2)}% 365-day goal.`, "good");
    }
  } else if (s.treasuryDiv <= 0) {
    addLog("Dividend automation could not pay because treasury DIV is empty.", "bad");
  }
}

function enforceFloorRulesV3() {
  if (config.strictStaticFloorEnabled && strictFloorLockedV3) {
    setFloorValuesV3(strictFloorLockedV3.buy, strictFloorLockedV3.sell);
  }

  if (config.strictRisingFloorEnabled) {
    if (!s.floorMinV3) s.floorMinV3 = getFloorValuesV3();
    const current = getFloorValuesV3();
    const buy = Math.max(current.buy, s.floorMinV3.buy);
    const sell = Math.max(current.sell, s.floorMinV3.sell);
    setFloorValuesV3(buy, sell);
    const after = getFloorValuesV3();
    s.floorMinV3 = {
      buy: Math.max(s.floorMinV3.buy, after.buy),
      sell: Math.max(s.floorMinV3.sell, after.sell),
      mid: Math.max(s.floorMinV3.mid, after.mid)
    };
  } else {
    s.floorMinV3 = null;
  }
}

function applyStrictFloorGrowthV3(hours) {
  if (!config.strictRisingFloorEnabled || config.strictStaticFloorEnabled) return;

  const annualPct = Math.max(0, Number(config.strictFloorGrowthPct) || 0);
  if (annualPct <= 0) return;

  const rate = Math.pow(1 + annualPct / 100, hours / HOURS_PER_YEAR) - 1;
  const floor = getFloorValuesV3();
  const oldMid = floor.mid;
  const newMid = oldMid * (1 + rate);
  const delta = newMid - oldMid;

  setFloorValuesV3(floor.buy + delta, floor.sell + delta);
  const updated = getFloorValuesV3();
  s.floorMinV3 = {
    buy: Math.max(s.floorMinV3?.buy || 0, updated.buy),
    sell: Math.max(s.floorMinV3?.sell || 0, updated.sell),
    mid: Math.max(s.floorMinV3?.mid || 0, updated.mid)
  };
}

function processTick(hours) {
  s.hour += hours;
  applyStrictFloorGrowthV3(hours);
  applyTreasuryYield(hours);
  applyDivMiddleGrowth(hours);
  marketStep(hours, "mono");
  marketStep(hours, "div");
  processPeerTrades(hours);
  processTreasuryDesk(hours, "mono");
  processTreasuryDesk(hours, "div");
  processDivLoweringRule();
  enforceFloorRulesV3();
  processDividendAutomationV3();

  monoHistory.push(s.monoPrice);
  divHistory.push(s.divPrice);
  if (monoHistory.length > MAX_HISTORY) monoHistory.shift();
  if (divHistory.length > MAX_HISTORY) divHistory.shift();

  divPriceSnapshotsV2.push({ hour: s.hour, price: s.divPrice });
  const cutoff = s.hour - HOURS_PER_YEAR * 1.2;
  divPriceSnapshotsV2 = divPriceSnapshotsV2.filter(x => x.hour >= cutoff);

  markDirty();
}

function tick(hours) {
  try {
    processTick(hours);
  } catch (error) {
    console.error("Tick failed:", error);
  }
}

function applyListings(shouldLog = true) {
  const monoPct = clamp(Number(config.monoListPct) || 0, 0, 100);
  const divPct = clamp(Number(config.divListPct) || 0, 0, 100);
  config.monoListPct = monoPct;
  config.divListPct = divPct;
  s.monoListed = s.treasuryMono * monoPct / 100;
  s.divListed = s.treasuryDiv * divPct / 100;
  if (shouldLog) addLog(`Public listings set: ${monoPct.toFixed(1)}% of treasury Mono and ${divPct.toFixed(1)}% of treasury DIV made available.`, "warn");
  markDirty();
}

function clearListings() {
  config.monoListPct = 0;
  config.divListPct = 0;
  s.monoListed = 0;
  s.divListed = 0;
  addLog("Public listings cleared. No treasury coins are currently listed.", "warn");
  markDirty();
}

function setSpeed(mode, shouldLog = true) {
  if (!SPEEDS[mode]) mode = "60s_hour";
  currentMode = mode;
  if (timer) clearInterval(timer);
  const speed = SPEEDS[mode];
  timer = setInterval(() => tick(speed.tickHours), speed.intervalMs);
  if (shouldLog) addLog("Speed changed to " + speed.label + ".", "warn");
  markDirty();
}

function pauseGame() {
  if (timer) clearInterval(timer);
  timer = null;
  addLog("Simulation paused.", "warn");
  markDirty();
}

function advanceHoursInstant(hours) {
  let remaining = Math.max(0, Number(hours) || 0);
  while (remaining > 0) {
    const chunk = Math.min(remaining, 24);
    processTick(chunk);
    remaining -= chunk;
  }
  addLog("Instantly advanced " + fmtDuration(hours) + ".", "warn");
  markDirty();
}

function fmtDuration(hours) {
  if (hours === 24) return "1 day";
  if (hours === 168) return "1 week";
  if (hours === 720) return "1 month";
  if (hours === 8760) return "1 year";
  return hours + " hours";
}

function speedStatus() {
  return timer ? SPEEDS[currentMode].label : "Paused";
}

function updateConfig(updates = {}) {
  const numberKeys = new Set([
    "monoBuy", "monoSell", "divBuy", "divSell", "divGrowthPct", "divLowerThreshold", "divLowerPct",
    "divLowerGrowthTriggerPct", "monoListPct", "divListPct", "dividendPct", "divFloorBuy", "divFloorSell",
    "autoDividendPerMono", "autoDividendGoalPct", "strictFloorGrowthPct"
  ]);
  const boolKeys = new Set([
    "divGrowthOn", "divLoweringOn", "dividendAutomationEnabled", "strictStaticFloorEnabled", "strictRisingFloorEnabled"
  ]);

  const oldStatic = config.strictStaticFloorEnabled;
  const oldRising = config.strictRisingFloorEnabled;

  for (const [key, value] of Object.entries(updates)) {
    if (!(key in DEFAULT_CONFIG)) continue;
    if (numberKeys.has(key)) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) config[key] = parsed;
    } else if (boolKeys.has(key)) {
      config[key] = asBool(value);
    }
  }

  config.divLowerPct = clamp(Number(config.divLowerPct) || 0, 0, 99);
  config.monoListPct = clamp(Number(config.monoListPct) || 0, 0, 100);
  config.divListPct = clamp(Number(config.divListPct) || 0, 0, 100);
  syncAllPoints();

  if (!oldStatic && config.strictStaticFloorEnabled) {
    strictFloorLockedV3 = getFloorValuesV3();
    addLog(`Strict static floor enabled at buying $${strictFloorLockedV3.buy.toFixed(4)} and selling $${strictFloorLockedV3.sell.toFixed(4)}.`, "warn");
  }

  if (oldStatic && !config.strictStaticFloorEnabled) {
    strictFloorLockedV3 = null;
    addLog("Strict static floor disabled. Floor points can be edited again.", "warn");
  }

  if (!oldRising && config.strictRisingFloorEnabled) {
    s.floorMinV3 = getFloorValuesV3();
  }

  markDirty();
}

function dailyDivGrowthPct() {
  const annualPct = Math.max(0, Number(config.divGrowthPct) || 0);
  return (Math.pow(1 + annualPct / 100, 1 / 365) - 1) * 100;
}

function publicState() {
  return {
    state: s,
    config,
    derived: {
      day: day(),
      hourOfDay: hourOfDay(),
      year: year(),
      monoMiddle: getMiddle("mono"),
      divMiddle: getMiddle("div"),
      divFloorMiddle: divFloorMiddleV2(),
      div365GrowthPct: trailingDivGrowth365V2() * 100,
      dividend365Pct: dividendPct365V2(),
      divGrowthDailyPct: dailyDivGrowthPct(),
      speedStatus: speedStatus(),
      currentMode,
      floorMode: config.strictStaticFloorEnabled ? "Strict static floor" : config.strictRisingFloorEnabled ? "Strict rising floor" : "Flexible floor"
    },
    histories: {
      mono: monoHistory,
      div: divHistory
    },
    logs: logItems.slice(0, 250)
  };
}

function loadSavedState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return false;
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const saved = JSON.parse(raw);
    s = { ...makeInitialState(), ...(saved.state || {}) };
    config = { ...DEFAULT_CONFIG, ...(saved.config || {}) };
    monoHistory = Array.isArray(saved.monoHistory) ? saved.monoHistory.slice(-MAX_HISTORY) : Array.from({ length: 90 }, () => s.monoPrice);
    divHistory = Array.isArray(saved.divHistory) ? saved.divHistory.slice(-MAX_HISTORY) : Array.from({ length: 90 }, () => s.divPrice);
    logItems = Array.isArray(saved.logItems) ? saved.logItems.slice(0, MAX_LOG_ITEMS) : [];
    journalItems = Array.isArray(saved.journalItems) ? saved.journalItems.slice(0, MAX_JOURNAL_ITEMS) : [];
    divPriceSnapshotsV2 = Array.isArray(saved.divPriceSnapshotsV2) ? saved.divPriceSnapshotsV2 : [{ hour: s.hour, price: s.divPrice }];
    dividendEventsV2 = Array.isArray(saved.dividendEventsV2) ? saved.dividendEventsV2 : [];
    topPointWasTriggeredV2 = !!saved.topPointWasTriggeredV2;
    growthTriggerWasTriggeredV2 = !!saved.growthTriggerWasTriggeredV2;
    strictFloorLockedV3 = saved.strictFloorLockedV3 || null;
    lastAutoDividendLogDayV3 = Number.isFinite(saved.lastAutoDividendLogDayV3) ? saved.lastAutoDividendLogDayV3 : -1;
    currentMode = saved.currentMode && SPEEDS[saved.currentMode] ? saved.currentMode : "60s_hour";
    syncAllPoints();
    return true;
  } catch (error) {
    console.error("Failed to load saved state:", error);
    return false;
  }
}

function markDirty() {
  dirty = true;
}

function saveStateNow() {
  if (!dirty) return;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const payload = {
      savedAt: new Date().toISOString(),
      state: s,
      config,
      monoHistory,
      divHistory,
      logItems,
      journalItems,
      divPriceSnapshotsV2,
      dividendEventsV2,
      topPointWasTriggeredV2,
      growthTriggerWasTriggeredV2,
      strictFloorLockedV3,
      lastAutoDividendLogDayV3,
      currentMode
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(payload));
    dirty = false;
  } catch (error) {
    console.error("Failed to save state:", error.message);
  }
}

function startSaveLoop() {
  if (saveTimer) clearInterval(saveTimer);
  saveTimer = setInterval(saveStateNow, 5_000);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": contentTypeFor(filePath),
      "cache-control": "no-cache"
    });
    res.end(data);
  });
}

async function handleApi(req, res, pathname) {
  try {
    if (req.method === "GET" && pathname === "/api/state") {
      sendJson(res, 200, publicState());
      return;
    }

    if (req.method === "GET" && pathname === "/api/journal") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const limit = clamp(Number(url.searchParams.get("limit")) || 500, 1, 5000);
      sendJson(res, 200, {
        items: journalItems.slice(0, limit),
        count: journalItems.length,
        derived: publicState().derived
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/config") {
      const body = await readJsonBody(req);
      updateConfig(body.updates || body || {});
      sendJson(res, 200, publicState());
      return;
    }

    if (req.method === "POST" && pathname === "/api/action") {
      const body = await readJsonBody(req);
      const type = body.type;

      if (type === "setSpeed") setSpeed(body.mode, true);
      else if (type === "pause") pauseGame();
      else if (type === "advanceHours") advanceHoursInstant(Number(body.hours) || 0);
      else if (type === "applyListings") applyListings(true);
      else if (type === "clearListings") clearListings();
      else if (type === "releaseDividend") {
        const pct = Math.max(0, Number(config.dividendPct) || 0);
        const paid = releaseDividendAmountPerMonoV3(pct / 100, "Manual Mono-holder DIV dividend");
        if (paid <= 0) addLog("Dividend failed: no DIV available in treasury or dividend percent is zero.", "bad");
      }
      else if (type === "clearLog") {
        logItems = [];
        markDirty();
      }
      else if (type === "clearJournal") {
        journalItems = [];
        markDirty();
      }
      else if (type === "reset") {
        resetAll();
        setSpeed("60s_hour", false);
      }
      else {
        sendJson(res, 400, { error: "Unknown action" });
        return;
      }

      sendJson(res, 200, publicState());
      return;
    }

    sendJson(res, 404, { error: "API route not found" });
  } catch (error) {
    console.error("API error:", error);
    sendJson(res, 500, { error: error.message || "Server error" });
  }
}

function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith("/api/")) {
    handleApi(req, res, pathname);
    return;
  }

  if (pathname === "/" || pathname === "/index.html") {
    serveFile(res, path.join(PUBLIC_DIR, "index.html"));
    return;
  }

  if (pathname === "/Journal" || pathname === "/journal" || pathname === "/Journal/") {
    serveFile(res, path.join(PUBLIC_DIR, "journal.html"));
    return;
  }

  const safePath = path.normalize(pathname).replace(/^([/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }
  serveFile(res, filePath);
}

function start() {
  const loaded = loadSavedState();
  if (!loaded) resetAll();
  setSpeed(currentMode, false);
  startSaveLoop();

  const server = http.createServer(handleRequest);
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Mono & DIV Coin Game running on port ${PORT}`);
    console.log(`State file: ${STATE_FILE}`);
    console.log(`Simulation speed: ${speedStatus()}`);
  });

  const shutdown = () => {
    saveStateNow();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start();
