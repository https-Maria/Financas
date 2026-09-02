import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/* =====================================================================
   CONFIGURAÇÃO
   A publishable key é pública por natureza: quem protege os dados é o
   Row Level Security no banco, não o sigilo desta chave.
   ===================================================================== */
const CFG = {
  url: localStorage.getItem('sb_url') || 'https://ulukjixlbxgmkyzmvxjm.supabase.co',
  key: localStorage.getItem('sb_key') || 'sb_publishable_5kdSmQS1sAa7oG__p9-c9A_1DI0EDD3'
};
const sb = createClient(CFG.url, CFG.key);

const APP_VER='v20';

/* =====================================================================
   ESTADO
   ===================================================================== */
const TABELAS = ['rendas','fixas','beneficios','cartoes','parcelamentos',
                 'assinaturas','lancamentos','terceiros','metas','casa_itens','financiamentos'];
let USER=null, GRUPO=null, EU=null;
let D = {rendas:[],fixas:[],beneficios:[],cartoes:[],parcelamentos:[],
         assinaturas:[],lancamentos:[],terceiros:[],metas:[],casa_itens:[],financiamentos:[],config:null};
let ONLINE = navigator.onLine, SYNC='off', FALTANDO=[];

/* =====================================================================
   HELPERS
   ===================================================================== */
