/* Small, dependency-free charts derived only from the selected report record. */
const PERIODS = ['1D', '5D', '1M'];
const TERMINAL = new Set(['CANCELLED', 'FILLED', 'REJECTED', 'EXPIRED']);
const COLORS = ['#a78bfa', '#60a5fa', '#50d8a6', '#eecb78', '#c084fc', '#67e8f9'];
let serial = 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
const plain = value => String(value ?? '').replace(/\*\*|`/g, '').trim();
const symbolOf = value => plain(value).match(/^([A-Z][A-Z0-9.:-]*)\b/)?.[1] ?? null;
const sourceDate = record => record.closeDate || record.marketAsOf || record.date || '日期未提供';
const sourceStamp = record => record.sourceCapturedAt || record.cutoff || '';
const isHistoricalRecovery = record => /^historical-report(?:-|$)/.test(String(record.id ?? '')) || record.originalClaimsOnly === true || record.coverage?.originalClaimsOnly === true || ['complete', 'partial'].includes(record.contentRecovery);
const tableOf = (record, workspace, required) => (record.sections?.[workspace]?.blocks ?? []).find(block => block.type === 'table' && required.every(header => block.headers?.includes(header)));

/** Returns a number only when the entire value is numeric; missing text stays null.
 *  Percent numbers use percentage units: 1.29 means 1.29%, not 0.0129. */
export function parseReportNumber(value, {percent = false} = {}) {
  if (finite(value)) return value;
  let raw = plain(value).replace(/[−–]/g, '-');
  if (percent && !raw.endsWith('%')) return null;
  if (!percent) raw = raw.replace(/^(?:USD\s*|\$)/, '').replace(/\s*USD$/, '');
  const pattern = percent ? /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%$/ : /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
  if (!pattern.test(raw)) return null;
  const number = Number(raw.replace(/[,％%]/g, ''));
  return finite(number) ? number : null;
}

function metricInCard(text, period) {
  const pattern = new RegExp(`(?:^|[｜|；;\\s])${period}\\s*([+\\-−]?\\d+(?:\\.\\d+)?%)`);
  const match = plain(text).match(pattern);
  return match ? parseReportNumber(match[1], {percent:true}) : null;
}

/** Reads explicit return matrices and the original cards' first close paragraph.
 *  Same-issuer share classes remain separate. Conflicting values are omitted. */
export function extractHistoricalReturns(record, workspace = 'market') {
  const scopes = workspace === 'market' ? ['analysis', 'trades', 'stocks', 'watchlist'] : [workspace];
  const rows = new Map();
  const add = (symbol, values, source) => {
    if (!symbol) return;
    const row = rows.get(symbol) ?? {symbol, label:symbol, values:{'1D':null, '5D':null, '1M':null}, conflicts:[], sources:[]};
    for (const period of PERIODS) {
      if (!finite(values[period]) || row.conflicts.includes(period)) continue;
      if (finite(row.values[period]) && Math.abs(row.values[period] - values[period]) > 1e-8) {
        row.values[period] = null;
        row.conflicts.push(period);
      } else row.values[period] = values[period];
    }
    if (source && !row.sources.includes(source)) row.sources.push(source);
    rows.set(symbol, row);
  };
  for (const scope of scopes) {
    const blocks = record.sections?.[scope]?.blocks ?? [];
    let cardSymbol = null, cardQuoteRead = false;
    for (const block of blocks) {
      if (block.type === 'heading') {
        const match = plain(block.text).match(/^([A-Z][A-Z0-9.:-]*)\s+·\s/);
        cardSymbol = match?.[1] ?? null;
        cardQuoteRead = false;
        if (cardSymbol) add(cardSymbol, {}, `${scope} · 原分析卡`);
      } else if (block.type === 'paragraph' && cardSymbol && !cardQuoteRead && /^收盘\s/.test(plain(block.text))) {
        add(cardSymbol, Object.fromEntries(PERIODS.map(period => [period, metricInCard(block.text, period)])), `${scope} · 原卡片量价段`);
        cardQuoteRead = true;
      }
      if (block.type !== 'table' || !PERIODS.every(period => block.headers?.includes(period)) || !block.headers?.includes('证券')) continue;
      const indexes = Object.fromEntries(['证券', ...PERIODS].map(header => [header, block.headers.indexOf(header)]));
      for (const cells of block.rows ?? []) add(symbolOf(cells[indexes['证券']]), Object.fromEntries(PERIODS.map(period => [period, parseReportNumber(cells[indexes[period]], {percent:true})])), `${scope} · 原行情表`);
    }
  }
  return [...rows.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function historicalHoldings(record) {
  const table = tableOf(record, 'holdings', ['证券', '收盘重估市值', '重算浮盈', '重算日损益']);
  if (!table) return [];
  const indexes = Object.fromEntries(table.headers.map((header, index) => [header, index]));
  return table.rows.map(cells => ({symbol:symbolOf(cells[indexes['证券']]), label:plain(cells[indexes['证券']]), value:parseReportNumber(cells[indexes['收盘重估市值']]), pnl:parseReportNumber(cells[indexes['重算浮盈']]), dailyPnl:parseReportNumber(cells[indexes['重算日损益']]), currency:'USD'})).filter(row => row.symbol);
}

function snapshotHoldings(record) {
  return (record.snapshot?.positions ?? []).map(position => ({symbol:position.symbol || position.contract_description, label:position.symbol || position.contract_description, value:finite(position.market_value) ? position.market_value : null, pnl:finite(position.unrealized_pnl) ? position.unrealized_pnl : null, dailyPnl:finite(position.daily_pnl) ? position.daily_pnl : null, currency:position.currency || '未提供币种'}));
}

function orderSymbol(order) { return order.symbol || String(order.primary_description ?? '').match(/^(?:Buy|Sell)\s+[\d.]+\s+(\S+)/i)?.[1] || null; }

/** Per-record stock amounts only. Replacement chains are never summed. */
export function extractOrderAmounts(record) {
  const rows = [];
  let excludedTerminal = 0, options = 0, unknown = 0;
  if (record.kind === 'account-snapshot') {
    for (const order of record.snapshot?.orders ?? []) {
      if (TERMINAL.has(order.order_status)) { excludedTerminal++; continue; }
      if (/\b(?:Put|Call)\b/i.test(String(order.primary_description ?? ''))) { options++; continue; }
      const symbol = orderSymbol(order), quantity = parseReportNumber(order.remaining_shares_qty), price = parseReportNumber(order.limit_price);
      if (!symbol || !finite(quantity) || quantity < 0 || !finite(price) || price < 0) { unknown++; continue; }
      rows.push({symbol, label:`${symbol} · ${order.order_status || '状态未提供'} · #${order.order_id ?? rows.length + 1}`, value:quantity * price, status:order.order_status, quantity, price, pending:order.order_status === 'REPLACED', sourceId:order.order_id, currency:order.currency || null});
    }
  } else {
    const table = tableOf(record, 'trades', ['标的', '方向／工具', '数量', '限价/权利金', '状态']);
    if (!table) return {rows, excludedTerminal, options, unknown};
    const indexes = Object.fromEntries(table.headers.map((header, index) => [header, index]));
    for (const [index, cells] of table.rows.entries()) {
      const status = plain(cells[indexes['状态']]), tool = plain(cells[indexes['方向／工具']]);
      if (TERMINAL.has(status)) { excludedTerminal++; continue; }
      if (/Put|Call|期权/i.test(tool)) { options++; continue; }
      if (!/股票/.test(tool)) { unknown++; continue; }
      const symbol = symbolOf(cells[indexes['标的']]), quantity = parseReportNumber(cells[indexes['数量']]), price = parseReportNumber(cells[indexes['限价/权利金']]);
      if (!symbol || !finite(quantity) || quantity < 0 || !finite(price) || price < 0) { unknown++; continue; }
      rows.push({symbol, label:`${symbol} · ${status} · 原表第 ${index + 1} 条`, value:quantity * price, status, quantity, price, pending:status === 'REPLACED', sourceRow:index + 1, currency:'USD'});
    }
  }
  return {rows, excludedTerminal, options, unknown};
}

