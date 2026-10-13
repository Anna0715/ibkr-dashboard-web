export const MARKET_WINDOWS={'1W':5,'1M':21,'3M':63,'6M':126,'1Y':249};
export const SECTOR_WINDOWS={'1D':'return1d','1W':'return5d','1M':'return21d'};
export function closeWindow(instrument,window='1M'){
  const rows=instrument?.data??[];
  if(!rows.length)return [];
  const intervals=MARKET_WINDOWS[window];
  if(!intervals)throw new Error('Unsupported market window');
  return rows.slice(-Math.min(rows.length,intervals+1));
}
export function normalizedLines(market,symbols,window='1M'){
  if(!symbols.length)return {dates:[],series:{}};
  const full=symbols.map(s=>closeWindow(market.instruments[s],window));
  const common=full[0].filter(r=>full.every(a=>a.some(p=>p.date===r.date))).map(r=>r.date);
  if(common.length<2)return {dates:[],series:{}};
  const series={};
  symbols.forEach((symbol,i)=>{
    const map=new Map(full[i].map(p=>[p.date,p.close])),base=map.get(common[0]);
    series[symbol]=common.map(date=>({date,value:map.get(date)/base-1,close:map.get(date)}));
  });
  return {dates:common,series,start:common[0],end:common.at(-1)};
}
export function sectorsFor(market,window='1D'){
  const field=SECTOR_WINDOWS[window];if(!field)throw new Error('Unsupported sector window');
  const sectors=market.sectors.map(s=>({...s,ret:s[field]}));
  const available=sectors.filter(s=>s.status==='available'&&Number.isFinite(s.ret));
  const sorted=[...available].sort((a,b)=>b.ret-a.ret);
  return {sectors,available,sorted,advancing:available.filter(s=>s.ret>0).length,declining:available.filter(s=>s.ret<0).length,flat:available.filter(s=>s.ret===0).length,field};
}
export function movingAverageState(instrument){
  const m=instrument.metrics;return {above20:m.lastClose>m.ma20,above50:m.lastClose>m.ma50,distance20:m.lastClose/m.ma20-1,distance50:m.lastClose/m.ma50-1};
}
export function relativePriceReturn(market,a,b,window='1M'){
  const c=normalizedLines(market,[a,b],window);
  if(!c.dates.length)return null;
  const aReturn=c.series[a].at(-1).value,bReturn=c.series[b].at(-1).value;
  return {aReturn,bReturn,differencePercentagePoints:(aReturn-bReturn)*100,start:c.start,end:c.end};
}
export function marketInsights(market,window='1M'){
  const relative=relativePriceReturn(market,'QQQ','IWM',window);
  const breadth=relativePriceReturn(market,'RSP','SPY',window);
  const spy=movingAverageState(market.instruments.SPY),qqq=movingAverageState(market.instruments.QQQ);
  const sector=sectorsFor(market,window==='1W'?'1W':'1M');
  return {relative,breadth,spy,qqq,sector};
}
