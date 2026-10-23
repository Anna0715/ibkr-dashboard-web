export const PERIODS = { YTD:'记录以来', '1M':'近 1 个月', MTD:'本月', '7D':'近 7 日', '1D':'最近一期' };

export function accountOf(data) {
  const accounts = Object.values(data.performance.accounts || {});
  if (accounts.length !== 1 || !accounts[0]?.periods) throw new Error('账户数据结构无法识别');
  return accounts[0];
}

export function periodRows(data, key) {
  const p = accountOf(data).periods[key];
  if (!p || p.dates.length !== p.cps.length || p.dates.length !== p.nav.length) throw new Error('收益数据长度不一致');
  const rows = p.dates.map((date,i) => {
    const ret = p.cps[i], nav = p.nav[i];
    if (!/^\d{8}$/.test(date) || !Number.isFinite(ret) || ret <= -1 || !Number.isFinite(nav) || nav < 0) throw new Error('收益数据不完整');
    return { date, ret, nav, baseline:false };
  });
  if (p.start_nav > 0 && p.start_date < rows[0].date) rows.unshift({ date:p.start_date, ret:0, nav:p.start_nav, baseline:true });
  let peak = 1;
  return rows.map((row,i) => {
    peak = Math.max(peak, 1 + row.ret);
    return {...row, drawdown:(1+row.ret)/peak-1, daily:i ? (1+row.ret)/(1+rows[i-1].ret)-1 : null};
  });
}

export function benchmarkComparison(data, key) {
  const rows = periodRows(data,key);
  const maps = Object.fromEntries(Object.entries(data.benchmarks??{}).filter(([,b])=>Array.isArray(b?.data)&&b.data.length).map(([symbol,b]) => [symbol,new Map(b.data.map(r=>[r.date,r.close]))]));
  const common = Object.keys(maps).length ? rows.filter(r=>Object.values(maps).every(m=>Number.isFinite(m.get(r.date)) && m.get(r.date)>0)) : [];
  if (common.length < 2) return {ready:false, start:rows[0].date, end:rows.at(-1).date, latestAccountDate:rows.at(-1).date, series:{}, benchmarks:{}, accountReturn:null};
  const first=common[0], last=common.at(-1);
  const accountReturn=(1+last.ret)/(1+first.ret)-1;
  const benchmarks={}, series={};
  for (const [symbol,m] of Object.entries(maps)) {
    const base=m.get(first.date), ret=m.get(last.date)/base-1;
    benchmarks[symbol]={ret, excess:(accountReturn-ret)*100};
    series[symbol]=rows.map(r=>({date:r.date,value:r.date>=first.date && r.date<=last.date && m.has(r.date) ? m.get(r.date)/base-1 : null}));
  }
  return {ready:true,start:first.date,end:last.date,latestAccountDate:rows.at(-1).date,accountReturn,benchmarks,series};
}

export function positionStats(data) {
  const raw=data.positions.positions;
  const totalMarket=raw.reduce((s,p)=>s+p.market_value,0);
  // Option quote units are not a verified contract deliverable or cost multiplier.
  const costOf=p=>p.asset_class==='OPT' ? null : p.average_price*p.position;
  const costs=raw.map(costOf), costComplete=costs.every(Number.isFinite);
  const totalCost=costComplete ? costs.reduce((s,v)=>s+v,0) : null;
  const totalPnl=raw.reduce((s,p)=>s+p.unrealized_pnl,0);
  const positions=raw.map(p=>{const cost=costOf(p);return {...p,symbol:p.contract_description,cost,ret:p.position>0&&Number.isFinite(cost)&&cost>0?p.unrealized_pnl/cost:null,weight:totalMarket>0?p.market_value/totalMarket:0};});
  return {positions,totalMarket,totalCost,totalPnl,costComplete,holdingReturn:Number.isFinite(totalCost)&&totalCost>0?totalPnl/totalCost:null,dailyPnl:raw.reduce((s,p)=>s+p.daily_pnl,0)};
}

export function monthlyReturns(data) {
  const rows=periodRows(data,'YTD');
  const ends=new Map();
  for (const r of rows) ends.set(r.date.slice(0,6),r);
  let prior=rows[0];
  return Array.from(ends,([month,last])=>{
    const baselineOnly=last.date===rows[0].date;
    const result={month,date:last.date,ret:baselineOnly?null:(1+last.ret)/(1+prior.ret)-1,baselineOnly};
    prior=last;
    return result;
  });
}

export function dateLabel(date,year=false) {
  return year ? `${date.slice(0,4)}.${date.slice(4,6)}.${date.slice(6,8)}` : `${date.slice(4,6)}/${date.slice(6,8)}`;
}

export function dateTime(date) {
  return Date.UTC(Number(date.slice(0,4)),Number(date.slice(4,6))-1,Number(date.slice(6,8)));
}
