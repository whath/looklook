import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import watchlist from '../shared/watchlist.json';
import { rankGroups, advanceRankHistory, rankMovement } from './ranking.js';
import { refreshSchedule } from './schedule.js';
import './styles.css';

const scheduleCheckInterval = 60_000;
const defaultTitle = '记住来时路，坚定未来路';
const productionEndpoint = 'https://ericcself.top/v1/looklook/quotes';
const quotePath = new URL(productionEndpoint).pathname;
const localEndpoint = `http://127.0.0.1:8000${quotePath}`;
const productionOrigin = new URL(productionEndpoint).origin;
const settingsKey = 'looklook.connection';
const titleKey = 'looklook.title';
const groupKey = 'looklook.active-group';
const rankHistoryKey = 'looklook.rank-history';
const snapshotKey = 'looklook.last-snapshot';

const percentFormatter = new Intl.NumberFormat('zh-CN', {
  style: 'percent',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: 'exceptZero',
});
const tradeDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const statusTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const el = (id) => document.getElementById(id);
const titleButton = el('edit-title');
const titleForm = el('title-form');
const titleInput = el('title-input');
const tabs = el('quote-tabs');
const stockGrid = el('stock-grid');
const lastRefresh = el('last-refresh');
const statusText = el('status-text');
const retryButton = el('retry-quotes');
const settingsDialog = el('settings-dialog');
const endpointInput = el('server-endpoint');
const tokenInput = el('server-token');
const settingsError = el('settings-error');

function readPreference(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Keep the current session usable when storage is unavailable.
  }
}

function normalizeEndpoint(input) {
  const endpoint = new URL(input.trim());
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (!(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && loopback))) {
    throw new Error('请使用 HTTPS 接口。本机服务可用 HTTP。');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('请填写不含登录信息、参数或片段的接口地址。');
  }
  if (endpoint.pathname === '/') endpoint.pathname = quotePath;
  return endpoint.href;
}

function requiresToken(endpoint) {
  return new URL(endpoint).origin === productionOrigin;
}

function needsToken(settings) {
  return requiresToken(settings.endpoint) && !settings.token;
}

function initialConnection() {
  try {
    const stored = JSON.parse(readPreference(settingsKey));
    if (stored?.endpoint) {
      return {
        endpoint: normalizeEndpoint(stored.endpoint),
        token: typeof stored.token === 'string' ? stored.token.trim() : '',
      };
    }
  } catch {
    // An outdated address can be repaired through settings.
  }
  try {
    return { endpoint: normalizeEndpoint(import.meta.env.VITE_LOOKLOOK_ENDPOINT || productionEndpoint), token: '' };
  } catch {
    return { endpoint: productionEndpoint, token: '' };
  }
}

function readRankHistory(endpoint) {
  try {
    const stored = JSON.parse(readPreference(rankHistoryKey));
    const history = stored?.history;
    if (stored?.endpoint === endpoint && Number.isFinite(history?.updatedAt)
        && history.current && history.previous) return history;
  } catch {
    // Start a new comparison history if local data cannot be read.
  }
  return null;
}

let connection = initialConnection();
let connectionRevision = 0;
let rankHistory = readRankHistory(connection.endpoint);
let title = readPreference(titleKey)?.trim().slice(0, 60) || defaultTitle;
let activeGroup = watchlist.groups.find((group) => group.id === readPreference(groupKey)) || watchlist.groups[0];
let activeSnapshot = null;
let changes = new Map();
let previousChanges = {};
let groupOrder = watchlist.groups;
let refreshing = false;
let failure = '';
let refreshTimer;
let lastRequestedSlot;
const groupElements = new Map();

function formatChange(value) {
  return Number.isFinite(value) ? percentFormatter.format(value / 100) : '—';
}

function renderTitle() {
  titleButton.textContent = title;
  titleButton.setAttribute('aria-label', `${title}，点击编辑标题`);
}

