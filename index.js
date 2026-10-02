import express from 'express';
import cors from 'cors';
import axios from 'axios';
import * as cheerio from 'cheerio';

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

let bacboHistory = [];
let statsCache = {PLAYER:0,BANKER:0,TIE:0};
let clients = []; // SSE clients
let fetchStatus = 'Iniciando...';
let lastFetch = Date.now();

function genId(){ return 'bb_'+Date.now()+'_'+Math.random().toString(36).substr(2,5); }
function recalcStats(){
  statsCache={PLAYER:0,BANKER:0,TIE:0};
  for(const r of bacboHistory){ if(statsCache[r.winner]!==undefined) statsCache[r.winner]++; }
}
function addResult(player, banker, broadcast=true){
  player=parseInt(player); banker=parseInt(banker);
  if(isNaN(player)||isNaN(banker)||player<2||player>12||banker<2||banker>12) return null;
  let winner=player>banker?'PLAYER':banker>player?'BANKER':'TIE';
  const now=Date.now();
  if(bacboHistory.length>0){
    const last=bacboHistory[0];
    if(last.player===player && last.banker===banker && (now-last.ts)<25000) return null;
  }
  const entry={
    round_id: genId(), round: bacboHistory.length+1,
    player, banker, winner,
    time: new Date().toLocaleTimeString('pt-BR'),
    ts: now,
    diceP1: Math.max(1,Math.floor(player/2)), diceP2: player-Math.max(1,Math.floor(player/2)),
    diceB1: Math.max(1,Math.floor(banker/2)), diceB2: banker-Math.max(1,Math.floor(banker/2))
  };
  bacboHistory.unshift(entry);
  bacboHistory=bacboHistory.slice(0,400);
  recalcStats();
  lastFetch=now;
  if(broadcast) broadcastUpdate(entry);
  return entry;
}
function seedMock(){
  if(bacboHistory.length>0) return;
  for(let i=0;i<40;i++){
    const p=Math.floor(Math.random()*11)+2;
    const b=Math.floor(Math.random()*11)+2;
    bacboHistory.push({
      round_id: genId(), round: i+1, player:p, banker:b,
      winner: p>b?'PLAYER':b>p?'BANKER':'TIE',
      time: new Date(Date.now()-i*35000).toLocaleTimeString('pt-BR'),
      ts: Date.now()-i*35000,
      diceP1: Math.max(1,Math.floor(p/2)), diceP2: p-Math.max(1,Math.floor(p/2)),
      diceB1: Math.max(1,Math.floor(b/2)), diceB2: b-Math.max(1,Math.floor(b/2))
    });
  }
  recalcStats();
}
async function scrapeCasinoScores(){
  try{
    fetchStatus='Buscando CasinoScores...';
    const urls=['https://www.casino.org/casinoscores/pt-br/bac-bo/','https://casinoscores.com/bac-bo'];
    for(const url of urls){
      try{
        const resp=await axios.get(url,{
          headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','Accept':'text/html'},
          timeout:8000
        });
        const $=cheerio.load(resp.data);
        const text=$('body').text();
        const matches=text.match(/\d{1,2}\s*[-x]\s*\d{1,2}/g);
        if(matches && matches.length>=3){
          let added=0;
          for(const m of matches.slice(0,20)){
            const parts=m.split(/[-x]/);
            if(parts.length>=2){
              const p=parseInt(parts[0].trim()), b=parseInt(parts[1].trim());
              if(p>=2&&p<=12&&b>=2&&b<=12){ if(addResult(p,b)) added++; }
            }
          }
          if(added>0){ fetchStatus='OK via '+url+' +'+added; console.log('Scrape +'+added); return; }
        }
      }catch(e){ console.log('Scrape fail', e.message); }
    }
    fetchStatus='Cloudflare bloqueou - aguardando POST';
  }catch(e){ fetchStatus='Erro: '+e.message; }
}
function broadcastUpdate(entry){
  const payload = JSON.stringify({type:'new_round', data:entry, total:bacboHistory.length, stats:statsCache});
  clients.forEach(res=>{
    try{ res.write(`data: ${payload}\n\n`); }catch(e){}
  });
}

// SSE STREAM - igual Football Studio - nuvem sempre atualizando
app.get('/api/stream', (req,res)=>{
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.flushHeaders();
  clients.push(res);
  // envia estado inicial
  res.write(`data: ${JSON.stringify({type:'init', total:bacboHistory.length, stats:statsCache, history:bacboHistory.slice(0,20)})}\n\n`);
  req.on('close', ()=>{
    clients = clients.filter(c=>c!==res);
  });
});

app.get('/', (req,res)=>res.json({message:'BAC BO CLOUD API - SSE Streaming', total:bacboHistory.length, stats:statsCache, status:fetchStatus, clients:clients.length, endpoints:{rounds:'/api/rounds', stream:'/api/stream SSE', health:'/health'}}));
app.get('/health', (req,res)=>res.json({ok:true, total:bacboHistory.length, status:fetchStatus, clients:clients.length}));
app.get('/api/rounds', (req,res)=>res.json({data:bacboHistory, history:bacboHistory, total:bacboHistory.length}));
app.get('/api/stats', (req,res)=>res.json({stats:statsCache, total:bacboHistory.length, ...statsCache}));
app.post('/api/add', (req,res)=>{const r=addResult(req.body.player, req.body.banker); if(r) res.json({ok:true, added:r, total:bacboHistory.length}); else res.status(400).json({ok:false});});
app.post('/api/bulk', (req,res)=>{
  let added=0; const results=req.body.results||[];
  for(const txt of results){const m=String(txt).match(/(\d{1,2})\s*[-x]\s*(\d{1,2})/); if(m){const p=parseInt(m[1]), b=parseInt(m[2]); if(addResult(p,b)) added++;}}
  res.json({ok:true, added, total:bacboHistory.length});
});

seedMock();
scrapeCasinoScores();
setInterval(scrapeCasinoScores, 60000);
// heartbeat para SSE
setInterval(()=>{ clients.forEach(res=>{ try{ res.write(`: heartbeat\n\n`); }catch(e){} }); }, 25000);

app.listen(PORT, ()=>console.log(`BAC BO CLOUD API SSE na porta ${PORT} - ${bacboHistory.length} rodadas`));
