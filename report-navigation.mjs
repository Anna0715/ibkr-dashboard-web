const WORKSPACES = ['market', 'portfolio', 'holdings', 'analysis', 'trades', 'stocks', 'watchlist'];
const PRIORITY = ['analysis', 'trades', 'stocks', 'watchlist', 'holdings', 'portfolio', 'market'];
const PREFIX = 'ibkr-stock-analysis-';
const HISTORY_KEY = 'ibkrStockNavigation';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const normalize = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
const regexEscape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function headingSymbol(text) {
  return String(text ?? '').trim().replace(/\*\*|`/g, '').match(/^([A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)*)\s*[·｜|]\s*\S/)?.[1] ?? null;
}

function targetFor(record, workspace, headingText) {
  const symbol = headingSymbol(headingText);
  if (!symbol || !WORKSPACES.includes(workspace) || !/^\d{4}-\d{2}-\d{2}$/.test(record?.date ?? '')) return null;
  const identity = [String(record.id ?? ''), record.date, workspace, symbol, String(headingText)];
  return { id: PREFIX + encodeURIComponent(JSON.stringify(identity)), recordId: String(record.id ?? ''),
    date: record.date, frequency: record.frequency ?? 'daily', workspace, symbol, headingText: String(headingText) };
}

/** Attribute string for the existing h3; report text and layout remain unchanged. */
export function headingAttributes(record, workspace, headingText) {
  const target = targetFor(record, workspace, headingText);
  if (!target) return '';
  return ` id="${esc(target.id)}" tabindex="-1" data-report-anchor="${esc(target.id)}" data-report-record="${esc(target.recordId)}" data-report-date="${esc(target.date)}" data-report-workspace-target="${workspace}" data-report-symbol="${esc(target.symbol)}"`;
}

export function buildStockIndex(records = []) {
  const index = new Map(), seen = new Set();
  for (const record of records) {
    for (const workspace of WORKSPACES) {
      for (const block of record?.sections?.[workspace]?.blocks ?? []) {
        if (block.type !== 'heading') continue;
        const target = targetFor(record, workspace, block.text);
        if (!target || seen.has(target.id)) continue;
        seen.add(target.id);
        const entries = index.get(target.symbol) ?? [];
        entries.push(target);
        index.set(target.symbol, entries);
      }
    }
  }
  for (const entries of index.values()) entries.sort((a, b) => b.date.localeCompare(a.date)
    || PRIORITY.indexOf(a.workspace) - PRIORITY.indexOf(b.workspace) || a.id.localeCompare(b.id));
  return index;
}

export function createStockNavigator({ records = [], getFilter, setFilter }) {
  if (typeof getFilter !== 'function' || typeof setFilter !== 'function') throw new Error('Stock navigation requires report filter callbacks');
  const index = buildStockIndex(records), byId = new Map();
  for (const entries of index.values()) for (const target of entries) byId.set(target.id, target);
  const doc = typeof document === 'undefined' ? null : document;
  const win = doc?.defaultView ?? (typeof window === 'undefined' ? null : window);
  const symbols = [...index.keys()];
  if (index.has('GOOGL') && !symbols.includes('GOOG')) symbols.push('GOOG');
  const pattern = symbols.length ? new RegExp(`(?<![A-Za-z0-9_.-])(?:${symbols.sort((a, b) => b.length - a.length).map(regexEscape).join('|')})(?![A-Za-z0-9_.-])`, 'g') : null;
  let observer, refreshTimer, routeTimer, toastTimer, highlightTimer, highlighted, destroyed = false, navigationVersion = 0;

  const elementFor = target => doc?.getElementById(target.id) ?? null;
  const targetsFor = symbol => index.get(normalize(symbol) === 'GOOG' && index.has('GOOGL') ? 'GOOGL' : normalize(symbol)) ?? [];
  function chooseTarget(symbol) {
    const entries = targetsFor(symbol), filter = getFilter() ?? {};
    return entries.find(target => (filter.date === 'all' || !filter.date || filter.date === target.date)
      && (filter.frequency === 'all' || !filter.frequency || filter.frequency === target.frequency)) ?? entries.find(elementFor) ?? entries[0];
  }
  const targetHash = target => '#' + encodeURIComponent(target.id);
  function href(symbol) { const target = chooseTarget(symbol); return target ? targetHash(target) : undefined; }
  function link(symbol, label = symbol) {
    const target = chooseTarget(symbol), code = normalize(symbol);
    if (!target) return esc(label);
    return `<a class="stock-analysis-link" href="${esc(targetHash(target))}" data-stock-symbol="${esc(code)}" title="${esc(`查看 ${code} 的逐股分析 · 报告日期 ${target.date}`)}">${esc(label)}</a>`;
  }

  function showWorkspace(workspace) {
    if (win?.InvestmentShell?.showWorkspace) win.InvestmentShell.showWorkspace(workspace);
    else doc?.querySelector(`.workspace-nav [data-workspace="${workspace}"]`)?.click();
  }
  function notify(message) {
    if (!doc?.body) return;
    let toast = doc.getElementById('stock-navigation-status');
    if (!toast) {
      toast = doc.createElement('div'); toast.id = 'stock-navigation-status'; toast.className = 'stock-navigation-toast';
      toast.setAttribute('role', 'status'); toast.setAttribute('aria-live', 'polite'); toast.setAttribute('aria-atomic', 'true');
      doc.body.append(toast);
    }
    toast.textContent = message; toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 5500);
  }
  function deduplicateHeadingIds() {
    if (!doc) return;
    const used = new Set([...doc.querySelectorAll('[id]:not([data-report-anchor])')].map(node => node.id));
    for (const node of doc.querySelectorAll('[data-report-anchor]')) {
      const base = node.dataset.reportAnchor;
      if (!byId.has(base)) continue;
      let id = base, suffix = 1;
      while (used.has(id)) id = `${base}--copy-${++suffix}`;
      if (node.id !== id) node.id = id;
      used.add(id);
    }
  }
  function scanRoots(root) {
    if (root !== doc) return root?.nodeType === 1 ? [root] : [];
    const roots = [...doc.querySelectorAll(WORKSPACES.map(workspace => `#${workspace}-page`).join(',')),
      ...doc.querySelectorAll('[data-report-workspace]')];
    return [...new Set(roots)].filter(node => !roots.some(parent => parent !== node && parent.contains(node)));
  }
  function refresh(root = doc) {
    if (!doc || !root || destroyed) return;
    observer?.disconnect();
    try {
      deduplicateHeadingIds();
      if (!pattern) return;
      const skip = 'a,button,select,option,input,textarea,script,style,svg,math,code,pre,noscript,[contenteditable],[aria-hidden="true"],[data-stock-no-link],[data-report-anchor]';
      for (const scope of scanRoots(root)) {
        const walker = doc.createTreeWalker(scope, win?.NodeFilter?.SHOW_TEXT ?? 4), nodes = [];
        while (walker.nextNode()) if (!walker.currentNode.parentElement?.closest(skip)) nodes.push(walker.currentNode);
        for (const node of nodes) {
          const text = node.nodeValue ?? '', matches = [...text.matchAll(pattern)].filter(match => match[0] !== 'IBKR'
            || node.parentElement?.closest('td:first-child,.ticker-title,.report-symbols,.allocation-label,.rc-legend'));
          if (!matches.length || !node.parentNode) continue;
          const fragment = doc.createDocumentFragment(); let start = 0;
          for (const match of matches) {
            const target = chooseTarget(match[0]); if (!target) continue;
            fragment.append(doc.createTextNode(text.slice(start, match.index)));
            const anchor = doc.createElement('a'); anchor.className = 'stock-analysis-link';
            anchor.href = targetHash(target); anchor.dataset.stockSymbol = match[0]; anchor.textContent = match[0];
            anchor.title = `查看 ${match[0]} 的逐股分析 · 报告日期 ${target.date}`;
            fragment.append(anchor); start = match.index + match[0].length;
          }
          fragment.append(doc.createTextNode(text.slice(start))); node.replaceWith(fragment);
        }
      }
    } finally {
      if (!destroyed && observer && doc.body) observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
    }
  }
  function scheduleRefresh() {
    if (refreshTimer || destroyed) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 0);
  }
  function targetFromHash(hash) {
    try { return byId.get(decodeURIComponent(String(hash ?? '').replace(/^#/, ''))); }
    catch { return undefined; }
  }
  function captureView() {
    const filter = getFilter() ?? {}, target = targetFromHash(win?.location.hash);
    return { filter: { date: filter.date ?? 'all', frequency: filter.frequency ?? 'daily' },
      workspace: win?.InvestmentShell?.getWorkspace?.() ?? 'market',
      targetId: target && elementFor(target) ? target.id : null,
      x: win?.scrollX ?? 0, y: win?.scrollY ?? 0 };
  }
  function writeHistory(method, view, hash) {
    if (!win?.history) return;
    try { win.history[method]({ ...(win.history.state ?? {}), [HISTORY_KEY]: view }, '', hash ?? win.location.href); }
    catch { /* A browser with disabled history still supports in-page navigation. */ }
  }
  async function waitForHeading(target) {
    if (elementFor(target)) return elementFor(target);
    if (!win?.MutationObserver || !doc?.body) return null;
    return new Promise(resolve => {
      const pending = new win.MutationObserver(() => { const node = elementFor(target); if (node) finish(node); });
      const timeout = setTimeout(() => finish(null), 1800);
      const finish = node => { clearTimeout(timeout); pending.disconnect(); resolve(node); };
      pending.observe(doc.body, { childList: true, subtree: true });
    });
  }
  async function navigateTarget(target, { push = true, symbol = target.symbol, announce = true } = {}) {
    if (!doc || destroyed) return false;
    const version = ++navigationVersion;
    if (push) writeHistory('replaceState', captureView());
    refresh();
    let changed = false;
    if (!elementFor(target)) {
      try { setFilter({ date: target.date, frequency: 'daily' }); changed = true; }
      catch { notify('暂时无法切换到该报告，请稍后重试。'); return false; }
      refresh();
    }
    showWorkspace(target.workspace);
    const heading = await waitForHeading(target);
    if (version !== navigationVersion || destroyed) return false;
    if (!heading) { notify(`未能定位 ${target.date} 的 ${symbol} 分析，请重新载入报告。`); return false; }
    if (push) writeHistory('pushState', { ...captureView(), workspace: target.workspace, targetId: target.id }, targetHash(target));
    highlighted?.classList.remove('report-stock-target'); highlighted = heading;
    heading.classList.add('report-stock-target');
    clearTimeout(highlightTimer); highlightTimer = setTimeout(() => heading.classList.remove('report-stock-target'), 5000);
    heading.focus({ preventScroll: true });
    const reduced = win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    heading.scrollIntoView?.({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    if (announce) notify(`${changed ? '已切换到' : '已定位至'} ${target.date} 日报的 ${symbol} 分析${symbol === 'GOOG' && target.symbol === 'GOOGL' ? '（与 GOOGL 共用发行人分析）' : ''}${changed ? '；日期筛选已更新。' : '；保留当前筛选。'}`);
    return true;
  }
  function onClick(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const anchor = event.target?.closest?.('a[href]'); if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return;
    let url; try { url = new URL(anchor.getAttribute('href'), win.location.href); } catch { return; }
    if (url.origin !== win.location.origin || url.pathname !== win.location.pathname || url.search !== win.location.search) return;
    const target = targetFromHash(url.hash); if (!target) return;
    event.preventDefault();
    void navigateTarget(target, { symbol: anchor.dataset.stockSymbol || target.symbol });
  }
  function restoreView(view) {
    if (!view || !WORKSPACES.includes(view.workspace) || !view.filter || !['daily', 'weekly', 'all'].includes(view.filter.frequency)
      || !(view.filter.date === 'all' || /^\d{4}-\d{2}-\d{2}$/.test(view.filter.date))) return false;
    try { setFilter({ date: view.filter.date, frequency: view.filter.frequency }); } catch { return false; }
    showWorkspace(view.workspace); refresh(); return true;
  }
  function routeLocation() {
    if (destroyed || !win) return;
    const saved = win.history.state?.[HISTORY_KEY], restored = restoreView(saved);
    if (restored && saved.targetId === null) {
      win.scrollTo?.({ left: Number(saved.x) || 0, top: Number(saved.y) || 0, behavior: 'auto' }); return;
    }
    const target = targetFromHash(win.location.hash);
    if (target) void navigateTarget(target, { push: false });
  }
  function scheduleRoute() { clearTimeout(routeTimer); routeTimer = setTimeout(routeLocation, 0); }
  if (doc && win) {
    doc.addEventListener('click', onClick);
    win.addEventListener('hashchange', scheduleRoute); win.addEventListener('popstate', scheduleRoute);
    win.addEventListener('investment-report-filter-change', scheduleRefresh);
    if (win.MutationObserver) observer = new win.MutationObserver(scheduleRefresh);
    refresh(); scheduleRoute();
  }
  return { href, link, refresh, navigate: symbol => {
    const target = chooseTarget(symbol); return target ? navigateTarget(target, { symbol: normalize(symbol) }) : Promise.resolve(false);
  }, destroy() {
    destroyed = true; navigationVersion++;
    observer?.disconnect(); clearTimeout(refreshTimer); clearTimeout(routeTimer); clearTimeout(toastTimer); clearTimeout(highlightTimer);
    doc?.removeEventListener('click', onClick); win?.removeEventListener('hashchange', scheduleRoute);
    win?.removeEventListener('popstate', scheduleRoute); win?.removeEventListener('investment-report-filter-change', scheduleRefresh);
    highlighted?.classList.remove('report-stock-target');
  } };
}
