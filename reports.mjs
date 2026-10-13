const WORKSPACES=['market','portfolio','holdings','analysis','trades','stocks','watchlist'];
const STATUS_LABELS={NEW:'待处理',REPLACED:'替换状态待核验',CANCELLED:'已取消 · 排除计划',FILLED:'已成交',REJECTED:'已拒绝',EXPIRED:'已到期'};
let payload=null;
const state={date:'all',frequency:'all'};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const money=(value,currency='USD')=>finite(value)?new Intl.NumberFormat('zh-CN',{style:'currency',currency:currency==='BASE'?'USD':currency,maximumFractionDigits:2}).format(value):'未提供';
const percent=value=>finite(value)?`${value>=0?'+':''}${(value*100).toFixed(2)}%`:'未提供';
const dateLabel=value=>String(value??'').replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');
const tone=value=>finite(value)?value<0?'negative':'positive':'';
const stamp=value=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value))+' JST':'来源时间未提供';
const unique=values=>[...new Set(values.filter(Boolean))];
const inline=value=>esc(value).replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/`([^`]+)`/g,'<span>$1</span>');
const panel=(title,body,badge='',source='')=>`<section class="panel"><div class="panel-top"><h2>${esc(title)}</h2>${badge?`<span class="report-badge">${esc(badge)}</span>`:''}</div>${body}${source?`<div class="report-source">${esc(source)}</div>`:''}</section>`;
const empty=(title,message)=>panel(title,`<div class="report-empty"><strong>${esc(message)}</strong><span>只显示所选日期实际保存的记录；缺失日期不会套用其他日期的报告。</span></div>`,'未提供');
const table=(heads,rows,cls='')=>`<div class="table-scroll ${cls}" tabindex="0" role="region" aria-label="${esc(heads.join('、'))}，可水平滚动"><table><thead><tr>${heads.map(h=>`<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(cell=>`<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const paragraphs=values=>`<div class="report-body">${(values??[]).map(value=>`<p>${inline(value)}</p>`).join('')}</div>`;

export function mondayOf(date){const d=new Date(date+'T00:00:00Z');if(!Number.isFinite(d.getTime()))return null;d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10);}
export function selectRecords(records,{date='all',frequency='all'}={}){return (records??[]).filter(record=>(frequency==='all'||record.frequency===frequency)&&(date==='all'||record.date===date)).sort((a,b)=>b.date.localeCompare(a.date));}
export function makeWeeklySummaries(records){
  const groups=new Map();
  for(const record of records??[]){if(record.frequency!=='daily'||!record.date)continue;const key=mondayOf(record.date);if(!key)continue;const rows=groups.get(key)??[];rows.push(record);groups.set(key,rows);}
  return [...groups].map(([start,daily])=>{const end=new Date(start+'T00:00:00Z');end.setUTCDate(end.getUTCDate()+6);const dates=unique(daily.map(r=>r.date)).sort();const fullReports=daily.filter(r=>r.kind==='daily-report'&&r.completeness==='complete');const missingDates=Array.from({length:7},(_,i)=>{const day=new Date(start+'T00:00:00Z');day.setUTCDate(day.getUTCDate()+i);return day.toISOString().slice(0,10);}).filter(date=>!dates.includes(date));return {id:'weekly-'+start,date:start,weekEnd:end.toISOString().slice(0,10),frequency:'weekly',kind:'weekly-summary',title:'一周归档总结',completeness:missingDates.length||fullReports.length<7?'partial':'complete',dailyRecords:daily.sort((a,b)=>a.date.localeCompare(b.date)),dailyDates:dates,fullDailyReportCount:fullReports.length,missingDates,sourceRecordIds:daily.map(r=>r.id)};});
}
export function orderSymbol(order){return order.symbol||String(order.primary_description??'').match(/^(?:Buy|Sell)\s+[\d.]+\s+(\S+)/i)?.[1]||null;}
export function classifyUniverse(snapshot,fixedPool=[]){
  const positions=snapshot?.positions??[],orders=snapshot?.orders??[],watchlists=snapshot?.watchlists??[];
  const held=new Set(positions.map(p=>p.symbol||p.contract_description));
  const currentOrders=orders.filter(o=>!['CANCELLED','FILLED','REJECTED','EXPIRED'].includes(o.order_status));
  const ordered=new Set(currentOrders.map(orderSymbol));
  const waiting=new Set(watchlists.filter(w=>w.role==='waiting').flatMap(w=>(w.instruments??[]).map(i=>i.symbol||i.contract_description)));
  const symbols=unique([...held,...ordered,...watchlists.flatMap(w=>(w.instruments??[]).map(i=>i.symbol||i.contract_description)),...fixedPool.map(i=>i.symbol)]);
  return symbols.map(symbol=>{const pool=fixedPool.find(i=>i.symbol===symbol);const memberships=watchlists.filter(w=>(w.instruments??[]).some(i=>(i.symbol||i.contract_description)===symbol)).map(w=>w.name);const category=held.has(symbol)?'holding':ordered.has(symbol)?'order':waiting.has(symbol)?'waiting':'watch';return {symbol,category,memberships,inFixedPool:!!pool,issuerKey:pool?.issuerKey||symbol,identityStatus:pool?.identityStatus||'reported',focus:pool?.focus??false,orderVerificationPending:currentOrders.some(o=>orderSymbol(o)===symbol&&o.order_status==='REPLACED')};}).sort((a,b)=>['holding','order','waiting','watch'].indexOf(a.category)-['holding','order','waiting','watch'].indexOf(b.category)||a.symbol.localeCompare(b.symbol));
}
export function selectUniverseCategory(snapshot,fixedPool,category){return classifyUniverse(snapshot,fixedPool).filter(row=>row.category===category);}
function renderBlocks(blocks){return `<div class="report-body">${(blocks??[]).map(block=>{
  if(block.type==='heading')return `<h3>${inline(block.text)}</h3>`;
  if(block.type==='table')return table(block.headers??[],(block.rows??[]).map(row=>row.map(inline)));
  if(block.type==='list')return `<ul>${(block.items??[]).map(item=>`<li>${inline(item)}</li>`).join('')}</ul>`;
  return `<p>${inline(block.text)}</p>`;
}).join('')}</div>`;}
function renderNarrative(record,workspace){const section=record.sections?.[workspace];if(!section)return empty(record.title||'历史报告','该日期未保存此栏目内容');return panel(section.title||record.title,renderBlocks(section.blocks),record.date+' · 历史报告',record.sourceNote||'来自原会话历史报告；本次未重新核验其中行情、研究结论或交易条件。');}
function sourceFor(record,key){const source=record.sourceTimes?.[key];return source?`${source.label||key} · ${stamp(source.fetchedAt)}${source.asOf?' · 数据日期 '+dateLabel(source.asOf):''}`:`账户快照 · ${stamp(record.sourceCapturedAt)}`;}
function renderSnapshotAnalysis(record){
  const s=record.snapshot,positions=s.positions??[],total=positions.reduce((n,p)=>n+(p.market_value??0),0),pnl=positions.reduce((n,p)=>n+(p.unrealized_pnl??0),0),summary=s.summary??{};
  const rows=positions.map(p=>{const cost=finite(p.position)&&finite(p.average_price)?p.position*p.average_price:null;const weight=total? p.market_value/total:null;const accountWeight=summary.net_liquidation?p.market_value/summary.net_liquidation:null;return [`<div class="ticker-title">${esc(p.symbol||p.contract_description)}</div><div class="ticker-name">${esc(p.asset_class)} · ${esc(p.currency)}</div>`,esc(p.position),money(p.market_value,p.currency),`<span class="${tone(p.unrealized_pnl)}">${money(p.unrealized_pnl,p.currency)}</span>`,percent(cost?p.unrealized_pnl/cost:null),percent(weight),percent(accountWeight),'<span class="muted">新财报、量价与加减仓条件尚未核验</span>'];});
  const totals=`<section class="overview"><article class="stat-card"><div class="stat-top">明细持仓数量</div><div class="stat-value">${positions.length}</div><div class="stat-detail">所有返回的开放持仓</div></article><article class="stat-card"><div class="stat-top">明细市值合计</div><div class="stat-value money">${money(total)}</div><div class="stat-detail">仅此持仓接口快照</div></article><article class="stat-card"><div class="stat-top">明细未实现盈亏</div><div class="stat-value money ${tone(pnl)}">${money(pnl)}</div><div class="stat-detail">不替代账户 TWR</div></article><article class="stat-card"><div class="stat-top">账户摘要净值</div><div class="stat-value money">${money(summary.net_liquidation)}</div><div class="stat-detail">账户摘要独立来源</div></article></section>`;
  return totals+panel('持仓结构与研究状态',positions.length?table(['持仓','数量','快照市值','未实现盈亏','持仓浮盈率','股票内权重','摘要净值参考比','本日研究状态'],rows):'<div class="report-empty">本次未取得持仓明细。</div>',record.date,sourceFor(record,'positions'))+panel('估值与研究范围',paragraphs(record.sections?.analysis?.paragraphs??[]),'来源差异',sourceFor(record,'summary'));
}
function renderSnapshotOrders(record){
  const orders=record.snapshot.orders??[];
  const rows=orders.map(o=>{const rawDescription=String(o.primary_description??'');const option=/\b(Put|Call)\b/i.test(rawDescription);const tif=o.tif||o.time_in_force;const describedTif=String(o.secondary_description??'').match(/\b(GTC|DAY|OVT|OND|OPG)\b/)?.[1];const tifText=tif?esc(tif):describedTif?`${esc(describedTif)}<div class="report-row-note">仅订单描述；独立 TIF 字段未提供</div>`:'未提供';const status=o.order_status;return [`<strong>${esc(o.order_id??'未提供')}</strong><div class="report-row-note">${esc(o.order_time??'时间未提供')}</div>`,`<div class="report-order-description"><div class="ticker-title">${esc(rawDescription)}</div><div class="ticker-name">${esc(o.secondary_description)}</div></div>`,`${esc(o.side)} · ${esc(o.order_type)}`,esc(o.total_shares_qty),esc(o.cum_shares_qty),esc(o.remaining_shares_qty),esc(o.limit_price??'未提供'),`<span class="${status==='REPLACED'?'amber':status==='CANCELLED'?'muted':''}">${esc(status)}<div class="report-row-note">${esc(STATUS_LABELS[status]||'状态需核验')}</div></span>`,tifText,option?'未提供 · 禁止套用 100 股假设':'未提供 · 不推算期权接货额'];});
  const statuses=orders.reduce((a,o)=>(a[o.order_status]=(a[o.order_status]||0)+1,a),{});
  return panel('全部订单记录',orders.length?table(['订单 ID / 来源时间','标的与描述','方向 / 类型','原始数量','已成交数量','剩余数量','限价','状态','有效期','合约乘数'],rows,'report-table'):'<div class="report-empty">未返回订单。</div>',`${orders.length} 条返回记录`,sourceFor(record,'orders'))+panel('计划核验与预算',paragraphs([`本次记录状态：${Object.entries(statuses).map(([key,count])=>key+' '+count+' 条').join('；')}。NEW 是接口返回的待处理状态，不保证此刻仍可成交。`,'CANCELLED 等完成状态排除当前计划。REPLACED 单列为待核验，不视为独立有效订单，也不自动链接到相似订单。','完整替换链、OCA 关系、合约身份和乘数未提供，因此不加总可能重复的记录，不展示合计资金压力或合计接货额。','本次只读取账户快照，没有取得最新多周期行情及新财报。本日不据旧价位生成改单、撤单或加减仓方案。']),'状态待复核')+renderTrades(record);
}
function renderTrades(record){const trades=record.snapshot.trades??[];return panel('近 7 日实际成交',trades.length?table(['时间','标的','方向','数量','价格','佣金','已实现盈亏'],trades.map(t=>[esc(t.trade_time),esc(t.symbol||t.description),esc(t.side),esc(t.size),money(t.price,t.currency),money(t.commission,t.currency),money(t.realized_pnl,t.currency)])):paragraphs(['IBKR 返回的滚动 7 日成交列表为空。该窗口按 UTC 计算，不能从订单状态推导成交记录。']),'DAYS_7 · UTC',sourceFor(record,'trades'));}
function renderUniverse(record,category='waiting'){
  const rows=classifyUniverse(record.snapshot,payload.fixedPool??[]),labels={holding:'持仓',order:'订单（含待核验）',waiting:'等待买点',watch:'其他关注 / 固定池'};
  const groups=Object.entries(labels).map(([key,label])=>{const members=rows.filter(row=>row.category===key);return `<div class="report-list-item"><strong>${esc(label)} · ${members.length} 个工具</strong><div class="report-symbols">${members.map(row=>`<span>${esc(row.symbol)}${row.focus?' · 重点':''}${row.identityStatus==='pending'?' · 身份待确认':''}</span>`).join('')}</div></div>`;}).join('');
  const detailed=rows.filter(row=>row.category===category);
  return panel('研究优先级',`<div class="report-list">${groups}</div>`,'去重分类',`优先级：持仓 → 订单 → 等待买点 → 其他关注 / 固定池。每个工具只归入一个主类；观察分组关系仍全部保留。`)+panel(category==='waiting'?'等待买点 · 逐股覆盖与缺口':'其他关注与固定池 · 研究覆盖',detailed.length?table(['工具','主类','所属观察分组','固定池','发行人研究合并','本日行情 / 研究'],detailed.map(row=>[`<strong class="${row.identityStatus==='pending'?'report-identity-pending':''}">${esc(row.symbol)}</strong>${row.identityStatus==='pending'?'<div class="report-row-note">身份待确认，未替换成其他代码</div>':''}`,`${esc(labels[row.category])}${row.orderVerificationPending?'<div class="report-row-note">含 REPLACED，订单状态待核验</div>':''}`,esc(row.memberships.join(' / ')||'无返回分组'),row.inFixedPool?'是':'—',esc(row.issuerKey),'<span class="muted">未取得本日完整行情与新财报；分析待补</span>'])):'<div class="report-empty">此主类没有返回工具。</div>',`${detailed.length} 个工具`,sourceFor(record,'watchlists'));
}
function renderWatchlists(record){const lists=record.snapshot.watchlists??[];return renderUniverse(record,'watch')+panel('全部自选分组',`<div class="report-list">${lists.map(list=>`<div class="report-list-item"><strong>${esc(list.name)} · ${(list.instruments??[]).length} 个工具</strong><p>分组 ID ${esc(list.id)} · ${list.complete?'完整取得':'内容未齐'}</p><div class="report-symbols">${(list.instruments??[]).map(i=>`<span title="${esc(i.contract_id_ex)}">${esc(i.symbol||i.contract_description)}</span>`).join('')}</div></div>`).join('')}</div>`,`${lists.length} 个分组`,sourceFor(record,'watchlists'))+panel('固定观察池',`<div class="report-body"><p>原会话提供的固定池保留为独立研究范围。双重股权代码保留各自工具身份，发行人分析按相同 issuerKey 合并。</p><div class="report-symbols">${(payload.fixedPool??[]).map(item=>`<span>${esc(item.symbol)}${item.identityStatus==='pending'?' · 身份待确认':''}${item.focus?' · 重点':''}</span>`).join('')}</div></div>`,'原会话配置')+panel('覆盖说明',paragraphs(record.sections?.watchlist?.paragraphs??[]),'研究未齐');}
function renderSnapshot(record,workspace){
  if(workspace==='analysis')return renderSnapshotAnalysis(record);
  if(workspace==='trades')return renderSnapshotOrders(record);
  if(workspace==='stocks')return renderUniverse(record,'waiting');
  if(workspace==='watchlist')return renderWatchlists(record);
  const section=record.sections?.[workspace];
  return panel(section?.title||'本次账户记录',paragraphs(section?.paragraphs??['此栏目本日尚未取得完整数据。']),record.date+' · 账户快照',section?.sourceNote||sourceFor(record,workspace==='market'?'market':'performance'));
}
function renderWeekly(record,workspace){
  const complete=record.completeness==='complete';
  const intro=panel('一周归档覆盖',paragraphs([`${record.date} — ${record.weekEnd}：保存 ${record.dailyDates.length} 个日期、${record.dailyRecords.length} 条每日记录；经完整性标记确认的全面日报 ${record.fullDailyReportCount} 份。`,complete?'已覆盖该周全部每日记录。':`本周记录不完整。未保存日期：${record.missingDates.join('、')||'每日记录存在，但全面日报未齐'}。`, '以下按归档日期汇集已有栏目，不把累计 TWR 相加，不把缺少行情的记录补成市场结论。']),complete?'覆盖完整':'不完整周');
  const rows=record.dailyRecords.map(day=>[esc(day.date),esc(day.title),esc(day.kind==='account-snapshot'?'账户快照':day.kind==='daily-report'?'历史日报':'归档记录'),esc(day.completeness==='complete'?'完整':'部分覆盖'),esc(day.sections?.[workspace]?'已保存此栏目':'此栏目缺失')]);
  const inventory=panel('本周记录清单',table(['日期','记录','类型','覆盖状态','所选栏目'],rows),'真实归档');
  const sections=record.dailyRecords.map(day=>day.kind==='account-snapshot'?renderSnapshot(day,workspace):renderNarrative(day,workspace)).join('');
  return intro+inventory+sections;
}
function allRecords(){return [...(payload?.records??[]),...makeWeeklySummaries(payload?.records??[])].filter((record,index,array)=>array.findIndex(r=>r.id===record.id)===index);}
function applyFilters(){
  if(!payload)return;
  const matches=selectRecords(allRecords(),state),dailyMatches=matches.filter(r=>r.frequency==='daily');
  const snapshot=payload.records.filter(r=>r.kind==='account-snapshot').sort((a,b)=>b.date.localeCompare(a.date))[0];
  const showCurrentSnapshot=state.frequency!=='weekly'&&!!snapshot&&(state.date==='all'||state.date===snapshot.date);
  document.querySelectorAll('[data-report-current-snapshot]').forEach(node=>{node.hidden=!showCurrentSnapshot;});
  document.querySelectorAll('[data-report-range]').forEach(node=>{node.textContent=state.date==='all'?`全部已存档日期 · ${state.frequency==='weekly'?'每周总结':state.frequency==='daily'?'每日记录':'每日记录与周总结'}`:`${state.date} · ${state.frequency==='weekly'?'每周总结':state.frequency==='daily'?'每日记录':'已存档记录'}`;});
  for(const workspace of WORKSPACES){const mount=document.querySelector(`[data-report-workspace="${workspace}"]`);if(!mount)continue;mount.innerHTML=matches.length?matches.map(record=>record.frequency==='weekly'?renderWeekly(record,workspace):record.kind==='account-snapshot'?renderSnapshot(record,workspace):renderNarrative(record,workspace)).join(''):empty('所选日期没有报告','没有符合日期与频率的已存档记录');}
  window.dispatchEvent(new CustomEvent('investment-report-filter-change',{detail:{...state,matchingRecords:matches.map(r=>({id:r.id,date:r.date,frequency:r.frequency})),dailyDates:unique(dailyMatches.map(r=>r.date)),showCurrentSnapshot,snapshotDate:snapshot?.date??null}}));
}
function populateFilters(){
  const date=document.getElementById('report-date-filter'),frequency=document.getElementById('report-frequency-filter');
  if(frequency&&!frequency.options.length)frequency.innerHTML='<option value="all">全部频率</option><option value="daily">每日记录</option><option value="weekly">每周总结</option>';
  const dates=unique(allRecords().map(r=>r.date)).sort().reverse();
  if(date){date.innerHTML='<option value="all">全部日期</option>'+dates.map(value=>`<option value="${esc(value)}">${esc(value)}</option>`).join('');const initial=payload.defaultDate||payload.records.filter(r=>r.frequency==='daily').map(r=>r.date).sort().at(-1)||'all';date.value=dates.includes(initial)?initial:'all';state.date=date.value;date.addEventListener('change',()=>{state.date=date.value;applyFilters();});}
  if(frequency){state.frequency=['all','daily','weekly'].includes(frequency.value)?frequency.value:'all';frequency.value=state.frequency;frequency.addEventListener('change',()=>{state.frequency=frequency.value;applyFilters();});}
}
async function init(){
  if(!window.InvestmentShell)throw new Error('报告读取入口未就绪');
  payload=await window.InvestmentShell.readSnapshot('./reports.json','报告归档');
  if(payload?.schemaVersion!==1||!Array.isArray(payload.records))throw new Error('报告归档格式无法识别');
  populateFilters();applyFilters();
  window.InvestmentReports={readSnapshot:()=>({schemaVersion:payload.schemaVersion,generatedAt:payload.generatedAt,date:state.date,frequency:state.frequency,recordIds:selectRecords(allRecords(),state).map(r=>r.id)}),setFilter:input=>{if(!input||Object.keys(input).some(k=>!['date','frequency'].includes(k)))throw new Error('筛选参数无效');if(input.frequency&&!['all','daily','weekly'].includes(input.frequency))throw new Error('频率无效');state.date=input.date??state.date;state.frequency=input.frequency??state.frequency;const date=document.getElementById('report-date-filter'),frequency=document.getElementById('report-frequency-filter');if(date)date.value=state.date;if(frequency)frequency.value=state.frequency;applyFilters();}};
}
if(typeof document!=='undefined')init().catch(error=>{document.querySelectorAll('[data-report-workspace]').forEach(node=>{node.innerHTML=empty('报告暂未加载',error.message);});});
