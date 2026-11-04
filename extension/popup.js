/* global chrome */
const byId = id => document.getElementById(id);
let currentSettings;
let busy = false;
let settingsSaving = false;

function formatPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const digits = number < 0.01 ? 6 : number < 1 ? 5 : number < 100 ? 3 : 2;
  return `$${number.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: Math.min(digits, 2) })}`;
}

function formatStrength(value) {
  const number = Number(value);
  if (number >= 1e9) return `${(number / 1e9).toFixed(1)}B`;
  if (number >= 1e6) return `${(number / 1e6).toFixed(1)}M`;
  if (number >= 1e3) return `${(number / 1e3).toFixed(0)}K`;
  return number.toFixed(0);
}

function formatTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderQuotes(market) {
  const container = byId("quotes");
  container.replaceChildren();
  if (!market?.quotes?.length) {
    container.append(element("div", "empty", "暂无价格数据"));
    return;
  }
  for (const quote of market.quotes) {
    const row = element("div", "quote");
    row.append(element("span", "symbol", quote.symbol));
    const value = element("div", "quote-value");
    value.append(element("div", "price", formatPrice(quote.priceUsd)));
    const change = Number(quote.change24hPercent);
    value.append(element("div", `change ${change >= 0 ? "up" : "down"}`,
      `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`));
    row.append(value);
    container.append(row);
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
const TIER_COLORS = ["#3b8fff", "#49d3d5", "#e5bf49", "#ee9250", "#9e86dc"];

function svgNode(tag, attributes = {}, content) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (content !== undefined) node.textContent = content;
  return node;
}

function drawMap(levels, lastPrice) {
  const width = 350, height = 220;
  const left = 41, right = 10, top = 17, bottom = 31;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const minPrice = Math.min(lastPrice, levels[0].price);
  const maxPrice = Math.max(lastPrice, levels.at(-1).price);
  const span = maxPrice - minPrice || lastPrice * 0.02 || 1;
  const xForPrice = price => left + (price - minPrice) / span * plotWidth;
  const currentX = xForPrice(lastPrice);
  const columns = Array.from({ length: Math.ceil(plotWidth) }, () => ({ leverage: [0, 0, 0, 0, 0], price: 0 }));
  for (const level of levels) {
    const index = Math.min(columns.length - 1, Math.max(0, Math.floor(xForPrice(level.price) - left)));
    for (let tier = 0; tier < 5; tier++) columns[index].leverage[tier] += Number(level.leverage[tier]) || 0;
    columns[index].price = level.price;
  }
  const totals = columns.map(column => column.leverage.reduce((sum, value) => sum + value, 0));
  const barMax = Math.max(1, ...totals);
  const mid = Math.max(0, Math.min(columns.length - 1, Math.floor(currentX - left)));
  const longTotal = totals.slice(0, mid).reduce((sum, value) => sum + value, 0);
  const shortTotal = totals.slice(mid + 1).reduce((sum, value) => sum + value, 0);
  const cumulativeMax = Math.max(1, longTotal, shortTotal);
  const baseline = top + plotHeight;
  const chart = svgNode("svg", { class: "liquidation-chart", viewBox: `0 0 ${width} ${height}`,
    role: "img", "aria-label": "清算地图：杠杆分色柱状图与多空累计清算曲线" });

  for (let step = 0; step <= 4; step++) {
    const y = baseline - step / 4 * plotHeight;
    chart.append(svgNode("line", { x1: left, y1: y, x2: width - right, y2: y, class: "chart-grid" }));
    chart.append(svgNode("text", { x: left - 5, y: y + 3, "text-anchor": "end", class: "chart-axis" },
      formatStrength(barMax * step / 4)));
  }
  for (let step = 0; step <= 4; step++) {
    const x = left + step / 4 * plotWidth;
    const label = (minPrice + step / 4 * span).toLocaleString("en-US", { maximumFractionDigits: lastPrice < 1 ? 4 : 0 });
    chart.append(svgNode("text", { x, y: height - 8, "text-anchor": step === 0 ? "start" : step === 4 ? "end" : "middle", class: "chart-axis" }, label));
  }

  const barHeight = plotHeight * 0.68;
  columns.forEach((column, index) => {
    let y = baseline;
    for (let tier = 0; tier < 5; tier++) {
      const value = column.leverage[tier];
      if (!value) continue;
      const segmentHeight = value / barMax * barHeight;
      y -= segmentHeight;
      const bar = svgNode("rect", { x: left + index, y, width: 1.15, height: segmentHeight,
        fill: TIER_COLORS[tier], opacity: 0.88 });
      bar.append(svgNode("title", {}, `${formatPrice(column.price)} · ${tier === 4 ? "其他" : [10, 25, 50, 100][tier] + "x"} · ${formatStrength(value)}`));
      chart.append(bar);
    }
  });

  const curve = (start, end, direction, total, className) => {
    const points = [[currentX, baseline]];
    let accumulated = 0;
    for (let index = start; index !== end; index += direction) {
      accumulated += totals[index];
      points.push([left + index + 0.5, baseline - accumulated / cumulativeMax * plotHeight * 0.88]);
    }
    if (total) chart.append(svgNode("polyline", { points: points.map(point => point.join(",")).join(" "), class: className }));
  };
  curve(mid - 1, -1, -1, longTotal, "chart-curve long");
  curve(mid + 1, columns.length, 1, shortTotal, "chart-curve short");
  chart.append(svgNode("line", { x1: currentX, y1: top, x2: currentX, y2: baseline, class: "current-line" }));
  const labelX = Math.max(left + 28, Math.min(width - right - 28, currentX));
  chart.append(svgNode("rect", { x: labelX - 27, y: top - 12, width: 54, height: 16, rx: 4, class: "current-tag" }));
  chart.append(svgNode("text", { x: labelX, y: top, "text-anchor": "middle", class: "current-label" }, "现价"));
  return { chart, longTotal, shortTotal };
}

function renderMap(map) {
  const container = byId("map-content");
  container.replaceChildren();
  if (!map) {
    container.append(element("div", "empty", "暂无清算地图数据"));
    return;
  }
  byId("map-pair").textContent = map.symbol;
  const price = element("div", "map-price");
  price.append(element("span", "", "接口最新价格"));
  price.append(element("strong", "", formatPrice(map.lastPrice)));
  container.append(price);
  if (!map.levels?.length) {
    container.append(element("div", "empty", "暂无价格档位，刷新后重试"));
    return;
  }
  const { chart, longTotal, shortTotal } = drawMap(map.levels, map.lastPrice);
  container.append(chart);
  const legend = element("div", "map-legend");
  ["10x", "25x", "50x", "100x", "其他"].forEach((tier, index) => {
    const item = element("span", "legend-item", tier);
    item.style.setProperty("--legend-color", TIER_COLORS[index]);
    legend.append(item);
  });
  container.append(legend);
  const totals = element("div", "map-totals");
  totals.append(element("span", "long", `跌破现价 · 多单累计 ${formatStrength(longTotal)}`));
  totals.append(element("span", "short", `突破现价 · 空单累计 ${formatStrength(shortTotal)}`));
  container.append(totals);
  container.append(element("div", "map-hint", `${map.levelCount} 个价格档位 · 柱状图按杠杆倍数分色 · 曲线为累计估算清算强度`));
}

const PRESET_SYMBOLS = new Set(["DOGE", "BTC", "ETH", "SOL", "BNB"]);

function renderSettings(settings) {
  if (!settings) return;
  currentSettings = settings;
  for (const button of byId("symbol-buttons").querySelectorAll("button[data-custom-symbol]")) button.remove();
  for (const symbol of settings.symbols.filter(item => !PRESET_SYMBOLS.has(item))) {
    const button = element("button", "symbol-button", symbol);
    button.type = "button";
    button.dataset.symbol = symbol;
    button.dataset.customSymbol = "true";
    byId("symbol-buttons").append(button);
  }
  for (const button of byId("symbol-buttons").querySelectorAll("button[data-symbol]")) {
    button.setAttribute("aria-pressed", String(settings.symbols.includes(button.dataset.symbol)));
  }
  byId("map-symbol-value").textContent = settings.mapSymbol;
  for (const button of byId("map-symbol-buttons").querySelectorAll("button[data-map-symbol]")) {
    button.setAttribute("aria-pressed", String(settings.mapSymbol === button.dataset.mapSymbol));
  }
  byId("obe-value").textContent = settings.obe ? "已获取" : "未获取";
}

function render(state) {
  if (state.error) {
    byId("status").textContent = state.error;
    byId("status-dot").className = "dot warn";
    return;
  }
  const { settings, snapshot } = state;
  renderSettings(settings);
  const errors = snapshot?.errors || {};
  const hasError = Boolean(errors.market || errors.map);
  const hasData = Boolean(snapshot?.market || snapshot?.map);
  byId("status-dot").className = `dot ${hasError ? "warn" : hasData ? "ok" : ""}`;
  byId("status").textContent = hasError ? "部分数据更新失败" : hasData ? "数据已更新" : "等待首次更新";
  byId("updated-at").textContent = formatTime(snapshot?.market?.fetchedAt || snapshot?.map?.fetchedAt);
  byId("market-error").hidden = !errors.market;
  byId("market-error").textContent = errors.market || "";
  byId("map-error").hidden = !errors.map;
  byId("map-error").textContent = errors.map || "";
  renderQuotes(snapshot?.market);
  renderMap(snapshot?.map);
}

async function message(type, settings) {
  return chrome.runtime.sendMessage({ type, settings });
}

async function refresh() {
  if (busy) return;
  busy = true;
  byId("refresh").disabled = true;
  byId("status").textContent = "正在刷新…";
  try { render(await message("REFRESH")); }
  catch (error) { render({ error: error.message }); }
  finally {
    busy = false;
    byId("refresh").disabled = false;
  }
}

async function saveQuickSetting(settings, successMessage, buttons) {
  if (settingsSaving) return;
  settingsSaving = true;
  buttons.forEach(button => { button.disabled = true; });
  byId("settings-message").textContent = "正在保存并刷新…";
  try {
    const result = await message("SAVE_SETTINGS", settings);
    if (result.error) throw new Error(result.error);
    render(result);
    byId("settings-message").textContent = successMessage;
  } catch (error) {
    byId("settings-message").textContent = error.message;
  } finally {
    buttons.forEach(button => { button.disabled = false; });
    settingsSaving = false;
  }
}

async function fetchObeFromPage() {
  if (settingsSaving) return;
  settingsSaving = true;
  const button = byId("fetch-obe");
  button.disabled = true;
  byId("settings-message").textContent = "正在从 CoinGlass 页面获取 obe…";
  try {
    const result = await message("CAPTURE_OBE");
    if (result.error) throw new Error(result.error);
    render(result);
    byId("settings-message").textContent = "obe 已自动获取并刷新";
  } catch (error) {
    byId("settings-message").textContent = error.message;
  } finally {
    button.disabled = false;
    settingsSaving = false;
  }
}

byId("refresh").addEventListener("click", refresh);
byId("symbol-buttons").addEventListener("click", event => {
  const button = event.target.closest("button[data-symbol]");
  if (!button || !currentSettings || settingsSaving) return;
  const selected = currentSettings.symbols.includes(button.dataset.symbol);
  if (!selected && currentSettings.symbols.length >= 10) {
    byId("settings-message").textContent = "最多关注 10 个币种";
    return;
  }
  if (selected && currentSettings.symbols.length === 1) {
    byId("settings-message").textContent = "至少保留一个币种";
    return;
  }
  const symbols = selected
    ? currentSettings.symbols.filter(symbol => symbol !== button.dataset.symbol)
    : [...currentSettings.symbols, button.dataset.symbol];
  saveQuickSetting({ ...currentSettings, symbols },
    `${button.dataset.symbol} 已${selected ? "取消关注" : "加入关注"}`,
    [...byId("symbol-buttons").querySelectorAll("button")]);
});
byId("map-symbol-buttons").addEventListener("click", event => {
  const button = event.target.closest("button[data-map-symbol]");
  if (!button || !currentSettings || settingsSaving || currentSettings.mapSymbol === button.dataset.mapSymbol) return;
  saveQuickSetting({ ...currentSettings, mapSymbol: button.dataset.mapSymbol },
    `${button.textContent} 清算地图已选中`,
    [...byId("map-symbol-buttons").querySelectorAll("button")]);
});
byId("fetch-obe").addEventListener("click", fetchObeFromPage);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.snapshot || changes.capturedObe)) {
    message("GET_STATE").then(render).catch(error => render({ error: error.message }));
  }
});
message("GET_STATE").then(state => {
  render(state);
  if (!state.snapshot?.market || !state.snapshot?.map) refresh();
}).catch(error => render({ error: error.message }));
setInterval(() => {
  message("GET_STATE").then(render).catch(error => render({ error: error.message }));
}, 10_000);
