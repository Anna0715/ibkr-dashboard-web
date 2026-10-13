#!/usr/bin/env node
/** Portable, dependency-free report preparation. This module never runs git or publishes. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, link, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKSPACES = Object.freeze(['market', 'portfolio', 'holdings', 'analysis', 'trades', 'stocks', 'watchlist']);
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const GENERATION_KEYS = new Set(['generatedAt', 'generated_at', 'preparedAt', 'importedAt']);
const MANAGED_RECORD_KEYS = new Set(['id', 'revisionOf', 'pipeline', 'originalReportPath', 'sourceCapturedAt', 'frequency', 'format', 'kind', 'date', 'weekEnd']);
const BUNDLE_KEYS = new Set(['record', 'data', 'market', 'archiveHtml']);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, label) => typeof value === 'string' && value.trim().length > 0 ? value : fail(`${label} must be a nonempty string`);
const escape = value => String(value ?? '未提供').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const normalizedKey = key => key.toLowerCase().replace(/[^a-z0-9]/g, '');

export function calendarDate(value, label = 'date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label} must be YYYY-MM-DD`);
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(`${label} is not a real calendar date`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) fail(`${label} must include seconds and an explicit timezone`);
  calendarDate(value.slice(0, 10), label);
  const hour = Number(value.slice(11, 13)), minute = Number(value.slice(14, 16)), second = Number(value.slice(17, 19));
  const zone = value.match(/([+-])(\d{2}):(\d{2})$/);
  if (hour > 23 || minute > 59 || second > 59 || zone && (Number(zone[2]) > 14 || Number(zone[3]) > 59 || Number(zone[2]) === 14 && Number(zone[3]) !== 0)) fail(`${label} is not a real timestamp`);
  const result = Date.parse(value);
  if (!Number.isFinite(result)) fail(`${label} is not a real timestamp`);
  return result;
}

function publicUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { fail(`${label} must be a public HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail(`${label} must be a public HTTP(S) URL without credentials`);
  for (const key of url.searchParams.keys()) if (/(?:token|secret|password|credential|authorization|api.?key|account.?id|email)/i.test(key)) fail(`${label} contains a private query parameter`);
  return url;
}

/** Validate the incoming bundle only; historical records are intentionally not scanned. */
export function assertPublic(value, label = 'bundle', depth = 0) {
  if (depth > 80) fail(`${label} exceeds the supported nesting depth`);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(`${label} contains a nonfinite number`); return; }
  if (typeof value === 'string') {
    if (/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/i.test(value)) fail(`${label} contains an email address`);
    if (/\b(?:DU|U)\d{5,}\b|-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sb_secret_[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,})\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\bBearer\s+[A-Za-z0-9._-]{8,}/i.test(value)) fail(`${label} contains a private identifier or credential`);
    if (/\b(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret)\s*[:=]\s*[^\s,;]+/i.test(value)) fail(`${label} contains credential text`);
    for (const match of value.matchAll(/https?:\/\/[^\s<>"'\])]+/g)) publicUrl(match[0], label);
    return;
  }
  if (Array.isArray(value)) { value.forEach((entry, index) => assertPublic(entry, `${label}[${index}]`, depth + 1)); return; }
  if (!object(value)) fail(`${label} contains an unsupported value`);
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (['__proto__', 'prototype', 'constructor'].includes(key) || /^(?:account(?:id|ids|number|numbers)|order(?:id|ids)|trade(?:id|ids)|user(?:id|name)|credentials?|password|passwd|pwd|tokens?|accesstokens?|refreshtokens?|idtokens?|secrets?|authorization|apikeys?|privatekeys?|cookies?|session(?:id|token)?|emails?|emailaddress)$/.test(normalized)) fail(`${label}.${key} is private; use publicOrderRef or an ordinal for anonymous order references`);
    if (/(?:path|paths|filename|filepath|files)$/.test(normalized)) fail(`${label}.${key} is not an accepted output path`);
    assertPublic(entry, `${label}.${key}`, depth + 1);
  }
}

function cell(value, label) {
  if (value !== null && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) fail(`${label} must be text, a finite number, or null`);
}

function blocks(value, label) {
  if (!Array.isArray(value) || !value.length) fail(`${label} must contain at least one block`);
  value.forEach((block, index) => {
    const name = `${label}[${index}]`;
    if (!object(block)) fail(`${name} must be an object`);
    if (['paragraph', 'text', 'heading'].includes(block.type)) text(block.text, `${name}.text`);
    else if (block.type === 'table') {
      if (!Array.isArray(block.headers) || !block.headers.length) fail(`${name}.headers must be nonempty`);
      block.headers.forEach((header, i) => text(header, `${name}.headers[${i}]`));
      if (!Array.isArray(block.rows)) fail(`${name}.rows must be an array`);
      block.rows.forEach((row, i) => {
        if (!Array.isArray(row) || row.length !== block.headers.length) fail(`${name}.rows[${i}] has the wrong column count`);
        row.forEach((value, column) => cell(value, `${name}.rows[${i}][${column}]`));
      });
    } else if (block.type === 'list') {
      if (!Array.isArray(block.items) || !block.items.length) fail(`${name}.items must be nonempty`);
      block.items.forEach((item, i) => cell(item, `${name}.items[${i}]`));
    } else fail(`${name}.type is unsupported`);
  });
}