export function snapshotPriorityCounts(record, fixedPool = []) {
  const snapshot = record.snapshot ?? {};
  const held = new Set((snapshot.positions ?? []).map(position => position.symbol || position.contract_description).filter(Boolean));
  const ordered = new Set((snapshot.orders ?? []).filter(order => !TERMINAL.has(order.order_status)).map(orderSymbol).filter(Boolean));
  const lists = snapshot.watchlists ?? [];
  const waiting = new Set(lists.filter(list => list.role === 'waiting').flatMap(list => (list.instruments ?? []).map(instrument => instrument.symbol || instrument.contract_description)).filter(Boolean));
  const all = new Set([...held, ...ordered, ...lists.flatMap(list => (list.instruments ?? []).map(instrument => instrument.symbol || instrument.contract_description)), ...fixedPool.map(instrument => typeof instrument === 'string' ? instrument : instrument.symbol), ...(record.coverage?.fixedPoolMissingFromWatchlists ?? [])].filter(Boolean));
  const counts = {holding:0, order:0, waiting:0, watch:0};
  for (const symbol of all) counts[held.has(symbol) ? 'holding' : ordered.has(symbol) ? 'order' : waiting.has(symbol) ? 'waiting' : 'watch']++;
  return {counts, total:all.size};
}

/** Models expose chart inputs and source notes for bounded tests and integration. */
export function getReportChartData(record, workspace, {fixedPool = []} = {}) {
  if (!record || record.frequency === 'weekly') return [];
  const daily = record.kind === 'daily-report';
  const historical = daily && isHistoricalRecovery(record);
  const date = daily ? sourceDate(record) : record.date;
  const models = [];
  if (daily && ['market', 'stocks', 'watchlist'].includes(workspace)) {
    const rows = extractHistoricalReturns(record, workspace);
    if (rows.length) models.push({type:'returns', title:workspace === 'market' ? historical ? '原日报证券表现' : '日报证券表现' : '本栏目证券表现', date, rows, expected:workspace === 'market' ? (record.sourceCoverage?.security_codes ?? rows.length) : rows.length, notes:['1D、5D、1M来自本日原行情表和量价卡；这是区间收益比较，没有重建时间序列。', '未获取和冲突数据不画成零。GOOG / GOOGL保留各自报价；本图不是板块资金净流量。', ...(historical ? ['原报告历史数值，本次未重新核验。'] : [])]});
  }
  if (['holdings', 'analysis'].includes(workspace)) {
    const holdings = daily ? historicalHoldings(record) : snapshotHoldings(record);
    const currencies = [...new Set(holdings.map(row => row.currency))];
    for (const currency of currencies) {
      const rows = holdings.filter(row => row.currency === currency);
      const basis = daily ? `${historical ? '原' : ''}${date}收盘重估` : '持仓接口mark快照';
      const notes = [daily ? historical ? `假设原表持仓数量在${date}收盘已存在；与原报告当前mark表分开。` : '采用本日报持仓表的收盘重估市值；数量时点和重估依据以报告来源说明为准。' : '采用此记录的持仓接口市值，不与账户摘要净值或较早绩效日期混合。', '占比仅以本表已列正市值持仓为分母，不包括现金、购买力或其他资产。'];
      if (sourceStamp(record)) notes.push(`该记录来源时间：${sourceStamp(record)}`);
      models.push({type:'allocation', title:`持仓市值分布 · ${basis}`, date, currency, rows, notes});
      models.push({type:'pnl', title:`持仓盈亏 · ${basis}`, date, currency, rows, closeRevaluation:daily, notes:[daily ? historical ? '原表重算浮盈和日损益；不是已实现收益或账户TWR。' : '本日报表内重算浮盈和日损益；不是已实现收益或账户TWR。' : '接口未实现盈亏与daily_pnl原字段分开。daily_pnl会话起点未核验，不能当作所选收盘日的日损益；不把入金、购买力或市值变化当作收益。', `与同一持仓记录对应 · ${currency}`]});
    }
  }
  if (workspace === 'trades') {
    const amounts = extractOrderAmounts(record);
    if (amounts.rows.length) models.push({type:'orders', title:'逐笔股票限价名义金额', date, rows:amounts.rows, currency:daily ? 'USD' : null, notes:[daily ? historical ? '历史原表股数 × 限价；不是已核验的当前剩余数量或实时预算。' : '本日报表内股数 × 限价；数量时点和订单状态以报告来源说明为准，不等同于实时剩余数量或可合并预算。' : '接口剩余数量 × 限价。订单没有返回独立计价币种，因此保留原计价单位、不换算为USD。', '每条记录独立显示。REPLACED是替换链待核验，不视为已确认独立有效；不计算合计资金压力。', `${amounts.options} 条期权记录保留于原表，不套用合约乘数或推算接货额；${amounts.excludedTerminal} 条终止记录排除；${amounts.unknown} 条字段不足。`]});
  }
  if (daily && workspace === 'portfolio') {
    const table = tableOf(record, 'portfolio', ['表现', '与账户差值']);
    if (table) {
      const valueIndex = table.headers.indexOf('表现');
      const rows = table.rows.map(cells => ({label:plain(cells[0]), value:parseReportNumber(cells[valueIndex], {percent:true})}));
      if (rows.some(row => finite(row.value))) models.push({type:'bars', title:historical ? '原日报同区间账户与基准' : '日报同区间账户与基准', date, unit:'percent', rows, notes:[`${table.headers[0]} · 采用原表表现列，未重新计算。`, '账户TWR与ETF价格回报口径不同；此图不是统一含息总回报，也不代表其他日期的新绩效。']});
    }
  }
  if (!daily && ['watchlist', 'stocks'].includes(workspace)) {
    const priority = snapshotPriorityCounts(record, fixedPool);
    const labels = {holding:'持仓', order:'挂单（含待核验）', waiting:'等待买点', watch:'其他关注 / 固定池'};
    models.push({type:'bars', title:'去重后的分析优先级', date, unit:'count', rows:Object.entries(priority.counts).map(([key, value]) => ({label:labels[key], value})), notes:[`本快照共 ${priority.total} 个唯一标的。持仓 → 挂单 → 等待买点 → 其他关注，每个标的仅归一个主栏目。`, '这是覆盖数量，不是风险评分、买入建议或行业分布。']});
  }
  if (daily && !historical) for (const model of models) {
    model.notes.push('数值来自该日报保存数据；核验状态、数据时点与缺口以报告来源说明为准。');
    if (record.sourceNote) model.notes.push(record.sourceNote);
  }
  return models;
}

