import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACES, MARKET_PARTS, REPORT_TEMPLATE_ID, validateBundle, validateArchiveHtml, prepareReport } from '../scripts/report-pipeline.mjs';

const now = new Date('2026-10-20T04:00:00Z');
const oldRecord = { id: 'daily-2026-10-19-v1', date: '2026-10-19', type: 'daily', frequency: 'daily', periodStart: '2026-10-19', periodEnd: '2026-10-19', version: 1, title: '历史正文不改', legacy: { order_id: '历史匿名编号' } };
function candidate() {
  const record = {
    type: 'daily', periodStart: '2026-10-19', periodEnd: '2026-10-19', closeDate: '2026-10-19', reportDate: '2026-10-20',
    closeTimestamp: '2026-10-19T16:00:00-04:00', capturedAt: '2026-10-20T03:00:00Z', cutoff: '2026-10-20T11:00:00+08:00',
    version: 1, title: '格式恢复验证', sourceNote: '本报告保留实际来源与日期，未获取的数据不补零。', completeness: 'partial',
    decisionSummary: '先核实风险，再决定是否改变订单。',
    summaryBlocks: [{ type: 'heading', text: '今日重点事项' }, { type: 'list', items: ['保留全部已取得的账户风险分析。', '研究覆盖缺口明确列出，不编造新研究。'] }],
    sections: Object.fromEntries(WORKSPACES.map(key => [key, { title: key, blocks: [{ type: 'paragraph', text: '本栏目只有当次实际证据；其余信息未获取，保持缺口。' }] }])),
    evidence: [{ id: 'original', source: '已恢复且清洗的原日报', tool: 'read_saved_report', capturedAt: '2026-10-20T02:50:00Z', asOfDate: '2026-10-19' }],
    coverage: { missing: ['全自选名单与完整逐股研究未取得，不能声称研究完整。'], sections: Object.fromEntries(WORKSPACES.map(key => [key, { status: 'partial', evidenceIds: ['original'] }])) }
  };
  record.sections.market.blocks = MARKET_PARTS.flatMap((part, index) => [{ type: 'heading', part, text: '市场部分' + (index + 1) }, { type: 'paragraph', text: '本部分证据有限，未取得完整统计与来源覆盖，保留明确缺口。' }]);
  record.sections.portfolio.blocks.push({ type: 'table', headers: ['指标', '本期值', '口径'], rows: [['净资产', '$25,000', '报告快照'], ['现金', '$1,200', '不是购买力'], ['维持保证金', '$8,000', '账户读数'], ['超额流动性', '$3,000', '风险指标']] });
  record.sections.holdings.blocks.push({ type: 'table', headers: ['证券', '数量', '平均成本', '收盘价', '收盘重估市值', '重算浮盈', '重算日损益'], rows: [['FN', 2, 300, 360, 720, 120, null]] });
  record.sections.analysis.blocks.push({ type: 'heading', text: 'FN · 光通信制造' }, { type: 'paragraph', text: '仅保留原来源已获得的分析，没有新增研究。' });
  record.sections.stocks.blocks.push({ type: 'table', headers: ['证券', '1D', '5D', '1M'], rows: [['FN', '-0.2%', null, '未提供']] });
  return { record };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ibkr-template-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'archive'));
  await writeFile(join(root, 'archive/2026-10-19-v1.html'), '<html><body>原历史附件</body></html>');
  await writeFile(join(root, 'reports.json'), JSON.stringify({ fixedPool: [{ symbol: 'IREN' }], records: [oldRecord] }));
  return root;
}
const json = async file => JSON.parse(await readFile(file, 'utf8'));
test('seven market parts require ordered identity and actual body, while honest data gaps pass', () => {
  const value = candidate();
  assert.equal(validateBundle(value, { now }), value);
  const missing = structuredClone(value);
  missing.record.sections.market.blocks.splice(6, 2);
  assert.throws(() => validateBundle(missing, { now }), /seven ordered/);
  const empty = structuredClone(value);
  empty.record.sections.market.blocks.splice(1, 1);
  assert.throws(() => validateBundle(empty, { now }), /macro needs actual content/);
  const swapped = structuredClone(value);
  swapped.record.sections.market.blocks[0].part = 'sectors';
  assert.throws(() => validateBundle(swapped, { now }), /seven ordered/);
});
test('unknown template and headings-only workspace are refused', () => {
  const value = candidate();
  value.record.template = { id: 'simple-blue-page' };
  assert.throws(() => validateBundle(value, { now }), /record.template/);
  delete value.record.template;
  value.record.sections.analysis.blocks = [{ type: 'heading', text: 'FN · 只有标题' }];
  assert.throws(() => validateBundle(value, { now }), /cannot contain headings only/);
});
test('new archives reuse the original assets, freeze one record, and render available charts and targets', async t => {
  const root = await fixture(t), value = candidate();
  const result = await prepareReport({ root, bundle: value, now });
  const saved = await json(join(root, 'archive/2026-10-19-v2.json'));
  const html = await readFile(join(root, 'archive/2026-10-19-v2.html'), 'utf8');
  assert.equal(saved.template.id, REPORT_TEMPLATE_ID);
  assert.equal(saved.revisionOf, oldRecord.id);
  for (const asset of ['styles.css', 'reports.css', 'reports-charts.css', 'report-navigation.css']) assert.ok(html.includes('href="../' + asset + '"'));
  assert.equal((html.match(/data-workspace="/g) || []).length, 7);
  assert.equal((html.match(/data-market-part="/g) || []).length, 7);
  assert.match(html, /<svg/);
  assert.match(html, /data-report-symbol="FN"/);
  assert.match(html, /import \{ createStockNavigator \} from '\.\.\/report-navigation\.mjs'/);
  assert.match(html, /connect-src &#39;none&#39;/);
  assert.doesNotMatch(html, /fetch\(|src="[^"]*(?:app\.mjs|market\.mjs|reports\.mjs)|href="[^"]*(?:data|market|reports)\.json/);
  const payload = JSON.parse(html.match(/<script type="application\/json" id="archive-record">([^]*?)<\/script>/)[1]);
  assert.equal(payload.id, saved.id);
  assert.equal(payload.sections.portfolio.blocks[1].rows[2][1], '$8,000');
  assert.equal(payload.sections.holdings.blocks[1].rows[0][6], null);
  assert.equal(result.status, 'prepared');
});
test('history records and archive bytes remain unchanged; template omission and explicit id are idempotent', async t => {
  const root = await fixture(t), before = await readFile(join(root, 'archive/2026-10-19-v1.html'));
  const value = candidate();
  await prepareReport({ root, bundle: value, now });
  const firstReports = await readFile(join(root, 'reports.json'));
  assert.deepEqual((await json(join(root, 'reports.json'))).records[0], oldRecord);
  assert.deepEqual(await readFile(join(root, 'archive/2026-10-19-v1.html')), before);
  value.record.template = { id: REPORT_TEMPLATE_ID };
  value.record.version = 99;
  value.record.generatedAt = '2026-10-20T03:30:00Z';
  const retry = await prepareReport({ root, bundle: value, now });
  assert.equal(retry.status, 'noop');
  assert.deepEqual(await readFile(join(root, 'reports.json')), firstReports);
});
test('summary blocks are validated and rendered before market; account risk values are allowed', async t => {
  const root = await fixture(t), value = candidate();
  validateBundle(value, { now });
  await prepareReport({ root, bundle: value, now });
  const html = await readFile(join(root, 'archive/2026-10-19-v2.html'), 'utf8');
  assert.ok(html.indexOf('今日重点事项') < html.indexOf('id="market-page"'));
  assert.match(html, /维持保证金/);
  assert.match(html, /超额流动性/);
  value.record.summaryBlocks = [{ type: 'list', items: [] }];
  assert.throws(() => validateBundle(value, { now }), /items must be nonempty/);
  value.record.summaryBlocks = [{ type: 'heading', text: '今日重点事项' }];
  assert.throws(() => validateBundle(value, { now }), /summaryBlocks cannot contain headings only/);
});
test('identity and credentials are still refused, without rejecting financial risk fields', () => {
  for (const [key, value] of [['account_id', 'redacted'], ['accessToken', 'redacted']]) {
    const bundle = candidate(); bundle.record[key] = value;
    assert.throws(() => validateBundle(bundle, { now }), /private/);
  }
  const bundle = candidate(); bundle.record.sections.portfolio.blocks.push({ type: 'paragraph', text: '账户 ' + 'U' + String(123456789) + ' 不得公开。' });
  assert.throws(() => validateBundle(bundle, { now }), /private identifier/);
});
test('untrusted HTML cannot replace the template, and text cannot break out of frozen JSON', async t => {
  const root = await fixture(t), value = candidate();
  value.archiveHtml = '<html><body>更换简化模板</body></html>';
  assert.throws(() => validateBundle(value, { now }), /cannot replace/);
  assert.throws(() => validateArchiveHtml('<html><body><script>alert(1)</script></body></html>'), /unsupported or active tag/);
  delete value.archiveHtml;
  const hostile = '</script><script>alert("injected")</script><img src=x onerror=alert(1)>';
  value.record.sections.analysis.blocks.push({ type: 'paragraph', text: hostile });
  await prepareReport({ root, bundle: value, now });
  const html = await readFile(join(root, 'archive/2026-10-19-v2.html'), 'utf8');
  assert.equal((html.match(/<script\b/g) || []).length, 2);
  assert.doesNotMatch(html, /<img src=x|<script>alert\("injected"\)/);
  assert.ok(html.includes('\\u003c/script\\u003e'));
  assert.ok(html.includes('&lt;/script&gt;'));
});
test('public source URLs in body and appendix tables remain safe clickable links', async t => {
  const root = await fixture(t), value = candidate();
  value.record.appendix = { title: '原始来源', blocks: [{ type: 'table', headers: ['来源', '链接'], rows: [['SEC', 'https://www.sec.gov/Archives/example?x=1&y=2'], ['普通文本', 'javascript:alert(1)']] }] };
  await prepareReport({ root, bundle: value, now });
  const html = await readFile(join(root, 'archive/2026-10-19-v2.html'), 'utf8');
  assert.match(html, /href="https:\/\/www\.sec\.gov\/Archives\/example\?x=1&amp;y=2" target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /href="javascript:/);
});
test('duplicate issuer headings never emit duplicate target ids', async t => {
  const root = await fixture(t), value = candidate();
  value.record.sections.analysis.blocks.push({ type: 'heading', text: 'FN · 光通信制造' });
  await prepareReport({ root, bundle: value, now });
  const html = await readFile(join(root, 'archive/2026-10-19-v2.html'), 'utf8');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});
test('validate-only does not write; changed same-date report makes another preserved revision', async t => {
  const root = await fixture(t), before = await readFile(join(root, 'reports.json')), value = candidate();
  const checked = await prepareReport({ root, bundle: value, now, check: true });
  assert.equal(checked.status, 'checked');
  assert.deepEqual(await readFile(join(root, 'reports.json')), before);
  assert.deepEqual(await readdir(join(root, 'archive')), ['2026-10-19-v1.html']);
  await prepareReport({ root, bundle: value, now });
  const first = await readFile(join(root, 'archive/2026-10-19-v2.html'));
  value.record.sourceNote += ' 本次增加经核实的来源说明。';
  const changed = await prepareReport({ root, bundle: value, now });
  assert.equal(changed.version, 3);
  assert.deepEqual(await readFile(join(root, 'archive/2026-10-19-v2.html')), first);
});
test('unverified weekly calendar remains explicit and does not fabricate trading days or returns', async t => {
  const root = await fixture(t), value = candidate();
  Object.assign(value.record, { type: 'weekly', periodStart: '2026-10-12', periodEnd: '2026-10-19' });
  Object.assign(value.record.coverage, { tradingDatesVerified: false, tradingDays: [], coveredDays: [], missingDays: [], calendarEvidenceId: null, returnMethod: 'not-calculated' });
  value.record.coverage.missing.push('交易日历本次未核验。');
  const result = await prepareReport({ root, bundle: value, now });
  const html = await readFile(join(root, result.changedFiles.find(path => path.endsWith('.html'))), 'utf8');
  assert.match(html, /交易日历未核验/);
  assert.match(html, /未计算周收益/);
});