function dateList(value, label, start, end) {
  if (!Array.isArray(value)) fail(`${label} must be an explicit array`);
  const dates = value.map((day, index) => calendarDate(day, `${label}[${index}]`));
  if (new Set(dates).size !== dates.length || dates.some(day => day < start || day > end)) fail(`${label} must contain unique dates inside the report period`);
  return [...dates].sort();
}

function validateEvidence(record, captureTime) {
  if (!Array.isArray(record.evidence) || !record.evidence.length) fail('record.evidence must contain actual sources');
  const ids = new Set();
  for (const [index, evidence] of record.evidence.entries()) {
    const label = `record.evidence[${index}]`;
    if (!object(evidence)) fail(`${label} must be an object`);
    const id = text(evidence.id, `${label}.id`);
    if (ids.has(id)) fail(`${label}.id must be unique`);
    ids.add(id);
    text(evidence.source, `${label}.source`);
    const fetched = timestamp(evidence.capturedAt, `${label}.capturedAt`);
    if (fetched > captureTime + 300_000) fail(`${label} was captured after the report`);
    const asOf = calendarDate(evidence.asOfDate, `${label}.asOfDate`);
    if (asOf > record.reportDate) fail(`${label}.asOfDate is after the report date`);
    if (evidence.url !== undefined) publicUrl(evidence.url, `${label}.url`);
    else text(evidence.tool, `${label}.tool`);
    if (evidence.role === 'market-close' && (asOf !== record.closeDate || fetched < Date.parse(record.closeDate + 'T00:00:00Z') || record.closeTimestamp && fetched < timestamp(record.closeTimestamp, 'record.closeTimestamp'))) fail(`${label} does not match the actual closeDate and closing time`);
  }
  return ids;
}

function validateCoverage(record, evidenceIds) {
  const coverage = record.coverage;
  if (!object(coverage) || !Array.isArray(coverage.missing) || !object(coverage.sections)) fail('record.coverage needs missing[] and seven section declarations');
  coverage.missing.forEach((entry, i) => text(entry, `record.coverage.missing[${i}]`));
  let partial = coverage.missing.length > 0;
  for (const workspace of WORKSPACES) {
    const item = coverage.sections[workspace];
    if (!object(item) || !['complete', 'partial', 'missing'].includes(item.status) || !Array.isArray(item.evidenceIds)) fail(`record.coverage.sections.${workspace} needs status and evidenceIds`);
    if (item.status !== 'missing' && !item.evidenceIds.length) fail(`record.coverage.sections.${workspace} needs actual evidence`);
    if (item.evidenceIds.some(id => !evidenceIds.has(id))) fail(`record.coverage.sections.${workspace} references unknown evidence`);
    partial ||= item.status !== 'complete';
  }
  if (Object.keys(coverage.sections).some(key => !WORKSPACES.includes(key))) fail('record.coverage.sections contains an unknown workspace');
  if (record.type === 'weekly') {
    const trading = dateList(coverage.tradingDays, 'record.coverage.tradingDays', record.periodStart, record.periodEnd);
    const covered = dateList(coverage.coveredDays, 'record.coverage.coveredDays', record.periodStart, record.periodEnd);
    const missing = dateList(coverage.missingDays, 'record.coverage.missingDays', record.periodStart, record.periodEnd);
    if (!['twr', 'compound', 'endpoint-ratio', 'not-calculated'].includes(coverage.returnMethod)) fail('weekly returnMethod cannot sum daily returns');
    if (coverage.tradingDatesVerified === false) {
      if (trading.length || covered.length || missing.length || coverage.calendarEvidenceId != null || coverage.returnMethod !== 'not-calculated') fail('unverified weekly calendar must have empty day lists, no calendar evidence and no calculated return');
      if (!coverage.missing.some(item => /交易日|日历|calendar|trading day|unverified/i.test(item))) fail('unverified weekly calendar must explicitly declare missing calendar coverage');
      partial = true;
    } else {
      if (!trading.length) fail('weekly coverage needs a verified nonempty trading day list or an explicitly unverified partial calendar');
      if (covered.some(day => !trading.includes(day)) || missing.join(',') !== trading.filter(day => !covered.includes(day)).join(',')) fail('weekly missingDays must exactly match tradingDays minus coveredDays');
      if (!evidenceIds.has(coverage.calendarEvidenceId)) fail('weekly coverage.calendarEvidenceId must reference actual calendar evidence');
      partial ||= missing.length > 0;
    }
  }
  if (record.completeness === 'complete' && partial) fail('complete report has declared coverage gaps');
  if (record.completeness === 'partial' && !partial) fail('partial report must explicitly declare its missing coverage');
  if (coverage.fullDailyReport !== undefined && coverage.fullDailyReport !== (record.type === 'daily' && record.completeness === 'complete')) fail('coverage.fullDailyReport conflicts with the actual coverage');
}

