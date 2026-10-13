import { accountOf, periodRows, positionStats, dateLabel, dateTime } from './metrics.mjs';
import { normalizedLines, sectorsFor, relativePriceReturn, movingAverageState } from './market-metrics.mjs';

const $=id=>document.getElementById(id);
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nf=new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const num=value=>nf.format(value);
const usd=value=>'$'+num(value);
const sign=value=>value>1e-8?'+':value< -1e-8?'−':'';
const pct=value=>value==null?'—':sign(value)+(Math.abs(value)*100).toFixed(2)+'%';
const pp=value=>sign(value)+Math.abs(value).toFixed(2)+' pp';
const tone=value=>value< -1e-8?'negative':value>1e-8?'positive':'muted';
const money=value=>sign(value)+usd(Math.abs(value));
const palette={SPY:'#60a5fa',QQQ:'#a78bfa',DIA:'#50d8a6',IWM:'#eecb78'};
const labels={SPY:'标普 500',QQQ:'纳斯达克 100',DIA:'道琼斯工业',IWM:'罗素 2000'};
const holdingColors={FN:'#a78bfa',CEG:'#60a5fa',NVDA:'#50d8a6',NU:'#eecb78',MO:'#9fabc3'};
const windows={'1W':'近 5 个日线间隔','1M':'近 21 个日线间隔','3M':'近 63 个日线间隔','6M':'近 126 个日线间隔','1Y':'可用近一年日线'};
const sectorPeriods={'1D':'1d','1W':'5d','1M':'21d'};
const state={workspace:'market',window:'1M',symbols:['SPY','QQQ','DIA','IWM'],focus:'SPY',sectorWindow:'1D',sector:'XLE',selected:null};
let market,accountData,geometry,resizeObserver,unregister;

function sparkline(values,{width=140,height=42,color='#a78bfa',id='spark',area=false}={}){
  if(values.length<2)return '';
  const min=Math.min(...values),max=Math.max(...values),span=max-min||1;
  const x=i=>3+i/(values.length-1)*(width-6),y=v=>5+(max-v)/span*(height-10);
  const path=values.map((v,i)=>(i?'L':'M')+x(i).toFixed(2)+' '+y(v).toFixed(2)).join(' ');
  let html='';
  if(area)html='<defs><linearGradient id="'+id+'" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="'+color+'" stop-opacity=".22"/><stop offset="1" stop-color="'+color+'" stop-opacity="0"/></linearGradient></defs><path d="'+path+' L'+(width-3)+' '+height+' L3 '+height+' Z" fill="url(#'+id+')"/>';
  return html+'<path d="'+path+'" fill="none" stroke="'+color+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
}