function safeHref(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\\]/.test(value) || value.startsWith('//')) return null;
  if (/^(?:#|\?|\.\/|\/)/.test(value)) return value;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}

function link(symbol, label, symbolLink, svg = false, attributes = '') {
  let href = null;
  try { if (symbol && typeof symbolLink === 'function') href = safeHref(symbolLink(symbol, label)); } catch { /* Missing route keeps the truthful label. */ }
  return href ? `<a href="${esc(href)}" data-stock-symbol="${esc(symbol)}" ${attributes}>${svg ? label : esc(label)}</a>` : svg ? label : esc(label);
}

function numberLabel(value, unit = 'number', currency) {
  if (!finite(value)) return '未获取';
  if (unit === 'percent') return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
  if (unit === 'count') return String(value);
  return `${currency === 'USD' ? '$' : ''}${new Intl.NumberFormat('zh-CN', {maximumFractionDigits:2}).format(value)}`;
}

function notes(values) { return `<div class="rc-notes">${values.map(value => `<p>${esc(value)}</p>`).join('')}</div>`; }

function bars(rows, {title, date, unit = 'number', currency, symbolLink, signed = true} = {}) {
  const valid = rows.filter(row => finite(row.value));
  if (!valid.length) return '<p class="rc-empty">此字段未取得可绘制数值。</p>';
  const minimum = Math.min(0, ...valid.map(row => row.value)), maximum = Math.max(0, ...valid.map(row => row.value));
  const span = maximum - minimum || 1;
  const x = value => (value - minimum) / span * 100;
  const zero = x(0);
  const axis = `<div class="rc-html-row rc-html-axis" aria-hidden="true"><span>${unit === 'percent' ? '区间收益' : unit === 'count' ? '标的数量' : currency || '原计价单位'}</span><span class="rc-html-scale"><small>${esc(numberLabel(minimum, unit, currency))}</small>${minimum < 0 && maximum > 0 ? `<small class="rc-scale-zero" style="left:${zero}%">0</small>` : ''}<small>${minimum === maximum ? '' : esc(numberLabel(maximum, unit, currency))}</small></span><span>数值</span></div>`;
  const marks = valid.map((row, index) => {
    const point = x(row.value), barWidth = Math.abs(point - zero);
    const fill = row.pending ? '#eecb78' : signed ? row.value < 0 ? '#eecb78' : '#50d8a6' : COLORS[index % COLORS.length];
    const label = link(row.symbol, row.label, symbolLink);
    const value = numberLabel(row.value, unit, currency), accessible = `${row.label}：${value}${row.pending ? ' · 替换链待核验' : ''}`;
    return `<div class="rc-html-row" role="group" aria-label="${esc(accessible)}"><span class="rc-html-label">${label}</span><span class="rc-html-track" aria-hidden="true"><i class="rc-html-zero" style="left:${zero}%"></i><i class="rc-html-fill${row.pending ? ' rc-pending' : ''}" style="left:${Math.min(point, zero)}%;width:${barWidth}%;background:${fill}"></i>${row.value === 0 ? `<i class="rc-html-zero-dot" style="left:${zero}%;background:${fill}"></i>` : ''}</span><strong class="rc-html-value">${esc(value)}</strong></div>`;
  }).join('');
  return `<div class="rc-html-bars" role="region" aria-label="${esc(title)} · ${esc(date)}">${axis}${marks}</div>`;
}

function allocation(model, symbolLink) {
  const rows = model.rows.filter(row => finite(row.value) && row.value > 0);
  const excluded = model.rows.length - rows.length, total = rows.reduce((sum, row) => sum + row.value, 0);
  if (!total) return '<p class="rc-empty">没有可作为市值分母的已知正市值持仓。</p>';
  const id = `rc-chart-${++serial}`, circumference = 2 * Math.PI * 75;
  let offset = 0;
  const slices = rows.map((row, index) => {
    const length = row.value / total * circumference;
    const slice = `<circle cx="120" cy="120" r="75" fill="none" stroke="${COLORS[index % COLORS.length]}" stroke-width="30" stroke-dasharray="${length} ${circumference}" stroke-dashoffset="${-offset}" transform="rotate(-90 120 120)"><title>${esc(row.label)} ${numberLabel(row.value, 'number', model.currency)} · ${(row.value / total * 100).toFixed(2)}%</title></circle>`;
    offset += length;
    return slice;
  }).join('');
  const legend = rows.map((row, index) => `<li><i aria-hidden="true" style="background:${COLORS[index % COLORS.length]}"></i><span>${link(row.symbol, row.label, symbolLink)}</span><strong>${(row.value / total * 100).toFixed(2)}%</strong><small>${esc(numberLabel(row.value, 'number', model.currency))}</small></li>`).join('');
  const description = `${model.date}，${model.currency}。仅本表正市值持仓。${rows.map(row => `${row.label} ${(row.value / total * 100).toFixed(2)}%，市值${numberLabel(row.value, 'number', model.currency)}`).join('；')}。`;
  return `<div class="rc-allocation"><svg class="rc-donut" viewBox="0 0 240 240" role="img" aria-labelledby="${id}-title ${id}-desc"><title id="${id}-title">持仓市值分布 · ${esc(model.date)}</title><desc id="${id}-desc">${esc(description)}</desc><circle cx="120" cy="120" r="75" fill="none" stroke="#2a2b3a" stroke-width="30"/>${slices}<text class="rc-donut-count" x="120" y="116" text-anchor="middle">${rows.length} 只</text><text class="rc-donut-label" x="120" y="138" text-anchor="middle">${esc(model.currency)} 市值占比</text></svg><ul class="rc-legend">${legend}</ul></div>${excluded ? `<p class="rc-empty">${excluded} 条市值缺失、为零或非正值的记录未纳入饼图分母，原表仍保留。</p>` : ''}`;
}

function modelBody(model, symbolLink) {
  if (model.type === 'allocation') return allocation(model, symbolLink);
  if (model.type === 'returns') return PERIODS.map((period, index) => {
    const rows = model.rows.filter(row => finite(row.values[period])).map(row => ({...row, value:row.values[period]})).sort((a, b) => b.value - a.value);
    const missing = Math.max(0, model.expected - rows.length), conflicts = model.rows.filter(row => row.conflicts.includes(period)).length;
    return `<details class="rc-period"${index === 0 ? ' open' : ''}><summary>${period} · ${rows.length}/${model.expected} 有值 <span>${missing} 缺失${conflicts ? ` · ${conflicts} 冲突` : ''}</span></summary>${bars(rows, {...model, title:`${model.title} · ${period}`, unit:'percent', symbolLink})}</details>`;
  }).join('');
  if (model.type === 'pnl') return [{key:'pnl', label:model.closeRevaluation ? '收盘重算浮盈' : '接口未实现盈亏'}, {key:'dailyPnl', label:model.closeRevaluation ? '收盘重算日损益' : '快照区间损益 · 起点未核验'}].map(({key, label}, index) => `<details class="rc-period"${index === 0 ? ' open' : ''}><summary>${label}</summary>${bars(model.rows.map(row => ({...row, value:row[key]})), {...model, title:label, symbolLink})}</details>`).join('');
  return bars(model.rows, {...model, symbolLink, signed:model.type !== 'orders' && model.unit !== 'count'});
}

/** Internal cards only: safe to insert inside the original report panel.
 *  symbolLink(symbol, label) returns a safe href, not an HTML fragment.
 *  fixedPool is optional; snapshot coverage also retains fixed-pool omissions. */
export function renderReportCharts(record, workspace, {symbolLink, fixedPool = []} = {}) {
  const models = getReportChartData(record, workspace, {fixedPool});
  if (!models.length) return '';
  const daily = record.kind === 'daily-report', historical = daily && isHistoricalRecovery(record);
  const caption = model => daily && !historical ? `日报来源数据 · 收盘日期 ${sourceDate(record)} · 报告发布日期 ${record.reportDate || record.date || '日期未提供'}${model.currency ? ` · ${model.currency}` : ''}` : `${model.date}${model.currency ? ` · ${model.currency}` : ''}${historical ? ' · 历史原文' : ' · 账户快照'}`;
  return `<div class="report-charts">${models.map(model => `<figure class="rc-card"><figcaption><h3>${esc(model.title)}</h3><span>${esc(caption(model))}</span></figcaption>${modelBody(model, symbolLink)}${notes(model.notes)}</figure>`).join('')}</div>`;
}
