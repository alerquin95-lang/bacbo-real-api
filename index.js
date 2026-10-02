import express from 'express';
import cors from 'cors';
import axios from 'axios';
import * as cheerio from 'cheerio';
import cron from 'node-cron';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- STORAGE EM MEMORIA (400 rodadas) ---
let bacboHistory = []; // [{round_id, player, banker, winner, time, ts}]
let statsCache = {PLAYER:0,BANKER:0,TIE:0};
let lastFetch = 0;
let fetchStatus = 'Aguardando...';

// Gera round_id unico
function genId(){ return 'bb_'+Date.now()+'_'+Math.random().toString(36).substr(2,5); }

// Calcula stats
function recalcStats(){
  statsCache={PLAYER:0,BANKER:0,TIE:0};
  for(const r of bacboHistory){
    if(statsCache[r.winner]!==undefined) statsCache[r.winner]++;
  }
}

// Adiciona resultado novo (evita duplicado por tempo proximo)
function addResult(player, banker, timeStr=null){
  player=parseInt(player); banker=parseInt(banker);
  if(isNaN(player)||isNaN(banker)||player<2||player>12||banker<2||banker>12) return null;
  let winner='TIE';
  if(player>banker) winner='PLAYER';
  else if(banker>player) winner='BANKER';
  const now=Date.now();
  // evita duplicado se ultimo resultado igual e recente (<20s)
  if(bacboHistory.length>0){
    const last=bacboHistory[0];
    if(last.player===player && last.banker===banker && (now-last.ts)<20000) return null;
  }
  const entry={
    round_id: genId(),
    round: bacboHistory.length+1,
    player: player,
    banker: banker,
    winner: winner,
    time: timeStr || new Date().toLocaleTimeString('pt-BR'),
    ts: now
  };
  bacboHistory.unshift(entry);
  bacboHistory=bacboHistory.slice(0,400);
  recalcStats();
  return entry;
}

// --- SCRAPER CASINOSCORES ---
async function scrapeCasinoScores(){
  try{
    fetchStatus='Buscando CasinoScores...';
    // Tenta API direta que o frontend do CasinoScores usa
    // Inspecionando o site, ele carrega via https://api.casinoscores.com ou similar
    // Vamos tentar endpoints comuns
    
    // Tentativa 1: API publica do CasinoScores (se existir)
    try{
      const apiUrls=[
        'https://api.casinoscores.com/api/bac-bo/recent',
        'https://www.casinoscores.com/api/bac-bo',
        'https://casino.org/api/casinoscores/bac-bo'
      ];
      for(const url of apiUrls){
        try{
          const r=await axios.get(url, {timeout:5000, headers:{'User-Agent':'Mozilla/5.0'}});
          if(r.data && Array.isArray(r.data)){
            console.log('Achou API em', url, r.data.length);
            for(const item of r.data.slice(0,20)){
              // tenta parsear formato
              const p=item.player||item.playerScore||item.p;
              const b=item.banker||item.bankerScore||item.b;
              if(p&&b) addResult(p,b,item.time);
            }
            if(bacboHistory.length>0){ fetchStatus='OK via API '+url; return; }
          }
        }catch(e){}
      }
    }catch(e){}

    // Tentativa 2: Scraping HTML direto com axios+cheerio (pode ser bloqueado por Cloudflare)
    try{
      const url='https://www.casino.org/casinoscores/pt-br/bac-bo/';
      const resp=await axios.get(url, {
        headers:{
          'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language':'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
        },
        timeout:10000
      });
      const $=cheerio.load(resp.data);
      // Procura por padrões tipo 8-6 no texto
      const text=$('body').text();
      const matches=text.match(/\d{1,2}\s*[-x]\s*\d{1,2}/g);
      if(matches){
        console.log('Achou', matches.length, 'resultados no HTML');
        for(const m of matches.slice(0,30)){
          const parts=m.split(/[-x]/);
          if(parts.length>=2){
            const p=parseInt(parts[0].trim());
            const b=parseInt(parts[1].trim());
            if(p>=2&&p<=12&&b>=2&&b<=12) addResult(p,b);
          }
        }
        if(bacboHistory.length>0){ fetchStatus='OK via HTML scrape'; return; }
      }
    }catch(e){
      console.log('HTML scrape falhou', e.message);
    }

    // Tentativa 3: Se tudo falhar, gera dados mock realistas pra testar (remove em prod)
    // Isso garante que a API sempre responde algo mesmo se CasinoScores bloquear
    if(bacboHistory.length===0){
      console.log('Nenhum dado real, gerando mock inicial para teste');
      for(let i=0;i<50;i++){
        const p=Math.floor(Math.random()*11)+2;
        const b=Math.floor(Math.random()*11)+2;
        addResult(p,b);
      }
      fetchStatus='MOCK (CasinoScores bloqueou - ative Puppeteer)';
    }

    lastFetch=Date.now();
  }catch(e){
    console.error('scrape error', e);
    fetchStatus='Erro: '+e.message;
  }
}

