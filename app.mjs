import { PERIODS, accountOf, periodRows, benchmarkComparison, positionStats, monthlyReturns, dateLabel, dateTime } from './metrics.mjs';

const byId = id => document.getElementById(id);
const escapeHtml = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd = value => Number.isFinite(value) ? new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(value) : '未取得';
const number = value => new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).format(value);
const sign = value => value < -0.00000001 ? '−' : value > 0.00000001 ? '+' : '';
const pct = value => !Number.isFinite(value) ? '未取得' : sign(value)+(Math.abs(value)*100).toFixed(2)+'%';
const signedUsd = value => sign(value)+usd(Math.abs(value));
const pctHtml = value => sign(value)+(Math.abs(value)*100).toFixed(2)+'<span>%</span>';
const tone = value => value < -0.00000001 ? 'negative' : value > 0.00000001 ? 'positive' : '';
const names = {FN:'Fabrinet',CEG:'Constellation Energy',NVDA:'NVIDIA',NU:'Nu Holdings',MO:'Altria Group'};
const colors = {account:'#a78bfa',QQQ:'#60a5fa',SPY:'#50d8a6'};
let data, stats, geometry, resizeObserver, unregister;
const state = {period:'YTD',view:'return',benchmarks:{QQQ:true,SPY:true},sort:'market_value',ascending:false,selected:null};