function stopEditingTitle() {
  titleForm.hidden = true;
  titleButton.parentElement.hidden = false;
  titleButton.focus();
}

titleButton.addEventListener('click', () => {
  titleInput.value = title;
  titleButton.parentElement.hidden = true;
  titleForm.hidden = false;
  titleInput.focus();
  titleInput.select();
});
titleForm.addEventListener('submit', (event) => {
  event.preventDefault();
  title = titleInput.value.trim() || defaultTitle;
  writePreference(titleKey, title);
  renderTitle();
  stopEditingTitle();
});
el('cancel-title').addEventListener('click', stopEditingTitle);
titleInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') stopEditingTitle();
});

function buildWatchlist() {
  for (const group of watchlist.groups) {
    const card = document.createElement('section');
    card.id = `group-${group.id}`;
    card.className = 'stock-card';
    const header = document.createElement('header');
    header.className = 'stock-list-header';
    const heading = document.createElement('h2');
    heading.id = `heading-${group.id}`;
    heading.textContent = group.name;
    card.setAttribute('aria-labelledby', heading.id);
    const cardValue = document.createElement('span');
    cardValue.className = 'card-value';
    const movement = document.createElement('span');
    movement.className = 'rank-movement';
    const metrics = document.createElement('span');
    metrics.className = 'card-metrics';
    metrics.append(movement, cardValue);
    header.append(heading, metrics);

    const stockList = document.createElement('ul');
    stockList.className = 'stock-list';
    const stockValues = group.stocks.map((stock) => {
      const row = document.createElement('li');
      row.className = 'stock-row';
      const identity = document.createElement('span');
      identity.className = 'stock-identity';
      const name = document.createElement('span');
      name.className = 'stock-name';
      name.textContent = stock.name;
      const code = document.createElement('span');
      code.className = 'stock-code';
      code.textContent = stock.code;
      identity.append(name, code);
      const value = document.createElement('span');
      value.className = 'stock-change';
      const movement = document.createElement('span');
      movement.className = 'stock-movement';
      const metrics = document.createElement('span');
      metrics.className = 'stock-metrics';
      metrics.append(value, movement);
      row.append(identity, metrics);
      stockList.append(row);
      return { value, movement };
    });
    card.append(header, stockList);
    stockGrid.append(card);

    const button = document.createElement('button');
    button.type = 'button';
    button.id = `tab-${group.id}`;
    button.className = 'quote-tab';
    button.setAttribute('aria-controls', card.id);
    if (group === activeGroup) button.setAttribute('aria-current', 'location');

    const tabValue = document.createElement('span');
    tabValue.className = 'tab-value';
    const name = document.createElement('span');
    name.textContent = group.name;
    button.append(tabValue, name);
    button.addEventListener('click', () => selectGroup(group));
    button.addEventListener('keydown', (event) => {
      const index = groupOrder.indexOf(group);
      const size = groupOrder.length;
      const targetIndex = {
        ArrowLeft: (index + size - 1) % size,
        ArrowRight: (index + 1) % size,
        Home: 0,
        End: size - 1,
      }[event.key];
      if (targetIndex === undefined) return;
      event.preventDefault();
      const target = groupOrder[targetIndex];
      groupElements.get(target.id).button.focus({ preventScroll: true });
      selectGroup(target);
    });
    groupElements.set(group.id, { button, tabValue, card, cardValue, movement, stockValues });
    tabs.append(button);
  }
}

function applyGroupOrder(ranking) {
  const order = ranking.map(({ group }) => group);
  if (order.every((group, index) => group === groupOrder[index])) return;

  let anchor;
  let anchorTop;
  if (stockGrid.scrollTop > 0) {
    const viewportTop = stockGrid.getBoundingClientRect().top;
    anchor = [...stockGrid.children].find((card) => card.getBoundingClientRect().bottom > viewportTop);
    anchorTop = anchor?.getBoundingClientRect().top;
  }
  const focusedTab = tabs.contains(document.activeElement) ? document.activeElement : null;
  const elements = order.map((group) => groupElements.get(group.id));
  tabs.append(...elements.map(({ button }) => button));
  stockGrid.append(...elements.map(({ card }) => card));
  groupOrder = order;
  if (anchor) stockGrid.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
  else stockGrid.scrollTop = 0;
  if (focusedTab && document.activeElement !== focusedTab) focusedTab.focus({ preventScroll: true });
}