function sourceDate(value, label) {
  const normalized = typeof value === 'string' ? value.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : value;
  return calendarDate(normalized, label);
}

function numberOrNull(value, label) {
  if (value !== null && !(typeof value === 'number' && Number.isFinite(value))) fail(`${label} must be a finite number or explicitly null`);
}

function snapshotEvidence(snapshot, key, fetchedAt, asOfDate, record, label) {
  const declaration = snapshot.sourceEvidence?.[key];
  if (!object(declaration) || declaration.status !== 'success' || typeof declaration.evidenceId !== 'string') fail(`${label}.sourceEvidence.${key} needs explicit success and evidenceId`);
  const evidence = record.evidence.find(item => item.id === declaration.evidenceId);
  if (!evidence || timestamp(evidence.capturedAt, 'snapshot evidence capturedAt') !== timestamp(fetchedAt, 'snapshot fetchedAt') || evidence.asOfDate !== asOfDate) fail(`${label}.sourceEvidence.${key} does not match its actual source time and date`);
}

/** Optional current snapshots use the existing site's shape plus explicit successful source evidence. */
function validateSnapshots(bundle, captureTime) {
  const record = bundle.record;
  if (Object.hasOwn(bundle, 'data')) {
    const data = bundle.data;
    if (!object(data) || !object(data.summary) || !object(data.balances) || !Array.isArray(data.balances.balances) || !object(data.positions) || !Array.isArray(data.positions.positions) || !object(data.performance?.accounts?.account) || !object(data.definitions) || !object(data.actualSnapshot) || !object(data.snapshotSourceTimes)) fail('bundle.data is missing core summary/balances/positions/performance/definitions/source metadata');
    const dataCapture = timestamp(data.capturedAt, 'bundle.data.capturedAt');
    if (dataCapture > captureTime + 300_000 || data.actualSnapshot.capturedAt !== data.capturedAt) fail('bundle.data source capture metadata is inconsistent');
    const accountDate = calendarDate(data.actualSnapshot.accountSnapshotDate, 'bundle.data.actualSnapshot.accountSnapshotDate');
    if (accountDate !== new Date(dataCapture).toISOString().slice(0, 10)) fail('bundle.data account date does not match source capture date');
    text(data.summary.currency, 'bundle.data.summary.currency');
    for (const key of ['net_liquidation', 'equity_with_loan_value', 'buying_power', 'gross_position_value', 'total_cash_value', 'available_funds', 'initial_margin', 'maintenance_margin', 'excess_liquidity']) numberOrNull(data.summary[key], `bundle.data.summary.${key}`);
    for (const [index, row] of data.positions.positions.entries()) {
      if (!object(row)) fail('bundle.data.positions row is invalid');
      text(row.contract_description || row.symbol, `bundle.data.positions[${index}].symbol`);
      text(row.currency, `bundle.data.positions[${index}].currency`);
      text(row.asset_class, `bundle.data.positions[${index}].asset_class`);
      for (const key of ['position', 'market_price', 'market_value', 'average_price', 'unrealized_pnl', 'daily_pnl']) numberOrNull(row[key], `bundle.data.positions[${index}].${key}`);
    }
    if (!data.balances.balances.length) fail('bundle.data.balances must include an actual currency balance');
    for (const [index, row] of data.balances.balances.entries()) {
      if (!object(row)) fail('bundle.data.balances row is invalid');
      text(row.currency, `bundle.data.balances[${index}].currency`);
      for (const key of ['cash_balance', 'settled_cash', 'net_liquidation_value', 'stock_market_value', 'unrealized_pnl', 'realized_pnl', 'exchange_rate']) numberOrNull(row[key], `bundle.data.balances[${index}].${key}`);
    }
    const performance = data.performance.accounts.account;
    const end = sourceDate(performance.end, 'bundle.data.performance.end');
    if (calendarDate(data.actualSnapshot.performanceAsOfDate, 'bundle.data.actualSnapshot.performanceAsOfDate') !== end || end > record.closeDate || !object(performance.periods) || !Object.keys(performance.periods).length) fail('bundle.data performance source date or periods are inconsistent');
    for (const [key, period] of Object.entries(performance.periods)) {
      if (!object(period) || !Array.isArray(period.dates) || !Array.isArray(period.cps) || !Array.isArray(period.nav) || period.dates.length !== period.cps.length || period.dates.length !== period.nav.length) fail(`bundle.data.performance.periods.${key} has inconsistent series`);
      for (const [index, date] of period.dates.entries()) {
        if (sourceDate(date, `bundle.data.performance.periods.${key}.dates`) > end) fail('bundle.data performance series is newer than its source end date');
        numberOrNull(period.cps[index], 'bundle.data.performance.cps');
        numberOrNull(period.nav[index], 'bundle.data.performance.nav');
      }
    }
    text(data.definitions.returnMethod, 'bundle.data.definitions.returnMethod');
    text(data.definitions.benchmarkMethod, 'bundle.data.definitions.benchmarkMethod');
    for (const key of ['summary', 'positions', 'balances', 'performance']) {
      const fetched = timestamp(data.snapshotSourceTimes[key], `bundle.data.snapshotSourceTimes.${key}`);
      if (fetched > dataCapture || key !== 'performance' && new Date(fetched).toISOString().slice(0, 10) !== accountDate) fail('bundle.data source timestamps cannot be relabelled as a new account date');
      snapshotEvidence(data, key, data.snapshotSourceTimes[key], key === 'performance' ? end : accountDate, record, 'bundle.data');
    }
  }
  if (Object.hasOwn(bundle, 'market')) {
    const market = bundle.market;
    if (!object(market) || !object(market.instruments) || !Object.keys(market.instruments).length || !Array.isArray(market.sectors) || !Array.isArray(market.events) || !object(market.definitions) || !Array.isArray(market.sources) || !object(market.actualSnapshot)) fail('bundle.market is missing core instruments/sectors/events/definitions/source metadata');
    const marketCapture = timestamp(market.capturedAt, 'bundle.market.capturedAt');
    const asOf = sourceDate(market.asOfDate, 'bundle.market.asOfDate');
    if (marketCapture > captureTime + 300_000 || asOf > record.closeDate || market.actualSnapshot.asOfDate !== asOf) fail('bundle.market source date or capture metadata is inconsistent');
    text(market.source, 'bundle.market.source');
    let latest;
    for (const [symbol, instrument] of Object.entries(market.instruments)) {
      if (!object(instrument) || instrument.symbol !== symbol || typeof instrument.available !== 'boolean') fail('bundle.market instrument identity/availability is required');
      if (!instrument.available) { text(instrument.missingReason, `bundle.market.instruments.${symbol}.missingReason`); continue; }
      if (!object(instrument.metrics) || !Array.isArray(instrument.data) || !instrument.data.length || !object(instrument.source)) fail('bundle.market available instruments need actual metrics, history and source');
      text(instrument.source.provider, 'bundle.market instrument provider');
      text(instrument.source.tool, 'bundle.market instrument tool');
      const date = sourceDate(instrument.metrics.asOfDate, `bundle.market.instruments.${symbol}.metrics.asOfDate`);
      const fetched = timestamp(instrument.fetchedAt, `bundle.market.instruments.${symbol}.fetchedAt`);
      if (fetched > marketCapture || date > asOf) fail('bundle.market instrument is newer than the declared source snapshot');
      for (const row of instrument.data) {
        if (!object(row) || sourceDate(row.date, 'bundle.market instrument history date') > date) fail('bundle.market instrument history conflicts with its source date');
        numberOrNull(row.close, 'bundle.market instrument history close');
      }
      const last = instrument.data.at(-1);
      if (sourceDate(last.date, 'bundle.market last history date') !== date || instrument.metrics.lastClose !== last.close) fail('bundle.market metrics cannot relabel old history as a new close');
      snapshotEvidence(market, symbol, instrument.fetchedAt, date, record, 'bundle.market');
      if (!latest || date > latest) latest = date;
    }
    if (!latest || latest !== asOf) fail('bundle.market needs a successfully sourced instrument at its declared asOfDate');
  }
}