function switchWorkspace(name){
  if(!['market','portfolio','holdings'].includes(name))throw new Error('不支持的工作区');
  state.workspace=name;
  if(window.InvestmentShell){window.InvestmentShell.showWorkspace(name);return;}
  for(const key of ['market','portfolio','holdings'])$(key+'-page').hidden=key!==name;
  document.querySelectorAll('.workspace-nav [data-workspace]').forEach(b=>{if(b.dataset.workspace===name)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  $('workspace-title').textContent={market:'市场总览',portfolio:'账户表现',holdings:'持仓分析'}[name];
  if(name==='market'&&market)requestAnimationFrame(drawMarketChart);
}

function renderTickers(){
  $('market-tickers').innerHTML=Object.keys(labels).map(symbol=>{
    const inst=market.instruments[symbol],m=inst.metrics,change=m.returns['1d'].value;
    return '<button class="market-ticker" data-focus-symbol="'+symbol+'" aria-pressed="'+(state.focus===symbol)+'" style="--ticker-color:'+palette[symbol]+'"><div class="ticker-card-top"><span class="index-symbol">'+symbol+'</span><span class="ticker-market-name">'+labels[symbol]+'</span><span class="card-arrow" aria-hidden="true">↗</span></div><div class="ticker-card-middle"><strong>'+usd(m.lastClose)+'</strong><svg viewBox="0 0 112 38" aria-hidden="true">'+sparkline(inst.data.slice(-22).map(r=>r.close),{width:112,height:38,color:palette[symbol]})+'</svg></div><div class="ticker-card-bottom"><span class="'+tone(change)+'">'+pct(change)+' <small>'+money(m.dayChange)+'</small></span><span>ETF · 最近收盘</span></div></button>';
  }).join('');
  document.querySelectorAll('[data-focus-symbol]').forEach(b=>b.addEventListener('click',()=>{
    state.focus=b.dataset.focusSymbol;if(!state.symbols.includes(state.focus))state.symbols.push(state.focus);renderMarket();
  }));
}

function renderBook(){
  const a=accountOf(accountData),rows=periodRows(accountData,'YTD'),last=rows.at(-1),month=a.periods.MTD.cps.at(-1),dd=Math.min(0,...rows.map(r=>r.drawdown));
  $('book-nav').textContent=usd(last.nav);
  $('book-return').textContent=pct(last.ret);$('book-return').className=tone(last.ret);
  $('book-month').textContent=pct(month);$('book-month').className=tone(month);
  $('book-drawdown').textContent=pct(dd);
  $('book-cash').textContent=usd(accountData.summary.total_cash_value);
  $('book-sparkline').innerHTML='<title>账户记录以来时间加权收益 '+pct(last.ret)+'</title>'+sparkline(rows.map(r=>r.ret),{width:280,height:100,color:'#a78bfa',id:'book-gradient',area:true});
  $('book-date').textContent=dateLabel(rows[0].date)+' — '+dateLabel(last.date)+' · 现金取自账户摘要';
}

function renderTrend(){
  $('market-trend-row').innerHTML=Object.keys(labels).map(symbol=>{
    const m=movingAverageState(market.instruments[symbol]);
    return '<div class="trend-item"><strong>'+symbol+'</strong><span class="'+(m.above20?'positive':'negative')+'">'+(m.above20?'↑':'↓')+' MA20</span><span class="'+(m.above50?'positive':'negative')+'">'+(m.above50?'↑':'↓')+' MA50</span></div>';
  }).join('');
}

function drawMarketChart(){
  if(!market)return;
  const comparison=normalizedLines(market,state.symbols,state.window),wrap=$('market-chart-wrap'),svg=$('market-chart');
  if(comparison.dates.length<2){svg.innerHTML='<title>共同日期不足，暂不能绘图</title>';return;}
  const width=Math.max(280,wrap.clientWidth),height=parseFloat(getComputedStyle(svg).height)||276;
  const margin={left:50,right:17,top:16,bottom:33},plotW=width-margin.left-margin.right,plotH=height-margin.top-margin.bottom;
  const all=Object.values(comparison.series).flatMap(s=>s.map(r=>r.value));
  let min=Math.min(0,...all),max=Math.max(0,...all),span=max-min||.01;min-=span*.13;max+=span*.16;
  const times=comparison.dates.map(dateTime),first=times[0],last=times.at(-1);
  const x=i=>margin.left+(times[i]-first)/(last-first||1)*plotW,y=v=>margin.top+(max-v)/(max-min)*plotH;
  svg.setAttribute('viewBox','0 0 '+width+' '+height);
  let html='<title id="market-svg-title">'+windows[state.window]+'的主要市场 ETF 价格收益，'+dateLabel(comparison.start,true)+' 至 '+dateLabel(comparison.end,true)+'</title><defs><linearGradient id="market-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="'+palette[state.focus]+'" stop-opacity=".13"/><stop offset="1" stop-color="'+palette[state.focus]+'" stop-opacity="0"/></linearGradient></defs>';
  for(let i=0;i<5;i++){
    const value=min+(max-min)*i/4,py=y(value);
    html+='<line x1="'+margin.left+'" y1="'+py+'" x2="'+(width-margin.right)+'" y2="'+py+'" stroke="#2b2c3b" stroke-dasharray="2 5"/><text x="'+(margin.left-11)+'" y="'+(py+4)+'" text-anchor="end" fill="#7f8096" font-size="11">'+(value*100).toFixed(max-min<.08?1:0)+'%</text>';
  }
  html+='<line x1="'+margin.left+'" y1="'+y(0)+'" x2="'+(width-margin.right)+'" y2="'+y(0)+'" stroke="#545164" stroke-dasharray="4 5"/>';
  const ticks=width<470?3:5;
  for(let i=0;i<ticks;i++){
    const idx=Math.round(i*(comparison.dates.length-1)/(ticks-1));
    html+='<text x="'+x(idx)+'" y="'+(height-8)+'" text-anchor="middle" fill="#7f8096" font-size="11">'+dateLabel(comparison.dates[idx])+'</text>';
  }
  const order=state.symbols.filter(s=>s!==state.focus).concat(state.focus);
  for(const symbol of order){
    const rows=comparison.series[symbol];if(!rows)continue;
    const path=rows.map((r,i)=>(i?'L':'M')+x(i).toFixed(2)+' '+y(r.value).toFixed(2)).join(' ');
    if(symbol===state.focus)html+='<path d="'+path+' L'+x(rows.length-1)+' '+y(min)+' L'+x(0)+' '+y(min)+' Z" fill="url(#market-area)"/>';
    html+='<path d="'+path+'" fill="none" stroke="'+palette[symbol]+'" stroke-width="'+(symbol===state.focus?'2.5':'1.7')+'" stroke-opacity="'+(symbol===state.focus?'1':'.78')+'" stroke-linecap="round" stroke-linejoin="round"/>';
    html+='<circle cx="'+x(rows.length-1)+'" cy="'+y(rows.at(-1).value)+'" r="'+(symbol===state.focus?'3.5':'2.4')+'" fill="'+palette[symbol]+'"/>';
  }
  html+='<g id="market-crosshair" visibility="hidden"><line id="market-crosshair-line" x1="0" x2="0" y1="'+margin.top+'" y2="'+(height-margin.bottom)+'" stroke="#9690b0" stroke-dasharray="3 4"/></g>';
  svg.innerHTML=html;geometry={width,height,comparison,x,y,times};
  $('market-chart-range').textContent=dateLabel(comparison.start,true)+' — '+dateLabel(comparison.end,true)+' · '+windows[state.window];
  $('market-chart-end').textContent='截至 '+dateLabel(comparison.end);
  $('market-focus-label').textContent=labels[state.focus]+' · '+state.focus;
  const focusReturn=comparison.series[state.focus].at(-1).value;
  $('market-return-large').textContent=pct(focusReturn);$('market-return-large').className=tone(focusReturn);
  hideMarketTooltip();
}

function renderMarket(){
  document.querySelectorAll('[data-market-window]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.marketWindow===state.window)));
  document.querySelectorAll('[data-market-symbol]').forEach(b=>{const active=state.symbols.includes(b.dataset.marketSymbol);b.setAttribute('aria-pressed',String(active));b.disabled=active&&state.symbols.length===1;});
  renderTickers();drawMarketChart();
}

function showMarketTooltip(index){
  if(!geometry)return;
  const g=geometry;index=Math.max(0,Math.min(index,g.comparison.dates.length-1));state.selected=index;
  const px=g.x(index);$('market-crosshair').setAttribute('visibility','visible');$('market-crosshair-line').setAttribute('x1',px);$('market-crosshair-line').setAttribute('x2',px);
  let html='<strong>'+dateLabel(g.comparison.dates[index],true)+'</strong>';
  for(const symbol of state.symbols){const p=g.comparison.series[symbol][index];html+='<div class="tooltip-row"><span><i class="tooltip-dot" style="background:'+palette[symbol]+'"></i>'+symbol+'</span><b>'+usd(p.close)+'</b><b class="'+tone(p.value)+'">'+pct(p.value)+'</b></div>';}
  html+='<small>相对本图共同起点的价格收益</small>';
  const tip=$('market-tooltip');tip.innerHTML=html;tip.hidden=false;
  tip.style.left=Math.max(6,Math.min(px+15,g.width-tip.offsetWidth-6))+'px';tip.style.top='12px';
}
function hideMarketTooltip(){const cross=$('market-crosshair');if(cross)cross.setAttribute('visibility','hidden');$('market-tooltip').hidden=true;state.selected=null;}
function moveMarketTooltip(event){
  if(!geometry)return;
  const rect=$('market-chart').getBoundingClientRect();if(!rect.width)return;
  const px=(event.clientX-rect.left)*geometry.width/rect.width;
  let index=0,min=Infinity;geometry.times.forEach((_,i)=>{const distance=Math.abs(geometry.x(i)-px);if(distance<min){min=distance;index=i;}});showMarketTooltip(index);
}

function renderSectorDetail(){
  const sector=market.sectors.find(s=>s.symbol===state.sector),p=sector?.returnPeriods[sectorPeriods[state.sectorWindow]];
  if(!p)return;
  $('sector-detail').innerHTML='<div><strong>'+esc(sector.name)+'</strong><span>'+sector.symbol+' · '+usd(sector.latestClose)+'</span></div><div><strong class="'+tone(p.value)+'">'+pct(p.value)+'</strong><span>'+dateLabel(p.startDate)+' — '+dateLabel(p.endDate)+'</span></div>';
}
function renderSectors(){
  const view=sectorsFor(market,state.sectorWindow),max=Math.max(...view.available.map(s=>Math.abs(s.ret)),.01);
  document.querySelectorAll('[data-sector-window]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.sectorWindow===state.sectorWindow)));
  $('sector-heatmap').innerHTML=view.sectors.map(s=>{
    const alpha=.08+Math.abs(s.ret)/max*.18,color=s.ret>=0?'80,216,166':'238,203,120';
    return '<button class="sector-tile '+tone(s.ret)+'" data-sector="'+s.symbol+'" aria-pressed="'+(s.symbol===state.sector)+'" style="--tile-bg:rgba('+color+','+alpha.toFixed(3)+');--tile-border:rgba('+color+',.15)"><span>'+esc(s.name)+'</span><strong>'+pct(s.ret)+'</strong><small>'+s.symbol+'</small></button>';
  }).join('')+'<div class="sector-breadth"><span>上涨板块</span><strong>'+view.advancing+'<small> / '+view.available.length+'</small></strong><span>'+view.declining+' 个下跌 · '+view.flat+' 个持平</span></div>';
  document.querySelectorAll('[data-sector]').forEach(b=>b.addEventListener('click',()=>{state.sector=b.dataset.sector;renderSectors();}));
  const p=view.available[0].returnPeriods[sectorPeriods[state.sectorWindow]];
  $('sector-date-range').textContent=dateLabel(p.startDate)+' — '+dateLabel(p.endDate)+' · 收盘价格变化';renderSectorDetail();
}

function renderRisk(){
  const v=market.instruments.VIX,m=v.metrics;
  $('vix-value').textContent=num(m.lastClose);
  $('vix-daily').innerHTML='<strong class="amber">'+sign(m.dayChange)+num(Math.abs(m.dayChange))+' 点</strong><span>'+pct(m.returns['1d'].value)+' · 日变化</span>';
  $('vix-sparkline').innerHTML='<title>VIX 近 21 个日线间隔</title>'+sparkline(v.data.slice(-22).map(p=>p.close),{width:280,height:60,color:'#eecb78',id:'vix-gradient',area:true});
  $('vix-month').textContent=pct(m.returns['21d'].value);
  const rsp=market.instruments.RSP.metrics.returns['1d'].value,spy=market.instruments.SPY.metrics.returns['1d'].value,iwm=market.instruments.IWM.metrics.returns['1d'].value;
  const rows=[{label:'长期美债 · TLT',detail:'ETF 单日价格收益',value:pct(market.instruments.TLT.metrics.returns['1d'].value),color:'blue'},{label:'等权 / 市值加权',detail:'RSP − SPY · 单日差',value:pp((rsp-spy)*100),color:'positive'},{label:'小盘 / 大盘',detail:'IWM − SPY · 单日差',value:pp((iwm-spy)*100),color:'purple'}];
  $('risk-rows').innerHTML=rows.map(r=>'<div class="risk-row"><div><strong>'+r.label+'</strong><span>'+r.detail+'</span></div><b class="'+r.color+'">'+r.value+'</b></div>').join('');
}

function renderInsights(){
  const daily=sectorsFor(market,'1D'),month=sectorsFor(market,'1M'),style=relativePriceReturn(market,'QQQ','IWM','1M'),breadth=relativePriceReturn(market,'RSP','SPY','1M');
  const best=daily.sorted[0],worst=daily.sorted.at(-1);
  const cards=[
    {kicker:'01 / SECTOR ROTATION',title:'当日板块分化',value:daily.advancing+' / '+daily.available.length,unit:'板块上涨',color:'green',body:best.name+' '+pct(best.ret)+' 领涨，'+worst.name+' '+pct(worst.ret)+'。计数仅覆盖这 11 只行业 ETF。',range:dateLabel(market.asOfDate,true)},
    {kicker:'02 / MARKET STYLE',title:'大盘成长与小盘分化',value:Math.abs(style.differencePercentagePoints).toFixed(2),unit:'个百分点',color:'purple',body:'近 21 期 QQQ '+pct(style.aReturn)+'，IWM '+pct(style.bReturn)+'；按同区间价格收益率计算，QQQ '+(style.differencePercentagePoints>=0?'领先':'落后')+'。',range:dateLabel(style.start)+' — '+dateLabel(style.end)},
    {kicker:'03 / PARTICIPATION',title:breadth.differencePercentagePoints<=0?'等权表现落后大盘':'等权表现领先大盘',value:Math.abs(breadth.differencePercentagePoints).toFixed(2),unit:'个百分点',color:'blue',body:'近 21 期 RSP '+pct(breadth.aReturn)+'，SPY '+pct(breadth.bReturn)+'；同期 '+month.advancing+' / '+month.available.length+' 只行业 ETF 上涨。',range:dateLabel(breadth.start)+' — '+dateLabel(breadth.end)}
  ];
  $('market-insight-cards').innerHTML=cards.map(c=>'<article class="insight-card '+c.color+'-insight"><div class="insight-kicker">'+c.kicker+'</div><h3>'+c.title+'</h3><div class="insight-value">'+c.value+'<span>'+c.unit+'</span></div><p>'+c.body+'</p><span class="insight-range">'+c.range+'</span></article>').join('');
}

function renderCalendar(){
  $('calendar-events').innerHTML=market.events.map(e=>{
    const day=e.localTime.slice(8,10),month=e.localTime.slice(5,7),time=e.localTime.slice(11,16);
    return '<article class="calendar-event"><div class="calendar-date"><span>'+Number(month)+' 月</span><strong>'+day+'</strong></div><div class="calendar-content"><div class="calendar-event-top"><span class="event-status '+(e.status==='已发布'?'published':'upcoming')+'">'+esc(e.status)+'</span><time datetime="'+esc(e.localTime)+'">'+time+' JST</time></div><h3>'+esc(e.title)+'</h3><span class="event-subtitle">'+esc(e.subtitle)+'</span><p>'+esc(e.relevance)+'</p><a href="'+esc(e.sourceUrl)+'" target="_blank" rel="noopener noreferrer">'+(e.sourceId==='fed-minutes'?'Federal Reserve':'BLS')+' · 官方来源 <span aria-hidden="true">↗</span></a></div></article>';
  }).join('');
}

function renderHoldings(){
  const stats=positionStats(accountData),positions=[...stats.positions].sort((a,b)=>b.market_value-a.market_value),topTwo=positions.slice(0,2).reduce((s,p)=>s+p.weight,0);
  const cards=[{label:'股票持仓市值',value:usd(stats.totalMarket),detail:positions.length+' 个持仓 · 持仓明细',color:''},{label:'未实现盈亏',value:money(stats.totalPnl),detail:'当前持仓的累计浮盈',color:tone(stats.totalPnl)},{label:'持仓浮盈率',value:pct(stats.holdingReturn),detail:'未实现盈亏 / 持仓成本',color:tone(stats.holdingReturn)},{label:'前两大持仓权重',value:(topTwo*100).toFixed(2)+'%',detail:positions.slice(0,2).map(p=>p.symbol).join(' + ')+' · 股票市值内',color:'purple'}];
  $('holdings-kpis').innerHTML=cards.map(c=>'<article class="stat-card"><div class="stat-top">'+c.label+'</div><div class="stat-value '+c.color+'">'+c.value+'</div><div class="stat-detail">'+c.detail+'</div></article>').join('');
  $('holdings-allocation').innerHTML='<div class="holdings-stacked" aria-label="股票市值权重">'+positions.map(p=>'<span title="'+p.symbol+' '+(p.weight*100).toFixed(2)+'%" style="width:'+(p.weight*100)+'%;background:'+holdingColors[p.symbol]+'"></span>').join('')+'</div>'+positions.map(p=>'<div class="holding-weight-row"><span><i style="background:'+holdingColors[p.symbol]+'"></i><strong>'+p.symbol+'</strong></span><span>'+usd(p.market_value)+'</span><b>'+(p.weight*100).toFixed(2)+'%</b></div>').join('');
  const sorted=[...positions].sort((a,b)=>b.unrealized_pnl-a.unrealized_pnl),max=Math.max(...sorted.map(p=>Math.abs(p.unrealized_pnl)),1);
  $('holdings-attribution').innerHTML=sorted.map(p=>'<div class="attribution-row"><strong>'+p.symbol+'</strong><div class="attribution-bar"><span style="width:'+(Math.abs(p.unrealized_pnl)/max*100)+'%;background:'+holdingColors[p.symbol]+'"></span></div><b class="'+tone(p.unrealized_pnl)+'">'+money(p.unrealized_pnl)+'</b></div>').join('')+'<p class="small-note">按当前未实现盈亏金额排序；不是账户期间收益贡献。</p>';
}

function registerTools(){
  if(!document.modelContext?.registerTool)return;
  const lifecycle=new AbortController();unregister=()=>lifecycle.abort();
  const definitions=[
    {name:'get_investment_market_snapshot',title:'读取美股市场快照',description:'读取此公开快照仪表盘已有的市场与板块快照，不获取实时行情。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:false},execute:input=>{if(input&&Object.keys(input).length)throw new Error('此工具不接受参数');return {snapshotOnly:true,capturedAt:market.capturedAt,asOfDate:market.asOfDate,workspace:state.workspace,window:state.window,series:normalizedLines(market,state.symbols,state.window),sectorWindow:state.sectorWindow,sectors:sectorsFor(market,state.sectorWindow).sectors.map(s=>({symbol:s.symbol,name:s.name,returnFraction:s.ret})),vix:market.instruments.VIX.metrics};}},
    {name:'set_investment_workspace',title:'切换投资管理工作区',description:'切换市场总览、账户表现或持仓分析，以及市场图表区间；只改变显示。',inputSchema:{type:'object',properties:{workspace:{type:'string',enum:['market','portfolio','holdings']},window:{type:'string',enum:Object.keys(windows)}},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute:input=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['workspace','window'].includes(k)))throw new Error('无效的视图选项');if(input.window!==undefined&&!Object.hasOwn(windows,input.window))throw new Error('不支持的时间范围');if(input.workspace!==undefined&&!['market','portfolio','holdings'].includes(input.workspace))throw new Error('不支持的工作区');if(input.window)state.window=input.window;switchWorkspace(input.workspace??state.workspace);renderMarket();return {workspace:state.workspace,window:state.window,snapshotOnly:true};}}
  ];
  for(const definition of definitions){try{Promise.resolve(document.modelContext.registerTool(definition,{signal:lifecycle.signal})).catch(()=>{});}catch{}}
}

async function init(){
  if(!window.InvestmentShell){
  document.querySelectorAll('[data-workspace]').forEach(b=>b.addEventListener('click',()=>switchWorkspace(b.dataset.workspace)));
  document.querySelectorAll('[data-open-market-method]').forEach(b=>b.addEventListener('click',()=>$('method-dialog').showModal()));
  window.addEventListener('investment-show-portfolio',()=>switchWorkspace('portfolio'));
  }else{
    state.workspace=window.InvestmentShell.getWorkspace();
    window.addEventListener('investment-workspace-change',event=>{state.workspace=event.detail.workspace;if(state.workspace==='market'&&market)requestAnimationFrame(drawMarketChart);});
  }
  if(window.InvestmentShell){
    [market,accountData]=await Promise.all([window.InvestmentShell.readSnapshot('./market.json','市场快照'),window.InvestmentShell.readSnapshot('./data.json','账户快照')]);
  }else{
  const responses=await Promise.all([fetch('./market.json',{cache:'no-store'}),fetch('./data.json',{cache:'no-store'})]);
  if(responses.some(r=>!r.ok))throw new Error('行情或账户快照未能加载');
  [market,accountData]=await Promise.all(responses.map(r=>r.json()));
  }
  $('market-asof').textContent='最近完整交易日 · '+dateLabel(market.asOfDate,true)+' · 日线数据';
  const captured=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Tokyo',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(accountData.capturedAt));
  $('global-snapshot').textContent=captured+' JST';$('global-snapshot').setAttribute('datetime',accountData.capturedAt);
  $('global-data-note').textContent='市场截至 '+dateLabel(market.asOfDate)+' · 账户截至 '+dateLabel(accountOf(accountData).end);
  renderMarket();renderBook();renderTrend();renderSectors();renderRisk();renderInsights();renderCalendar();renderHoldings();
  document.querySelectorAll('[data-market-window]').forEach(b=>b.addEventListener('click',()=>{state.window=b.dataset.marketWindow;renderMarket();}));
  document.querySelectorAll('[data-market-symbol]').forEach(b=>b.addEventListener('click',()=>{
    const symbol=b.dataset.marketSymbol,has=state.symbols.includes(symbol);if(has&&state.symbols.length===1)return;
    state.symbols=has?state.symbols.filter(s=>s!==symbol):Object.keys(labels).filter(s=>s===symbol||state.symbols.includes(s));
    if(!state.symbols.includes(state.focus))state.focus=state.symbols[0];renderMarket();
  }));
  document.querySelectorAll('[data-sector-window]').forEach(b=>b.addEventListener('click',()=>{state.sectorWindow=b.dataset.sectorWindow;renderSectors();}));
  const chart=$('market-chart-wrap');chart.addEventListener('pointermove',moveMarketTooltip);chart.addEventListener('pointerdown',moveMarketTooltip);chart.addEventListener('pointerleave',hideMarketTooltip);chart.addEventListener('pointercancel',hideMarketTooltip);chart.addEventListener('blur',hideMarketTooltip);
  chart.addEventListener('keydown',event=>{if(!geometry||!['ArrowLeft','ArrowRight','Home','End','Escape'].includes(event.key))return;event.preventDefault();if(event.key==='Escape'){hideMarketTooltip();return;}const current=state.selected??geometry.comparison.dates.length-1;showMarketTooltip(event.key==='Home'?0:event.key==='End'?geometry.comparison.dates.length-1:current+(event.key==='ArrowLeft'?-1:1));});
  let timer;const onResize=()=>{clearTimeout(timer);timer=setTimeout(drawMarketChart,70);};if(typeof ResizeObserver==='function'){resizeObserver=new ResizeObserver(onResize);resizeObserver.observe(chart);}else window.addEventListener('resize',onResize);
  registerTools();window.addEventListener('pagehide',()=>{resizeObserver?.disconnect();unregister?.();},{once:true});
}
init().catch(error=>{if(window.InvestmentShell){window.InvestmentShell.reportLoadError('market-load-error','市场视图暂未加载：'+error.message+'。');return;}const el=$('market-load-error');el.hidden=false;el.textContent='市场视图暂未加载：'+error.message+'。请重新打开本页；若仍无法显示，请在原对话请求更新。';});
