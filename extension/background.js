/* global chrome, CoinGlassCodec */
importScripts("lib/coinglass.js");

const DEFAULT_SETTINGS = {
  symbols: ["DOGE", "BTC", "ETH", "SOL", "BNB"],
  mapSymbol: "Binance_BTCUSDT",
};
let pendingRefresh;
let bridgeTabPromise;
let pendingObe;
let resolveObe;
let lastObeAttempt = 0;
let tenSecondTimer;
let lastRefreshStartedAt = 0;

function ensureTenSecondTimer() {
  if (tenSecondTimer) return;
  tenSecondTimer = setInterval(() => {
    refreshAll().catch(console.error);
  }, 10_000);
}

async function getSettings() {
  const stored = await chrome.storage.local.get(["settings", "capturedObe"]);
  const { obe: _legacyObe, ...settings } = stored.settings || {};
  return { ...DEFAULT_SETTINGS, ...settings, obe: stored.capturedObe || "" };
}

chrome.webRequest.onBeforeSendHeaders.addListener(details => {
  if (details.initiator !== "https://www.coinglass.com" || details.tabId < 0) return;
  const obe = details.requestHeaders?.find(header => header.name.toLowerCase() === "obe")?.value;
  if (!obe || !/^s_[A-Za-z0-9]+$/.test(obe)) return;
  chrome.storage.local.set({ capturedObe: obe }).catch(console.error);
  if (resolveObe) resolveObe(obe);
}, { urls: ["https://capi.coinglass.com/*"] }, ["requestHeaders"]);

async function acquireObe(force = false) {
  const { capturedObe } = await chrome.storage.local.get("capturedObe");
  if (capturedObe && !force) return capturedObe;
  if (pendingObe) return pendingObe;
  if (!force && Date.now() - lastObeAttempt < 60_000) {
    throw new Error("等待 CoinGlass 页面发出带 obe 的请求");
  }
  lastObeAttempt = Date.now();
  pendingObe = (async () => {
    let timeout;
    const captured = new Promise((resolve, reject) => {
      resolveObe = resolve;
      timeout = setTimeout(() => reject(new Error("未从 CoinGlass 页面获取到 obe，请打开页面后重试")), 15000);
    });
    try {
      const tab = await findCaptureTab();
      if (tab.status === "complete") await chrome.tabs.reload(tab.id);
      return await captured;
    } finally {
      clearTimeout(timeout);
      resolveObe = undefined;
    }
  })();
  try { return await pendingObe; }
  finally { pendingObe = undefined; }
}

function requestHeaders(timestamp, obe) {
  return {
    accept: "application/json",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "cache-control": "no-cache",
    "cache-ts-v2": timestamp,
    encryption: "true",
    language: "zh",
    obe,
  };
}

function copyResponseHeaders(response) {
  const headers = {};
  for (const name of ["content-type", "encryption", "v", "user", "time"]) {
    headers[name] = response.headers.get(name) || "";
  }
  return headers;
}

async function fetchDirect(url, headers) {
  const response = await fetch(url, { headers, cache: "no-store", credentials: "omit" });
  return { status: response.status, headers: copyResponseHeaders(response), body: await response.text() };
}

async function findCoinGlassTab() {
  if (!bridgeTabPromise) {
    bridgeTabPromise = (async () => {
      const existing = await chrome.tabs.query({ url: "https://www.coinglass.com/*" });
      if (existing.length) return existing[0];
      return chrome.tabs.create({ url: "https://www.coinglass.com/zh", active: false, pinned: true });
    })();
  }
  try { return await bridgeTabPromise; }
  finally { bridgeTabPromise = undefined; }
}

async function findCaptureTab() {
  const existing = await chrome.tabs.query({ url: "https://www.coinglass.com/*" });
  const backgroundTab = existing.find(tab => !tab.active);
  if (backgroundTab) return backgroundTab;
  return chrome.tabs.create({ url: "https://www.coinglass.com/zh", active: false, pinned: true });
}

async function waitForTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("CoinGlass 标签页加载超时"));
    }, 15000);
    function onUpdated(updatedId, change) {
      if (updatedId !== tabId || change.status !== "complete") return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then(latest => {
      if (latest.status === "complete") onUpdated(tabId, { status: "complete" });
    }).catch(reject);
  });
}