function getRows(){return periodRows(data,state.period);}
function getComparison(){
  const required=['QQQ','SPY'];
  if(!required.every(symbol=>Array.isArray(data.benchmarks?.[symbol]?.data)&&data.benchmarks[symbol].data.length)){
    const rows=getRows();
    return {ready:false,start:rows[0].date,end:rows.at(-1).date,latestAccountDate:rows.at(-1).date,series:{},benchmarks:{},accountReturn:null};
  }
  return benchmarkComparison(data,state.period);
}
function benchmarkDateLabel(year=false){
  const date=data.benchmarks?.QQQ?.data?.at(-1)?.date;
  return typeof date==='string'&&/^\d{8}$/.test(date) ? dateLabel(date,year) : '未取得';
}
function rangeText(rows,year=true){return dateLabel(rows[0].date,year)+' — '+dateLabel(rows.at(-1).date,year);}
function updateControls(){
  document.querySelectorAll('[data-period]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.period===state.period)));
  document.querySelectorAll('[data-view]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.view===state.view)));
  document.querySelectorAll('[data-benchmark]').forEach(el=>{
    el.setAttribute('aria-pressed',String(state.benchmarks[el.dataset.benchmark]));
    el.hidden=state.view!=='return';
    const c=getComparison();
    el.disabled=!c.ready || c.start!==getRows()[0].date;
  });
}

function renderOverview(){
  const rows=getRows(), last=rows.at(-1), account=accountOf(data), month=account.periods.MTD;
  byId('return-label').textContent=state.period==='YTD'?'累计收益率':PERIODS[state.period]+'收益率';
  byId('return-value').innerHTML=pctHtml(last.ret);
  byId('return-range').textContent=rangeText(rows);
  byId('nav-value').textContent=usd(last.nav);
  byId('nav-detail').textContent='PortfolioAnalyst · '+dateLabel(last.date);
  byId('month-value').innerHTML=pctHtml(month.cps.at(-1));
  byId('month-value').className='stat-value '+tone(month.cps.at(-1));
  byId('month-detail').textContent=account.end.slice(0,4)+' 年 '+Number(account.end.slice(4,6))+' 月 · 截至 '+dateLabel(account.end);
  const dd=Math.min(0,...rows.map(r=>r.drawdown));
  byId('drawdown-value').innerHTML=pctHtml(dd);
  byId('drawdown-value').className='stat-value '+tone(dd);
  byId('chart-range').textContent=rangeText(rows);
}

function renderComparison(){
  const c=getComparison();
  if(!c.ready){
    byId('benchmark-strip').innerHTML='<div class="benchmark-empty"><strong>同口径ETF基准未取得</strong><span>账户已有 '+dateLabel(c.latestAccountDate)+' 记录；本快照未提供足够的同口径ETF数据，暂不计算比较差值。</span></div>';
    return;
  }
  let html='<div class="comparison-heading"><strong>同区间比较 · '+dateLabel(c.start)+' — '+dateLabel(c.end)+'</strong><span>ETF 价格收益率参考 · 非完整总回报</span></div><div class="comparison-grid">';
  html+='<div class="comparison-item"><div class="comparison-label">我的账户 · TWR</div><div class="comparison-number '+tone(c.accountReturn)+'">'+pct(c.accountReturn)+'</div><div class="comparison-note">共同日期截至 '+dateLabel(c.end)+'</div></div>';
  for(const symbol of ['QQQ','SPY']){
    const b=c.benchmarks[symbol];
    html+='<div class="comparison-item"><div class="comparison-label">'+symbol+' · 价格收益</div><div class="comparison-number">'+pct(b.ret)+'</div><div class="comparison-note">账户'+(b.excess>=0?'领先 ':'落后 ')+Math.abs(b.excess).toFixed(2)+' 个百分点</div></div>';
  }
  byId('benchmark-strip').innerHTML=html+'</div>';
}

function chartValue(row){return state.view==='nav'?row.nav:state.view==='drawdown'?row.drawdown:row.ret;}
function renderChart(){
  const rows=getRows(), c=getComparison(), wrap=byId('chart-wrap'), svg=byId('performance-chart');
  const alignedChart=c.ready && c.start===rows[0].date;
  const w=Math.max(270,wrap.clientWidth), h=parseFloat(getComputedStyle(svg).height)||314;
  const margin={left:state.view==='nav'?68:54,right:22,top:21,bottom:37}, plotW=w-margin.left-margin.right, plotH=h-margin.top-margin.bottom;
  const times=rows.map(r=>dateTime(r.date)), minT=times[0], maxT=times.at(-1);
  const x=t=>margin.left+(t-minT)/(maxT-minT||1)*plotW;
  let values=rows.map(chartValue);
  if(state.view==='return'&&alignedChart)for(const symbol of ['QQQ','SPY'])if(state.benchmarks[symbol])values.push(...c.series[symbol].filter(r=>r.value!=null).map(r=>r.value));
  let min=Math.min(...values),max=Math.max(...values);
  if(state.view!=='nav'){min=Math.min(0,min);max=Math.max(0,max);}
  const span=max-min|| (state.view==='nav'?1000:0.01);
  min-=span*0.1;max+=span*0.13;
  const y=value=>margin.top+(max-value)/(max-min)*plotH;
  const title={return:'累计收益率',nav:'账户净资产',drawdown:'TWR 指数回撤'}[state.view];
  svg.setAttribute('viewBox','0 0 '+w+' '+h);
  let html='<title id="chart-svg-title">'+title+'，'+rangeText(rows)+'，末值 '+(state.view==='nav'?usd(chartValue(rows.at(-1))):pct(chartValue(rows.at(-1))))+'</title>';
  html+='<defs><linearGradient id="area-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="'+(state.view==='drawdown'?'#eecb78':'#a78bfa')+'" stop-opacity=".18"/><stop offset="100%" stop-color="'+(state.view==='drawdown'?'#eecb78':'#a78bfa')+'" stop-opacity=".01"/></linearGradient><clipPath id="plot-clip"><rect x="'+margin.left+'" y="'+margin.top+'" width="'+plotW+'" height="'+plotH+'"/></clipPath></defs>';
  for(let i=0;i<5;i++){
    const value=min+(max-min)*i/4, py=y(value);
    const label=state.view==='nav'?(Math.abs(value)>=1000?'$'+(value/1000).toFixed(1)+'k':usd(value)):(value*100).toFixed(Math.abs(max-min)<0.05?1:0)+'%';
    html+='<line x1="'+margin.left+'" y1="'+py+'" x2="'+(w-margin.right)+'" y2="'+py+'" stroke="#2b2c3b" stroke-dasharray="3 4"/><text x="'+(margin.left-12)+'" y="'+(py+4)+'" font-size="12" fill="#7f8096" text-anchor="end">'+label+'</text>';
  }
  const labelCount=w<500?3:5, tickIndices=[...new Set(Array.from({length:Math.min(labelCount,rows.length)},(_,i)=>Math.round(i*(rows.length-1)/(Math.min(labelCount,rows.length)-1||1))))];
  for(const index of tickIndices){
    html+='<text x="'+x(times[index])+'" y="'+(h-12)+'" text-anchor="middle" fill="#7f8096" font-size="12">'+dateLabel(rows[index].date)+'</text>';
  }
  if(min<0&&max>0&&state.view!=='nav')html+='<line x1="'+margin.left+'" y1="'+y(0)+'" x2="'+(w-margin.right)+'" y2="'+y(0)+'" stroke="#545164" stroke-dasharray="4 4"/>';
  const path=rows.map((r,i)=>(i?'L':'M')+x(times[i]).toFixed(2)+' '+y(chartValue(r)).toFixed(2)).join(' ');
  const baseline=y(state.view==='nav'?min:0),area=path+' L'+x(times.at(-1))+' '+baseline+' L'+x(times[0])+' '+baseline+' Z';
  const lineColor=state.view==='drawdown'?'#eecb78':state.view==='nav'?'#60a5fa':colors.account;
  html+='<g clip-path="url(#plot-clip)"><path d="'+area+'" fill="url(#area-gradient)"/>';
  if(state.view==='return'&&alignedChart){
    for(const symbol of ['SPY','QQQ']){
      if(!state.benchmarks[symbol])continue;
      const points=c.series[symbol].filter(r=>r.value!=null);
      const bp=points.map((p,i)=>(i?'L':'M')+x(dateTime(p.date)).toFixed(2)+' '+y(p.value).toFixed(2)).join(' ');
      html+='<path d="'+bp+'" fill="none" stroke="'+colors[symbol]+'" stroke-width="1.8" stroke-dasharray="'+(symbol==='SPY'?'5 4':'none')+'" stroke-linejoin="round"/>';
    }
  }
  html+='<path d="'+path+'" fill="none" stroke="'+lineColor+'" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></g>';
  const last=rows.at(-1);
  html+='<circle cx="'+x(times.at(-1))+'" cy="'+y(chartValue(last))+'" r="4.6" fill="'+lineColor+'" stroke="#171822" stroke-width="2"/>';
  html+='<g id="chart-crosshair" visibility="hidden"><line id="crosshair-line" x1="0" y1="'+margin.top+'" x2="0" y2="'+(h-margin.bottom)+'" stroke="#9690b0" stroke-dasharray="4 4"/><circle id="crosshair-dot" cx="0" cy="0" r="4.5" fill="'+lineColor+'" stroke="#171822" stroke-width="2"/></g>';
  svg.innerHTML=html;
  geometry={w,h,margin,x,y,rows,times,c,alignedChart};
  document.querySelector('.account-line').style.backgroundColor=lineColor;
  if(state.view==='nav')byId('chart-note').textContent='净资产包含资金进出影响；此曲线不代表投资收益率。';
  else if(state.view==='drawdown')byId('chart-note').textContent='以所选区间 TWR 指数的前高为基准；已调整外部资金流影响。';
  else byId('chart-note').textContent='账户更新至 '+dateLabel(last.date)+'；ETF 日线截至 '+benchmarkDateLabel()+'。'+(c.ready&&!alignedChart?' 基准起点不同，比较结果见下方。':'');
  hideTooltip();
}

function showTooltip(index){
  if(!geometry)return;
  index=Math.max(0,Math.min(index,geometry.rows.length-1));state.selected=index;
  const row=geometry.rows[index],g=geometry,px=g.x(g.times[index]),py=g.y(chartValue(row));
  byId('chart-crosshair').setAttribute('visibility','visible');
  byId('crosshair-line').setAttribute('x1',px);byId('crosshair-line').setAttribute('x2',px);
  byId('crosshair-dot').setAttribute('cx',px);byId('crosshair-dot').setAttribute('cy',py);
  let html='<strong>'+dateLabel(row.date,true)+(row.baseline?' · 基准日':'')+'</strong>';
  const label=state.view==='nav'?'账户净资产':state.view==='drawdown'?'区间回撤':'我的账户';
  html+='<div class="tooltip-row"><span>'+label+'</span><b class="'+(state.view==='nav'?'':tone(chartValue(row)))+'">'+(state.view==='nav'?usd(row.nav):pct(chartValue(row)))+'</b></div>';
  if(state.view==='return'){
    for(const symbol of ['QQQ','SPY'])if(state.benchmarks[symbol]){
      const value=g.alignedChart ? g.c.series[symbol]?.find(r=>r.date===row.date)?.value : null;
      html+='<div class="tooltip-row"><span>'+symbol+'</span><b style="color:'+colors[symbol]+'">'+(value==null?'未提供':pct(value))+'</b></div>';
    }
  }
  const tip=byId('chart-tooltip');tip.innerHTML=html;tip.hidden=false;
  const tw=tip.offsetWidth,th=tip.offsetHeight;
  tip.style.left=Math.max(7,Math.min(px+14,g.w-tw-7))+'px';
  tip.style.top=Math.max(8,Math.min(py-th-15,g.h-th-14))+'px';
}
function hideTooltip(){const cross=byId('chart-crosshair');if(cross)cross.setAttribute('visibility','hidden');byId('chart-tooltip').hidden=true;state.selected=null;}
function pointerTooltip(event){
  if(!geometry)return;
  const rect=byId('performance-chart').getBoundingClientRect(),px=(event.clientX-rect.left)*(geometry.w/rect.width);
  let nearest=0,min=Infinity;
  geometry.times.forEach((t,i)=>{const distance=Math.abs(geometry.x(t)-px);if(distance<min){nearest=i;min=distance;}});
  showTooltip(nearest);
}

function renderAllocation(){
  const s=data.summary,base=s.net_liquidation;
  const items=[{name:'证券毛敞口',value:s.gross_position_value,color:'#a78bfa'},{name:'现金',value:s.total_cash_value,color:'#50d8a6'},{name:'股息应计余额',value:s.dividends,color:'#eecb78'}];
  const radius=73,circumference=2*Math.PI*radius;let offset=0;
  let html='<title>账户摘要资产分布：证券毛敞口 '+(items[0].value/base*100).toFixed(2)+'%，现金 '+(items[1].value/base*100).toFixed(2)+'%，应计余额 '+(items[2].value/base*100).toFixed(2)+'%</title><circle cx="95" cy="95" r="'+radius+'" fill="none" stroke="#2a2537" stroke-width="17"/>';
  const canDrawAllocation=base>0&&items.every(item=>Number.isFinite(item.value)&&item.value>=0)&&Math.abs(items.reduce((sum,item)=>sum+item.value,0)-base)<base*.01;
  for(const item of canDrawAllocation?items:[]){
    const length=item.value/base*circumference;
    html+='<circle cx="95" cy="95" r="'+radius+'" fill="none" stroke="'+item.color+'" stroke-width="17" stroke-dasharray="'+length+' '+(circumference-length)+'" stroke-dashoffset="'+(-offset)+'" transform="rotate(-90 95 95)"/>';offset+=length;
  }
  if(!canDrawAllocation)html+='<text x="95" y="99" text-anchor="middle" fill="#9fabc3" font-size="12">融资敞口见明细</text>';
  byId('allocation-donut').innerHTML=html;
  byId('cash-weight').textContent=(s.total_cash_value/base*100).toFixed(2)+'%';
  byId('allocation-list').innerHTML=items.map(item=>'<div class="allocation-row"><span class="allocation-label"><i class="allocation-dot" style="background:'+item.color+'"></i>'+item.name+'</span><strong>'+usd(item.value)+'</strong><span class="allocation-value">'+(item.value/base*100).toFixed(2)+'%</span></div>').join('');
  byId('summary-nav').textContent=usd(base);
}
function renderMonths(){
  const months=monthlyReturns(data).filter(m=>!m.baselineOnly),max=Math.max(...months.map(m=>Math.abs(m.ret)),.01);
  byId('monthly-returns').innerHTML=months.map(m=>'<div class="month-row"><span>'+Number(m.month.slice(4))+' 月</span><div class="month-bar" aria-hidden="true"><i style="width:'+(Math.abs(m.ret)/max*100)+'%"></i></div><strong class="'+tone(m.ret)+'">'+pct(m.ret)+'</strong></div>').join('');
}
function renderPositions(){
  const positions=[...stats.positions].sort((a,b)=>{
    const result=typeof a[state.sort]==='string'?a[state.sort].localeCompare(b[state.sort]):a[state.sort]-b[state.sort];
    return state.ascending?result:-result;
  });
  document.querySelectorAll('[data-sort]').forEach(b=>b.closest('th').setAttribute('aria-sort',b.dataset.sort===state.sort?(state.ascending?'ascending':'descending'):'none'));
  byId('positions-body').innerHTML=positions.map(p=>'<tr><td><div class="symbol-cell"><span class="ticker-avatar" aria-hidden="true">'+escapeHtml(p.symbol.slice(0,2))+'</span><div><div class="ticker-title">'+escapeHtml(p.symbol)+'</div><div class="ticker-name">'+escapeHtml(names[p.symbol]||'')+'</div></div></div></td><td class="number">'+p.position+'</td><td class="number">'+usd(p.average_price)+'</td><td class="number">'+usd(p.market_price)+'</td><td class="number">'+usd(p.market_value)+'</td><td class="number pnl-cell '+tone(p.unrealized_pnl)+'">'+signedUsd(p.unrealized_pnl)+'</td><td class="number"><span class="return-pill '+tone(p.ret)+'">'+pct(p.ret)+'</span></td><td class="number"><div class="weight-cell"><span class="weight-line" aria-hidden="true"><i style="width:'+(p.weight*100)+'%"></i></span><span>'+(p.weight*100).toFixed(2)+'%</span></div></td></tr>').join('');
  byId('positions-foot').innerHTML='<tr><td>持仓合计</td><td class="number">—</td><td class="number" colspan="2">成本 '+usd(stats.totalCost)+'</td><td class="number">'+usd(stats.totalMarket)+'</td><td class="number '+tone(stats.totalPnl)+'">'+signedUsd(stats.totalPnl)+'</td><td class="number">'+pct(stats.holdingReturn)+'</td><td class="number">100.00%</td></tr>';
  byId('holding-pnl').textContent=signedUsd(stats.totalPnl);
  byId('holding-return').textContent=pct(stats.holdingReturn);
}
function renderSources(){
  const a=accountOf(data),nav=a.periods.YTD.nav.at(-1),s=data.summary;
  byId('source-comparison').innerHTML='<table class="source-table"><thead><tr><th>来源</th><th>净资产</th><th>股票市值</th><th>未实现盈亏</th></tr></thead><tbody><tr><td>账户摘要 / 余额</td><td>'+usd(s.net_liquidation)+'</td><td>'+usd(s.gross_position_value)+'</td><td>'+usd(data.balances?.balances?.find(b=>b.currency==='BASE')?.unrealized_pnl)+'</td></tr><tr><td>持仓明细合计</td><td>未提供</td><td>'+usd(stats.totalMarket)+'</td><td>'+usd(stats.totalPnl)+'</td></tr><tr><td>PortfolioAnalyst</td><td>'+usd(nav)+'</td><td>未提供</td><td>未提供</td></tr></tbody></table>';
  const snapshot=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(data.capturedAt));
  byId('snapshot-time').textContent=snapshot+' JST';byId('snapshot-time').setAttribute('datetime',data.capturedAt);
  byId('source-times').innerHTML='<dt>快照生成时间 · 日本时间</dt><dd>'+escapeHtml(snapshot)+' JST</dd><dt>绩效来源更新时间</dt><dd>'+escapeHtml(a.last_successful_update)+'（时区未提供）</dd><dt>账户绩效日期范围</dt><dd>'+dateLabel(a.start,true)+' — '+dateLabel(a.end,true)+'</dd><dt>ETF 最近收盘日期</dt><dd>'+benchmarkDateLabel(true)+'</dd>';
}
function renderPerformance(){updateControls();renderOverview();renderComparison();renderChart();}
function setView(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('请提供有效的视图选项');
  const keys=Object.keys(input);if(keys.some(k=>!['period','view'].includes(k)))throw new Error('存在不支持的选项');
  const nextPeriod=input.period??state.period,nextView=input.view??state.view;
  if(!Object.hasOwn(PERIODS,nextPeriod))throw new Error('不支持的时间范围');
  if(!['return','nav','drawdown'].includes(nextView))throw new Error('不支持的图表类型');
  state.period=nextPeriod;state.view=nextView;window.dispatchEvent?.(new Event('investment-show-portfolio'));renderPerformance();return readSnapshot();
}
function readSnapshot(){
  const rows=getRows(),c=getComparison();
  return {snapshotOnly:true,capturedAt:data.capturedAt,period:state.period,view:state.view,currency:'USD',start:rows[0].date,end:rows.at(-1).date,returnMethod:'TWR',returnFraction:rows.at(-1).ret,nav:rows.at(-1).nav,maxDrawdownFraction:Math.min(0,...rows.map(r=>r.drawdown)),comparison:c.ready?{start:c.start,end:c.end,accountReturnFraction:c.accountReturn,benchmarkPriceReturns:c.benchmarks}:null};
}
function registerTools(){
  if(!document.modelContext?.registerTool)return;
  const lifecycle=new AbortController();unregister=()=>lifecycle.abort();
  const tools=[
    {name:'get_ibkr_performance_snapshot',title:'读取账户收益快照',description:'读取此公开快照仪表盘中当前时间范围的既有 IBKR 数据快照，不查询或刷新券商数据。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:false},execute:input=>{if(input&&Object.keys(input).length)throw new Error('此工具不接受参数');return readSnapshot();}},
    {name:'set_ibkr_performance_view',title:'切换账户收益图表',description:'切换页面中的时间范围或图表类型；只改变此页显示，不执行交易，也不刷新券商账户。',inputSchema:{type:'object',properties:{period:{type:'string',enum:Object.keys(PERIODS)},view:{type:'string',enum:['return','nav','drawdown']}},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute:setView}
  ];
  for(const tool of tools){try{Promise.resolve(document.modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}}
}

async function init(){
  if(!window.InvestmentShell){
  const dialog=byId('method-dialog'),openMethod=()=>dialog.showModal();
  byId('method-button').addEventListener('click',openMethod);document.querySelectorAll('[data-open-method]').forEach(b=>b.addEventListener('click',openMethod));
  byId('close-method').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  }
  data=window.InvestmentShell ? await window.InvestmentShell.readSnapshot('./data.json','账户快照') : await (async()=>{const response=await fetch('./data.json',{cache:'no-store'});if(!response.ok)throw new Error('账户快照未能加载');return response.json();})();if(data.performance.portfolio_measure!=='TWR')throw new Error('收益方式已变化，需要重新核对页面口径');
  stats=positionStats(data);
  renderSources();renderAllocation();renderMonths();renderPositions();renderPerformance();
  document.querySelectorAll('[data-period]').forEach(button=>button.addEventListener('click',()=>setView({period:button.dataset.period})));
  document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>setView({view:button.dataset.view})));
  document.querySelectorAll('[data-benchmark]').forEach(button=>button.addEventListener('click',()=>{state.benchmarks[button.dataset.benchmark]=!state.benchmarks[button.dataset.benchmark];updateControls();renderChart();}));
  document.querySelectorAll('[data-sort]').forEach(button=>button.addEventListener('click',()=>{const key=button.dataset.sort;state.ascending=state.sort===key?!state.ascending:key==='symbol';state.sort=key;renderPositions();}));
  const chart=byId('chart-wrap');chart.addEventListener('pointermove',pointerTooltip);chart.addEventListener('pointerdown',pointerTooltip);chart.addEventListener('pointerleave',hideTooltip);chart.addEventListener('pointercancel',hideTooltip);chart.addEventListener('blur',hideTooltip);
  chart.addEventListener('keydown',event=>{if(geometry&&['ArrowLeft','ArrowRight','Home','End','Escape'].includes(event.key)){event.preventDefault();if(event.key==='Escape'){hideTooltip();return;}const current=state.selected??geometry.rows.length-1;showTooltip(event.key==='Home'?0:event.key==='End'?geometry.rows.length-1:current+(event.key==='ArrowLeft'?-1:1));}});
  let resizeTimer;const onResize=()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(renderChart,70);};if(typeof ResizeObserver==='function'){resizeObserver=new ResizeObserver(onResize);resizeObserver.observe(chart);}else window.addEventListener('resize',onResize);
  window.addEventListener('investment-workspace-change',event=>{if(event.detail?.workspace==='portfolio')requestAnimationFrame(renderChart);});
  registerTools();window.addEventListener('pagehide',()=>{resizeObserver?.disconnect();unregister?.();},{once:true});
}
init().catch(error=>{if(window.InvestmentShell){window.InvestmentShell.reportLoadError('load-error','账户视图暂未加载：'+error.message+'。');return;}const el=byId('load-error');el.hidden=false;el.textContent='数据加载遇到问题：'+error.message+'。请重新打开本页；若仍无法显示，请在原对话请求更新。';});
