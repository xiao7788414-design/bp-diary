'use strict';
const $ = id => document.getElementById(id);
const form = $('form'), fields = form.elements;
const periods = ['早餐','晚餐'];
const keys = ['id','date','time','period','sbp','dbp','hr','med','note'];
const headings = ['记录编号','日期','时间','时段','收缩压','舒张压','心率','服药情况','备注'];
let editing = '', rows = [];
function message(text) { $('status').textContent = text; }
const db = new Promise((ok,fail) => {
  const req = indexedDB.open('morning-evening-bp',1);
  req.onupgradeneeded = () => req.result.createObjectStore('readings',{keyPath:'id'});
  req.onsuccess = () => ok(req.result);
  req.onerror = () => fail(req.error);
});
async function transaction(mode,work) {
  const database = await db;
  return new Promise((ok,fail) => {
    const tx = database.transaction('readings',mode);
    const request = work(tx.objectStore('readings'));
    tx.oncomplete = () => ok(request?.result);
    tx.onabort = () => fail(tx.error || Error('保存失败'));
    tx.onerror = () => fail(tx.error);
  });
}
async function refresh() {
  rows = await transaction('readonly',store => store.getAll());
  rows.sort((a,b) => (b.date+b.time).localeCompare(a.date+a.time));
  render();
}
function nowFields() {
  const d = new Date(), pad = n => String(n).padStart(2,'0');
  fields.date.value = [d.getFullYear(),pad(d.getMonth()+1),pad(d.getDate())].join('-');
  fields.time.value = [pad(d.getHours()),pad(d.getMinutes())].join(':');
  fields.period.value = periods[Number(d.getHours()>=12)];
  defaultMedication();
}
function defaultMedication() {
  fields.med.value = fields.period.value === '早餐' ? '服药时' : '未注明';
}
for (const radio of fields.period) radio.addEventListener('change', defaultMedication);
function reset() {
  editing=''; form.reset(); nowFields(); $('title').textContent='记录血压'; $('cancel').hidden=true;
  $('day').textContent=new Date().toLocaleDateString('zh-CN',{weekday:'long'});
}
function view(id) {
  for (const section of document.querySelectorAll('main>section')) section.hidden=section.id!==id;
  for (const b of document.querySelectorAll('nav button')) b.setAttribute('aria-pressed',String(b.dataset.page===id));
  message('');
}
function valid(r) {
  const numeric = (s,max) => /^\d{1,3}$/.test(s) && +s>0 && +s<=max;
  const dt = new Date(r.date+'T12:00:00Z');
  return /^[a-zA-Z0-9-]{1,80}$/.test(r.id) && /^\d{4}-\d\d-\d\d$/.test(r.date) &&
    Number.isFinite(+dt) && dt.toISOString().slice(0,10)===r.date &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(r.time) && periods.includes(r.period) &&
    numeric(r.sbp,400) && numeric(r.dbp,400) && +r.sbp>+r.dbp &&
    (r.hr==='' || numeric(r.hr,350)) && [...fields.med.options].some(o=>o.value===r.med) && r.note.length<=400;
}
function recordId() { return Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join(''); }
function el(tag,text) { const node=document.createElement(tag); node.textContent=text; return node; }
function render() {
  const days=$('days'); days.replaceChildren(); $('count').textContent=rows.length+' 次测量';
  if (!rows.length) {days.append(el('p','还没有测量记录。')); return;}
  const groups=new Map();
  for (const r of rows) {if (!groups.has(r.date)) groups.set(r.date,[]); groups.get(r.date).push(r);}
  for (const [date,group] of groups) {
    const day=el('article',''); day.className='day'; day.append(el('h2',date));
    const cols=el('div',''); cols.className='periods'; day.append(cols);
    for (const period of periods) {
      const data=group.filter(r=>r.period===period), col=el('div',''); cols.append(col); col.append(el('h3',period));
      if (!data.length) col.append(el('p','暂无记录'));
      if (data.length>1) {
        const mean=k=>Math.round(data.reduce((sum,r)=>sum+Number(r[k]),0)/data.length);
        col.append(el('p',data.length+' 次平均 '+mean('sbp')+'/'+mean('dbp')+' mmHg'));
      }
      for (const r of data) {
        const line=el('div',''); line.className='row';
        const info=el('span',r.time+'　'+r.sbp+'/'+r.dbp);
        info.append(el('p',[r.hr && r.hr+' 次/分',r.med!=='未注明'&&r.med,r.note].filter(Boolean).join(' · ')));
        const b=el('button','编辑'); b.onclick=()=>{view('entry'); editing=r.id; for (const k of keys.slice(1)) fields[k].value=r[k]; $('title').textContent='编辑读数'; $('cancel').hidden=false; window.scrollTo(0,0);};
        line.append(info,b); col.append(line);
      }
    }
    days.append(day);
  }
}
for (const b of document.querySelectorAll('nav button')) b.onclick=()=>{view(b.dataset.page); if(b.dataset.page==='history') refresh().catch(storageError);};
$('cancel').onclick=()=>{reset();view('history');};
function storageError(){message('无法读写本机记录，请检查浏览器存储权限和剩余空间。');}
form.onsubmit=async event=>{
  event.preventDefault();
  const r=Object.fromEntries(new FormData(form)); r.id=editing||recordId();
  if(!valid(r)) {message('请核对日期、时间和读数，收缩压应高于舒张压。');return;}
  const b=form.querySelector('[type=submit]'); b.disabled=true;
  try {await transaction('readwrite',s=>s.put(r));await refresh();reset();view('history');message('已保存 '+r.date+' '+r.time+' 的'+r.period+'读数。');}
  catch {storageError();} finally {b.disabled=false;}
};
function csvField(s){return '"'+String(s).replaceAll('"','""')+'"';}
function safeNote(s){return /^[\s]*[=+@-]|^['\t\r\n]/.test(s) ? "'"+s : s;}
function readCSV(raw) {
  const src=raw.replace(/^\uFEFF/,''); const lines=[]; let row=[],cell='',quoted=false,closed=false;
  for(let i=0;i<src.length;i++){
    const ch=src[i];
    if(quoted){
      if(ch!=='"') cell+=ch;
      else if(src[i+1]==='"'){cell+='"';i++;}
      else {quoted=false;closed=true;}
    }else if(ch===','){row.push(cell);cell='';closed=false;}
    else if(ch==='\r'||ch==='\n'){if(ch==='\r'&&src[i+1]==='\n')i++;row.push(cell);lines.push(row);row=[];cell='';closed=false;}
    else if(ch==='"' && !cell && !closed)quoted=true;
    else if(closed||ch==='"')throw Error('CSV 引号格式有误');
    else cell+=ch;
  }
  if(quoted)throw Error('CSV 不完整');
  if(cell||row.length||closed){row.push(cell);lines.push(row);}
  return lines;
}
$('export').onclick=async()=>{
  const from=$('from').value,to=$('to').value;
  if(from&&to&&from>to){message('开始日期应早于或等于结束日期。');return;}
  try{
    await refresh();
    const data=rows.filter(r=>(!from||r.date>=from)&&(!to||r.date<=to)).reverse();
    if(!data.length){message('所选日期内没有可导出的记录。');return;}
    const lines=[headings,...data.map(r=>keys.map(k=>k==='note'?safeNote(r[k]):r[k]))];
    const url=URL.createObjectURL(new Blob(['\uFEFF'+lines.map(line=>line.map(csvField).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
    const a=document.createElement('a');a.href=url;a.download='早晚血压_'+data[0].date+'_'+data.at(-1).date+'.csv';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
    message('已生成 CSV，共 '+data.length+' 条。');
  }catch{storageError();}
};
$('restore').onchange=async e=>{
  const file=e.target.files[0];if(!file)return;
  try {
    const [header,...lines]=readCSV(await file.text()); if(JSON.stringify(header)!==JSON.stringify(headings))throw Error('请选择本应用导出的 CSV');
    const data=lines.map((line,i)=>{
      const r=Object.fromEntries(keys.map((k,j)=>[k,line[j]]));
      if(line.length!==keys.length)throw Error('第 '+(i+2)+' 行字段不完整');
      if(r.note.startsWith("'") && safeNote(r.note.slice(1))===r.note)r.note=r.note.slice(1);
      if(!valid(r))throw Error('第 '+(i+2)+' 行数据无效');return r;
    });
    let added=0;
    await transaction('readwrite',store=>{
      const req=store.getAllKeys();req.onsuccess=()=>{const seen=new Set(req.result);for(const r of data){if(!seen.has(r.id)){store.add(r);seen.add(r.id);added++;}}};
    });
    await refresh();message('恢复完成，新增 '+added+' 条，已存在 '+(data.length-added)+' 条。');
  }catch(err){message('恢复失败。'+err.message);}finally{e.target.value='';}
};
reset();refresh().catch(storageError);