function renderStockMovement(node, change, previous) {
  const delta = Number.isFinite(change) && Number.isFinite(previous)
    ? Number((change - previous).toFixed(2)) : null;
  if (delta === null) {
    node.textContent = '—';
    node.title = '暂无上一轮可比较的涨幅';
  } else if (delta === 0) {
    node.textContent = '0.00';
    node.title = '较上一轮涨幅持平';
  } else {
    const magnitude = Math.abs(delta).toFixed(2);
    node.textContent = `${delta > 0 ? '↑+' : '↓−'}${magnitude}`;
    node.title = `较上一轮${delta > 0 ? '上升' : '下降'} ${magnitude} 个百分点`;
  }
  node.setAttribute('aria-label', node.title);
}

function renderQuotes(ranking = rankGroups(watchlist.groups, changes), history = null) {
  for (const { group, value, count } of ranking) {
    const { button, tabValue, cardValue, movement, stockValues } = groupElements.get(group.id);
    const formatted = formatChange(value);
    tabValue.textContent = formatted;
    cardValue.textContent = formatted;
    const delta = rankMovement(history, group.id);
    movement.textContent = delta === null ? '—' : delta > 0 ? `↑${delta}` : delta < 0 ? `↓${-delta}` : '0';
    movement.title = delta === null ? '暂无上一轮名次'
      : delta > 0 ? `较上一轮上升 ${delta} 名`
        : delta < 0 ? `较上一轮下降 ${-delta} 名` : '与上一轮持平';
    movement.setAttribute('aria-label', movement.title);
    const label = `${group.name}，平均涨幅 ${formatted}，${count}/${group.stocks.length} 只有行情`;
    button.title = label;
    button.setAttribute('aria-label', label);

    group.stocks.forEach((stock, index) => {
      const change = changes.get(stock.code);
      const { value, movement } = stockValues[index];
      const missing = !Number.isFinite(change);
      value.textContent = formatChange(change);
      value.classList.toggle('missing', missing);
      if (missing) value.title = '暂无有效报价';
      else value.removeAttribute('title');
      renderStockMovement(movement, change, previousChanges[stock.code]);
    });
  }
  applyGroupOrder(ranking);
}

function selectGroup(group) {
  const { button, card } = groupElements.get(group.id);
  groupElements.get(activeGroup.id).button.removeAttribute('aria-current');
  activeGroup = group;
  writePreference(groupKey, group.id);
  button.setAttribute('aria-current', 'location');
  card.scrollIntoView({ block: 'start', inline: 'nearest' });
}