// Tenta com Puppeteer (mais pesado, mas burla Cloudflare)
async function scrapeWithPuppeteer(){
  try{
    const puppeteer = (await import('puppeteer-extra')).default;
    const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
    puppeteer.use(StealthPlugin());
    const browser=await puppeteer.launch({
      headless:'new',
      args:['--no-sandbox','--disable-setuid-sandbox']
    });
    const page=await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.goto('https://www.casino.org/casinoscores/pt-br/bac-bo/', {waitUntil:'networkidle2', timeout:30000});
    await page.waitForTimeout(5000);
    const content=await page.content();
    const $=cheerio.load(content);
    const text=$('body').text();
    const matches=text.match(/\d{1,2}\s*[-x]\s*\d{1,2}/g);
    if(matches){
      for(const m of matches.slice(0,30)){
        const parts=m.split(/[-x]/);
        const p=parseInt(parts[0].trim());
        const b=parseInt(parts[1].trim());
        if(p>=2&&p<=12&&b>=2&&b<=12) addResult(p,b);
      }
    }
    await browser.close();
    fetchStatus='OK via Puppeteer';
    console.log('Puppeteer scrape ok, total', bacboHistory.length);
  }catch(e){
    console.error('Puppeteer fail', e.message);
    fetchStatus='Puppeteer falhou: '+e.message;
  }
}

// --- ROTAS API IGUAL FOOTBALL STUDIO ---
app.get('/', (req,res)=>{
  res.json({
    message:'BAC BO REAL API - Auto scraping CasinoScores',
    endpoints:{
      rounds:'/api/rounds',
      stats:'/api/stats',
      signals:'/api/signals',
      add:'/api/add (POST {player, banker})',
      health:'/health'
    },
    total:bacboHistory.length,
    stats:statsCache,
    lastFetch:new Date(lastFetch).toISOString(),
    status:fetchStatus
  });
});

app.get('/health', (req,res)=>res.json({ok:true, total:bacboHistory.length, status:fetchStatus}));

app.get('/api/rounds', (req,res)=>{
  res.json({data:bacboHistory, history:bacboHistory, total:bacboHistory.length});
});

app.get('/api/stats', (req,res)=>{
  res.json({stats:statsCache, total:bacboHistory.length, ...statsCache});
});

app.get('/api/signals', (req,res)=>{
  // retorna stats vazios por enquanto, frontend calcula local
  res.json({stats:{greens:0,reds:0,g0:0,g1:0,g2:0,tieGreens:0}, signals:[], total:bacboHistory.length});
});

app.post('/api/add', (req,res)=>{
  const {player, banker} = req.body;
  const r=addResult(player,banker);
  if(r) res.json({ok:true, added:r, total:bacboHistory.length});
  else res.status(400).json({ok:false, error:'Dados invalidos ou duplicado'});
});

app.post('/api/bulk', (req,res)=>{
  const {results} = req.body; // array de strings tipo ["8-6","7-7"]
  let added=0;
  if(Array.isArray(results)){
    for(const txt of results){
      const m=String(txt).match(/(\d{1,2})\s*[-x]\s*(\d{1,2})/);
      if(m){
        const p=parseInt(m[1]), b=parseInt(m[2]);
        if(addResult(p,b)) added++;
      }
    }
  }
  res.json({ok:true, added, total:bacboHistory.length});
});

// --- CRON: busca a cada 30s ---
cron.schedule('*/30 * * * * *', async ()=>{
  await scrapeCasinoScores();
});

// Busca inicial
scrapeCasinoScores();
setTimeout(()=>{ if(bacboHistory.length<10) scrapeWithPuppeteer(); }, 10000);

// --- START ---
app.listen(PORT, ()=>{
  console.log(`BAC BO API rodando na porta ${PORT}`);
  console.log(`Acesse http://localhost:${PORT}/api/rounds`);
});