/** Strict static HTML subset: no scripts, handlers, remote resources, or CSS execution. */
export function validateArchiveHtml(html) {
  text(html, 'archiveHtml');
  if (Buffer.byteLength(html) > MAX_INPUT_BYTES) fail('archiveHtml is too large');
  if (!/<html(?:\s|>)/i.test(html) || !/<body(?:\s|>)/i.test(html) || /<!\s*(?:ENTITY|\[CDATA)|<\?/i.test(html)) fail('archiveHtml must be a standalone static HTML document');
  const decode = value => value.replace(/&#(?:x([a-f0-9]+)|(\d+));?/gi, (_, hex, decimal) => String.fromCodePoint(Math.min(parseInt(hex ?? decimal, hex ? 16 : 10), 0x10ffff))).replace(/&(colon|tab|newline|amp|quot|apos|lt|gt);?/gi, (_, name) => ({ colon: ':', tab: '\t', newline: '\n', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }[name.toLowerCase()]));
  const safeCss = css => { if (/\\|@import|url\s*\(|expression\s*\(|(?:-moz-binding|behavior)\s*:/i.test(decode(css))) fail('archiveHtml contains external or executable CSS'); };
  html = html.replace(/<!--[^]*?-->/g, '');
  html = html.replace(/<style(?:\s[^<>]*)?>([^]*?)<\/style\s*>/gi, (match, css) => { safeCss(css); return match.replace(css, ''); });
  const allowed = new Set(['html', 'head', 'meta', 'title', 'style', 'body', 'main', 'header', 'footer', 'section', 'article', 'nav', 'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col', 'strong', 'b', 'em', 'i', 'small', 'mark', 'code', 'pre', 'blockquote', 'br', 'hr', 'a', 'figure', 'figcaption', 'details', 'summary', 'time']);
  const common = new Set(['id', 'class', 'title', 'lang', 'dir', 'role', 'tabindex', 'hidden', 'style']);
  const attributes = { a: new Set(['href', 'target', 'rel']), meta: new Set(['charset', 'name', 'content']), th: new Set(['scope', 'colspan', 'rowspan']), td: new Set(['colspan', 'rowspan']), col: new Set(['span']), time: new Set(['datetime']), ol: new Set(['start', 'reversed']), li: new Set(['value']) };
  const tokens = /<!doctype\s+html\s*>|<\/?([a-z][\w:-]*)([^<>]*)>/gi;
  let end = 0;
  for (const match of html.matchAll(tokens)) {
    if (html.slice(end, match.index).includes('<')) fail('archiveHtml contains malformed markup');
    end = match.index + match[0].length;
    if (!match[1]) continue;
    const tag = match[1].toLowerCase();
    if (!allowed.has(tag)) fail(`archiveHtml contains an unsupported or active tag: ${tag}`);
    if (match[0].startsWith('</')) { if (match[2].trim()) fail('archiveHtml contains malformed closing markup'); continue; }
    let rest = match[2].replace(/\/\s*$/, ''), seen = new Set();
    while (rest.trim()) {
      const attribute = rest.match(/^\s+([a-z][\w:-]*)(?:\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)'|([^\s"'`=<>]+)))?/i);
      if (!attribute) fail('archiveHtml contains malformed attributes');
      rest = rest.slice(attribute[0].length);
      const key = attribute[1].toLowerCase(), value = decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
      if (seen.has(key) || /^on/.test(key) || !(common.has(key) || /^aria-[a-z-]+$/.test(key) || /^data-[a-z-]+$/.test(key) || attributes[tag]?.has(key))) fail(`archiveHtml contains an unsupported attribute: ${key}`);
      seen.add(key);
      if (key === 'style') safeCss(value);
      if (key === 'href') {
        const canonical = value.replace(/[\u0000-\u0020\u007f]/g, '');
        if (!/^#[a-z0-9_-]*$/i.test(canonical)) publicUrl(canonical, 'archiveHtml href');
      }
      if (tag === 'meta' && key === 'name' && !['viewport', 'description', 'color-scheme'].includes(value.toLowerCase())) fail('archiveHtml meta name is unsupported');
      if (key === 'target' && !['_blank', '_self'].includes(value)) fail('archiveHtml target is unsupported');
    }
  }
  if (html.slice(end).includes('<')) fail('archiveHtml contains malformed markup');
  return true;
}

export function validateBundle(bundle, { now = new Date() } = {}) {
  if (!object(bundle) || !object(bundle.record)) fail('input must be a bundle containing record');
  if (Object.keys(bundle).some(key => !BUNDLE_KEYS.has(key))) fail('bundle contains an unknown field or output path');
  assertPublic(bundle);
  const record = bundle.record;
  for (const key of MANAGED_RECORD_KEYS) if (Object.hasOwn(record, key)) fail(`record.${key} is generated by the pipeline`);
  if (!['daily', 'weekly'].includes(record.type)) fail('record.type must be daily or weekly');
  for (const key of ['periodStart', 'periodEnd', 'reportDate', 'closeDate']) calendarDate(record[key], `record.${key}`);
  if (record.periodEnd < record.periodStart || record.closeDate > record.reportDate || record.periodEnd > record.reportDate) fail('record dates are inconsistent');
  if (record.type === 'daily' && (record.periodStart !== record.closeDate || record.periodEnd !== record.closeDate)) fail('daily periodStart and periodEnd must equal closeDate');
  if (record.type === 'weekly' && (record.closeDate < record.periodStart || record.closeDate > record.periodEnd)) fail('weekly closeDate must be inside its period');
  if (!Number.isSafeInteger(record.version) || record.version < 1) fail('record.version must be a positive integer');
  text(record.title, 'record.title');
  if (!['complete', 'partial'].includes(record.completeness)) fail('record.completeness must be complete or partial');
  const captureTime = timestamp(record.capturedAt, 'record.capturedAt'), cutoff = timestamp(record.cutoff, 'record.cutoff');
  if (!Number.isFinite(new Date(now).getTime()) || captureTime > new Date(now).getTime() + 300_000 || cutoff > captureTime + 300_000 || cutoff < Date.parse(record.closeDate + 'T00:00:00Z')) fail('capturedAt or cutoff is in the future or inconsistent');
  if (new Date(captureTime).toISOString().slice(0, 10) < record.closeDate) fail('capturedAt precedes closeDate');
  if (record.closeTimestamp !== undefined && (timestamp(record.closeTimestamp, 'record.closeTimestamp') > cutoff || record.closeTimestamp.slice(0, 10) !== record.closeDate)) fail('closeTimestamp conflicts with closeDate or cutoff');
  if (record.type === 'daily' && Date.parse(record.reportDate) - Date.parse(record.closeDate) > 86400000) {
    const note = text(record.sourceNote, 'record.sourceNote');
    if (!note.includes(record.reportDate) || !/(?:无新(?:的)?收盘|没有新(?:的)?收盘|休市|非交易日|no new close|market closed|holiday)/i.test(note)) fail('holiday update sourceNote must explain reportDate and the absence of a new close');
  }
  if (!object(record.sections) || Object.keys(record.sections).some(key => !WORKSPACES.includes(key))) fail('record.sections must contain the seven known workspaces');
  for (const workspace of WORKSPACES) {
    const section = record.sections[workspace];
    if (!object(section)) fail(`record.sections.${workspace} is required`);
    text(section.title, `record.sections.${workspace}.title`);
    blocks(section.blocks, `record.sections.${workspace}.blocks`);
  }
  if (record.appendix !== undefined) {
    if (!object(record.appendix)) fail('record.appendix must be an object');
    text(record.appendix.title, 'record.appendix.title');
    blocks(record.appendix.blocks, 'record.appendix.blocks');
  }
  const evidenceIds = validateEvidence(record, captureTime);
  validateCoverage(record, evidenceIds);
  validateSnapshots(bundle, captureTime);
  if (Object.hasOwn(bundle, 'archiveHtml')) validateArchiveHtml(bundle.archiveHtml);
  return bundle;
}

function canonical(value, { omitGeneration = false } = {}) {
  if (Array.isArray(value)) return value.map(item => canonical(item, { omitGeneration }));
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().filter(key => !omitGeneration || !GENERATION_KEYS.has(key)).map(key => [key, canonical(value[key], { omitGeneration })]));
  return value;
}

export function contentDigest(bundle) {
  const record = Object.fromEntries(Object.entries(bundle.record).filter(([key]) => key !== 'version' && !MANAGED_RECORD_KEYS.has(key)));
  return sha256(JSON.stringify(canonical({ ...bundle, record }, { omitGeneration: true })));
}

function renderBlocks(blockList) {
  return blockList.map(block => {
    if (block.type === 'heading') return `<h3>${escape(block.text)}</h3>`;
    if (block.type === 'list') return `<ul>${block.items.map(item => `<li>${escape(item)}</li>`).join('')}</ul>`;
    if (block.type === 'table') return `<div class="table-scroll"><table><thead><tr>${block.headers.map(header => `<th>${escape(header)}</th>`).join('')}</tr></thead><tbody>${block.rows.map(row => `<tr>${row.map(value => `<td>${escape(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    return `<p>${escape(block.text)}</p>`;
  }).join('\n');
}

export function renderArchive(record) {
  const coverage = record.completeness === 'complete' ? '覆盖完整' : '部分覆盖';
  const sections = WORKSPACES.map(workspace => `<section id="${workspace}"><h2>${escape(record.sections[workspace].title)}</h2>${renderBlocks(record.sections[workspace].blocks)}</section>`).join('\n');
  const appendix = record.appendix ? `<section><h2>${escape(record.appendix.title)}</h2>${renderBlocks(record.appendix.blocks)}</section>` : '';
  const sources = record.evidence.map(source => `<li>${escape(source.source)} · ${escape(source.asOfDate)} · ${escape(source.capturedAt)}${source.url ? ` · <a href="${escape(source.url)}" target="_blank" rel="noopener noreferrer">来源</a>` : ` · ${escape(source.tool)}`}</li>`).join('');
  const weeklyCoverage = record.frequency !== 'weekly' ? '' : record.tradingDatesVerified === false ? '<p>交易日历未核验；未提供交易日清单，不声明本周交易日覆盖完整，未计算周收益。</p>' : `<p>已核验交易日：${escape(record.coverage.tradingDays.join('、'))}；缺失日：${escape(record.coverage.missingDays.join('、') || '无')}；收益计算方式：${escape(record.coverage.returnMethod)}。</p>`;
  return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(record.title)}</title><style>:root{color-scheme:dark}body{margin:0;background:#0b1118;color:#d8e3ee;font:15px/1.7 system-ui,sans-serif}main{max-width:1200px;margin:auto;padding:28px}section{margin:24px 0;padding:24px;background:#111a25;border:1px solid #263445;border-radius:12px}h1,h2,h3{color:#f0f5fa}h1{font-size:28px}h2{font-size:20px}h3{font-size:17px}p,li{overflow-wrap:anywhere}.meta{color:#92a6bd}.table-scroll{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{padding:10px;text-align:left;border-bottom:1px solid #29384a}a{color:#78b7ff}</style></head><body><main><header><h1>${escape(record.title)}</h1><p class="meta">${record.frequency === 'weekly' ? '周报' : '日报'} · ${escape(record.periodStart)} — ${escape(record.periodEnd)} · v${record.version} · ${coverage}</p><p class="meta">报告日 ${escape(record.reportDate)} · 收盘日 ${escape(record.closeDate)} · 截止 ${escape(record.cutoff)} · 来源取得 ${escape(record.capturedAt)}</p>${record.sourceNote ? `<p>${escape(record.sourceNote)}</p>` : ''}</header>${sections}${appendix}<section><h2>覆盖与来源</h2><p>${coverage}${record.coverage.missing.length ? ' · ' + escape(record.coverage.missing.join('；')) : ''}</p>${weeklyCoverage}<ul>${sources}</ul></section></main></body></html>\n`;
}

function samePeriod(record, candidate) {
  const type = record.type ?? record.frequency;
  const start = record.periodStart ?? (type === 'daily' ? record.closeDate ?? record.date : record.date);
  const end = record.periodEnd ?? (type === 'weekly' ? record.weekEnd : start);
  return type === candidate.type && start === candidate.periodStart && end === candidate.periodEnd;
}

function existingVersion(record) {
  if (Number.isSafeInteger(record.version) && record.version > 0) return record.version;
  const match = String(record.id ?? '').match(/-v([1-9]\d*)$/);
  return match ? Number(match[1]) : 0;
}

function allowedFile(path) {
  if (['reports.json', 'data.json', 'market.json'].includes(path)) return path;
  const match = path.match(/^archive\/(\d{4}-\d{2}-\d{2})(?:-weekly)?-v([1-9]\d*)\.(html|json)$/);
  if (!match) fail('attempted write to an unsupported output path');
  calendarDate(match[1], 'archive date');
  return path;
}

async function exists(path) {
  try { await access(path, constants.F_OK); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function regularFile(path, { optional = false } = {}) {
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) fail(`refusing nonregular file: ${basename(path)}`); }
  catch (error) { if (!(optional && error.code === 'ENOENT')) throw error; }
}

async function archiveDirectory(root, { create = false } = {}) {
  const path = join(root, 'archive');
  try { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) fail('archive must be a real directory, not a symlink'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; if (create) await mkdir(path); }
}

async function readJsonFile(path, maximum) {
  await regularFile(path);
  const info = await stat(path);
  if (info.size > maximum) fail(`${basename(path)} exceeds the supported size`);
  const bytes = await readFile(path);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail(`${basename(path)} is not valid JSON`); }
  return { value, bytes };
}

const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

/**
 * Prepare only the accepted local output files. beforeCommit is an in-process
 * test hook, never a CLI/bundle option. Existing records retain their exact JSON values.
 */
export async function prepareReport({ root, input, bundle, check = false, now = new Date(), beforeCommit } = {}) {
  if (!root || (!input && bundle === undefined)) fail('root and input are required');
  const rootPath = await realpath(resolve(root));
  if (!(await stat(rootPath)).isDirectory()) fail('root must be a directory');
  if (bundle === undefined) bundle = (await readJsonFile(resolve(input), MAX_INPUT_BYTES)).value;
  validateBundle(bundle, { now });
  const reportsPath = join(rootPath, 'reports.json');
  const base = await readJsonFile(reportsPath, MAX_REPORT_BYTES);
  if (!object(base.value) || !Array.isArray(base.value.records) || base.value.records.some(record => !object(record) || typeof record.id !== 'string')) fail('existing reports.json must contain a valid records array');
  if (new Set(base.value.records.map(record => record.id)).size !== base.value.records.length) fail('existing reports.json contains duplicate record ids');
  const baseSha256 = sha256(base.bytes), contentSha256 = contentDigest(bundle);
  const candidates = base.value.records.filter(record => samePeriod(record, bundle.record));
  const duplicate = candidates.find(record => record.pipeline?.schemaVersion === 1 && record.pipeline?.contentSha256 === contentSha256);
  if (duplicate) return { status: 'noop', check, recordId: duplicate.id, version: duplicate.version, contentSha256, baseReportsSha256: baseSha256, reportsSha256: baseSha256, changedFiles: [], files: [] };
  await archiveDirectory(rootPath);
  let version = Math.max(bundle.record.version, ...candidates.map(record => existingVersion(record) + 1));
  const type = bundle.record.type, archiveDate = type === 'daily' ? bundle.record.closeDate : bundle.record.periodStart;
  let recordId, archiveStem;
  do {
    recordId = `${type}-${bundle.record.periodStart}${type === 'weekly' ? '-' + bundle.record.periodEnd : ''}-v${version}`;
    archiveStem = `archive/${archiveDate}${type === 'weekly' ? '-weekly' : ''}-v${version}`;
    if (!base.value.records.some(record => record.id === recordId) && !(await exists(join(rootPath, archiveStem + '.html'))) && !(await exists(join(rootPath, archiveStem + '.json')))) break;
    version++;
  } while (Number.isSafeInteger(version));
  if (!Number.isSafeInteger(version)) fail('revision number exceeds the supported range');
  const previous = [...candidates].sort((a, b) => existingVersion(b) - existingVersion(a)).at(0);
  const record = {
    ...bundle.record, id: recordId, version,
    date: archiveDate, frequency: type, format: 'narrative', kind: type === 'weekly' ? 'weekly-report' : 'daily-report',
    sourceCapturedAt: bundle.record.capturedAt,
    ...(type === 'weekly' ? { weekEnd: bundle.record.periodEnd, tradingDates: [...bundle.record.coverage.tradingDays], tradingDatesVerified: bundle.record.coverage.tradingDatesVerified !== false } : {}),
    ...(previous ? { revisionOf: previous.id } : {}),
    originalReportPath: './' + archiveStem + '.html',
    pipeline: { schemaVersion: 1, contentSha256 }
  };
  const html = bundle.archiveHtml ?? renderArchive(record);
  validateArchiveHtml(html);
  const nextReports = { ...base.value, generatedAt: new Date(now).toISOString(), records: [...base.value.records, record] };
  const planned = new Map([[archiveStem + '.html', Buffer.from(html)], [archiveStem + '.json', jsonBytes(record)]]);
  for (const name of ['data', 'market']) if (Object.hasOwn(bundle, name)) {
    const target = join(rootPath, name + '.json');
    await regularFile(target, { optional: true });
    const bytes = jsonBytes(bundle[name]);
    if (!(await exists(target)) || !bytes.equals(await readFile(target))) planned.set(name + '.json', bytes);
  }
  planned.set('reports.json', jsonBytes(nextReports));
  for (const path of planned.keys()) allowedFile(path);
  const result = {
    status: check ? 'checked' : 'prepared', check, recordId, version, ...(previous ? { revisionOf: previous.id } : {}),
    contentSha256, baseReportsSha256: baseSha256, reportsSha256: sha256(planned.get('reports.json')),
    changedFiles: [...planned.keys()], files: [...planned].map(([path, bytes]) => ({ path, sha256: sha256(bytes), bytes: bytes.length }))
  };
  if (check) return result;

  const lockPath = join(tmpdir(), 'ibkr-report-pipeline-' + sha256(rootPath) + '.lock');
  try { await mkdir(lockPath); } catch (error) { if (error.code === 'EEXIST') fail('another report preparation holds the root lock; retry after it finishes'); throw error; }
  let staging, madeArchive = [], replaced = [], originalSnapshots = new Map();
  const assertUnchanged = async () => {
    await regularFile(reportsPath);
    if (sha256(await readFile(reportsPath)) !== baseSha256) fail('reports.json changed during preparation; retry from its latest version');
  };
  try {
    await assertUnchanged();
    staging = await mkdtemp(join(tmpdir(), 'ibkr-report-stage-'));
    if ((await stat(staging)).dev !== (await stat(rootPath)).dev) fail('temporary staging and root must be on the same filesystem for atomic preparation');
    for (const [index, [path, bytes]] of [...planned].entries()) {
      await writeFile(join(staging, String(index)), bytes, { mode: 0o600, flag: 'wx' });
      if (['data.json', 'market.json'].includes(path)) {
        const target = join(rootPath, path);
        originalSnapshots.set(path, await exists(target) ? await readFile(target) : null);
      }
    }
    if (beforeCommit !== undefined) await beforeCommit({ root: rootPath, result });
    await assertUnchanged();
    await archiveDirectory(rootPath, { create: true });
    for (const [index, [path]] of [...planned].entries()) {
      const target = join(rootPath, path), source = join(staging, String(index));
      if (path.startsWith('archive/')) {
        await archiveDirectory(rootPath);
        await link(source, target); // Exclusive creation: a prior archive is never overwritten.
        madeArchive.push(path);
      }
    }
    await assertUnchanged();
    for (const [index, [path, bytes]] of [...planned].entries()) {
      if (!['data.json', 'market.json'].includes(path)) continue;
      const target = join(rootPath, path);
      await regularFile(target, { optional: true });
      const original = originalSnapshots.get(path), current = await exists(target) ? await readFile(target) : null;
      if (original === null ? current !== null : current === null || !original.equals(current)) fail(`${path} changed during preparation`);
      await rename(join(staging, String(index)), target);
      replaced.push([path, bytes]);
    }
    await assertUnchanged();
    await rename(join(staging, String([...planned.keys()].indexOf('reports.json'))), reportsPath);
    return result;
  } catch (error) {
    // Undo only this invocation's writes; never overwrite a concurrent writer's version.
    for (const [path, bytes] of replaced.reverse()) {
      const target = join(rootPath, path), original = originalSnapshots.get(path);
      if (await exists(target) && sha256(await readFile(target)) === sha256(bytes)) {
        if (original === null) await rm(target);
        else { const rollback = join(staging, 'rollback-' + path); await writeFile(rollback, original, { flag: 'wx', mode: 0o600 }); await rename(rollback, target); }
      }
    }
    for (const path of madeArchive) if (await exists(join(rootPath, path)) && sha256(await readFile(join(rootPath, path))) === sha256(planned.get(path))) await rm(join(rootPath, path));
    throw error;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lockPath, { recursive: true, force: true });
  }
}

function argumentsFor(argv) {
  const result = { check: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--check') result.check = true;
    else if (flag === '--help' || flag === '-h') result.help = true;
    else if (['--root', '--input'].includes(flag)) {
      if (!argv[index + 1] || argv[index + 1].startsWith('--') || result[flag.slice(2)] !== undefined) fail(`${flag} needs exactly one path`);
      result[flag.slice(2)] = argv[++index];
    } else fail(`unsupported option: ${flag}`);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = argumentsFor(process.argv.slice(2));
    if (options.help) process.stdout.write('Usage: node scripts/report-pipeline.mjs --root PATH --input BUNDLE.json [--check]\n--check validates and reports planned hashes without writing. Default prepares local files only.\n');
    else process.stdout.write(JSON.stringify(await prepareReport(options), null, 2) + '\n');
  } catch (error) {
    process.stderr.write('Report preparation failed: ' + error.message + '\n');
    process.exitCode = 1;
  }
}
