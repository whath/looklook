import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import watchlist from '../shared/watchlist.json';
import './styles.css';

const refreshInterval = 15 * 60 * 1000;
const defaultTitle = '记住来时路，坚定未来路';
const productionEndpoint = 'https://ericcself.top/v1/looklook/quotes';
const quotePath = new URL(productionEndpoint).pathname;
const localEndpoint = `http://127.0.0.1:8000${quotePath}`;
const productionOrigin = new URL(productionEndpoint).origin;
const settingsKey = 'looklook.connection';
const titleKey = 'looklook.title';
const groupKey = 'looklook.active-group';

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
const categorySelect = el('category-select');
const stockPanel = el('stock-panel');
const stockList = el('stock-list');
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

let connection = initialConnection();
let connectionRevision = 0;
let title = readPreference(titleKey)?.trim().slice(0, 60) || defaultTitle;
let activeGroup = watchlist.groups.find((group) => group.id === readPreference(groupKey)) || watchlist.groups[0];
let activeSnapshot = null;
let changes = new Map();
let refreshing = false;
let failure = '';
let intervalHandle;
let lastRequestAt = 0;
const tabElements = new Map();

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

function categoryAverage(group) {
  let total = 0;
  let count = 0;
  for (const stock of group.stocks) {
    const change = changes.get(stock.code);
    if (!Number.isFinite(change)) continue;
    total += change;
    count += 1;
  }
  return { value: count ? total / count : null, count };
}

function buildCategories() {
  const jumpPrompt = new Option('跳转分类', '');
  jumpPrompt.disabled = true;
  jumpPrompt.selected = true;
  categorySelect.append(jumpPrompt);

  let optionCategory;
  let options;
  watchlist.groups.forEach((group, index) => {
    if (optionCategory !== group.category) {
      optionCategory = group.category;
      options = document.createElement('optgroup');
      options.label = optionCategory;
      categorySelect.append(options);
    }
    options.append(new Option(group.name, group.id));

    const button = document.createElement('button');
    button.type = 'button';
    button.id = `tab-${group.id}`;
    button.className = 'quote-tab';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', stockPanel.id);

    const value = document.createElement('span');
    value.className = 'tab-value';
    const name = document.createElement('span');
    name.textContent = group.name;
    button.append(value, name);
    button.addEventListener('click', () => selectGroup(group));
    button.addEventListener('keydown', (event) => {
      const size = watchlist.groups.length;
      const targetIndex = {
        ArrowLeft: (index + size - 1) % size,
        ArrowRight: (index + 1) % size,
        Home: 0,
        End: size - 1,
      }[event.key];
      if (targetIndex === undefined) return;
      event.preventDefault();
      const target = watchlist.groups[targetIndex];
      selectGroup(target);
      tabElements.get(target.id).button.focus({ preventScroll: true });
    });
    tabElements.set(group.id, { button, value });
    tabs.append(button);
  });
  categorySelect.addEventListener('change', () => {
    const group = watchlist.groups.find((entry) => entry.id === categorySelect.value);
    if (group) selectGroup(group);
    categorySelect.value = '';
  });
}

function renderCategories() {
  for (const group of watchlist.groups) {
    const nodes = tabElements.get(group.id);
    const selected = group.id === activeGroup.id;
    const average = categoryAverage(group);
    const formatted = formatChange(average.value);
    nodes.value.textContent = formatted;
    const label = `${group.name}，平均涨幅 ${formatted}，${average.count}/${group.stocks.length} 只有行情`;
    nodes.button.title = label;
    nodes.button.setAttribute('aria-label', label);
    nodes.button.setAttribute('aria-selected', String(selected));
    nodes.button.tabIndex = selected ? 0 : -1;
  }
  stockPanel.setAttribute('aria-labelledby', `tab-${activeGroup.id}`);
}