async function fetchFromCoinGlassPage(url, headers) {
  const tab = await findCoinGlassTab();
  await waitForTab(tab.id);
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: async (requestUrl, requestHeadersObject) => {
      const response = await fetch(requestUrl, {
        headers: requestHeadersObject, cache: "no-store", credentials: "omit",
      });
      const responseHeaders = {};
      for (const name of ["content-type", "encryption", "v", "user", "time"]) {
        responseHeaders[name] = response.headers.get(name) || "";
      }
      return {
        status: response.status,
        headers: responseHeaders,
        body: await response.text(),
      };
    },
    args: [url, headers],
  });
  if (!results?.[0]?.result) throw new Error("CoinGlass 标签页没有返回请求结果");
  return results[0].result;
}

async function fetchDecoded(url, obe) {
  const timestamp = String(Date.now());
  const headers = requestHeaders(timestamp, obe);
  let directError;
  try {
    return await CoinGlassCodec.decodeResponse(await fetchDirect(url, headers), url, timestamp);
  } catch (error) {
    directError = error;
  }
  try {
    return await CoinGlassCodec.decodeResponse(
      await fetchFromCoinGlassPage(url, headers), url, timestamp,
    );
  } catch (error) {
    throw new Error(`直接请求：${directError.message}；页面请求：${error.message}`);
  }
}

function marketSummary(data, symbols) {
  return symbols.map(symbol => {
    const item = data.list?.find(coin => coin.symbol === symbol);
    if (!item) throw new Error(`${symbol} 未出现在行情响应中`);
    return {
      symbol,
      priceUsd: item.price,
      change24hPercent: item.h24PriceChangePercent,
    };
  });
}

function mapSummary(data) {
  const price = Number(data.lastPrice);
  if (!Number.isFinite(price) || !data.liqMapV2) throw new Error("清算地图缺少价格或档位");
  const levels = Object.entries(data.liqMapV2).map(([bucket, rows]) => {
    const leverage = [0, 0, 0, 0, 0];
    for (const row of Array.isArray(rows) ? rows : []) {
      const strength = Number(row[1]);
      const tier = Number.parseFloat(row[2]);
      if (!Number.isFinite(strength) || strength <= 0) continue;
      const index = tier === 10 ? 0 : tier === 25 ? 1 : tier === 50 ? 2 : tier === 100 ? 3 : 4;
      leverage[index] += strength;
    }
    return { price: Number(bucket), leverage };
  }).filter(level => Number.isFinite(level.price) && level.leverage.some(Boolean))
    .sort((left, right) => left.price - right.price);
  return {
    symbol: `${data.instrument?.exName || "Binance"} ${data.instrument?.instrumentId || "BTCUSDT"}`,
    lastPrice: price,
    levels,
    levelCount: levels.length,
  };
}

async function setBadge(snapshot) {
  if (snapshot.errors?.market || !snapshot.market?.quotes?.length) {
    await chrome.action.setIcon({ path: "icon.png" });
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#64748b" });
    return;
  }
  const quote = snapshot.market.quotes.find(item => item.symbol === "DOGE") || snapshot.market.quotes[0];
  const price = Number(quote.priceUsd);
  const formatted = price < 1 ? price.toFixed(5) : price.toPrecision(5);
  const rising = Number(quote.change24hPercent) >= 0;
  const canvas = new OffscreenCanvas(32, 32);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.roundRect(0, 0, 32, 32, 6);
  context.fill();
  context.strokeStyle = rising ? "#0b8f70" : "#b64755";
  context.lineWidth = 1;
  context.stroke();
  context.fillStyle = "#050505";
  context.font = "bold 14px Arial, sans-serif";
  context.textAlign = "center";
  if (price < 1) {
    const [whole, decimals] = formatted.split(".");
    context.fillText(`${whole}.${decimals.slice(0, 2)}`, 16, 14, 30);
    context.fillText(decimals.slice(2), 16, 28, 30);
  } else {
    context.fillText(formatted, 16, 21, 30);
  }
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setIcon({ imageData: context.getImageData(0, 0, 32, 32) });
  await chrome.action.setTitle({ title: `${quote.symbol} $${formatted} · CoinGlass 行情观察` });
}