function marketDate(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(tradeDateFormatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function snapshotTradeDate({ tradeDate, updatedAt }) {
  // Some providers supply only the collection time during the trading session.
  return tradeDate || (typeof updatedAt === 'string' ? marketDate(updatedAt) : null);
}

function renderLastRefresh(updatedAt) {
  const timestamp = typeof updatedAt === 'string' ? Date.parse(updatedAt) : NaN;
  lastRefresh.hidden = !Number.isFinite(timestamp);
  if (lastRefresh.hidden) {
    lastRefresh.removeAttribute('datetime');
    lastRefresh.removeAttribute('title');
    lastRefresh.textContent = '';
    return;
  }
  const date = marketDate(timestamp);
  const time = statusTimeFormatter.format(timestamp);
  const label = date === marketDate(Date.now()) ? time : `${date.slice(5)} ${time}`;
  lastRefresh.dateTime = updatedAt;
  lastRefresh.title = `${date} ${time}（北京时间）`;
  lastRefresh.textContent = `上次刷新 ${label}`;
}

function readSnapshot(data) {
  if (!data || typeof data !== 'object' || !data.quotes || typeof data.quotes !== 'object' || Array.isArray(data.quotes)) {
    throw new Error('行情格式错误');
  }

  const tradeDate = snapshotTradeDate(data);
  const values = new Map();
  for (const [code, quote] of Object.entries(data.quotes)) {
    if (!/^\d{6}$/.test(code) || quote?.stale || !Number.isFinite(quote?.changePct)) continue;
    const date = quote.tradeDate || (quote.quotedAt ? marketDate(quote.quotedAt) : null);
    if (date && tradeDate && date !== tradeDate) continue;
    values.set(code, quote.changePct);
  }
  return { data, values };
}

function renderStatus() {
  const hasData = changes.size > 0;
  if (needsToken(connection)) {
    statusText.textContent = '请在设置中填写访问令牌';
  } else if (refreshing) {
    statusText.textContent = hasData ? '正在更新行情…' : '正在连接服务器…';
  } else if (!hasData) {
    statusText.textContent = failure || '暂无行情，等待下一次交易时段刷新';
  } else {
    const { tradeDate, stale } = activeSnapshot;
    const details = [];
    if (failure) details.push('连接失败，保留上次行情');
    else if (stale) details.push('上次行情');
    if (typeof tradeDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
      details.push(`交易日 ${tradeDate.slice(5)}`);
    }
    statusText.textContent = details.join(' · ') || '行情已更新';
  }
  statusText.parentElement.dataset.ready = String(hasData && !failure && !activeSnapshot?.stale && !refreshing);
  retryButton.hidden = !failure || refreshing || needsToken(connection) || refreshSchedule(Date.now()).slot === null;
}

async function requestSnapshot(settings) {
  if (isTauri()) return invoke('fetch_quotes', settings);

  const address = settings.endpoint === localEndpoint && import.meta.env.DEV ? quotePath : settings.endpoint;
  const headers = settings.token ? { Authorization: `Bearer ${settings.token}` } : {};
  const response = await fetch(address, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function displaySnapshot(snapshot) {
  const { updatedAt } = snapshot.data;
  activeSnapshot = snapshot.data;
  changes = snapshot.values;
  const ranking = rankGroups(watchlist.groups, changes);
  const history = advanceRankHistory(rankHistory, updatedAt, ranking);
  if (history !== rankHistory) {
    rankHistory = history;
    writePreference(rankHistoryKey, JSON.stringify({ endpoint: connection.endpoint, history }));
  }
  renderLastRefresh(changes.size ? updatedAt : null);
  renderQuotes(ranking, Date.parse(updatedAt) === rankHistory?.updatedAt ? rankHistory : null);
}

function restoreSnapshot() {
  if (needsToken(connection)) return;
  try {
    const saved = JSON.parse(readPreference(snapshotKey));
    if (saved?.endpoint === connection.endpoint) {
      const snapshot = readSnapshot(saved.data);
      previousChanges = saved.previousChanges ?? {};
      displaySnapshot(snapshot);
    }
  } catch {
    // Invalid local data should not prevent the next scheduled refresh.
  }
}

async function refreshQuotes(slot) {
  if (refreshing || needsToken(connection) || slot === null || slot !== refreshSchedule(Date.now()).slot) return;
  const revision = connectionRevision;
  lastRequestedSlot = slot;
  refreshing = true;
  renderStatus();
  try {
    const snapshot = readSnapshot(await requestSnapshot(connection));
    if (revision !== connectionRevision) return;
    const { updatedAt } = snapshot.data;
    const timestamp = typeof updatedAt === 'string' ? Date.parse(updatedAt) : NaN;
    const lastTimestamp = Date.parse(activeSnapshot?.updatedAt);
    if (changes.size && (!snapshot.values.size || !Number.isFinite(timestamp) || timestamp < lastTimestamp)) {
      failure = '服务器暂未提供更新行情';
      return;
    }
    const tradeDate = snapshotTradeDate(snapshot.data);
    const lastTradeDate = activeSnapshot && snapshotTradeDate(activeSnapshot);
    if (tradeDate !== lastTradeDate) previousChanges = {};
    else if (timestamp > lastTimestamp) previousChanges = Object.fromEntries(changes);
    failure = '';
    displaySnapshot(snapshot);
    if (changes.size) {
      writePreference(snapshotKey, JSON.stringify({ endpoint: connection.endpoint, data: snapshot.data, previousChanges }));
    }
  } catch (error) {
    if (revision !== connectionRevision) return;
    const message = String(error);
    if (/\b50[23]\b|暂无行情|尚无可用行情/.test(message)) failure = '服务器暂未提供行情';
    else if (/\b40[13]\b|令牌/.test(message)) failure = '访问被拒绝，请检查令牌';
    else if (message.includes('行情格式错误')) failure = '行情格式不正确';
    else failure = '连接失败，请检查服务器设置';
  } finally {
    refreshing = false;
    if (revision === connectionRevision) renderStatus();
    else scheduleRefresh();
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  const now = Date.now();
  const { slot, next } = refreshSchedule(now);
  const wait = Math.min(next === null ? Infinity : next - now, scheduleCheckInterval - now % scheduleCheckInterval);
  refreshTimer = setTimeout(scheduleRefresh, wait);
  if (slot !== null && slot !== lastRequestedSlot) void refreshQuotes(slot);
  renderLastRefresh(changes.size ? activeSnapshot?.updatedAt : null);
  renderStatus();
}

retryButton.addEventListener('click', () => void refreshQuotes(refreshSchedule(Date.now()).slot));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleRefresh();
});

el('open-settings').addEventListener('click', () => {
  endpointInput.value = connection.endpoint;
  tokenInput.value = connection.token;
  el('token-hint').textContent = needsToken(connection) ? '（服务器要求）' : '（按服务器要求填写）';
  settingsError.hidden = true;
  settingsDialog.showModal();
  endpointInput.focus();
  endpointInput.select();
});

el('cancel-settings').addEventListener('click', () => settingsDialog.close());
el('settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  let endpoint;
  try {
    endpoint = normalizeEndpoint(endpointInput.value);
  } catch (error) {
    settingsError.textContent = error instanceof TypeError ? '请输入完整的服务器地址。' : error.message;
    settingsError.hidden = false;
    endpointInput.focus();
    return;
  }
  const token = tokenInput.value.trim();
  if (needsToken({ endpoint, token })) {
    settingsError.textContent = '请填写服务器的访问令牌。';
    settingsError.hidden = false;
    tokenInput.focus();
    return;
  }
  const endpointChanged = connection.endpoint !== endpoint;
  const changed = endpointChanged || connection.token !== token;
  connection = { endpoint, token };
  writePreference(settingsKey, JSON.stringify(connection));
  settingsDialog.close();
  if (changed) {
    connectionRevision += 1;
    lastRequestedSlot = undefined;
    if (endpointChanged) rankHistory = readRankHistory(endpoint);
    activeSnapshot = null;
    changes = new Map();
    previousChanges = {};
    failure = '';
    writePreference(snapshotKey, '');
    renderLastRefresh(null);
    renderQuotes();
  }
  scheduleRefresh();
});
settingsDialog.addEventListener('close', () => {
  tokenInput.value = '';
});

if (isTauri()) {
  const windowHandle = getCurrentWindow();
  el('minimize-window').addEventListener('click', () => void windowHandle.minimize().catch(console.error));
  el('close-window').addEventListener('click', () => void windowHandle.close().catch(console.error));
}

renderTitle();
buildWatchlist();
renderQuotes();
restoreSnapshot();
if (activeGroup !== groupOrder[0]) {
  groupElements.get(activeGroup.id).card.scrollIntoView({ block: 'start', inline: 'nearest' });
}
scheduleRefresh();