function selectGroup(group) {
  activeGroup = group;
  writePreference(groupKey, group.id);
  renderCategories();
  renderStocks();
  stockList.scrollTop = 0;
  tabElements.get(group.id).button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderStocks() {
  el('group-name').textContent = activeGroup.name;
  const contents = document.createDocumentFragment();
  for (const stock of activeGroup.stocks) {
    const row = document.createElement('div');
    row.className = 'stock-row';
    row.setAttribute('role', 'listitem');
    const identity = document.createElement('div');
    identity.className = 'stock-identity';
    const name = document.createElement('span');
    name.className = 'stock-name';
    name.textContent = stock.name;
    const code = document.createElement('span');
    code.className = 'stock-code';
    code.textContent = stock.code;
    identity.append(name, code);

    const change = document.createElement('span');
    change.className = 'stock-change';
    const value = changes.get(stock.code);
    change.textContent = formatChange(value);
    if (!Number.isFinite(value)) {
      change.classList.add('missing');
      change.title = '暂无有效报价';
    }
    row.append(identity, change);
    contents.append(row);
  }
  stockList.replaceChildren(contents);
}

function marketDate(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(tradeDateFormatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function readSnapshot(data) {
  if (!data || typeof data !== 'object' || !data.quotes || typeof data.quotes !== 'object' || Array.isArray(data.quotes)) {
    throw new Error('行情格式错误');
  }

  const values = new Map();
  for (const [code, quote] of Object.entries(data.quotes)) {
    if (!/^\d{6}$/.test(code) || quote?.stale || !Number.isFinite(quote?.changePct)) continue;
    const date = quote.tradeDate || (quote.quotedAt ? marketDate(quote.quotedAt) : null);
    if (date && data.tradeDate && date !== data.tradeDate) continue;
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
    statusText.textContent = failure || '暂无行情，等待服务器更新';
  } else {
    const { tradeDate, updatedAt, stale } = activeSnapshot;
    const details = [];
    if (failure) details.push('连接失败，保留上次行情');
    else if (stale) details.push('上次行情');
    if (typeof tradeDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
      details.push(`交易日 ${tradeDate.slice(5)}`);
    }
    if (updatedAt && Number.isFinite(new Date(updatedAt).getTime())) {
      details.push(`拉取 ${statusTimeFormatter.format(new Date(updatedAt))}`);
    }
    statusText.textContent = details.join(' · ') || '行情已更新';
  }
  statusText.parentElement.dataset.ready = String(hasData && !failure && !activeSnapshot?.stale && !refreshing);
  retryButton.hidden = !failure || refreshing || needsToken(connection);
}

async function requestSnapshot(settings) {
  if (isTauri()) return invoke('fetch_quotes', settings);

  const address = settings.endpoint === localEndpoint && import.meta.env.DEV ? quotePath : settings.endpoint;
  const headers = settings.token ? { Authorization: `Bearer ${settings.token}` } : {};
  const response = await fetch(address, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function refreshQuotes() {
  if (refreshing) return;
  if (needsToken(connection)) {
    renderStatus();
    return;
  }
  const revision = connectionRevision;
  lastRequestAt = Date.now();
  refreshing = true;
  renderStatus();
  try {
    const snapshot = readSnapshot(await requestSnapshot(connection));
    if (revision !== connectionRevision) return;
    activeSnapshot = snapshot.data;
    changes = snapshot.values;
    failure = '';
    renderCategories();
    renderStocks();
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
    else void refreshQuotes();
  }
}

function startPolling() {
  clearInterval(intervalHandle);
  intervalHandle = setInterval(refreshQuotes, refreshInterval);
  void refreshQuotes();
}

retryButton.addEventListener('click', refreshQuotes);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - lastRequestAt >= refreshInterval) void refreshQuotes();
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
  const changed = connection.endpoint !== endpoint || connection.token !== token;
  connection = { endpoint, token };
  writePreference(settingsKey, JSON.stringify(connection));
  settingsDialog.close();
  if (changed) {
    connectionRevision += 1;
    activeSnapshot = null;
    changes = new Map();
    failure = '';
    renderCategories();
    renderStocks();
  }
  startPolling();
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
buildCategories();
renderCategories();
renderStocks();
tabElements.get(activeGroup.id).button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
startPolling();