const $ = id => document.getElementById(id);
const BRL = v => (v<0?'-':'')+'R$ '+Math.abs(+v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
const PCT = v => (v*100).toFixed(1).replace('.',',')+'%';
const esc = s => String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const hoje = () => new Date().toISOString().slice(0,10);
const ym = d => String(d).slice(0,7);
const mLabel = k => k.slice(5)+'/'+k.slice(0,4);
function addM(k,n){let[y,m]=k.split('-').map(Number);m+=n;y+=Math.floor((m-1)/12);m=((m-1)%12+12)%12+1;
  return y+'-'+String(m).padStart(2,'0');}
function horizon(n,ini){const o=[];let k=ini||ym(hoje());for(let i=0;i<n;i++){o.push(k);k=addM(k,1);}return o;}
/* Lista do seletor: 6 meses para trás, 12 para frente, mais qualquer mês
   que já tenha lançamento ou competência de terceiro registrada. */
function mesesDisponiveis(){
  const s=new Set(horizon(19, addM(ym(hoje()),-6)));
  D.lancamentos.forEach(l=>s.add(ym(l.data)));
  D.terceiros.forEach(t=>{ if(t.competencia&&/^\d{2}\/\d{4}$/.test(t.competencia)){
    const [m,y]=t.competencia.split('/'); s.add(y+'-'+m); } });
  return [...s].sort();
}
function toast(m,ms=2600){const t=$('toast');t.textContent=m;t.classList.add('on');
  clearTimeout(t._x);t._x=setTimeout(()=>t.classList.remove('on'),ms);}

/* cache offline */
const cacheSave = () => { try{localStorage.setItem('cache_'+GRUPO, JSON.stringify(D));}catch(e){} };
const cacheLoad = () => { try{const s=localStorage.getItem('cache_'+GRUPO); if(s){D=JSON.parse(s);return true;}}catch(e){} return false; };

/* =====================================================================
   CÁLCULOS  (mesmas regras do sistema: Reports e VA fora do orçamento)
   ===================================================================== */
const rendaAtiva = k => D.rendas.filter(r=>r.ativo && !r.protegida &&
  !(r.encerra_em && k && k >= ym(r.encerra_em)));
const totRenda = k => rendaAtiva(k).reduce((s,r)=>s+ +r.valor,0);
const totFixas = () => D.fixas.filter(f=>f.ativo).reduce((s,f)=>s+ +f.valor,0);
const totAssin = () => D.assinaturas.filter(a=>a.projetar).reduce((s,a)=>s+ +a.valor,0);
const totVA    = () => D.beneficios.filter(b=>b.ativo).reduce((s,b)=>s+ +b.valor,0);
const saldoParc= () => D.parcelamentos.reduce((s,p)=>s+ +p.valor_parcela*p.restantes,0);
const aReceber = () => D.terceiros.filter(t=>!t.recebido).reduce((s,t)=>s+ +t.valor,0);
const recebido = () => D.terceiros.filter(t=> t.recebido).reduce((s,t)=>s+ +t.valor,0);
const cfg = () => D.config || {reserva_atual:0,aporte_mensal:0};

/* parcelas devidas num mês, a partir da primeira fatura de cada dívida */
function parcelasMes(k, extra){
  let t=0;
  const conta=(p)=>{
    const ini = p.primeira_fatura ? ym(p.primeira_fatura) : ym(hoje());
    const idx = mesesEntre(ini,k);
    if(idx>=0 && idx<p.restantes) t += +p.valor_parcela;
  };
  D.parcelamentos.forEach(conta);
  if(extra) conta(extra);
  return t;
}
function mesesEntre(a,b){const[ay,am]=a.split('-').map(Number),[by,bm]=b.split('-').map(Number);
  return (by-ay)*12+(bm-am);}
/* Fatura de verdade: vem dos lançamentos. Se você já lançou o pagamento da
   fatura daquele cartão naquele mês, esse é o valor que vale — nada de
   estimativa por cima de dado real, e nada de tabela paralela. */
function faturaLancada(nome,k){
  const ls=D.lancamentos.filter(l=>
    ym(l.data)===k && l.tipo==='Saída' && !l.protegido &&
    (l.cartao||'')===nome &&
    (l.categoria==='Cartão' || /fatura/i.test(l.descricao||'')));
  if(!ls.length) return null;
  return {valor: ls.reduce((s,l)=>s+ +l.valor,0), itens: ls};
}

/* Fatura calculada: parcelas devidas + assinaturas projetadas do cartão. */
function faturaCalculada(nome, k, extra){
  let t=0;
  const conta=p=>{
    if((p.cartao||'')!==nome) return;
    const ini=p.primeira_fatura?ym(p.primeira_fatura):ym(hoje());
    const idx=mesesEntre(ini,k);
    if(idx>=0 && idx<p.restantes) t+= +p.valor_parcela;
  };
  D.parcelamentos.forEach(conta);
  if(extra) conta(extra);
  D.assinaturas.forEach(a=>{ if(a.projetar && (a.cartao||'')===nome) t+= +a.valor; });
  return t;
}

/* O valor que vale: o lançado manda; senão, o calculado. */
function faturaCartao(nome, k){
  const real=faturaLancada(nome,k);
  return real ? real.valor : faturaCalculada(nome,k);
}

/* Parcela de uma compra simulada neste mês. Independe de cartão escolhido:
   uma compra sem cartão definido ainda pesa no orçamento. */
function parcelaExtra(k, extra){
  if(!extra) return 0;
  const ini=extra.primeira_fatura?ym(extra.primeira_fatura):ym(hoje());
  const idx=mesesEntre(ini,k);
  return (idx>=0 && idx<extra.restantes) ? +extra.valor_parcela : 0;
}

/* Cartão que vence no dia 1 é pago com a sobra do último dia do mês anterior.
   Ou seja: o dinheiro sai do mês k para cobrir a fatura de k+1. O total do mês
   precisa seguir a mesma regra dos blocos por data, senão os dois discordam. */
const venceNoDia1 = nome => {
  const c=D.cartoes.find(x=>x.nome===nome);
  return !!c && +c.dia_venc===1;
};

/* Soma das faturas que saem do caixa neste mês. */
function totFaturas(k, extra){
  const nomes=new Set(D.cartoes.filter(c=>c.ativo).map(c=>c.nome));
  D.lancamentos.filter(l=>ym(l.data)===k&&l.cartao).forEach(l=>nomes.add(l.cartao));
  D.parcelamentos.forEach(p=>{ if(p.cartao) nomes.add(p.cartao); });
  D.assinaturas.forEach(a=>{ if(a.projetar&&a.cartao) nomes.add(a.cartao); });
  let t=0;
  nomes.forEach(n=>{ t += venceNoDia1(n) ? faturaCartao(n,addM(k,1)) : faturaCartao(n,k); });
  return t + parcelaExtra(k,extra);
}


/* Projeção do casal: renda menos contas fixas e faturas. Sem envelopes, sem casa. */
function fluxo(n=24, extra, ini){
  let acc=0;
  return horizon(n,ini).map(k=>{
    const renda=totRenda(k), fix=totFixas(), cart=totFaturas(k,extra);
    const real=D.cartoes.some(c=>faturaLancada(c.nome,k));
    const out=fix+cart, sal=renda-out; acc+=sal;
    return {k,renda,fix,cart,real,par:parcelasMes(k,extra),ass:totAssin(),
            out,sal,acc,pct:renda?out/renda:0};
  });
}

/* ---- Cenário da casa: só usado na aba dedicada ---- */
const totCasa = () => D.casa_itens.filter(i=>i.ativo).reduce((s,i)=>s+ +i.valor,0);
function fluxoCasa(n=24, extra, ini){
  let acc=0;
  return horizon(n,ini).map(k=>{
    const renda=totRenda(k), fix=totFixas(), cart=totFaturas(k,extra), casa=totCasa();
    const out=fix+cart+casa, sal=renda-out; acc+=sal;
    return {k,renda,fix,cart,casa,par:parcelasMes(k,extra),ass:totAssin(),
            out,sal,acc,pct:renda?out/renda:0};
  });
}

/* ---- Amortização de financiamento (tabela Price) ---- */
/* A taxa publicada no contrato vem arredondada (ex.: 2,19%), e com ela o
   saldo não fecha em zero na última parcela. A taxa real é a que reproduz
   exatamente a parcela contratada — é ela que o banco usa. Deduzimos por
   busca binária a partir de valor financiado, parcela e prazo. */
function taxaEfetiva(f){
  const PV=+f.valor_financiado, PMT=+f.valor_parcela, n=+f.total_parcelas;
  if(!PV||!PMT||!n) return +f.taxa_mensal||0;
  const pmt=i=> i>0 ? PV*i/(1-Math.pow(1+i,-n)) : PV/n;
  if(pmt(0.0000001)>PMT) return +f.taxa_mensal||0;
  let lo=0.0000001, hi=1;
  for(let k=0;k<200;k++){ const mid=(lo+hi)/2; if(pmt(mid)>PMT) hi=mid; else lo=mid; }
  return (lo+hi)/2;
}
function tabelaAmortizacao(f){
  const i=taxaEfetiva(f), PMT=+f.valor_parcela, n=+f.total_parcelas;
  let saldo=+f.valor_financiado;
  const ini=new Date(f.primeira_parcela+'T12:00:00');
  const linhas=[];
  for(let k=1;k<=n;k++){
    const d=new Date(ini); d.setMonth(d.getMonth()+(k-1));
    const juros=saldo*i, amort=PMT-juros, fim=Math.max(0,saldo-amort);
    linhas.push({k, venc:d, ini:saldo, juros, amort, fim, paga:k<=+f.parcelas_pagas});
    saldo=fim;
  }
  return linhas;
}
function resumoFin(f){
  const L=tabelaAmortizacao(f);
  const pagas=+f.parcelas_pagas, n=+f.total_parcelas, PMT=+f.valor_parcela;
  const restantes=n-pagas;
  /* Saldo devedor = valor presente das parcelas que faltam, na taxa do contrato.
     É o que o banco cobra para quitar hoje (cláusula de liquidação antecipada). */
  const saldo = pagas<n ? L[pagas].ini : 0;
  const nominal = PMT*restantes;
  return {linhas:L, pagas, restantes, saldo, nominal,
          economiaQuitar: nominal-saldo,
          jurosPagos: L.slice(0,pagas).reduce((s,x)=>s+x.juros,0),
          jurosFuturos: L.slice(pagas).reduce((s,x)=>s+x.juros,0),
          totalContrato: PMT*n, ultima: L[n-1]?.venc};
}
/* Antecipação de parcelas.
   A escolha de QUAIS parcelas antecipar muda o resultado:
     - as ÚLTIMAS rendem mais desconto (estão mais longe, carregam mais juros)
       e encurtam o contrato;
     - as PRÓXIMAS descontam menos, mas aliviam o caixa dos meses seguintes.
   O contrato prevê quitação a valor presente pela taxa da operação. */
function anteciparPlano(f, opt){
  const L=tabelaAmortizacao(f), i=taxaEfetiva(f), PMT=+f.valor_parcela;
  const pend=L.filter(l=>!l.paga);
  const N=Math.max(0,Math.min(+opt.n||0, pend.length));
  const est=opt.estrategia||'ultimas';
  let sel=[];
  if(N>0){
    if(est==='proximas') sel=pend.slice(0,N);
    else if(est==='ultimas') sel=pend.slice(-N);
    else { const a=Math.ceil(N/2), b=N-a; sel=[...pend.slice(0,a), ...(b?pend.slice(-b):[])]; }
  }
  const pagamento = opt.data ? new Date(opt.data+'T12:00:00') : new Date();
  const diaria = Math.pow(1+i, 1/30)-1;
  let custo=0;
  const itens = sel.map(l=>{
    const dias = Math.max(0, Math.round((l.venc-pagamento)/86400000));
    const vp = PMT/Math.pow(1+diaria, dias);
    custo += vp;
    return {k:l.k, venc:l.venc, dias, vp, desconto:PMT-vp};
  });
  const restantes = pend.filter(l=>!sel.includes(l));
  return {n:N, estrategia:est, itens, custo, nominal:PMT*N, economia:PMT*N-custo,
          pagamento, restantes,
          novaUltima: restantes.length?restantes[restantes.length-1].venc:null,
          qtdRestante: restantes.length,
          /* meses em que a parcela deixa de sair do orçamento */
          mesesLiberados: new Set(sel.map(l=>ym(l.venc.toISOString().slice(0,10))))};
}

const anteciparN=(f,N)=>{
  const p=anteciparPlano(f,{n:N,estrategia:'ultimas'});
  return {n:p.n, custoHoje:p.custo, nominal:p.nominal, economia:p.economia, novaUltima:p.novaUltima};
};

/* ---- Fluxo por dia de pagamento ---- */
/* ---- Fluxo por dia de pagamento ---- */
function blocosDoMes(k){
  const cartoes = D.cartoes.length?D.cartoes:[];
  const dias = new Set();
  D.rendas.filter(r=>r.ativo&&!r.protegida).forEach(r=>dias.add(+r.dia||1));
  D.fixas.filter(f=>f.ativo).forEach(f=>dias.add(+f.dia||1));
  cartoes.forEach(c=>{ if(c.ativo && +c.dia_venc>1) dias.add(+c.dia_venc); });
  dias.add(31);
  const ordenados=[...dias].filter(d=>d>1).sort((a,b)=>a-b);

  return ordenados.map(dia=>{
    const ultimo = dia===Math.max(...ordenados);
    const entradas = D.rendas.filter(r=>r.ativo&&!r.protegida&&(+r.dia||1)===dia)
      .map(r=>({desc:r.descricao,valor:+r.valor,quem:r.quem}));
    const saidas = D.fixas.filter(f=>f.ativo&&(+f.dia||1)===dia)
      .map(f=>({desc:f.descricao,valor:+f.valor,tipo:'fixa'}));
    cartoes.forEach(c=>{
      if(!c.ativo || +c.dia_venc!==dia) return;
      const v=faturaCartao(c.nome,k);
      if(v>0) saidas.push({desc:'Fatura '+c.nome,valor:v,tipo:'cartao',cartao:c.nome});
    });
    /* Regra: fatura que vence no dia 1 é paga com o que sobra do último dia do mês anterior. */
    if(ultimo){
      cartoes.forEach(c=>{
        if(!c.ativo || +c.dia_venc!==1) return;
        const prox=addM(k,1);
        const v=faturaCartao(c.nome,prox);
        if(v>0) saidas.push({desc:'Reserva p/ fatura '+c.nome+' (vence 01/'+mLabel(prox).slice(0,2)+')',
                             valor:v,tipo:'reserva',cartao:c.nome});
      });
    }
    const tIn=entradas.reduce((s,x)=>s+x.valor,0);
    const tOut=saidas.reduce((s,x)=>s+x.valor,0);
    return {dia,label:ultimo?'Último dia útil':'Dia '+String(dia).padStart(2,'0'),
            entradas,saidas,tIn,tOut,saldo:tIn-tOut,ultimo};
  });
}

/* REGRA DO CASAL: toda fatura que vence no dia 1 é paga com o pagamento do
   último dia do mês anterior. Então, para efeito de caixa, o dinheiro sai no
   mês anterior — mesmo que o lançamento esteja datado no dia 1. */
function mesDeCaixa(l){
  const k=ym(l.data);
  if(l.cartao && venceNoDia1(l.cartao) && String(l.data).slice(8,10)==='01')
    return addM(k,-1);
  return k;
}

/* Reports é dinheiro protegido: entra, paga coisas alocadas a ele, e o que
   sobra não é do orçamento do casal. Precisa ser visível, senão dinheiro
   se move sem ninguém ver. */
function reportsMes(k){
  const ls=D.lancamentos.filter(l=>mesDeCaixa(l)===k && l.protegido);
  const ent=ls.filter(l=>l.tipo==='Entrada').reduce((s,l)=>s+ +l.valor,0);
  const sai=ls.filter(l=>l.tipo==='Saída');
  const tot=sai.reduce((s,l)=>s+ +l.valor,0);
  const rendaRep=D.rendas.filter(r=>r.ativo&&r.protegida&&
    !(r.encerra_em && k>=ym(r.encerra_em))).reduce((s,r)=>s+ +r.valor,0);
  return {ent,sai,tot,saldo:ent-tot,previsto:rendaRep,
          temMovimento: ls.length>0,
          /* só está encerrado se não há entrada prevista nem lançada */
          encerrado: rendaRep===0 && ent===0};
}

function realizado(k){
  const ls=D.lancamentos.filter(l=>mesDeCaixa(l)===k);
  const ent=ls.filter(l=>l.tipo==='Entrada'&&!l.protegido&&!l.beneficio).reduce((s,l)=>s+ +l.valor,0);
  const sai=ls.filter(l=>l.tipo==='Saída'&&!l.protegido).reduce((s,l)=>s+ +l.valor,0);
  const va =ls.filter(l=>l.beneficio).reduce((s,l)=>s+ +l.valor,0);
  const porCat={};
  ls.filter(l=>l.tipo==='Saída'&&!l.protegido).forEach(l=>porCat[l.categoria]=(porCat[l.categoria]||0)+ +l.valor);
  return {ent,sai,va,sal:ent-sai,n:ls.length,porCat,temDados:ls.some(l=>!l.protegido&&!l.beneficio)};
}

/* =====================================================================
   BANCO — leitura, escrita e tempo real
   ===================================================================== */
function setSync(s){SYNC=s;const d=$('syncdot');if(d){d.className='dot '+s;
  $('synctxt').textContent={on:'Sincronizado',busy:'Sincronizando…',off:'Sem conexão'}[s];}}

async function carregarTudo(){
  setSync('busy');
  try{
    const res = await Promise.all([
      ...TABELAS.map(t=>sb.from(t).select('*').eq('grupo_id',GRUPO)),
      sb.from('config').select('*').eq('grupo_id',GRUPO).maybeSingle()
    ]);

    /* Tabela que ainda não existe no banco não pode derrubar o app inteiro:
       vira lista vazia e o resto carrega normalmente. */
    const faltando=[];
    const ehTabelaAusente = e => e && (e.code==='PGRST205' || e.code==='42P01' ||
      /could not find the table|does not exist|schema cache/i.test(e.message||''));

    const grave = res.find(r=>r.error && !ehTabelaAusente(r.error));
    if(grave) throw grave.error;

    TABELAS.forEach((t,i)=>{
      if(res[i].error){ D[t]=[]; faltando.push(t); }
      else D[t]=res[i].data||[];
    });

    if(res[TABELAS.length].error){ D.config=null; faltando.push('config'); }
    else D.config = res[TABELAS.length].data || null;

    if(!D.config && !faltando.includes('config')){
      const {data} = await sb.from('config').insert({grupo_id:GRUPO}).select().single();
      D.config = data;
    }
    D.lancamentos.sort((a,b)=>String(b.data).localeCompare(String(a.data)));
    cacheSave(); setSync('on');
    FALTANDO = faltando;
    if(faltando.length) toast('Falta rodar a migração no banco: '+faltando.join(', '), 6000);
    return true;
  }catch(e){
    setSync('off');
    if(cacheLoad()){ toast('Sem conexão — mostrando os últimos dados salvos'); return true; }
    throw e;
  }
}

async function inserir(tabela, linha){
  const {data,error} = await sb.from(tabela)
    .insert({...linha, grupo_id:GRUPO}).select().single();
  if(error){ toast('Erro ao salvar: '+error.message, 4200); return null; }
  D[tabela].push(data);
  if(tabela==='lancamentos') D.lancamentos.sort((a,b)=>String(b.data).localeCompare(String(a.data)));
  cacheSave(); return data;
}
async function atualizar(tabela, id, campos){
  const alvo = tabela==='config' ? sb.from('config').update(campos).eq('grupo_id',GRUPO)
                                 : sb.from(tabela).update(campos).eq('id',id);
  const {data,error} = await alvo.select().single();
  if(error){ toast('Erro ao atualizar: '+error.message, 4200); return null; }
  if(tabela==='config') D.config=data;
  else { const i=D[tabela].findIndex(x=>x.id===id); if(i>=0) D[tabela][i]=data; }
  cacheSave(); return data;
}
async function remover(tabela, id){
  const {error} = await sb.from(tabela).delete().eq('id',id);
  if(error){ toast('Erro ao excluir: '+error.message, 4200); return false; }
  D[tabela]=D[tabela].filter(x=>x.id!==id); cacheSave(); return true;
}

let canal=null;
function ligarTempoReal(){
  if(canal) sb.removeChannel(canal);
  canal = sb.channel('grupo:'+GRUPO);
  [...TABELAS,'config'].forEach(t=>{
    canal.on('postgres_changes',
      {event:'*',schema:'public',table:t,filter:'grupo_id=eq.'+GRUPO},
      async payload => {
        // ignora eco das próprias escritas quando o dado já bate
        await carregarTudo();
        render();
        if(payload.eventType==='INSERT' && t==='lancamentos'){
          const l=payload.new;
          if(l && l.criado_por && l.criado_por!==USER.id)
            toast('Novo lançamento: '+l.descricao+' · '+BRL(l.valor));
        }
      });
  });
  canal.subscribe();
}

window.addEventListener('online', async()=>{ONLINE=true;await carregarTudo();render();toast('De volta online');});
window.addEventListener('offline', ()=>{ONLINE=false;setSync('off');});

/* =====================================================================
   AUTENTICAÇÃO
   ===================================================================== */
let MODO='entrar';
function telaLogin(erro){
  $('root').innerHTML = `<div class="gate"><div class="gatebox">
    <h1>Controle Financeiro</h1>
    <p class="sub">Maria &amp; Jéssica</p>
    ${erro?`<div class="gateerr">${esc(erro)}</div>`:''}
    <div class="fld"><label for="em">E-mail</label>
      <input id="em" type="email" autocomplete="email" placeholder="voce@email.com"></div>
    <div class="fld"><label for="pw">Senha</label>
      <input id="pw" type="password" autocomplete="${MODO==='entrar'?'current-password':'new-password'}" placeholder="••••••••"></div>
    ${MODO==='criar'?`<div class="fld"><label for="cd">Código de convite</label>
      <input id="cd" placeholder="Ex.: FACC90F0"></div>
      <div class="fld"><label for="nm">Seu nome</label><input id="nm" placeholder="Maria"></div>`:''}
    <button class="btn" id="go">${MODO==='entrar'?'Entrar':'Criar conta e entrar no grupo'}</button>
    <div class="gatelink">
      ${MODO==='entrar'
        ? 'Recebeu um convite? <button id="alt">Criar conta</button>'
        : 'Já tem conta? <button id="alt">Entrar</button>'}
    </div>
  </div></div>`;
  $('alt').onclick=()=>{MODO=MODO==='entrar'?'criar':'entrar';telaLogin();};
  $('go').onclick=autenticar;
  $('pw').onkeydown=e=>{if(e.key==='Enter')autenticar();};
}

async function autenticar(){
  const email=$('em').value.trim(), senha=$('pw').value;
  if(!email||!senha) return telaLogin('Preencha e-mail e senha.');
  $('go').disabled=true; $('go').textContent='Aguarde…';
  try{
    if(MODO==='criar'){
      const codigo=$('cd').value.trim(), nome=$('nm').value.trim();
      if(!codigo||!nome){$('go').disabled=false;return telaLogin('Informe o código de convite e seu nome.');}
      const {error:e1}=await sb.auth.signUp({email,password:senha});
      if(e1) throw e1;
      const {error:e2}=await sb.auth.signInWithPassword({email,password:senha});
      if(e2) throw new Error('Conta criada. Se o projeto exige confirmação por e-mail, confirme e depois entre.');
      const {error:e3}=await sb.rpc('entrar_com_convite',{p_codigo:codigo,p_meu_nome:nome});
      if(e3) throw e3;
    }else{
      const {error}=await sb.auth.signInWithPassword({email,password:senha});
      if(error) throw error;
    }
    await iniciar();
  }catch(e){
    const m = /Invalid login/i.test(e.message) ? 'E-mail ou senha incorretos.' : e.message;
    telaLogin(m);
  }
}

async function sair(){
  if(canal) sb.removeChannel(canal);
  await sb.auth.signOut();
  USER=null;GRUPO=null;MODO='entrar';telaLogin();
}

/* =====================================================================
   SIMULADOR DE COMPRA — simular, ver consequências, só então decidir
   ===================================================================== */
let SIM = {desc:'', total:1800, cartao:'', parcelas:6, quem:'Casal', inicio:null};

function simCalc(){
  const ini = SIM.inicio || addM(ym(hoje()),1);
  const parcela = SIM.parcelas>0 ? SIM.total/SIM.parcelas : 0;
  const extra = {valor_parcela:parcela, restantes:SIM.parcelas, primeira_fatura:ini+'-01'};
  const antes = fluxo(SIM.parcelas+2, null, ini);
  const depois= fluxo(SIM.parcelas+2, extra, ini);
  const linhas = depois.slice(0,SIM.parcelas).map((d,i)=>({
    k:d.k, antes:antes[i].sal, depois:d.sal, pct:d.pct, parcela:d.par-antes[i].par
  }));
  const pior = linhas.reduce((a,b)=>b.depois<a.depois?b:a, linhas[0]||{depois:0,k:ini});
  const maxPct = Math.max(...linhas.map(l=>l.pct), 0);
  const ultima = addM(ini, SIM.parcelas-1);
  const negativos = linhas.filter(l=>l.depois<0);
  const comCasa = [];
  return {ini,parcela,linhas,pior,maxPct,ultima,negativos,extra,comCasa};
}

function impactoHTML(){
  const c = simCalc();
  const veredito = c.negativos.length ? 'bad' : (c.maxPct>0.85 ? 'warn' : 'ok');
  const txt = c.negativos.length
    ? `Esta compra deixa ${c.negativos.length} ${c.negativos.length===1?'mês negativo':'meses negativos'} (${c.negativos.map(l=>mLabel(l.k)).join(', ')}). O orçamento não comporta nesse formato.`
    : c.maxPct>0.85
      ? `Cabe, mas aperta: no pior mês (${mLabel(c.pior.k)}) sobram ${BRL(c.pior.depois)} e o comprometimento chega a ${PCT(c.maxPct)}.`
      : `Cabe com folga. No pior mês (${mLabel(c.pior.k)}) ainda sobram ${BRL(c.pior.depois)}, com ${PCT(c.maxPct)} da renda comprometida.`;
  const aviso = c.comCasa.length
    ? `<div class="verdict warn" style="border-top:1px solid var(--rule)">Atenção ao comparar: ${c.comCasa.length}
       ${c.comCasa.length===1?'parcela cai':'parcelas caem'} depois que os encargos da casa começam
       (${mLabel(c.comCasa[0].k)}). Um parcelamento mais curto pode terminar antes disso e parecer mais folgado
       do que realmente é — compare mês a mês, não só o pior mês.</div>`
    : '';
  return `<div class="ih"><b>Impacto no orçamento</b>
      <span>Comparando o saldo de cada mês com e sem esta compra</span></div>
    <div class="verdict ${veredito}">${txt}</div>
    ${aviso}
    <div class="tw"><table class="mini"><thead><tr>
      <th>Mês</th><th class="r">Parcela</th><th class="r">Sobra antes</th>
      <th class="r">Sobra depois</th><th class="r">Comprometido</th>
    </tr></thead><tbody>
    ${c.linhas.map(l=>`<tr>
      <td><b>${mLabel(l.k)}</b></td>
      <td class="r">${BRL(l.parcela)}</td>
      <td class="r" style="color:var(--muted)">${BRL(l.antes)}</td>
      <td class="r" style="font-weight:600;color:${l.depois<0?'var(--neg)':'var(--pos)'}">${BRL(l.depois)}</td>
      <td class="r"><span class="pill ${l.pct>0.85?'t-no':l.pct>0.7?'t-w':'t-ok'}">${PCT(l.pct)}</span></td>
    </tr>`).join('')}
    </tbody></table></div>
    <div class="confirmbar">
      <button class="btn" onclick="confirmarCompra()" ${c.negativos.length?'style="background:var(--neg)"':''}>
        Confirmar e adicionar ao orçamento</button>
      <button class="btn alt" onclick="go('painel')">Descartar</button>
      <span class="note" style="flex:1;min-width:180px">Só ao confirmar isto vira um parcelamento real, visível para as duas.</span>
    </div>`;
}

function vCompra(){
  const c = simCalc();
  const cartoes = D.cartoes.length ? D.cartoes.map(x=>x.nome)
                : [...new Set(D.parcelamentos.map(p=>p.cartao).filter(Boolean))];
  const meses = horizon(12, ym(hoje()));
  return `<div class="phead"><h1>Nova compra <span class="simbadge">SIMULAÇÃO</span></h1>
    <p>Nada é gravado enquanto você não confirmar. Mexa nos campos e veja o impacto mês a mês antes de decidir.</p></div>
  <div class="simwrap">
    <div class="panel"><h2>Dados da compra</h2><div class="pbody">
      <div class="fld" style="margin-bottom:11px"><label>Descrição</label>
        <input id="s_desc" value="${esc(SIM.desc)}" placeholder="Ex.: Geladeira" oninput="simSet('desc',this.value)"></div>
      <div class="fld" style="margin-bottom:11px"><label>Valor total</label>
        <input id="s_total" type="number" step="10" value="${SIM.total}" oninput="setSim('total',+this.value)"></div>
      <div class="fld" style="margin-bottom:11px"><label>Em quantas vezes</label>
        <input id="s_parc" type="number" min="1" max="24" value="${SIM.parcelas}" oninput="setSim('parcelas',+this.value)">
        <div class="qbtns" id="s_qbtns">${qbtnsHTML()}</div>
      </div>
      <div class="fld" style="margin-bottom:11px"><label>Cartão</label>
        <select onchange="simSet('cartao',this.value)">
          <option value="">— escolher —</option>
          ${cartoes.map(n=>`<option ${n===SIM.cartao?'selected':''}>${esc(n)}</option>`).join('')}
        </select></div>
      <div class="fld" style="margin-bottom:11px"><label>Responsável</label>
        <select onchange="simSet('quem',this.value)">
          ${['Casal','Maria','Jéssica'].map(q=>`<option ${q===SIM.quem?'selected':''}>${q}</option>`).join('')}
        </select></div>
      <div class="fld"><label>Primeira fatura</label>
        <select onchange="setSim('inicio',this.value)">
          ${meses.map(k=>`<option value="${k}" ${k===c.ini?'selected':''}>${mLabel(k)}</option>`).join('')}
        </select></div>
      <p class="note" style="margin-top:12px" id="s_resumo">${resumoHTML()}</p>
    </div></div>
    <div class="impact" id="s_impacto">${impactoHTML()}</div>
  </div>`;
}
function qbtnsHTML(){
  return [1,3,6,10,12].map(n=>
    `<button class="qbtn" aria-pressed="${SIM.parcelas===n}" onclick="setSim('parcelas',${n},true)">${n}x</button>`).join('');
}
function resumoHTML(){
  const c=simCalc();
  return `Parcela de <b>${BRL(c.parcela)}</b> · última em <b>${mLabel(c.ultima)}</b>`;
}
/* Atualiza só o que depende do cálculo, preservando o foco de quem digita. */
function refreshSim(redesenharBotoes){
  const imp=$('s_impacto'); if(imp) imp.innerHTML=impactoHTML();
  const res=$('s_resumo');  if(res) res.innerHTML=resumoHTML();
  if(redesenharBotoes){
    const q=$('s_qbtns'); if(q) q.innerHTML=qbtnsHTML();
    const p=$('s_parc');  if(p) p.value=SIM.parcelas;
  }else{
    document.querySelectorAll('#s_qbtns .qbtn').forEach(b=>
      b.setAttribute('aria-pressed', b.textContent===SIM.parcelas+'x'));
  }
}
/* campos que mudam o cálculo: atualiza só o painel de impacto */
window.setSim=(campo,val,doBotao)=>{
  SIM[campo] = (campo==='parcelas') ? Math.max(1,Math.min(24,val||1)) : val;
  refreshSim(!!doBotao);
};
/* campos que não afetam o cálculo: só guarda, sem redesenhar nada */
window.simSet=(campo,val)=>{ SIM[campo]=val; };
/* trocar o mês em foco */
window.setMes=v=>{ MREF=v; VISAO=null; render(); };
window.setVisao=v=>{ VISAO=v; render(); };
window.confirmarCompra=async()=>{
  if(!SIM.desc.trim()) return toast('Dê um nome para a compra antes de confirmar');
  if(!SIM.total || SIM.total<=0) return toast('Informe o valor total');
  const c=simCalc();
  if(c.negativos.length && !confirm(
     `Esta compra deixa ${c.negativos.length} mês(es) negativo(s). Confirmar mesmo assim?`)) return;
  const ok = await inserir('parcelamentos',{
    descricao:SIM.desc.trim(), cartao:SIM.cartao||null,
    valor_parcela:+c.parcela.toFixed(2), total_parcelas:SIM.parcelas,
    restantes:SIM.parcelas, primeira_fatura:c.ini+'-01',
    responsavel:SIM.quem, origem:'simulacao_confirmada',
    criado_por:USER.id
  });
  if(ok){
    toast(SIM.desc+' adicionada · '+SIM.parcelas+'x de '+BRL(c.parcela));
    SIM={desc:'',total:1800,cartao:'',parcelas:6,quem:'Casal',inicio:null};
    go('parc');
  }
};

/* =====================================================================
   TELAS
   ===================================================================== */
const PAGES=[['painel','Painel'],['compra','Nova compra'],['lanc','Lançamentos'],
  ['parc','Parcelamentos'],['assin','Assinaturas'],['terc','Terceiros'],
  ['proj','Projeção'],['amort','Amortização'],['casa','Projeções Casa'],
  ['cad','Cadastros'],['metas','Metas']];
let CUR='painel', MREF=ym(hoje()), VISAO=null;  // 'previsto' | 'realizado'

function head(t,p){return `<div class="phead"><h1>${t}</h1><p>${p}</p></div>`
  +(FALTANDO.length?`<div class="warn" style="margin-bottom:16px"><b>Banco desatualizado.</b>
     ${FALTANDO.length===1?'A tabela':'As tabelas'} <b>${FALTANDO.join(', ')}</b>
     ${FALTANDO.length===1?'ainda não existe':'ainda não existem'} no Supabase.
     Rode <b>migracao-casa.sql</b> no SQL Editor e recarregue. Até lá, esta parte fica vazia.</div>`:'');}
function kpi(k,v,s,cls){return `<div class="kpi"><span class="k">${k}</span>
  <span class="v ${cls||''}">${v}</span>${s?`<span class="s">${s}</span>`:''}</div>`;}
function bar(l,v,lim){const w=Math.min(100,v*100),
  c=v>lim?'var(--neg)':(v>lim*.75?'var(--amber)':'var(--pos)');
  return `<div class="bar"><span>${l}</span><span class="track">
    <span class="fill" style="width:${w}%;background:${c}"></span></span>
    <span class="r" style="font-weight:600;color:${c}">${PCT(v)}</span></div>`;}

function chartFluxo(n=12,ini){
  const f=fluxo(n,null,ini),w=760,h=150,pl=8,pt=14,pb=26,iw=w-16,ih=h-pt-pb;
  const mx=Math.max(...f.map(x=>x.sal),0),mn=Math.min(...f.map(x=>x.sal),0),rng=(mx-mn)||1;
  const bw=iw/f.length,y0=pt+ih*(mx/rng);
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="Saldo projetado por mês">
    <line x1="${pl}" y1="${y0.toFixed(1)}" x2="${w-pl}" y2="${y0.toFixed(1)}" stroke="var(--rule)"/>
    ${f.map((x,i)=>{const bh=Math.abs(x.sal)/rng*ih,bx=pl+i*bw+bw*0.16,bwid=bw*0.68,
      by=x.sal>=0?y0-bh:y0,col=x.sal<0?'var(--neg)':(x.casa?'var(--amber)':'var(--steel)');
      return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bwid.toFixed(1)}"
        height="${Math.max(1,bh).toFixed(1)}" fill="${col}" rx="1"><title>${mLabel(x.k)}: ${BRL(x.sal)}</title></rect>
        <text x="${(bx+bwid/2).toFixed(1)}" y="${h-9}" text-anchor="middle" font-size="9" fill="var(--muted)">${x.k.slice(5)}</text>`;
    }).join('')}</svg>`;
}

function primeiroMesComParcela(){
  const h=horizon(24,MREF);
  const k=h.find(m=>parcelasMes(m)>0);
  return k||MREF;
}
function ultimoMesParcela(){
  let ult=null;
  D.parcelamentos.forEach(p=>{
    if(p.restantes>0){
      const ini=p.primeira_fatura?ym(p.primeira_fatura):ym(hoje());
      const fim=addM(ini,p.restantes-1);
      if(!ult||fim>ult) ult=fim;
    }});
  return ult?mLabel(ult):'—';
}
function vPainel(){
  const f=fluxo(12,null,MREF), mes=f[0], r=realizado(MREF);
  const meses=mesesDisponiveis();
  const blocos=blocosDoMes(MREF);
  let corrido=0;
  const comAcum=blocos.map(b=>{ corrido+=b.saldo; return {...b,acum:corrido}; });
  const apertados=comAcum.filter(b=>b.acum<0);
  const terc=D.terceiros.filter(t=>!t.recebido);
  const cats=Object.entries(r.porCat).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const mxc=Math.max(...cats.map(c=>c[1]),1);

  const passado = MREF < ym(hoje());
  const semDados = r.n===0;
  return head('Painel','Entradas e saídas nas datas de pagamento. Clique num bloco para ver o detalhe.')
  +(passado&&semDados?`<div class="warn" style="margin-bottom:16px">
    <b>Mês sem lançamentos.</b> ${mLabel(MREF)} já passou, mas nada foi registrado —
    então os números abaixo são uma <b>projeção</b> feita a partir das contas fixas e
    assinaturas, não o que aconteceu de verdade. Lance os movimentos do mês para ver o real.</div>`:'')
  +(passado&&!semDados?`<div class="info" style="margin-bottom:16px">
    ${mLabel(MREF)} já passou. Os valores abaixo vêm dos ${r.n} lançamentos registrados.</div>`:'')
  +`<div class="rowbar">
    <div class="fld" style="max-width:160px"><label>Mês em foco</label>
      <select onchange="setMes(this.value)">
        ${meses.map(k=>`<option value="${k}" ${k===MREF?'selected':''}>${mLabel(k)}</option>`).join('')}
      </select></div>
    <div style="flex:1"></div>
    <button class="btn" onclick="go('compra')">Simular compra</button>
    <button class="btn alt" onclick="go('lanc')">Lançar movimento</button>
  </div>

  <div class="kpis">
    ${kpi('Renda',BRL(mes.renda),'em '+mLabel(MREF))}
    ${kpi(passado&&semDados?'Saídas (projetadas)':'Saídas previstas',BRL(mes.out),
      passado&&semDados?'sem lançamentos no mês':PCT(mes.pct)+' da renda',
      passado&&semDados?'amb':'')}
    ${kpi(passado&&semDados?'Saldo (projetado)':'Saldo previsto',BRL(mes.sal),'',
      passado&&semDados?'amb':(mes.sal<0?'neg':'pos'))}
    ${kpi('Dívida de cartões',BRL(saldoParc()),'quita em '+ultimoMesParcela(),'amb')}
  </div>

  ${apertados.length?`<div class="warn" style="margin-bottom:16px"><b>Atenção:</b> o dinheiro não fecha
    ${apertados.length===1?'no bloco':'nos blocos'} ${apertados.map(b=>b.label.toLowerCase()).join(', ')}.
    Vai faltar caixa antes da próxima entrada.</div>`:''}

  <div class="kgroup">Fluxo por data em ${mLabel(MREF)} <small>clique para detalhar</small></div>
  <div class="dayflow">
  ${comAcum.map(b=>`
    <details class="day">
      <summary>
        <span class="dlabel">${b.label}</span>
        <span class="din">${b.tIn?'+'+BRL(b.tIn):'—'}</span>
        <span class="dout">${b.tOut?'−'+BRL(b.tOut):'—'}</span>
        <span class="dsal ${b.saldo<0?'neg':''}">${BRL(b.saldo)}</span>
        <span class="dacum ${b.acum<0?'neg':''}">acum. ${BRL(b.acum)}</span>
      </summary>
      <div class="ddet">
        ${b.entradas.length?`<div class="dcol"><h5>Entra</h5>
          ${b.entradas.map(e=>`<div class="dline"><span>${esc(e.desc)}${e.quem?` <span class="tag t-g">${esc(e.quem)}</span>`:''}</span>
            <b style="color:var(--pos)">${BRL(e.valor)}</b></div>`).join('')}</div>`:''}
        ${b.saidas.length?`<div class="dcol"><h5>Sai</h5>
          ${b.saidas.map(x=>`<div class="dline"><span>${esc(x.desc)}
            ${x.tipo==='reserva'?'<span class="tag t-w">reserva</span>':''}
            ${x.tipo==='cartao'?'<span class="tag t-i">fatura</span>':''}</span>
            <b style="color:var(--neg)">${BRL(x.valor)}</b></div>`).join('')}</div>`:''}
      </div>
    </details>`).join('')}
  </div>

  <div class="grid2">
    <div class="panel"><h2>Faturas de ${mLabel(MREF)}</h2><div class="pbody">
      ${(()=>{
        const nomes=[...new Set([...D.cartoes.filter(c=>c.ativo).map(c=>c.nome),
          ...D.lancamentos.filter(l=>ym(l.data)===MREF&&l.cartao).map(l=>l.cartao)])];
        const linhas=nomes.map(n=>{
          const real=faturaLancada(n,MREF), calc=faturaCalculada(n,MREF), v=faturaCartao(n,MREF);
          if(!v) return '';
          const c=D.cartoes.find(x=>x.nome===n);
          const itens=[
            ...D.parcelamentos.filter(p=>(p.cartao||'')===n).filter(p=>{
              const i=p.primeira_fatura?ym(p.primeira_fatura):ym(hoje());
              const d=mesesEntre(i,MREF); return d>=0&&d<p.restantes;}).map(p=>({d:p.descricao,v:+p.valor_parcela})),
            ...D.assinaturas.filter(a=>a.projetar&&(a.cartao||'')===n).map(a=>({d:a.descricao,v:+a.valor}))];
          const terc=D.terceiros.filter(t=>t.cartao===n&&!t.recebido)
            .reduce((s,t)=>s+ +t.valor,0);
          return `<details class="mini-det"><summary><span>${esc(n)}
            <span class="tag ${real?'t-ok':'t-g'}">${real?'lançada':'estimada'}</span>
            ${c?`<span class="note">vence dia ${c.dia_venc||'—'}</span>`:''}</span>
            <b>${BRL(v)}</b></summary>
            <div style="padding:8px 0 10px">
              ${real
                ? `${real.itens.map(l=>`<div class="dline"><span>${esc(l.descricao)}
                     <span class="note">${String(l.data).split('-').reverse().join('/')}</span></span>
                     <span>${BRL(l.valor)}</span></div>`).join('')}
                   ${calc?`<div class="dline"><span class="note">Estimativa por parcelas e assinaturas era</span>
                     <span class="note">${BRL(calc)}</span></div>`:''}
                   <p class="note" style="margin-top:8px">Valor vindo do que você lançou.
                     Para corrigir, edite o lançamento em <b>Lançamentos</b>.</p>`
                : `${itens.map(i=>`<div class="dline"><span>${esc(i.d)}</span><span>${BRL(i.v)}</span></div>`).join('')
                     ||'<p class="note">Sem parcelas nem assinaturas neste cartão.</p>'}
                   <p class="note" style="margin-top:8px">Estimativa. Quando lançar o pagamento desta fatura,
                     o valor real assume o lugar.</p>`}
              ${terc?`<div class="dline"><span class="note">Terceiros a receber neste cartão</span>
                <span class="note" style="color:var(--amber)">${BRL(terc)}</span></div>`:''}
            </div>
          </details>`;}).filter(Boolean).join('');
        return linhas||'<p class="note">Nenhuma fatura neste mês.</p>';
      })()}
    </div></div>

    <div class="panel"><h2>Terceiros a receber <small>${BRL(aReceber())}</small></h2><div class="pbody">
      ${terc.length?terc.map(t=>`<div class="dline"><span>${esc(t.pessoa)} · ${esc(t.descricao)}
        <span class="note">${esc(t.competencia||'')}</span></span>
        <b style="color:var(--amber)">${BRL(t.valor)}</b></div>`).join('')
        :'<p class="note">Nada pendente.</p>'}
      <p class="note" style="margin-top:10px">Está dentro das faturas acima, mas não é gasto de vocês.</p>
    </div></div>
  </div>

  ${(()=>{
    const rp=reportsMes(MREF);
    if(!rp.temMovimento && !rp.previsto) return '';
    return `<div class="panel"><h2>Reports <small>protegido — fora do orçamento do casal</small></h2>
      <div class="pbody">
        <div class="dline"><span>${rp.ent?'Entrada recebida':'Entrada prevista'}</span>
          <b style="color:var(--pos)">${BRL(rp.ent||rp.previsto)}</b></div>
        ${rp.sai.map(l=>`<div class="dline"><span>${esc(l.descricao)}
          <span class="note">${String(l.data).split('-').reverse().join('/')}</span></span>
          <b style="color:var(--neg)">${BRL(l.valor)}</b></div>`).join('')}
        ${rp.tot?`<div class="dline" style="border-top:1px solid var(--rule);margin-top:4px;padding-top:6px">
          <span><b>Sobra protegida</b></span>
          <b style="color:${(rp.ent||rp.previsto)-rp.tot<0?'var(--neg)':'var(--pos)'}">
            ${BRL((rp.ent||rp.previsto)-rp.tot)}</b></div>`:''}
        ${rp.encerrado&&rp.tot?`<p class="note" style="margin-top:10px;color:var(--neg)">
          Atenção: o Reports encerrou e ainda há ${BRL(rp.tot)} alocado a ele neste mês.
          Sem entrada nova, isso acaba caindo no orçamento de vocês.</p>`
        :`<p class="note" style="margin-top:10px">Não soma à renda disponível e não entra no saldo do mês.</p>`}
      </div></div>`;
  })()}

  ${cats.length?`<div class="panel"><h2>Gastos por categoria em ${mLabel(MREF)}
    <small>do que você lançou</small></h2><div class="pbody"><div class="bars">
    ${cats.map(([c,v])=>`<div class="bar"><span>${esc(c)}</span>
      <span class="track"><span class="fill" style="width:${v/mxc*100}%"></span></span>
      <span class="r" style="font-weight:600">${BRL(v)}</span></div>`).join('')}
  </div></div></div>`:''}

  <div class="panel"><h2>Saldo projetado</h2><div class="pbody">${chartFluxo(12,MREF)}</div></div>`;
}

const CATS=['Salário/Renda','Moradia','Transporte','Combustível','Investimento','Telefonia',
  'Saúde','Compras','Cartão','Assinaturas','Alimentação','Lazer','Reserva','Reports','Outros'];

function vLanc(){
  const ls=D.lancamentos.filter(l=>ym(l.data)===MREF);
  const r=realizado(MREF);
  return head('Lançamentos','Cada movimento entra aqui e aparece no app da outra em segundos.')
  +`<div class="panel"><h2>Novo lançamento</h2><div class="pbody"><div class="form">
    <div class="fld"><label>Data</label><input type="date" id="l_d" value="${MREF}-01"></div>
    <div class="fld" style="grid-column:span 2"><label>Descrição</label><input id="l_n" placeholder="Ex.: Mercado"></div>
    <div class="fld"><label>Categoria</label><select id="l_c">${CATS.map(c=>`<option>${c}</option>`).join('')}</select></div>
    <div class="fld"><label>Tipo</label><select id="l_t"><option>Saída</option><option>Entrada</option></select></div>
    <div class="fld"><label>Quem</label><select id="l_q">${['Casal','Maria','Jéssica'].map(q=>`<option>${q}</option>`).join('')}</select></div>
    <div class="fld"><label>Valor</label><input type="number" step="0.01" id="l_v" placeholder="0,00"></div>
    <div class="fld"><label>&nbsp;</label><button class="btn" onclick="addLanc()">Adicionar</button></div>
  </div></div></div>
  <div class="kpis">
    ${kpi('Entradas',BRL(r.ent),'','pos')} ${kpi('Saídas',BRL(r.sai),'','neg')}
    ${kpi('Saldo',BRL(r.sal),'',r.sal<0?'neg':'pos')} ${kpi('Benefícios',BRL(r.va),'fora do saldo','amb')}
  </div>
  <div class="panel"><h2>${mLabel(MREF)} <small>${ls.length} lançamento${ls.length===1?'':'s'}</small>
    <select style="max-width:140px" onchange="setMes(this.value)">
      ${mesesDisponiveis().map(k=>`<option value="${k}" ${k===MREF?'selected':''}>${mLabel(k)}</option>`).join('')}
    </select></h2>
  <div class="tw"><table><thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th>
    <th>Quem</th><th class="r">Valor</th><th></th></tr></thead><tbody>
  ${ls.map(l=>`<tr class="${l.protegido||l.beneficio?'dim':''}">
    <td class="mono">${String(l.data).split('-').reverse().join('/')}</td>
    <td>${esc(l.descricao)}${l.protegido?' <span class="tag t-g">protegido</span>':''}${l.beneficio?' <span class="tag t-g">benefício</span>':''}${
      mesDeCaixa(l)!==ym(l.data)?` <span class="tag t-w">pago em ${mLabel(mesDeCaixa(l))}</span>`:''}</td>
    <td>${esc(l.categoria)}</td><td>${esc(l.quem)}</td>
    <td class="r" style="font-weight:600;color:${l.tipo==='Entrada'?'var(--pos)':'var(--neg)'}">
      ${l.tipo==='Entrada'?'+':'−'} ${BRL(l.valor)}</td>
    <td class="r"><button class="btn dgr" onclick="delRow('lancamentos','${l.id}')">excluir</button></td></tr>`).join('')
    ||'<tr><td colspan="6" class="note" style="padding:20px;text-align:center">Nenhum lançamento neste mês.</td></tr>'}
  </tbody></table></div></div>`;
}
window.addLanc=async()=>{
  const d=$('l_d').value,n=$('l_n').value.trim(),v=parseFloat($('l_v').value);
  if(!d||!n||!v) return toast('Preencha data, descrição e valor');
  const ok=await inserir('lancamentos',{data:d,descricao:n,categoria:$('l_c').value,
    tipo:$('l_t').value,quem:$('l_q').value,valor:v,status:'Confirmado',criado_por:USER.id});
  if(ok){MREF=ym(d);render();toast(n+' lançado · saldo do mês agora '+BRL(realizado(MREF).sal));}
};
window.delRow=async(t,id)=>{if(await remover(t,id)){render();toast('Excluído');}};

function vParc(){
  return head('Parcelamentos','Cada dívida com quantas faltam e quando termina.')
  +`<div class="kpis">
    ${kpi('Saldo devedor',BRL(saldoParc()),'','amb')}
    ${kpi('Parcelas este mês',BRL(parcelasMes(ym(hoje()))))}
    ${kpi('Dívidas ativas',D.parcelamentos.filter(p=>p.restantes>0).length)}
  </div>
  <div class="panel"><h2>Dívidas <small>edite as restantes para corrigir</small></h2>
  <div class="tw"><table><thead><tr><th>Dívida</th><th>Cartão</th><th class="r">Parcela</th>
    <th class="c">Faltam</th><th class="r">Saldo</th><th>Termina</th><th></th></tr></thead><tbody>
  ${D.parcelamentos.map(p=>{
    const ini=p.primeira_fatura?ym(p.primeira_fatura):ym(hoje());
    const fim=addM(ini,Math.max(0,p.restantes-1));
    return `<tr><td><b>${esc(p.descricao)}</b>${p.origem==='simulacao_confirmada'?' <span class="tag t-i">simulada</span>':''}</td>
    <td>${esc(p.cartao||'—')}</td><td class="r">${BRL(p.valor_parcela)}</td>
    <td class="c"><input type="number" min="0" value="${p.restantes}" style="width:56px;padding:3px 5px;text-align:center"
      onchange="setRow('parcelamentos','${p.id}','restantes',Math.max(0,+this.value))"></td>
    <td class="r"><b>${BRL(p.valor_parcela*p.restantes)}</b></td>
    <td>${p.restantes>0?mLabel(fim):'—'}</td>
    <td class="r"><button class="btn dgr" onclick="delRow('parcelamentos','${p.id}')">excluir</button></td></tr>`;}).join('')
    ||'<tr><td colspan="7" class="note" style="padding:20px;text-align:center">Nenhum parcelamento. Use "Nova compra" para simular e adicionar.</td></tr>'}
  </tbody></table></div>
  <div class="pbody"><button class="btn" onclick="go('compra')">Simular nova compra</button></div></div>`;
}
window.setRow=async(t,id,campo,val)=>{if(await atualizar(t,id,{[campo]:val})){render();toast('Atualizado');}};

function vAssin(){
  return head('Assinaturas','Desmarque para ver na hora quanto sobraria sem ela.')
  +`<div class="kpis">${kpi('Total ativo',BRL(totAssin()))}
    ${kpi('Por ano',BRL(totAssin()*12),'','amb')}
    ${kpi('Ativas',D.assinaturas.filter(a=>a.projetar).length+' de '+D.assinaturas.length)}</div>
  <div class="panel"><h2>Assinaturas</h2>
  <div class="tw"><table><thead><tr><th class="c">Projetar</th><th>Nome</th><th>Cartão</th>
    <th class="r">Valor</th><th class="r">Por ano</th><th></th></tr></thead><tbody>
  ${D.assinaturas.map(a=>`<tr class="${a.projetar?'':'dim'}">
    <td class="c"><input type="checkbox" ${a.projetar?'checked':''} style="width:auto;cursor:pointer"
      onchange="setRow('assinaturas','${a.id}','projetar',this.checked)"></td>
    <td><b>${esc(a.descricao)}</b>${a.observacao?`<br><span class="tag t-w">${esc(a.observacao)}</span>`:''}</td>
    <td>${esc(a.cartao||'—')}</td><td class="r">${BRL(a.valor)}</td>
    <td class="r">${a.projetar?BRL(a.valor*12):'—'}</td>
    <td class="r"><button class="btn dgr" onclick="delRow('assinaturas','${a.id}')">excluir</button></td></tr>`).join('')
    ||'<tr><td colspan="6" class="note" style="padding:20px;text-align:center">Nenhuma assinatura cadastrada.</td></tr>'}
  </tbody></table></div>
  <div class="pbody"><div class="form">
    <div class="fld"><label>Nome</label><input id="a_n" placeholder="Ex.: Netflix"></div>
    <div class="fld"><label>Valor</label><input type="number" step="0.01" id="a_v"></div>
    <div class="fld"><label>Cartão</label><input id="a_c" placeholder="opcional"></div>
    <div class="fld"><label>&nbsp;</label><button class="btn" onclick="addAssin()">Adicionar</button></div>
  </div></div></div>`;
}
window.addAssin=async()=>{
  const n=$('a_n').value.trim(),v=parseFloat($('a_v').value);
  if(!n||!v) return toast('Preencha nome e valor');
  if(await inserir('assinaturas',{descricao:n,valor:v,cartao:$('a_c').value.trim()||null,projetar:true}))
    {render();toast(n+' adicionada');}
};

function vTerc(){
  const pes=[...new Set(D.terceiros.map(t=>t.pessoa))];
  return head('Terceiros','Compras de outras pessoas nos cartões de vocês — dinheiro a recuperar.')
  +`<div class="kpis">${kpi('A receber',BRL(aReceber()),'','amb')}
    ${kpi('Já recebido',BRL(recebido()),'','pos')}
    ${kpi('Exposição total',BRL(aReceber()+recebido()))}</div>
  ${pes.length?`<div class="panel"><h2>Por pessoa</h2><div class="pbody"><div class="bars">
    ${pes.map(p=>{const v=D.terceiros.filter(t=>t.pessoa===p&&!t.recebido).reduce((s,t)=>s+ +t.valor,0);
      const mx=Math.max(...pes.map(q=>D.terceiros.filter(t=>t.pessoa===q&&!t.recebido).reduce((s,t)=>s+ +t.valor,0)),1);
      return `<div class="bar"><span>${esc(p)}</span><span class="track">
        <span class="fill" style="width:${v/mx*100}%"></span></span>
        <span class="r" style="font-weight:600">${BRL(v)}</span></div>`;}).join('')}
  </div></div></div>`:''}
  <div class="panel"><h2>Detalhe <small>marque quando receber</small></h2>
  <div class="tw"><table><thead><tr><th class="c">Recebido</th><th>Pessoa</th><th>Descrição</th>
    <th class="r">Valor</th><th></th></tr></thead><tbody>
  ${D.terceiros.map(t=>`<tr class="${t.recebido?'dim':''}">
    <td class="c"><input type="checkbox" ${t.recebido?'checked':''} style="width:auto;cursor:pointer"
      onchange="setRow('terceiros','${t.id}','recebido',this.checked)"></td>
    <td><b>${esc(t.pessoa)}</b></td><td>${esc(t.descricao)}</td>
    <td class="r" style="font-weight:600;color:${t.recebido?'var(--pos)':'var(--amber)'}">${BRL(t.valor)}</td>
    <td class="r"><button class="btn dgr" onclick="delRow('terceiros','${t.id}')">excluir</button></td></tr>`).join('')
    ||'<tr><td colspan="5" class="note" style="padding:20px;text-align:center">Nada pendente.</td></tr>'}
  </tbody></table></div>
  <div class="pbody"><div class="form">
    <div class="fld"><label>Pessoa</label><input id="t_p" placeholder="Ex.: Mãe"></div>
    <div class="fld" style="grid-column:span 2"><label>Descrição</label><input id="t_d"></div>
    <div class="fld"><label>Valor</label><input type="number" step="0.01" id="t_v"></div>
    <div class="fld"><label>&nbsp;</label><button class="btn" onclick="addTerc()">Adicionar</button></div>
  </div></div></div>`;
}
window.addTerc=async()=>{
  const p=$('t_p').value.trim(),d=$('t_d').value.trim(),v=parseFloat($('t_v').value);
  if(!p||!v) return toast('Preencha pessoa e valor');
  if(await inserir('terceiros',{pessoa:p,descricao:d||'—',valor:v,recebido:false}))
    {render();toast('Registrado');}
};

function vProj(){
  const f=fluxo(24),neg=f.filter(x=>x.sal<0);
  return head('Projeção 24 meses','Contas atuais, mês a mês. O cenário da casa fica na aba Projeções Casa.')
  +(neg.length?`<div class="warn" style="margin-bottom:16px"><b>Atenção:</b> ${neg.length}
     ${neg.length===1?'mês fica negativo':'meses ficam negativos'}: ${neg.map(x=>mLabel(x.k)).join(', ')}.</div>`
    :`<div class="info" style="margin-bottom:16px">Nenhum mês negativo. Acumulado em 24 meses: ${BRL(f[23].acc)}.</div>`)
  +`<div class="panel"><div class="tw"><table><thead><tr>
    <th>Mês</th><th class="r">Renda</th><th class="r">Fixas</th><th class="r">Cartões</th>
    <th class="r">Saídas</th><th class="r">Saldo</th><th class="r">Acumulado</th><th class="r">%</th>
  </tr></thead><tbody>
  ${f.map(x=>`<tr><td><b>${mLabel(x.k)}</b></td>
    <td class="r">${BRL(x.renda)}</td><td class="r">${BRL(x.fix)}</td>
    <td class="r">${BRL(x.cart)}${x.real?' <span class="tag t-ok">real</span>':''}</td>
    <td class="r"><b>${BRL(x.out)}</b></td>
    <td class="r" style="font-weight:600;color:${x.sal<0?'var(--neg)':'var(--pos)'}">${BRL(x.sal)}</td>
    <td class="r">${BRL(x.acc)}</td>
    <td class="r"><span class="pill ${x.pct>.8?'t-no':x.pct>.6?'t-w':'t-ok'}">${PCT(x.pct)}</span></td>
  </tr>`).join('')}</tbody></table></div></div>`;
}

function vCad(){
  const c=cfg();
  const tabela=(titulo,tab,campos,total)=>`
    <div class="panel"><h2>${titulo}</h2><div class="tw"><table><thead><tr>
      ${campos.map(f=>`<th class="${f.r?'r':''}">${f.l}</th>`).join('')}<th></th></tr></thead><tbody>
    ${D[tab].map(x=>`<tr class="${x.ativo===false?'dim':''}">
      ${campos.map(f=>`<td class="${f.r?'r':''}">${
        f.tipo==='check'?`<input type="checkbox" ${x[f.k]?'checked':''} style="width:auto;cursor:pointer"
            onchange="setRow('${tab}','${x.id}','${f.k}',this.checked)">`
        :`<input ${f.tipo==='num'?'type="number" step="0.01"':''} value="${esc(x[f.k]??'')}"
            style="border-color:transparent;padding:3px 5px;${f.r?'text-align:right;width:104px':''}"
            onchange="setRow('${tab}','${x.id}','${f.k}',${f.tipo==='num'?'+this.value':'this.value'})">`
      }</td>`).join('')}
      <td class="r"><button class="btn dgr" onclick="delRow('${tab}','${x.id}')">excluir</button></td></tr>`).join('')
      ||`<tr><td colspan="${campos.length+1}" class="note" style="padding:16px;text-align:center">Vazio.</td></tr>`}
    </tbody><tfoot><tr><td colspan="${campos.length-1}">Total</td>
      <td class="r">${BRL(total)}</td><td></td></tr></tfoot></table></div>
    <div class="pbody"><button class="btn alt sm" onclick="addCad('${tab}')">+ Adicionar</button></div></div>`;

  return head('Cadastros','Cartões, renda, contas fixas e benefícios. Mudar qualquer coisa aqui recalcula o resto.')
  +`<div class="rowbar"><span class="note">Nesta página:</span>
    ${['Cartões','Renda','Contas fixas','Benefícios'].map(x=>
      `<span class="tag t-i">${x}</span>`).join('')}
  </div>`
  +`<div class="kpis">${kpi('Renda',BRL(totRenda()))}${kpi('Fixas',BRL(totFixas()))}
    ${kpi('Benefícios',BRL(totVA()))}${kpi('Sobra estrutural',BRL(totRenda()-totFixas()),'antes de cartões','pos')}</div>
  <div class="panel"><h2>Cartões <small>o dia de vencimento define em qual bloco a fatura cai no painel</small></h2>
  <div class="tw"><table><thead><tr><th class="c">Ativo</th><th>Cartão</th><th>Titular</th>
    <th class="c">Vence dia</th><th class="r">Fatura de ${mLabel(MREF)}</th><th></th></tr></thead><tbody>
  ${D.cartoes.map(c=>{
    const real=faturaLancada(c.nome,MREF), v=faturaCartao(c.nome,MREF);
    return `<tr class="${c.ativo?'':'dim'}">
    <td class="c"><input type="checkbox" ${c.ativo?'checked':''} style="width:auto;cursor:pointer"
      onchange="setRow('cartoes','${c.id}','ativo',this.checked)"></td>
    <td><input value="${esc(c.nome)}" style="border-color:transparent;padding:3px 5px"
      onchange="setRow('cartoes','${c.id}','nome',this.value)"></td>
    <td><input value="${esc(c.titular||'')}" style="border-color:transparent;padding:3px 5px"
      onchange="setRow('cartoes','${c.id}','titular',this.value)"></td>
    <td class="c"><input type="number" min="1" max="31" value="${c.dia_venc||''}"
      style="width:60px;padding:3px 5px;text-align:center"
      onchange="setRow('cartoes','${c.id}','dia_venc',this.value?+this.value:null)"></td>
    <td class="r">${v?BRL(v):'—'} ${v?`<span class="tag ${real?'t-ok':'t-g'}">${real?'lançada':'estimada'}</span>`:''}</td>
    <td class="r"><button class="btn dgr" onclick="delRow('cartoes','${c.id}')">excluir</button></td></tr>`;}).join('')
    ||'<tr><td colspan="6" class="note" style="padding:16px;text-align:center">Nenhum cartão cadastrado.</td></tr>'}
  </tbody></table></div>
  <div class="pbody"><div class="form">
    <div class="fld"><label>Novo cartão</label><input id="ct_n" placeholder="Ex.: Nubank"></div>
    <div class="fld"><label>Titular</label><input id="ct_t" placeholder="Maria ou Jéssica"></div>
    <div class="fld"><label>Vence dia</label><input type="number" min="1" max="31" id="ct_d"></div>
    <div class="fld"><label>&nbsp;</label><button class="btn" onclick="addCartao()">Adicionar</button></div>
  </div>
  <p class="note" style="margin-top:10px">Cartão com vencimento no <b>dia 1</b> é tratado como pago com a sobra
  do último dia do mês anterior — por isso ele aparece como reserva naquele bloco, não num bloco próprio.</p>
  </div></div>

  ${tabela('Renda','rendas',[{l:'Descrição',k:'descricao'},{l:'Quem',k:'quem'},
    {l:'Dia',k:'dia',tipo:'num'},{l:'Valor',k:'valor',tipo:'num',r:1}],totRenda())}
  ${tabela('Contas fixas','fixas',[{l:'Ativa',k:'ativo',tipo:'check'},{l:'Descrição',k:'descricao'},
    {l:'Categoria',k:'categoria'},{l:'Dia',k:'dia',tipo:'num'},{l:'Valor',k:'valor',tipo:'num',r:1}],totFixas())}
  ${tabela('Benefícios','beneficios',[{l:'Descrição',k:'descricao'},{l:'Quem',k:'quem'},
    {l:'Dia',k:'dia',tipo:'num'},{l:'Valor',k:'valor',tipo:'num',r:1}],totVA())}
  <div class="info">Cenário da casa e simulações ficam na aba <b>Projeções Casa</b>.</div>`;
}
window.setCfg=async(k,v)=>{if(await atualizar('config',null,{[k]:v})){render();toast('Atualizado');}};
window.addCartao=async()=>{
  const n=$('ct_n').value.trim();
  if(!n) return toast('Dê um nome ao cartão');
  const d=parseInt($('ct_d').value);
  if(await inserir('cartoes',{nome:n,titular:$('ct_t').value.trim()||null,
      dia_venc:isNaN(d)?null:d,ativo:true})){render();toast(n+' adicionado');}
};
window.addCad=async(tab)=>{
  const novo={rendas:{descricao:'Nova renda',valor:0,dia:5,quem:'Casal',ativo:true},
    fixas:{descricao:'Nova conta',valor:0,dia:5,categoria:'Outros',ativo:true},
    beneficios:{descricao:'Novo benefício',valor:0,dia:1,quem:'Casal',ativo:true}}[tab];
  if(await inserir(tab,novo)){render();toast('Adicionado — edite os campos');}
};

function vMetas(){
  const c=cfg(), custo=totFixas()+totAssin(), meta=custo*6;
  const falta=Math.max(0,meta-+c.reserva_atual);
  const prog=meta?Math.min(1,+c.reserva_atual/meta):0;
  const meses=+c.aporte_mensal>0?Math.ceil(falta/+c.aporte_mensal):null;
  return head('Metas e reserva','Quanto falta para a reserva de emergência e em quanto tempo.')
  +`<div class="panel"><h2>Reserva de emergência</h2><div class="pbody">
    <div class="form" style="margin-bottom:16px">
      <div class="fld"><label>Reserva atual</label><input type="number" step="100" value="${c.reserva_atual}"
        onchange="setCfg('reserva_atual',+this.value)"></div>
      <div class="fld"><label>Aporte por mês</label><input type="number" step="50" value="${c.aporte_mensal}"
        onchange="setCfg('aporte_mensal',+this.value)"></div>
    </div>
    <div class="bar" style="grid-template-columns:110px 1fr 90px;margin-bottom:14px"><span>Progresso</span>
      <span class="track" style="height:22px"><span class="fill" style="width:${prog*100}%;background:var(--pos)"></span></span>
      <span class="r" style="font-weight:600">${PCT(prog)}</span></div>
    <div class="kpis" style="margin:0">
      ${kpi('Meta (6 meses de custo)',BRL(meta),'fixas + assinaturas')}
      ${kpi('Falta',BRL(falta),'','amb')}
      ${kpi('Meses até lá',meses!==null?meses:'—',meses!==null?'no ritmo atual':'defina um aporte')}
    </div>
  </div></div>
  <div class="panel"><h2>Outras metas</h2><div class="pbody">
    <div class="form" style="margin-bottom:14px">
      <div class="fld" style="grid-column:span 2"><label>Meta</label><input id="m_n" placeholder="Ex.: Entrada da casa"></div>
      <div class="fld"><label>Valor alvo</label><input type="number" id="m_a"></div>
      <div class="fld"><label>Já guardado</label><input type="number" id="m_g"></div>
      <div class="fld"><label>&nbsp;</label><button class="btn" onclick="addMeta()">Adicionar</button></div>
    </div>
    ${D.metas.length?`<div class="tw"><table><thead><tr><th>Meta</th><th class="r">Alvo</th>
      <th class="r">Guardado</th><th class="r">Falta</th><th></th></tr></thead><tbody>
    ${D.metas.map(m=>`<tr><td><b>${esc(m.nome)}</b></td><td class="r">${BRL(m.alvo)}</td>
      <td class="r"><input type="number" value="${m.guardado}" style="width:104px;padding:3px 5px;text-align:right;border-color:transparent"
        onchange="setRow('metas','${m.id}','guardado',+this.value)"></td>
      <td class="r" style="color:var(--amber)">${BRL(Math.max(0,m.alvo-m.guardado))}</td>
      <td class="r"><button class="btn dgr" onclick="delRow('metas','${m.id}')">excluir</button></td></tr>`).join('')}
    </tbody></table></div>`:'<p class="note">Nenhuma meta ainda.</p>'}
  </div></div>`;
}
window.addMeta=async()=>{
  const n=$('m_n').value.trim(),a=parseFloat($('m_a').value);
  if(!n||!a) return toast('Preencha nome e valor alvo');
  if(await inserir('metas',{nome:n,alvo:a,guardado:parseFloat($('m_g').value)||0}))
    {render();toast('Meta adicionada');}
};

/* =====================================================================
   PROJEÇÕES CASA — aba dedicada
   ===================================================================== */
let CASA_MES = null;   // mês em que a casa passaria a pesar
function vCasa(){
  const ini = CASA_MES || addM(ym(hoje()),1);
  const itens = D.casa_itens.slice().sort((a,b)=>(a.ordem||0)-(b.ordem||0));
  const total = totCasa();
  const semCasa = fluxo(12,null,ini);
  const comCasa = fluxoCasa(12,null,ini);
  const negativos = comCasa.filter(x=>x.sal<0);
  const pior = comCasa.reduce((a,b)=>b.sal<a.sal?b:a, comCasa[0]);
  const maxPct = Math.max(...comCasa.map(x=>x.pct));
  const vd = negativos.length?'bad':(maxPct>0.85?'warn':'ok');
  const txt = negativos.length
    ? `Com estes valores, ${negativos.length} ${negativos.length===1?'mês fica negativo':'meses ficam negativos'} (${negativos.slice(0,4).map(x=>mLabel(x.k)).join(', ')}${negativos.length>4?'…':''}). O orçamento não comporta.`
    : maxPct>0.85
      ? `Cabe, mas aperta: no pior mês (${mLabel(pior.k)}) sobram ${BRL(pior.sal)} e o comprometimento chega a ${PCT(maxPct)}.`
      : `Cabe. No pior mês (${mLabel(pior.k)}) ainda sobram ${BRL(pior.sal)}, com ${PCT(maxPct)} da renda comprometida.`;

  if(FALTANDO.includes('casa_itens'))
    return head('Projeções Casa','Esta aba precisa de uma tabela que ainda não existe no seu banco.');
  return head('Projeções Casa','Suas contas de hoje e como ficariam assumindo a casa. Nada aqui afeta o painel nem a projeção geral.')
  +`<div class="kpis">
    ${kpi('Custo da casa por mês',BRL(total),itens.filter(i=>i.ativo).length+' itens')}
    ${kpi('Sobra hoje',BRL(semCasa[0].sal),'sem a casa','pos')}
    ${kpi('Sobra com a casa',BRL(comCasa[0].sal),'em '+mLabel(ini),comCasa[0].sal<0?'neg':'pos')}
    ${kpi('Comprometimento',PCT(comCasa[0].pct),'era '+PCT(semCasa[0].pct),comCasa[0].pct>0.85?'neg':'amb')}
  </div>

  <div class="verdict ${vd}" style="border:1px solid var(--rule);border-radius:3px;margin-bottom:18px">${txt}</div>

  <div class="grid2">
    <div class="panel"><h2>Itens da casa <small>edite à vontade</small></h2>
      <div class="tw"><table><thead><tr><th class="c">Ativo</th><th>Item</th><th class="r">Valor</th><th></th></tr></thead><tbody>
      ${itens.map(i=>`<tr class="${i.ativo?'':'dim'}">
        <td class="c"><input type="checkbox" ${i.ativo?'checked':''} style="width:auto;cursor:pointer"
          onchange="setRow('casa_itens','${i.id}','ativo',this.checked)"></td>
        <td><input value="${esc(i.descricao)}" style="border-color:transparent;padding:3px 5px"
          onchange="setRow('casa_itens','${i.id}','descricao',this.value)"></td>
        <td class="r"><input type="number" step="10" value="${i.valor}"
          style="width:110px;padding:3px 5px;text-align:right;border-color:transparent"
          onchange="setRow('casa_itens','${i.id}','valor',+this.value)"></td>
        <td class="r"><button class="btn dgr" onclick="delRow('casa_itens','${i.id}')">excluir</button></td></tr>`).join('')
        ||'<tr><td colspan="4" class="note" style="padding:16px;text-align:center">Nenhum item ainda.</td></tr>'}
      </tbody><tfoot><tr><td colspan="2">Total ativo</td><td class="r">${BRL(total)}</td><td></td></tr></tfoot></table></div>
      <div class="pbody"><div class="form">
        <div class="fld" style="grid-column:span 2"><label>Novo item</label>
          <input id="ci_d" placeholder="Ex.: Água, Luz, IPTU, Condomínio"></div>
        <div class="fld"><label>Valor</label><input type="number" step="10" id="ci_v" placeholder="0,00"></div>
        <div class="fld"><label>&nbsp;</label><button class="btn" onclick="addCasaItem()">Adicionar</button></div>
      </div></div>
    </div>

    <div class="panel"><h2>Comparação lado a lado <small>em ${mLabel(ini)}</small></h2><div class="pbody">
      <div class="tw"><table><thead><tr><th></th><th class="r">Hoje</th><th class="r">Com a casa</th><th class="r">Diferença</th></tr></thead><tbody>
      ${[['Renda',semCasa[0].renda,comCasa[0].renda],
         ['Contas fixas',semCasa[0].fix,comCasa[0].fix],
         ['Cartões',semCasa[0].cart,comCasa[0].cart],
         ['Casa',0,total],
         ['Total de saídas',semCasa[0].out,comCasa[0].out],
         ['Sobra',semCasa[0].sal,comCasa[0].sal]].map(([l,a,b])=>{
        const dif=b-a, forte=l==='Sobra'||l==='Total de saídas';
        return `<tr><td${forte?' style="font-weight:600"':''}>${l}</td>
          <td class="r">${BRL(a)}</td>
          <td class="r"${forte?' style="font-weight:600"':''}>${BRL(b)}</td>
          <td class="r" style="color:${dif===0?'var(--muted)':(l==='Sobra'?(dif<0?'var(--neg)':'var(--pos)'):'var(--neg)')}">${dif?(dif>0?'+':'')+BRL(dif):'—'}</td></tr>`;}).join('')}
      </tbody></table></div>
      <div class="fld" style="margin-top:14px;max-width:220px"><label>Simular a partir de</label>
        <select onchange="setCasaMes(this.value)">
          ${horizon(24).map(k=>`<option value="${k}" ${k===ini?'selected':''}>${mLabel(k)}</option>`).join('')}
        </select></div>
      <p class="note" style="margin-top:8px">As parcelas atuais vão caindo com o tempo, então o mês de início muda bastante o resultado.</p>
    </div></div>
  </div>

  <div class="panel"><h2>Mês a mês com a casa <small>a partir de ${mLabel(ini)}</small></h2>
  <div class="tw"><table><thead><tr>
    <th>Mês</th><th class="r">Renda</th><th class="r">Fixas</th><th class="r">Cartões</th>
    <th class="r">Casa</th><th class="r">Saídas</th>
    <th class="r">Sobra sem casa</th><th class="r">Sobra com casa</th><th class="r">%</th>
  </tr></thead><tbody>
  ${comCasa.map((x,i)=>`<tr>
    <td><b>${mLabel(x.k)}</b></td>
    <td class="r">${BRL(x.renda)}</td><td class="r">${BRL(x.fix)}</td>
    <td class="r">${BRL(x.cart)}</td>
    <td class="r" style="color:var(--amber)">${BRL(x.casa)}</td>
    <td class="r"><b>${BRL(x.out)}</b></td>
    <td class="r" style="color:var(--muted)">${BRL(semCasa[i].sal)}</td>
    <td class="r" style="font-weight:600;color:${x.sal<0?'var(--neg)':'var(--pos)'}">${BRL(x.sal)}</td>
    <td class="r"><span class="pill ${x.pct>.85?'t-no':x.pct>.7?'t-w':'t-ok'}">${PCT(x.pct)}</span></td>
  </tr>`).join('')}
  </tbody></table></div></div>`;
}
window.setCasaMes=v=>{ CASA_MES=v; render(); };

window.addCasaItem=async()=>{
  const d=$('ci_d').value.trim(), v=parseFloat($('ci_v').value);
  if(!d||!v) return toast('Preencha descrição e valor');
  const ordem=(D.casa_itens.reduce((m,i)=>Math.max(m,i.ordem||0),0))+1;
  if(await inserir('casa_itens',{descricao:d,valor:v,ativo:true,ordem}))
    {render();toast(d+' adicionado ao cenário');}
};

/* =====================================================================
   AMORTIZAÇÃO — plano de pagamento dos financiamentos
   ===================================================================== */
let FIN_SEL=null, FIN_ANTEC=6, FIN_EST='ultimas', FIN_DATA=null;
function vAmort(){
  if(FALTANDO.includes('financiamentos'))
    return head('Amortização','Esta aba precisa de uma tabela que ainda não existe no seu banco.');
  const fins=D.financiamentos.filter(f=>f.ativo);
  if(!fins.length)
    return head('Amortização','Nenhum financiamento cadastrado.')
      +`<div class="info">Rode <b>migracao-financiamento.sql</b> para carregar o contrato do carro,
        ou cadastre um financiamento no banco.</div>`;
  const f = fins.find(x=>x.id===FIN_SEL) || fins[0];
  const R = resumoFin(f);
  const fmtD = d => d ? String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+d.getFullYear() : '—';
  const P = anteciparPlano(f,{n:FIN_ANTEC,estrategia:FIN_EST,data:FIN_DATA});
  const pctPago = R.pagas/(+f.total_parcelas);

  return head('Amortização','Como a dívida se comporta ao longo do contrato e quanto custa antecipar.')
  +(fins.length>1?`<div class="rowbar"><div class="fld" style="max-width:220px"><label>Financiamento</label>
    <select onchange="setFin(this.value)">${fins.map(x=>
      `<option value="${x.id}" ${x.id===f.id?'selected':''}>${esc(x.descricao)}</option>`).join('')}</select>
    </div></div>`:'')
  +`<div class="kpis">
    ${kpi('Saldo devedor hoje',BRL(R.saldo),'valor para quitar','amb')}
    ${kpi('Se pagar tudo até o fim',BRL(R.nominal),R.restantes+' parcelas de '+BRL(f.valor_parcela))}
    ${kpi('Economia ao quitar agora',BRL(R.economiaQuitar),'juros que deixam de correr','pos')}
    ${kpi('Parcelas pagas',R.pagas+' de '+f.total_parcelas,'última em '+fmtD(R.ultima))}
  </div>

  <div class="panel"><h2>Progresso do contrato</h2><div class="pbody">
    <div class="bar" style="grid-template-columns:110px 1fr 90px;margin-bottom:14px">
      <span>Quitado</span>
      <span class="track" style="height:22px"><span class="fill" style="width:${pctPago*100}%;background:var(--pos)"></span></span>
      <span class="r" style="font-weight:600">${PCT(pctPago)}</span>
    </div>
    <div class="tw"><table class="mini"><tbody>
      <tr><td>Credor</td><td class="r">${esc(f.credor||'—')} · contrato ${esc(f.contrato||'—')}</td></tr>
      <tr><td>Bem</td><td class="r">${esc(f.bem||'—')}</td></tr>
      <tr><td>Valor do bem / entrada</td><td class="r">${BRL(f.valor_bem)} · entrada ${BRL(f.entrada)}</td></tr>
      <tr><td>Financiado</td><td class="r">${BRL(f.valor_financiado)}</td></tr>
      <tr><td>Taxa de juros</td><td class="r">${(taxaEfetiva(f)*100).toFixed(4).replace('.',',')}% a.m.
        <span class="note">contrato informa ${(+f.taxa_mensal*100).toFixed(2).replace('.',',')}%</span>${
        f.cet_mensal?'<br><span class="note">CET '+(+f.cet_mensal*100).toFixed(2).replace('.',',')+'% a.m.</span>':''}</td></tr>
      <tr><td>Total do contrato</td><td class="r"><b>${BRL(R.totalContrato)}</b>
        <span class="note">(${BRL(R.totalContrato-(+f.valor_financiado))} de juros)</span></td></tr>
      <tr><td>Juros já pagos</td><td class="r">${BRL(R.jurosPagos)}</td></tr>
      <tr><td>Juros ainda a pagar</td><td class="r" style="color:var(--amber)">${BRL(R.jurosFuturos)}</td></tr>
    </tbody></table></div>
    ${f.observacao?`<p class="note" style="margin-top:10px">${esc(f.observacao)}</p>`:''}
  </div></div>

  <div class="panel"><h2>Simular antecipação <small>nada é gravado; é só simulação</small></h2>
    <div class="pbody">
      <div class="form" style="margin-bottom:14px">
        <div class="fld"><label>Quantas parcelas</label>
          <input type="number" min="0" max="${R.restantes}" value="${FIN_ANTEC}" oninput="setAntec(+this.value)">
        </div>
        <div class="fld"><label>Quais</label>
          <div class="seg">
            <button class="segb" aria-pressed="${FIN_EST==='ultimas'}" onclick="setEst('ultimas')">Últimas</button>
            <button class="segb" aria-pressed="${FIN_EST==='proximas'}" onclick="setEst('proximas')">Próximas</button>
            <button class="segb" aria-pressed="${FIN_EST==='ambas'}" onclick="setEst('ambas')">Ambas</button>
          </div>
        </div>
        <div class="fld"><label>Dia do pagamento</label>
          <input type="date" value="${P.pagamento.toISOString().slice(0,10)}" onchange="setFinData(this.value)">
        </div>
      </div>
      <div class="qbtns" style="margin-bottom:14px">${[1,3,6,12,R.restantes].map(x=>
        `<button class="qbtn" aria-pressed="${FIN_ANTEC===x}" onclick="setAntec(${x})">${x===R.restantes?'quitar tudo':x+'x'}</button>`).join('')}</div>

      <div class="verdict ${P.economia>0?'ok':'warn'}" style="border:1px solid var(--rule);border-radius:3px;margin-bottom:14px">
        ${P.n===0?'Escolha quantas parcelas quer antecipar.'
        :`Antecipando ${P.n} ${P.n===1?'parcela':'parcelas'} ${
          FIN_EST==='ultimas'?'do fim':FIN_EST==='proximas'?'mais próximas':'das duas pontas'},
          você paga <b>${BRL(P.custo)}</b> em vez de ${BRL(P.nominal)} — economia de <b>${BRL(P.economia)}</b>.
          ${P.qtdRestante?`Sobram ${P.qtdRestante} parcelas, até ${fmtD(P.novaUltima)}.`:'O contrato fica quitado.'}`}
      </div>

      <div class="tw"><table class="mini"><tbody>
        <tr><td>Se pagar no vencimento</td><td class="r">${BRL(P.nominal)}</td></tr>
        <tr><td>Pagando em ${fmtD(P.pagamento)}</td><td class="r"><b>${BRL(P.custo)}</b></td></tr>
        <tr><td><b>Economia</b></td><td class="r"><b style="color:var(--pos)">${BRL(P.economia)}</b></td></tr>
        <tr><td>Desconto médio por parcela</td><td class="r">${P.n?BRL(P.economia/P.n):'—'}</td></tr>
        <tr><td>Parcelas que sobram</td><td class="r">${P.qtdRestante}</td></tr>
        <tr><td>Contrato termina em</td><td class="r">${P.novaUltima?fmtD(P.novaUltima):'quitado'}</td></tr>
      </tbody></table></div>

      ${P.itens.length?`<details class="mini-det" style="margin-top:10px"><summary>
        <span>Ver as ${P.n} parcelas escolhidas</span><b>${BRL(P.custo)}</b></summary>
        <div class="tw"><table class="mini"><thead><tr>
          <th class="c">Nº</th><th>Vence</th><th class="r">Faltam</th>
          <th class="r">Valor hoje</th><th class="r">Desconto</th></tr></thead><tbody>
        ${P.itens.map(x=>`<tr><td class="c">${x.k}</td><td class="mono">${fmtD(x.venc)}</td>
          <td class="r">${x.dias} dias</td><td class="r">${BRL(x.vp)}</td>
          <td class="r" style="color:var(--pos)">${BRL(x.desconto)}</td></tr>`).join('')}
        </tbody></table></div></details>`:''}

      <p class="note" style="margin-top:10px">Antecipar as <b>últimas</b> economiza mais, porque são as que
      carregam mais juros. Antecipar as <b>próximas</b> economiza menos, mas alivia o caixa dos meses seguintes —
      veja a diferença na tabela abaixo. O desconto é calculado a valor presente pela taxa do contrato;
      o valor exato do banco pode variar alguns centavos.</p>
    </div></div>

  <div class="panel"><h2>Impacto no orçamento <small>próximos 12 meses</small></h2>
    <div class="tw"><table><thead><tr>
      <th>Mês</th><th class="r">Renda</th><th class="r">Saídas hoje</th><th class="r">Sobra hoje</th>
      <th class="r">Parcela do carro</th><th class="r">Sobra se antecipar</th><th class="r">Diferença</th>
    </tr></thead><tbody>
    ${fluxo(12,null,MREF).map(x=>{
      const liberou = P.mesesLiberados.has(x.k);
      const parc = (() => {
        const l=R.linhas.find(l=>!l.paga && ym(l.venc.toISOString().slice(0,10))===x.k);
        return l ? +f.valor_parcela : 0;
      })();
      const depois = x.sal + (liberou?parc:0);
      return `<tr><td><b>${mLabel(x.k)}</b></td>
        <td class="r">${BRL(x.renda)}</td>
        <td class="r">${BRL(x.out)}</td>
        <td class="r" style="color:${x.sal<0?'var(--neg)':'var(--muted)'}">${BRL(x.sal)}</td>
        <td class="r">${parc?BRL(parc):'—'}${liberou?' <span class="tag t-ok">antecipada</span>':''}</td>
        <td class="r" style="font-weight:600;color:${depois<0?'var(--neg)':'var(--pos)'}">${BRL(depois)}</td>
        <td class="r" style="color:${liberou?'var(--pos)':'var(--muted)'}">${liberou?'+'+BRL(parc):'—'}</td>
      </tr>`;}).join('')}
    </tbody></table></div>
    <div class="pbody"><p class="note">A coluna "sobra se antecipar" mostra os meses em que a parcela deixa
    de sair, porque já foi paga na simulação. Note que o dinheiro para antecipar (${BRL(P.custo)}) sai
    de uma vez, no dia escolhido — isso não está descontado desta tabela.</p></div>
  </div>

  <div class="panel"><h2>Tabela de amortização <small>parcela a parcela</small></h2>
  <div class="tw"><table><thead><tr>
    <th class="c">Nº</th><th>Vencimento</th><th class="r">Saldo antes</th>
    <th class="r">Juros</th><th class="r">Amortiza</th><th class="r">Saldo depois</th><th class="c">Status</th>
  </tr></thead><tbody>
  ${R.linhas.map(l=>`<tr class="${l.paga?'dim':''}">
    <td class="c">${l.k}</td>
    <td class="mono">${fmtD(l.venc)}</td>
    <td class="r">${BRL(l.ini)}</td>
    <td class="r" style="color:var(--neg)">${BRL(l.juros)}</td>
    <td class="r" style="color:var(--pos)">${BRL(l.amort)}</td>
    <td class="r"><b>${BRL(l.fim)}</b></td>
    <td class="c"><span class="tag ${l.paga?'t-ok':(l.k===R.pagas+1?'t-w':'t-g')}">${
      l.paga?'paga':(l.k===R.pagas+1?'próxima':'a vencer')}</span></td>
  </tr>`).join('')}
  </tbody></table></div></div>`;
}
window.setFin=v=>{ FIN_SEL=v; render(); };
window.setAntec=v=>{ FIN_ANTEC=Math.max(0,v||0); render(); };
window.setEst=v=>{ FIN_EST=v; render(); };
window.setFinData=v=>{ FIN_DATA=v||null; render(); };

/* =====================================================================
   SHELL E INICIALIZAÇÃO
   ===================================================================== */
const VIEWS={painel:vPainel,compra:vCompra,lanc:vLanc,parc:vParc,assin:vAssin,
             terc:vTerc,proj:vProj,amort:vAmort,casa:vCasa,cad:vCad,metas:vMetas};

function render(){
  const m=$('main'); if(!m) return montarShell();
  m.innerHTML=(VIEWS[CUR]||vPainel)();
  document.querySelectorAll('#nav button').forEach(b=>
    b.setAttribute('aria-current', b.dataset.p===CUR));
}
window.go=id=>{CUR=id;render();window.scrollTo(0,0);};

function montarShell(){
  $('root').innerHTML=`<div class="shell">
    <aside class="rail">
      <div class="brand"><b>Financeiro</b><span>${esc(EU||'')}</span></div>
      <nav id="nav">${PAGES.map(([id,l])=>
        `<button data-p="${id}" onclick="go('${id}')" aria-current="${CUR===id}">${l}</button>`).join('')}</nav>
      <div class="sync"><span class="dot ${SYNC}" id="syncdot"></span><span id="synctxt">Sincronizado</span>
        <span style="margin-left:auto;opacity:.55">${APP_VER}</span></div>
      <div class="railfoot">
        <button onclick="exportar()">Exportar backup</button>
        <button onclick="sair()">Sair</button>
      </div>
    </aside>
    <main class="main" id="main"></main></div>`;
  render();
}
window.sair=sair;
window.exportar=()=>{
  const blob=new Blob([JSON.stringify({exportado_em:new Date().toISOString(),grupo:GRUPO,dados:D},null,2)],
    {type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='financeiro-'+hoje()+'.json';
  a.click(); URL.revokeObjectURL(a.href);
  toast('Backup baixado — pode subir no Git');
};

async function iniciar(){
  const {data:{user}} = await sb.auth.getUser();
  if(!user) return telaLogin();
  USER=user;
  const {data:m,error} = await sb.from('membros').select('grupo_id,nome').limit(1).maybeSingle();
  if(error) return telaLogin('Erro ao buscar seu grupo: '+error.message);
  if(!m) return telaLogin('Sua conta existe, mas não está em nenhum grupo. Peça um código de convite.');
  GRUPO=m.grupo_id; EU=m.nome;
  try{ await carregarTudo(); }
  catch(e){ return telaLogin('Não consegui carregar os dados: '+e.message); }
  montarShell();
  ligarTempoReal();
}

if('serviceWorker' in navigator)
  window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));

sb.auth.onAuthStateChange((ev)=>{ if(ev==='SIGNED_OUT'){USER=null;GRUPO=null;telaLogin();} });
iniciar();