async function refreshAll() {
  if (pendingRefresh) return pendingRefresh;
  lastRefreshStartedAt = Date.now();
  pendingRefresh = (async () => {
    const settings = await getSettings();
    const previous = (await chrome.storage.local.get("snapshot")).snapshot || {};
    const snapshot = { ...previous, errors: {} };
    try {
      settings.obe = await acquireObe();
    } catch (error) {
      snapshot.errors.market = error.message;
      snapshot.errors.map = error.message;
      await chrome.storage.local.set({ snapshot });
      await setBadge(snapshot);
      return { settings, snapshot };
    }
    const marketUrl = CoinGlassCodec.marketUrl(settings.symbols);
    const mapUrl = await CoinGlassCodec.liqUrl(settings.mapSymbol);
    let [market, map] = await Promise.allSettled([
      fetchDecoded(marketUrl, settings.obe),
      fetchDecoded(mapUrl, settings.obe),
    ]);
    if (market.status === "rejected" && map.status === "rejected" && Date.now() - lastObeAttempt >= 60_000) {
      try {
        const freshObe = await acquireObe(true);
        if (freshObe !== settings.obe) {
          settings.obe = freshObe;
          [market, map] = await Promise.allSettled([
            fetchDecoded(marketUrl, freshObe),
            fetchDecoded(mapUrl, freshObe),
          ]);
        }
      } catch (error) { console.warn("CoinGlass obe 重新获取失败", error); }
    }
    if (market.status === "fulfilled") {
      try {
        snapshot.market = {
          quotes: marketSummary(market.value, settings.symbols),
          fetchedAt: new Date().toISOString(),
        };
      } catch (error) { snapshot.errors.market = error.message; }
    } else snapshot.errors.market = market.reason.message;
    if (map.status === "fulfilled") {
      try { snapshot.map = { ...mapSummary(map.value), fetchedAt: new Date().toISOString() }; }
      catch (error) { snapshot.errors.map = error.message; }
    } else snapshot.errors.map = map.reason.message;
    await chrome.storage.local.set({ snapshot });
    await setBadge(snapshot);
    return { settings, snapshot };
  })();
  try { return await pendingRefresh; }
  finally { pendingRefresh = undefined; }
}

async function initialize() {
  ensureTenSecondTimer();
  await chrome.alarms.create("refresh", { periodInMinutes: 0.5 });
  await refreshAll();
}

chrome.runtime.onInstalled.addListener(() => {
  (async () => {
    const { settings } = await chrome.storage.local.get("settings");
    if (settings && Object.hasOwn(settings, "obe")) {
      const { obe: _legacyObe, ...rest } = settings;
      await chrome.storage.local.set({ settings: rest });
    }
    await initialize();
  })().catch(console.error);
});
chrome.runtime.onStartup.addListener(() => { initialize().catch(console.error); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "refresh") {
    ensureTenSecondTimer();
    if (Date.now() - lastRefreshStartedAt >= 10_000) {
      refreshAll().catch(console.error);
    }
  }
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  ensureTenSecondTimer();
  (async () => {
    if (message.type === "GET_STATE") {
      const settings = await getSettings();
      const snapshot = (await chrome.storage.local.get("snapshot")).snapshot || {};
      return { settings, snapshot };
    }
    if (message.type === "REFRESH") return refreshAll();
    if (message.type === "CAPTURE_OBE") {
      if (pendingRefresh) await pendingRefresh;
      const obe = await acquireObe(true);
      await chrome.storage.local.set({ capturedObe: obe });
      return refreshAll();
    }
    if (message.type === "SAVE_SETTINGS") {
      const settings = {
        symbols: message.settings.symbols,
        mapSymbol: message.settings.mapSymbol,
      };
      await chrome.storage.local.set({ settings });
      if (pendingRefresh) await pendingRefresh;
      return refreshAll();
    }
    throw new Error("未知操作");
  })().then(sendResponse, error => sendResponse({ error: error.message }));
  return true;
});

ensureTenSecondTimer();
