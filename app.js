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

const APP_VER='v52';

/* =====================================================================
   ESTADO
   ===================================================================== */
const TABELAS = ['rendas','fixas','beneficios','cartoes','parcelamentos',
                 'assinaturas','lancamentos','terceiros','metas','casa_itens','financiamentos','agenda','snapshots','ciclos','auditoria'];
let USER=null, GRUPO=null, EU=null;
let D = {rendas:[],fixas:[],beneficios:[],cartoes:[],parcelamentos:[],
         assinaturas:[],lancamentos:[],terceiros:[],metas:[],casa_itens:[],financiamentos:[],agenda:[],snapshots:[],ciclos:[],auditoria:[],config:null};
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
const totAssin = (k) => D.assinaturas.filter(a=>a.projetar)
  .reduce((s,a)=>s + (+a.valor) * (k ? vezesAssinatura(a,k) : 1), 0);
const totVA    = () => D.beneficios.filter(b=>b.ativo).reduce((s,b)=>s+ +b.valor,0);
const saldoParc= () => D.parcelamentos.reduce((s,p)=>s+ +p.valor_parcela*p.restantes,0);
const aReceber = () => D.terceiros.filter(t=>!t.recebido).reduce((s,t)=>s+ +t.valor,0);
const recebido = () => D.terceiros.filter(t=> t.recebido).reduce((s,t)=>s+ +t.valor,0);
const cfg = () => D.config || {reserva_atual:0,aporte_mensal:0,
                               saldo_conferido:null,saldo_conferido_em:null};

/* ---- Saldo em conta ----
   Parte de um ponto de conferência (saldo que você viu no extrato, e quando)
   e soma tudo que foi lançado depois. Benefícios ficam fora: VA não é dinheiro
   na conta. Reports entra, porque é dinheiro que passa pela conta de verdade,
   mas fica destacado para não ser confundido com sobra. */
function saldoConta(){
  const c=cfg();
  const base = c.saldo_conferido==null ? null : +c.saldo_conferido;
  const desde = c.saldo_conferido_em || null;
  /* Saldo é extrato, não previsão: só entra o que já aconteceu e foi confirmado.
     Lançamento com data futura ou status Projetado fica de fora. */
  const ate = hoje();
  const depois = D.lancamentos.filter(l=>
    !l.beneficio &&
    l.status!=='Projetado' &&
    String(l.data) <= ate &&
    (!desde || String(l.data)>desde));
  const ent = depois.filter(l=>l.tipo==='Entrada').reduce((s,l)=>s+ +l.valor,0);
  const sai = depois.filter(l=>l.tipo==='Saída').reduce((s,l)=>s+ +l.valor,0);
  const rep = depois.filter(l=>l.protegido)
    .reduce((s,l)=>s+(l.tipo==='Entrada'? +l.valor : -(+l.valor)),0);
  return {base, desde, ent, sai, mov:ent-sai,
          atual: base==null?null:base+ent-sai,
          protegido: rep, n: depois.length,
          disponivel: base==null?null:base+ent-sai-Math.max(0,rep)};
}

/* parcelas devidas num mês, a partir da primeira fatura de cada dívida */
/* Em que meses esta parcela cai. Normalmente é mensal e consecutiva a partir
   da primeira fatura — mas o cartão às vezes pula um mês, e aí a lista real
   fica guardada em `competencias`. */
function mesesDaParcela(p){
  if(Array.isArray(p.competencias) && p.competencias.length)
    return p.competencias.slice(0, p.restantes);
  const ini=p.primeira_fatura?ym(p.primeira_fatura):ym(hoje());
  return Array.from({length:+p.restantes||0},(_,i)=>addM(ini,i));
}
const parcelaCaiEm=(p,k)=>mesesDaParcela(p).includes(k);

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
  /* Entrada num cartão é crédito: estorno, devolução, cashback. Ela abate a
     fatura em vez de virar receita. Por isso o valor é a soma das saídas menos
     a das entradas. */
  const ls=D.lancamentos.filter(l=>
    ym(l.data)===k && !l.protegido &&
    (l.cartao||'')===nome &&
    (l.categoria==='Cartão' || /fatura|estorno/i.test(l.descricao||'')));
  if(!ls.length) return null;
  const valor = ls.reduce((s,l)=> s + (l.tipo==='Entrada' ? -(+l.valor) : +l.valor), 0);
  return {valor, itens: ls,
          creditos: ls.filter(l=>l.tipo==='Entrada'),
          debitos:  ls.filter(l=>l.tipo!=='Entrada')};
}

/* ---- Ciclo de fatura: a janela que ela cobre ----
   A fatura de um mês cobre o período entre o fechamento anterior e o dela.
   Como as datas de fechamento variam, uma assinatura mensal pode cair duas
   vezes no mesmo ciclo — ou nenhuma. Foi o que aconteceu com a academia:
   a fatura de setembro do BB Elo pegou os débitos de 25/07 e de 25/08. */
const cicloDe = (cartao,k) => D.ciclos.find(c=>c.cartao===cartao && c.competencia===k) || null;

function janelaFatura(cartao,k){
  const c=cicloDe(cartao,k);
  if(!c) return null;
  const ant=cicloDe(cartao,addM(k,-1));
  if(ant) return {ini:ant.fecha, fim:c.fecha};
  /* sem o ciclo anterior, assume um mês antes do fechamento atual */
  const f=new Date(c.fecha+'T12:00:00'); f.setMonth(f.getMonth()-1);
  return {ini:f.toISOString().slice(0,10), fim:c.fecha, estimada:true};
}

/* Quantas vezes o dia X aparece dentro de (ini, fim] */
function vezesNoPeriodo(dia, ini, fim){
  if(!dia) return 1;
  let n=0;
  const a=new Date(ini+'T12:00:00'), b=new Date(fim+'T12:00:00');
  const d=new Date(a.getFullYear(), a.getMonth(), 1);
  while(d <= b){
    const ult=new Date(d.getFullYear(), d.getMonth()+1, 0).getDate();
    const cob=new Date(d.getFullYear(), d.getMonth(), Math.min(dia,ult), 12);
    if(cob > a && cob <= b) n++;
    d.setMonth(d.getMonth()+1);
  }
  return n;
}

/* Quantas cobranças desta assinatura entram na fatura do mês k */
function vezesAssinatura(a, k){
  const j=janelaFatura(a.cartao,k);
  if(!j) return 1;                       // sem ciclo cadastrado: comportamento antigo
  return vezesNoPeriodo(+a.dia, j.ini, j.fim);
}

/* Fatura calculada: parcelas devidas + assinaturas projetadas do cartão. */
function faturaCalculada(nome, k, extra){
  let t=0;
  const conta=p=>{
    if((p.cartao||'')!==nome) return;
    if(parcelaCaiEm(p,k)) t+= +p.valor_parcela;
  };
  D.parcelamentos.forEach(conta);
  if(extra) conta(extra);
  D.assinaturas.forEach(a=>{ if(a.projetar && (a.cartao||'')===nome)
    t += (+a.valor) * vezesAssinatura(a,k); });
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
    const av=avulsosDoMes(k);
    const avIn =av.filter(l=>l.tipo==='Entrada').reduce((s,l)=>s+ +l.valor,0);
    const avOut=av.filter(l=>l.tipo==='Saída').reduce((s,l)=>s+ +l.valor,0);
    const renda=totRenda(k)+avIn, fix=totFixas()+avOut, cart=totFaturas(k,extra);
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
    const av=avulsosDoMes(k);
    const avIn =av.filter(l=>l.tipo==='Entrada').reduce((s,l)=>s+ +l.valor,0);
    const avOut=av.filter(l=>l.tipo==='Saída').reduce((s,l)=>s+ +l.valor,0);
    const renda=totRenda(k)+avIn, fix=totFixas()+avOut, cart=totFaturas(k,extra), casa=totCasa();
    const out=fix+cart+casa, sal=renda-out; acc+=sal;
    return {k,renda,fix,cart,casa,par:parcelasMes(k,extra),ass:totAssin(),
            out,sal,acc,pct:renda?out/renda:0};
  });
}

/* ---- Eventos do calendário ----
   Os financeiros são derivados dos cadastros, não gravados: assim nunca
   ficam desatualizados quando você muda um valor ou uma data. */
function eventosDoDia(k, d){
  const data = k+'-'+String(d).padStart(2,'0');
  const ult = d===ultimoDiaDoMes(k);
  const ev=[];
  D.rendas.filter(r=>r.ativo&&!r.protegida).forEach(r=>{
    const dia=Math.min(+r.dia||1, ultimoDiaDoMes(k));
    if(dia===d) ev.push({t:'entrada',txt:r.descricao,v:+r.valor,quem:r.quem});
  });
  D.rendas.filter(r=>r.ativo&&r.protegida&&!(r.encerra_em&&k>=ym(r.encerra_em))).forEach(r=>{
    const dia=Math.min(+r.dia||1, ultimoDiaDoMes(k));
    if(dia===d) ev.push({t:'protegido',txt:r.descricao,v:+r.valor});
  });
  D.beneficios.filter(b=>b.ativo).forEach(b=>{
    const dia=Math.min(+b.dia||1, ultimoDiaDoMes(k));
    if(dia===d) ev.push({t:'beneficio',txt:b.descricao,v:+b.valor,quem:b.quem});
  });
  D.fixas.filter(f=>f.ativo).forEach(f=>{
    const dia=Math.min(+f.dia||1, ultimoDiaDoMes(k));
    if(dia===d) ev.push({t:'saida',txt:f.descricao,v:+f.valor});
  });
  D.cartoes.filter(c=>c.ativo&&+c.dia_venc===d).forEach(c=>{
    const v=faturaCartao(c.nome,k);
    if(v>0) ev.push({t:'fatura',txt:'Fatura '+c.nome,v,cartao:c.nome});
  });
  if(ult){
    D.cartoes.filter(c=>c.ativo&&+c.dia_venc===1).forEach(c=>{
      const v=faturaCartao(c.nome,addM(k,1));
      if(v>0) ev.push({t:'reserva',txt:'Reservar p/ fatura '+c.nome,v});
    });
  }
  D.agenda.filter(a=>a.data===data).forEach(a=>
    ev.push({t:a.tipo,txt:a.titulo,v:a.valor?+a.valor:null,id:a.id,
             feito:a.concluido,obs:a.observacao,quem:a.quem}));
  D.lancamentos.filter(l=>l.data===data).forEach(l=>
    ev.push({t:'lancado',txt:l.descricao,v:+l.valor,
             entrada:l.tipo==='Entrada',id:l.id}));
  return ev;
}

/* ---- Ligação entre o previsto (blocos) e o realizado (lançamentos) ---- */
const MARCA_PAINEL='Marcado no painel a partir do previsto';
const veioDoPainel = l => (l.observacao||'')===MARCA_PAINEL;
const ultimoDiaDoMes = k => new Date(+k.slice(0,4), +k.slice(5,7), 0).getDate();
/* Data em que o dinheiro sai de fato. Na reserva de fatura que vence dia 1,
   o pagamento acontece no último dia do mês anterior. */
function dataEfetiva(it, k, dia){
  if(it.tipo==='reserva') return k+'-'+String(ultimoDiaDoMes(k)).padStart(2,'0');
  return dataDoItem(it,k,dia);
}
function dataDoItem(it, k, dia){
  if(it.tipo==='reserva') return it.competencia+'-01';
  const d=Math.min(dia, ultimoDiaDoMes(k));
  return k+'-'+String(d).padStart(2,'0');
}
/* Qualquer lançamento ligado ao item — confirmado ou ainda previsto. */
function lancRelacionado(it, k){
  if(it.tipo==='avulso'){
    const l=D.lancamentos.find(x=>x.id===it.lancId);
    return l ? {valor:+l.valor, itens:[l]} : null;
  }
  if(it.tipo==='cartao')  return faturaLancada(it.cartao, k);
  if(it.tipo==='reserva') return faturaLancada(it.cartao, it.competencia);
  const ls = D.lancamentos.filter(x=>mesDeCaixa(x)===k && x.descricao===it.desc
                                     && (x.tipo===(it.tipo==='renda'?'Entrada':'Saída')));
  return ls.length ? {valor:ls.reduce((s,l)=>s+ +l.valor,0), itens:ls} : null;
}
/* O item já ACONTECEU?
   Vale se você marcou aqui no painel — mesmo adiantado, pagar antes é pagar.
   Vindo de outra origem (carga inicial, importação), só vale se a data já
   passou: algo lançado para o mês que vem não pode ter sido pago. */
const confirmado = l => l.status==='Confirmado' &&
  (veioDoPainel(l) || String(l.data) <= hoje());
function lancDoItem(it, k){
  const r = lancRelacionado(it,k);
  if(!r) return null;
  const feitos = r.itens.filter(confirmado);
  return feitos.length ? {valor:feitos.reduce((s,l)=>s+ +l.valor,0), itens:feitos} : null;
}
function montaLanc(it, k, dia){
  return {data: dataDoItem(it,k,dia),
          descricao: it.desc,
          categoria: it.categoria||'Outros',
          tipo: it.tipo==='renda' ? 'Entrada' : 'Saída',
          quem: it.quem||'Casal',
          cartao: it.cartao||null,
          valor: +it.valor,
          status: 'Confirmado',
          protegido: false, beneficio: false,
          observacao: MARCA_PAINEL,
          criado_por: USER?.id||null};
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
  /* quantas antecipar de cada ponta, sem deixar as duas se sobreporem */
  let prox=Math.max(0, Math.min(+opt.prox||0, pend.length));
  let ult =Math.max(0, Math.min(+opt.ult ||0, pend.length-prox));
  const sel=[...pend.slice(0,prox), ...(ult?pend.slice(-ult):[])];
  const N=sel.length;

  const pagamento = opt.data ? new Date(opt.data+'T12:00:00') : new Date();
  const diaria = Math.pow(1+i, 1/30)-1;
  let custo=0;
  const itens = sel.map(l=>{
    const dias = Math.max(0, Math.round((l.venc-pagamento)/86400000));
    const vp = PMT/Math.pow(1+diaria, dias);
    custo += vp;
    return {k:l.k, venc:l.venc, dias, vp, desconto:PMT-vp,
            ponta: prox && l.k<=pend[prox-1]?.k ? 'próxima' : 'última'};
  });
  const escolhidas=new Set(sel.map(l=>l.k));
  const restantes = pend.filter(l=>!escolhidas.has(l.k));
  return {n:N, prox, ult, itens, custo, nominal:PMT*N, economia:PMT*N-custo,
          pagamento, restantes,
          novaUltima: restantes.length?restantes[restantes.length-1].venc:null,
          qtdRestante: restantes.length,
          maxPend: pend.length,
          mesesLiberados: new Set(sel.map(l=>ym(l.venc.toISOString().slice(0,10))))};
}

const anteciparN=(f,N)=>{
  const p=anteciparPlano(f,{prox:0,ult:N});
  return {n:p.n, custoHoje:p.custo, nominal:p.nominal, economia:p.economia, novaUltima:p.novaUltima};
};

/* ---- Fluxo por dia de pagamento ---- */
/* ---- Fluxo por dia de pagamento ---- */
/* Lançamentos que não correspondem a nenhum cadastro — compra combinada
   para pagar dia 20, fiado na mercearia, um extra que caiu. Eles existem só
   como lançamento, e por isso não apareciam no fluxo por data nem na conta
   do mês. Aqui eles entram. */
function avulsosDoMes(k){
  const nomesFixas = new Set(D.fixas.filter(f=>f.ativo).map(f=>f.descricao));
  const nomesRendas = new Set(D.rendas.filter(r=>r.ativo).map(r=>r.descricao));
  const cartoesAtivos = new Set(D.cartoes.filter(c=>c.ativo).map(c=>c.nome));
  return D.lancamentos.filter(l=>{
    if(mesDeCaixa(l)!==k) return false;
    if(l.beneficio || l.protegido) return false;          // VA e Reports têm lugar próprio
    if(l.categoria==='Cartão' && cartoesAtivos.has(l.cartao)) return false;  // é a fatura
    if(l.tipo==='Saída'   && nomesFixas.has(l.descricao))  return false;     // é conta fixa
    if(l.tipo==='Entrada' && nomesRendas.has(l.descricao)) return false;     // é renda
    return true;
  });
}

function blocosDoMes(k){
  const cartoes = D.cartoes.length?D.cartoes:[];
  const dias = new Set();
  D.rendas.filter(r=>r.ativo&&!r.protegida).forEach(r=>dias.add(+r.dia||1));
  D.fixas.filter(f=>f.ativo).forEach(f=>dias.add(+f.dia||1));
  cartoes.forEach(c=>{ if(c.ativo && +c.dia_venc>1) dias.add(+c.dia_venc); });
  const avulsos = avulsosDoMes(k);
  avulsos.forEach(l=>{
    const d=+String(l.data).slice(8,10);
    if(d>1 && d<ultimoDiaDoMes(k)) dias.add(d);
  });
  dias.add(31);
  const ordenados=[...dias].filter(d=>d>1).sort((a,b)=>a-b);

  return ordenados.map(dia=>{
    const ultimo = dia===Math.max(...ordenados);
    const entradas = D.rendas.filter(r=>r.ativo&&!r.protegida&&(+r.dia||1)===dia)
      .map(r=>({desc:r.descricao,valor:+r.valor,quem:r.quem,
                tipo:'renda',categoria:'Salário/Renda'}));
    const saidas = D.fixas.filter(f=>f.ativo&&(+f.dia||1)===dia)
      .map(f=>({desc:f.descricao,valor:+f.valor,tipo:'fixa',
                categoria:f.categoria||'Outros',quem:'Casal'}));
    cartoes.forEach(c=>{
      if(!c.ativo || +c.dia_venc!==dia) return;
      const v=faturaCartao(c.nome,k);
      if(v>0) saidas.push({desc:'Fatura '+c.nome+' — parte casal',valor:v,tipo:'cartao',
                           cartao:c.nome,categoria:'Cartão',quem:'Casal'});
    });
    /* Regra: fatura que vence no dia 1 é paga com o que sobra do último dia do mês anterior. */
    if(ultimo){
      cartoes.forEach(c=>{
        if(!c.ativo || +c.dia_venc!==1) return;
        const prox=addM(k,1);
        const v=faturaCartao(c.nome,prox);
        if(v>0) saidas.push({desc:'Reserva p/ fatura '+c.nome+' (vence 01/'+mLabel(prox).slice(0,2)+')',
                             valor:v,tipo:'reserva',cartao:c.nome,categoria:'Cartão',
                             quem:'Casal',competencia:prox});
      });
    }
    /* avulsos do dia; no último bloco entram também os do fim do mês */
    avulsos.forEach(l=>{
      const d=+String(l.data).slice(8,10);
      const cai = ultimo ? d>=dia || d>=ultimoDiaDoMes(k) : d===dia;
      if(!cai) return;
      const it={desc:l.descricao, valor:+l.valor, tipo:'avulso', lancId:l.id,
                categoria:l.categoria||'Outros', quem:l.quem||'Casal',
                cartao:l.cartao||null, status:l.status, dataReal:l.data};
      (l.tipo==='Entrada'?entradas:saidas).push(it);
    });
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
      ...TABELAS.map(t=>sb.from(t)
        .select(t==='snapshots'?'id,rotulo,automatico,linhas,criado_em':'*')
        .eq('grupo_id',GRUPO)
        .order(t==='auditoria'?'quando':'id',{ascending:false})
        .limit(t==='auditoria'?400:10000)),
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
/* Marcar no painel cria o lançamento; desmarcar apaga. */
window.marcarItem=async(dia,lado,ix)=>{
  const b=blocosDoMes(MREF).find(x=>x.dia===dia);
  if(!b) return;
  const it=(lado==='in'?b.entradas:b.saidas)[ix];
  if(!it) return;
  const rel=lancRelacionado(it,MREF);
  const feito=rel && rel.itens.some(confirmado);
  if(feito){
    /* desmarcar: o que o painel criou some; o que veio de outra origem só
       volta a ser previsão, para não perder o valor real da fatura */
    for(const l of rel.itens.filter(confirmado)){
      /* o painel só apaga o que ele mesmo criou; o resto vira previsão */
      if(veioDoPainel(l) && it.tipo!=='avulso') await remover('lancamentos', l.id);
      else await atualizar('lancamentos', l.id, {status:'Projetado'});
    }
    render(); toast('Desmarcado — voltou a ser previsão');
    return;
  }
  if(rel){
    for(const l of rel.itens) await atualizar('lancamentos', l.id, {status:'Confirmado'});
    render(); toast(it.desc+' confirmado · '+BRL(rel.valor));
    return;
  }
  const criado=await inserir('lancamentos', montaLanc(it,MREF,dia));
  if(criado){ render(); toast(it.desc+' lançado · '+BRL(it.valor)); }

};
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
const PAGES=[['painel','Painel'],['dash','Dashboard'],['compra','Nova compra'],['lanc','Lançamentos'],
  ['parc','Parcelamentos'],['assin','Assinaturas'],['terc','Terceiros'],
  ['cal','Calendário'],['proj','Projeção'],['amort','Amortização'],['casa','Projeções Casa'],
  ['cad','Cadastros'],['metas','Metas'],['backup','Cópias'],['log','Atividade'],['fatura','Fatura']];

/* O menu mostra só o dia a dia. O resto fica agrupado atrás de "Mais",
   e o que é manutenção vai para a engrenagem. */
const MENU_FIXO=['painel','dash','lanc','cal','metas'];
const MENU_MAIS=[
  ['Compromissos',['fatura','parc','assin','terc']],
  ['Análise',     ['proj','amort','casa']],
  ['Simular',     ['compra']]];
const MENU_CONFIG=['cad','backup','log'];
const rotulo=id=>(PAGES.find(p=>p[0]===id)||[,id])[1];
let MENU_ABERTO=null;
let CUR='painel', MREF=ym(hoje()), VISAO=null;  // 'previsto' | 'realizado'

/* qual script resolve cada tabela que pode estar faltando */
const MIGRACAO_DE = {
  casa_itens:'migracao-casa.sql', financiamentos:'migracao-financiamento.sql',
  agenda:'migracao-agenda.sql', snapshots:'migracao-backup.sql',
  ciclos:'migracao-ciclos.sql', auditoria:'migracao-auditoria.sql',
};
function head(t,p){
  /* Tabelas que têm migração própria (casa, financiamento, agenda, cópias,
     ciclos, atividade) já mostram o aviso certo na aba que realmente precisa
     delas — cada uma checa FALTANDO.includes('sua_tabela') no próprio corpo.
     Aqui, no cabeçalho comum a toda tela, só avisa de tabelas SEM esse
     tratamento próprio — senão faltar 'auditoria' faria até o Painel, que
     não usa auditoria pra nada, mostrar um aviso sobre ela. */
  const faltandoGeral = FALTANDO.filter(t=>!MIGRACAO_DE[t]);
  return `<div class="phead"><h1>${t}</h1><p>${p}</p></div>`
  +(faltandoGeral.length?`<div class="warn" style="margin-bottom:16px"><b>Banco desatualizado.</b>
     ${faltandoGeral.length===1?'A tabela':'As tabelas'} <b>${faltandoGeral.join(', ')}</b>
     ${faltandoGeral.length===1?'ainda não existe':'ainda não existem'} no Supabase.
     Rode <b>schema.sql</b> no SQL Editor e recarregue. Até lá, esta parte fica vazia.</div>`:'');}
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

  ${(()=>{
    const S=saldoConta();
    const semColuna = D.config && !('saldo_conferido' in D.config);
    const naoConfig = S.base==null;
    const formulario = `
      <div class="form" style="margin-top:4px">
        <div class="fld"><label>Saldo que aparece no banco</label>
          <input type="number" step="0.01" id="sc_v" placeholder="${naoConfig?'0,00':(+S.atual).toFixed(2)}"></div>
        <div class="fld"><label>Data do extrato</label>
          <input type="date" id="sc_d" value="${hoje()}"></div>
        <div class="fld"><label>&nbsp;</label>
          <button class="btn" onclick="conferirSaldo()">${naoConfig?'Começar a acompanhar':'Fixar este saldo'}</button></div>
      </div>`;

    if(naoConfig) return `<div class="panel"><h2>Saldo em conta
      <small>ainda não configurado</small></h2><div class="pbody">
      ${semColuna?`<div class="warn" style="margin-bottom:12px">
        Falta rodar <b>migracao-saldo.sql</b> no Supabase. Sem isso o app não tem onde guardar o saldo.</div>`:''}
      <p class="note" style="margin-bottom:10px">Informe o saldo que está hoje na sua conta.
      A partir daí o app soma e subtrai cada lançamento que você fizer.</p>
      ${formulario}
    </div></div>`;

    return `<div class="panel"><h2>Saldo em conta
      <small>conferido em ${S.desde.split('-').reverse().join('/')} · ${S.n} lançamento${S.n===1?'':'s'} confirmado${S.n===1?'':'s'} desde então</small></h2>
      <div class="pbody">
        <div class="kpis" style="margin-bottom:14px">
          ${kpi('Saldo hoje',BRL(S.atual),'segundo os lançamentos',S.atual<0?'neg':'pos')}
          ${kpi('Entrou desde então','+'+BRL(S.ent))}
          ${kpi('Saiu desde então','−'+BRL(S.sai))}
          ${S.protegido>0?kpi('Disso, é Reports',BRL(S.protegido),'protegido, não é sobra','amb')
                        :kpi('Ponto de conferência',BRL(S.base),'em '+S.desde.split('-').reverse().join('/'))}
        </div>
        <div class="kgroup sub">Conferir com o extrato do banco</div>
        <p class="note" style="margin-bottom:6px">O app calcula <b>${BRL(S.atual)}</b>,
        contando só lançamentos já confirmados e com data até hoje —
        previsão e o que está marcado como Projetado ficam de fora.
        Se o banco mostra outro número, corrija aqui e o app segue deste ponto.</p>
        ${formulario}
      </div></div>`;
  })()}

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
        <span class="dacum ${b.acum<0?'neg':''}">acum. ${BRL(b.acum)}${(()=>{
          const tot=b.entradas.length+b.saidas.length;
          const fei=[...b.entradas,...b.saidas].filter(x=>lancDoItem(x,MREF)).length;
          return tot?` · <span class="tag ${fei===tot?'t-ok':'t-g'}">${fei}/${tot}</span>`:'';
        })()}</span>
      </summary>
      <div class="ddet">
        ${b.entradas.length?`<div class="dcol"><h5>Entra — marque quando receber</h5>
          ${b.entradas.map((e,ix)=>{const L=lancDoItem(e,MREF);
            const venceu=dataEfetiva(e,MREF,b.dia)<=hoje();
            return `
            <div class="dline chk ${L?'feito':''} ${!venceu&&!L?'futuro':''}">
              <span><input type="checkbox" ${L?'checked':''} onchange="marcarItem(${b.dia},'in',${ix})">
                ${esc(e.desc)}${e.quem?` <span class="tag t-g">${esc(e.quem)}</span>`:''}
                ${e.tipo==='avulso'?`<span class="tag t-i">${
                  String(e.dataReal).slice(8,10)+'/'+String(e.dataReal).slice(5,7)}</span>`:''}
                ${L&&Math.abs(L.valor-e.valor)>0.01?`<span class="tag t-w">lançado ${BRL(L.valor)}</span>`:''}</span>
              <b style="color:var(--pos)">${BRL(e.valor)}</b></div>`;}).join('')}</div>`:''}
        ${b.saidas.length?`<div class="dcol"><h5>Sai — marque quando pagar</h5>
          ${b.saidas.map((x,ix)=>{const L=lancDoItem(x,MREF);
            const venceu=dataEfetiva(x,MREF,b.dia)<=hoje();
            return `
            <div class="dline chk ${L?'feito':''} ${!venceu&&!L?'futuro':''}">
              <span><input type="checkbox" ${L?'checked':''} onchange="marcarItem(${b.dia},'out',${ix})">
                ${esc(x.desc)}
                ${x.tipo==='reserva'?'<span class="tag t-w">reserva</span>':''}
                ${x.tipo==='cartao'?'<span class="tag t-i">fatura</span>':''}
                ${x.tipo==='avulso'?`<span class="tag t-g">${
                  String(x.dataReal).slice(8,10)+'/'+String(x.dataReal).slice(5,7)}</span>`:''}
                ${L&&Math.abs(L.valor-x.valor)>0.01?`<span class="tag t-w">lançado ${BRL(L.valor)}</span>`:''}</span>
              <b style="color:var(--neg)">${BRL(x.valor)}</b></div>`;}).join('')}</div>`:''}
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
            ...D.parcelamentos.filter(p=>(p.cartao||'')===n && parcelaCaiEm(p,MREF))
              .map(p=>({d:p.descricao,v:+p.valor_parcela})),
            ...D.assinaturas.filter(a=>a.projetar&&(a.cartao||'')===n).map(a=>{
              const vz=vezesAssinatura(a,MREF);
              return {d:a.descricao+(vz!==1?' — '+vz+' cobranças neste ciclo':''), v:(+a.valor)*vz};
            }).filter(x=>x.v>0)];
          const terc=D.terceiros.filter(t=>t.cartao===n&&!t.recebido)
            .reduce((s,t)=>s+ +t.valor,0);
          const jan=janelaFatura(n,MREF);
          const rep=D.assinaturas.filter(a=>a.projetar&&(a.cartao||'')===n)
            .map(a=>({a, vz:vezesAssinatura(a,MREF)})).filter(x=>x.vz!==1);
          return `<details class="mini-det"><summary><span>${esc(n)}
            <span class="tag ${real?'t-ok':'t-g'}">${real?'lançada':'estimada'}</span>
            ${jan?`<span class="note">fecha ${jan.fim.split('-').reverse().slice(0,2).join('/')}</span>`
                 :(c?`<span class="note">vence dia ${c.dia_venc||'—'}</span>`:'')}
            ${rep.map(x=>`<span class="tag ${x.vz>1?'t-no':'t-w'}">${x.vz}x ${esc(x.a.descricao)}</span>`).join(' ')}</span>
            <b>${BRL(v)}</b></summary>
            <div style="padding:8px 0 10px">
              ${jan?`<p class="note" style="margin-bottom:8px">Ciclo de
                ${jan.ini.split('-').reverse().slice(0,2).join('/')} a
                ${jan.fim.split('-').reverse().slice(0,2).join('/')}${jan.estimada?' (estimado)':''}.
                Assinatura cujo dia de cobrança cai duas vezes nesse intervalo entra em dobro.</p>`:''}
              ${/* o que o app conhece da composição — aparece sempre */''}
              <div class="kgroup sub">O que o app conhece desta fatura</div>
              ${itens.length
                ? itens.map(i=>`<div class="dline"><span>${esc(i.d)}</span><span>${BRL(i.v)}</span></div>`).join('')
                  +`<div class="dline" style="border-top:1px solid var(--rule-soft)">
                     <span><b>Soma do que é conhecido</b></span><b>${BRL(calc)}</b></div>`
                : '<p class="note">Nenhuma parcela nem assinatura cadastrada neste cartão.</p>'}

              ${real ? `
                <div class="kgroup sub" style="margin-top:14px">O valor que você lançou</div>
                ${real.itens.map(l=>`<div class="dline"><span>${esc(l.descricao)}
                   ${l.tipo==='Entrada'?'<span class="tag t-ok">crédito</span>':''}
                   <span class="note">${String(l.data).split('-').reverse().join('/')}${
                     l.status==='Projetado'?' · previsto':''}</span></span>
                   <span><b style="color:${l.tipo==='Entrada'?'var(--pos)':'inherit'}">${
                     l.tipo==='Entrada'?'− ':''}${BRL(l.valor)}</b></span></div>`).join('')}
                ${real.creditos&&real.creditos.length?`<div class="dline">
                   <span class="note">${real.creditos.length} crédito${real.creditos.length===1?'':'s'} abatendo a fatura</span>
                   <span class="note" style="color:var(--pos)">−${BRL(real.creditos.reduce((s,l)=>s+ +l.valor,0))}</span>
                 </div>`:''}
                ${Math.abs(real.valor-calc)>0.01?`<div class="dline">
                  <span class="note">Diferença para o conhecido — compras do dia a dia,
                    encargos, coisas não cadastradas</span>
                  <span class="note" style="color:${real.valor>calc?'var(--neg)':'var(--pos)'}">${
                    (real.valor>calc?'+':'')+BRL(real.valor-calc)}</span></div>`:''}
                <p class="note" style="margin-top:8px">Este é o valor que vale nas contas.
                  Para corrigir, edite o lançamento em <b>Lançamentos</b>.</p>`
              : `<p class="note" style="margin-top:8px">A fatura ainda não foi lançada, então o app usa
                  esta soma como estimativa. Quando você lançar o valor real, ele assume o lugar.</p>`}
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

/* =====================================================================
   FILTRO UNIVERSAL — o mesmo padrão em toda tabela do app.
   Um objeto de estado por tela, e duas funções: desenhar a barra e
   aplicar o filtro numa lista. ===================================================================== */
let FILTROS={};
function filtroDe(tela){ if(!FILTROS[tela]) FILTROS[tela]={busca:'',tipo:'',cat:''}; return FILTROS[tela]; }
window.setFiltro=(tela,campo,v)=>{ filtroDe(tela)[campo]=v; render(); };
window.limparFiltro=(tela)=>{ FILTROS[tela]={busca:'',tipo:'',cat:''}; render(); };

/* opts: {placeholder, tipos:[[valor,rotulo],...], categorias:[...]} — tipos e categorias opcionais */
function barraFiltro(tela, opts){
  const f=filtroDe(tela);
  const ativo = f.busca || f.tipo || f.cat;
  const tipos = opts.tipos||[];
  const cats = opts.categorias||[];
  return `<div class="filtrobar">
    <div class="filtrobusca">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <label for="fb_${tela}" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">Buscar</label>
      <input id="fb_${tela}" type="text" value="${esc(f.busca)}" placeholder="${esc(opts.placeholder||'Buscar…')}"
        oninput="setFiltro('${tela}','busca',this.value)">
    </div>
    <div class="filtrochips">
      ${tipos.length?`<button class="fchip ${!f.tipo?'on':''}" onclick="setFiltro('${tela}','tipo','')">Todos</button>
        ${tipos.map(([v,r])=>`<button class="fchip ${f.tipo===v?'on':''}"
          onclick="setFiltro('${tela}','tipo','${v}')">${esc(r)}</button>`).join('')}`:''}
      ${cats.length?`<select onchange="setFiltro('${tela}','cat',this.value)" style="margin-left:auto">
        <option value="">Categoria</option>
        ${cats.map(c=>`<option ${f.cat===c?'selected':''}>${esc(c)}</option>`).join('')}</select>`:''}
      ${ativo?`<button class="btn dgr" onclick="limparFiltro('${tela}')" style="margin-left:${cats.length?'6px':'auto'}">limpar</button>`:''}
    </div>
  </div>`;
}

/* filtra uma lista de objetos pelas mesmas regras da barra acima */
function aplicaFiltro(tela, lista, campoBusca, campoTipo, campoCat){
  const f=filtroDe(tela);
  const q=f.busca.trim().toLowerCase();
  return lista.filter(item=>{
    if(q){
      const campos=Array.isArray(campoBusca)?campoBusca:[campoBusca];
      if(!campos.some(c=>String(item[c]||'').toLowerCase().includes(q))) return false;
    }
    if(f.tipo && campoTipo && item[campoTipo]!==f.tipo) return false;
    if(f.cat && campoCat && item[campoCat]!==f.cat) return false;
    return true;
  });
}

function vLanc(){
  const doMes=D.lancamentos.filter(l=>ym(l.data)===MREF);
  const cats=[...new Set(doMes.map(l=>l.categoria))].sort();
  const ls=aplicaFiltro('lanc', doMes, 'descricao', 'tipo', 'categoria');
  const r=realizado(MREF);
  return head('Lançamentos','Cada movimento entra aqui e aparece no app da outra em segundos.')
  +`<div class="panel"><h2>Novo lançamento</h2><div class="pbody"><div class="form">
    <div class="fld"><label>Data</label><input type="date" id="l_d" value="${MREF}-01"></div>
    <div class="fld" style="grid-column:span 2"><label>Descrição</label><input id="l_n" placeholder="Ex.: Mercado"></div>
    <div class="fld"><label>Categoria</label><select id="l_c" onchange="render()">${CATS.map(c=>`<option>${c}</option>`).join('')}</select></div>
    <div class="fld"><label>Tipo</label><select id="l_t"><option>Saída</option><option>Entrada</option></select></div>
    <div class="fld"><label>Quem</label><select id="l_q">${['Casal','Maria','Jéssica'].map(q=>`<option>${q}</option>`).join('')}</select></div>
    <div class="fld"><label>Valor</label><input type="number" step="0.01" id="l_v" placeholder="0,00"></div>
    <div class="fld"><label>Cartão${$('l_c')&&$('l_c').value==='Cartão'?' *':''}</label><select id="l_cart">
      <option value="">— nenhum —</option>
      ${D.cartoes.filter(c=>c.ativo).map(c=>`<option>${esc(c.nome)}</option>`).join('')}</select></div>
    <div class="fld"><label>&nbsp;</label><button class="btn" onclick="addLanc()">Adicionar</button></div>
    <div class="fld" style="grid-column:1/-1;padding-top:2px"><button class="btn alt sm" onclick="marcarEstorno()">Foi um estorno no cartão</button><span class="note" style="margin-left:10px">Crédito devolvido pela loja ou pelo banco: abate a fatura daquele mês em vez de virar receita.</span></div>
  </div></div></div>
  <div class="kpis">
    ${kpi('Entradas',BRL(r.ent),'','pos')} ${kpi('Saídas',BRL(r.sai),'','neg')}
    ${kpi('Saldo',BRL(r.sal),'',r.sal<0?'neg':'pos')} ${kpi('Benefícios',BRL(r.va),'fora do saldo','amb')}
  </div>
  <div class="panel"><h2>${mLabel(MREF)} <small>${ls.length} de ${doMes.length} lançamento${doMes.length===1?'':'s'}</small>
    <select style="max-width:140px" onchange="setMes(this.value)">
      ${mesesDisponiveis().map(k=>`<option value="${k}" ${k===MREF?'selected':''}>${mLabel(k)}</option>`).join('')}
    </select></h2>
  <div class="pbody" style="padding-bottom:0">
    ${barraFiltro('lanc', {placeholder:'Buscar por descrição…',
      tipos:[['Entrada','Entradas'],['Saída','Saídas']], categorias:cats})}
  </div>
  <div class="tw"><table><thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th>
    <th>Quem</th><th class="r">Valor</th><th></th></tr></thead><tbody>
  ${ls.map(l=>`<tr class="${l.protegido||l.beneficio?'dim':''}">
    <td class="mono">${String(l.data).split('-').reverse().join('/')}</td>
    <td>${esc(l.descricao)}${l.protegido?' <span class="tag t-g">protegido</span>':''}${l.beneficio?' <span class="tag t-g">benefício</span>':''}${
      mesDeCaixa(l)!==ym(l.data)?` <span class="tag t-w">sai do caixa em ${mLabel(mesDeCaixa(l))}</span>`:''}
    ${l.status==='Projetado'?' <span class="tag t-g">previsto</span>':''}</td>
    <td>${esc(l.categoria)}</td><td>${esc(l.quem)}</td>
    <td class="r" style="font-weight:600;color:${l.tipo==='Entrada'?'var(--pos)':'var(--neg)'}">
      ${l.tipo==='Entrada'?'+':'−'} ${BRL(l.valor)}</td>
    <td class="r"><button class="btn dgr" onclick="delRow('lancamentos','${l.id}')">excluir</button></td></tr>`).join('')
    ||`<tr><td colspan="6" class="note" style="padding:20px;text-align:center">${
      doMes.length?'Nenhum lançamento bate com o filtro.':'Nenhum lançamento neste mês.'}</td></tr>`}
  </tbody></table></div></div>`;
}
/* Atalho para estorno: crédito no cartão que abate a fatura. */
window.marcarEstorno=()=>{
  const t=$('l_t'); if(t) t.value='Entrada';
  const c=$('l_c'); if(c) c.value='Cartão';
  const n=$('l_n'); if(n && !n.value) n.value='Estorno — ';
  render();
  const cart=$('l_cart'); if(cart) cart.focus();
  toast('Escolha o cartão e o valor. O crédito abate a fatura daquele mês.', 4200);
};
window.addLanc=async()=>{
  const d=$('l_d').value,n=$('l_n').value.trim(),v=parseFloat($('l_v').value),
        cat=$('l_c').value, cart=$('l_cart')?.value||null;
  if(!d||!n||!v) return toast('Preencha data, descrição e valor');
  if(cat==='Cartão' && !cart) return toast('Escolha o cartão — senão isso não abate a fatura de ninguém', 4400);
  const ok=await inserir('lancamentos',{data:d,descricao:n,categoria:cat,cartao:cart,
    tipo:$('l_t').value,quem:$('l_q').value,valor:v,status:'Confirmado',criado_por:USER.id});
  if(ok){MREF=ym(d);render();toast(n+' lançado · saldo do mês agora '+BRL(realizado(MREF).sal));}
};
window.delRow=async(t,id)=>{if(await remover(t,id)){render();toast('Excluído');}};

function vParc(){
  const cartoes=[...new Set(D.parcelamentos.map(p=>p.cartao).filter(Boolean))].sort();
  const comStatus=D.parcelamentos.map(p=>({...p, _status:p.restantes>0?'ativa':'quitada'}));
  const lista=aplicaFiltro('parc', comStatus, 'descricao', '_status', 'cartao');
  return head('Parcelamentos','Cada dívida com quantas faltam e quando termina.')
  +`<div class="kpis">
    ${kpi('Saldo devedor',BRL(saldoParc()),'','amb')}
    ${kpi('Parcelas este mês',BRL(parcelasMes(ym(hoje()))))}
    ${kpi('Dívidas ativas',D.parcelamentos.filter(p=>p.restantes>0).length)}
  </div>
  <div class="panel"><h2>Dívidas <small>${lista.length} de ${D.parcelamentos.length} · edite as restantes para corrigir</small></h2>
  <div class="pbody" style="padding-bottom:0">
    ${barraFiltro('parc', {placeholder:'Buscar dívida…',
      tipos:[['ativa','Ativas'],['quitada','Quitadas']], categorias:cartoes})}
  </div>
  <div class="tw"><table><thead><tr><th>Dívida</th><th>Cartão</th><th class="r">Parcela</th>
    <th class="c">Faltam</th><th class="r">Saldo</th><th>Termina</th><th></th></tr></thead><tbody>
  ${lista.map(p=>{
    const meses=mesesDaParcela(p);
    const irregular=Array.isArray(p.competencias)&&p.competencias.length;
    const fim=meses.length?meses[meses.length-1]:null;
    return `<tr><td><b>${esc(p.descricao)}</b>${p.origem==='simulacao_confirmada'?' <span class="tag t-i">simulada</span>':''}
      ${irregular?' <span class="tag t-w">meses definidos</span>':''}</td>
    <td>${esc(p.cartao||'—')}</td><td class="r">${BRL(p.valor_parcela)}</td>
    <td class="c"><input type="number" min="0" value="${p.restantes}" style="width:56px;padding:3px 5px;text-align:center"
      onchange="setRow('parcelamentos','${p.id}','restantes',Math.max(0,+this.value))"></td>
    <td class="r"><b>${BRL(p.valor_parcela*p.restantes)}</b></td>
    <td>${fim?mLabel(fim):'—'}</td>
    <td class="r"><button class="btn dgr" onclick="delRow('parcelamentos','${p.id}')">excluir</button></td></tr>
    <tr class="sub"><td colspan="7" style="padding:4px 15px 10px">
      <span class="note">Meses em que cai:</span>
      <input value="${meses.map(m=>mLabel(m)).join(', ')}" style="width:min(420px,70%);padding:3px 7px;margin-left:6px"
        onchange="setCompetencias('${p.id}',this.value)"
        title="Escreva MM/AAAA separando por vírgula. Deixe em branco para voltar ao mês a mês.">
      ${irregular?'<span class="note" style="margin-left:8px">este parcelamento pula mês</span>'
                 :'<span class="note" style="margin-left:8px">mensais consecutivas</span>'}
    </td></tr>`;}).join('')
    ||`<tr><td colspan="7" class="note" style="padding:20px;text-align:center">${
      D.parcelamentos.length?'Nenhuma dívida bate com o filtro.':'Nenhum parcelamento. Use "Nova compra" para simular e adicionar.'}</td></tr>`}
  </tbody></table></div>
  <div class="pbody"><button class="btn" onclick="go('compra')">Simular nova compra</button></div></div>`;
}
window.setRow=async(t,id,campo,val)=>{if(await atualizar(t,id,{[campo]:val})){render();toast('Atualizado');}};

function vAssin(){
  const cartoes=[...new Set(D.assinaturas.map(a=>a.cartao).filter(Boolean))].sort();
  const comStatus=D.assinaturas.map(a=>({...a, _status:a.projetar?'ativa':'pausada'}));
  const lista=aplicaFiltro('assin', comStatus, 'descricao', '_status', 'cartao');
  return head('Assinaturas','Desmarque para ver na hora quanto sobraria sem ela.')
  +`<div class="kpis">${kpi('Total ativo',BRL(totAssin()))}
    ${kpi('Por ano',BRL(totAssin()*12),'','amb')}
    ${kpi('Ativas',D.assinaturas.filter(a=>a.projetar).length+' de '+D.assinaturas.length)}</div>
  <div class="panel"><h2>Assinaturas <small>${lista.length} de ${D.assinaturas.length}</small></h2>
  <div class="pbody" style="padding-bottom:0">
    ${barraFiltro('assin', {placeholder:'Buscar assinatura…',
      tipos:[['ativa','Ativas'],['pausada','Pausadas']], categorias:cartoes})}
  </div>
  <div class="tw"><table><thead><tr><th class="c">Projetar</th><th>Nome</th><th>Cartão</th>
    <th class="r">Valor</th><th class="r">Por ano</th><th></th></tr></thead><tbody>
  ${lista.map(a=>`<tr class="${a.projetar?'':'dim'}">
    <td class="c"><input type="checkbox" ${a.projetar?'checked':''} style="width:auto;cursor:pointer"
      onchange="setRow('assinaturas','${a.id}','projetar',this.checked)"></td>
    <td><b>${esc(a.descricao)}</b>${a.observacao?`<br><span class="tag t-w">${esc(a.observacao)}</span>`:''}</td>
    <td>${esc(a.cartao||'—')}</td><td class="r">${BRL(a.valor)}</td>
    <td class="r">${a.projetar?BRL(a.valor*12):'—'}</td>
    <td class="r"><button class="btn dgr" onclick="delRow('assinaturas','${a.id}')">excluir</button></td></tr>`).join('')
    ||`<tr><td colspan="6" class="note" style="padding:20px;text-align:center">${
      D.assinaturas.length?'Nenhuma assinatura bate com o filtro.':'Nenhuma assinatura cadastrada.'}</td></tr>`}
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

let TERC_ORIG='Pix', GRUPO_ABERTO=null;
function vTerc(){
  const hj=hoje();
  const dias=t=>t.data_saida?Math.max(0,Math.round((new Date(hj)-new Date(t.data_saida))/86400000)):null;
  const atrasado=t=>!t.recebido && t.previsao && t.previsao<hj;
  const semPrazo=t=>!t.recebido && !t.previsao;
  const noCartao=t=>!!t.cartao;

  const abertos=D.terceiros.filter(t=>!t.recebido);
  const porCartao=abertos.filter(noCartao);
  const fora=abertos.filter(t=>!noCartao(t));
  const pes=[...new Set(abertos.map(t=>t.pessoa))];
  const vencidos=abertos.filter(atrasado);
  const parados=abertos.filter(t=>semPrazo(t) && dias(t)!==null && dias(t)>=30);

  const pessoasTodas=[...new Set(D.terceiros.map(t=>t.pessoa))].sort();
  const comStatus=D.terceiros.map(t=>({...t, _status:t.recebido?'recebido':'pendente'}));
  const filtrados=aplicaFiltro('terc', comStatus, ['pessoa','descricao'], '_status', 'pessoa');

  /* Vários registros da mesma pessoa com a mesma descrição são parcelas de
     um compromisso só. Mostrar dez linhas iguais esconde o que importa:
     quanto falta ao todo e até quando. */
  /* tira "Parcela 3/10", "3/10" e o travessão que sobra, no começo ou no fim */
  const semParcela = d => String(d||'')
    .replace(/parcela\s*\d+\s*\/\s*\d+/ig,'')
    .replace(/\b\d+\s*\/\s*\d+\b/g,'')
    .replace(/^[\s—–-]+|[\s—–-]+$/g,'')
    .trim();
  function agrupar(lista){
    const g=new Map();
    lista.forEach(t=>{
      const ch=t.pessoa+'|'+semParcela(t.descricao);
      if(!g.has(ch)) g.set(ch,[]);
      g.get(ch).push(t);
    });
    return [...g.values()].map(its=>{
      const comps=its.map(x=>x.competencia).filter(Boolean).sort();
      return {itens:its, n:its.length,
              pessoa:its[0].pessoa,
              descricao:semParcela(its[0].descricao) || its[0].descricao,
              total:its.reduce((s,x)=>s+ +x.valor,0),
              origem:its[0].origem||its[0].cartao,
              cartao:its[0].cartao,
              ate:comps.length?comps[comps.length-1]:null,
              recebido:its.every(x=>x.recebido),
              parcial:its.some(x=>x.recebido)&&!its.every(x=>x.recebido)};
    });
  }

  const linha=t=>{
    const d=dias(t);
    return `<tr class="${t.recebido?'dim':''}">
      <td class="c"><input type="checkbox" ${t.recebido?'checked':''} style="width:auto;cursor:pointer"
        onchange="receberTerc('${t.id}',this.checked)"></td>
      <td><b>${esc(t.pessoa)}</b></td>
      <td>${esc(t.descricao)}</td>
      <td>${t.origem
        ? `<span class="tag ${noCartao(t)?'t-i':'t-w'}">${esc(t.origem)}</span>`
        : (t.cartao?`<span class="tag t-i">${esc(t.cartao)}</span>`:'<span class="note">—</span>')}</td>
      <td>${t.recebido
        ? `<span class="tag t-ok">recebido${t.recebido_em?' em '+String(t.recebido_em).split('-').reverse().slice(0,2).join('/'):''}</span>`
        : t.previsao
          ? `<span class="tag ${atrasado(t)?'t-no':'t-g'}">${atrasado(t)?'atrasado desde ':'volta em '}${
              String(t.previsao).split('-').reverse().slice(0,2).join('/')}</span>`
          : t.competencia
            ? `<span class="note">fatura de ${esc(t.competencia)}</span>`
            : `<span class="tag ${d!==null&&d>=90?'t-no':d!==null&&d>=60?'t-no':d!==null&&d>=30?'t-w':'t-g'}">sem prazo${
                d!==null?' · '+d+' dias':''}${d!==null&&d>=90?' · cobrar':''}</span>`}</td>
      <td class="r" style="font-weight:600;color:${t.recebido?'var(--pos)':'var(--amber)'}">${BRL(t.valor)}</td>
      <td class="r"><button class="btn dgr" onclick="delRow('terceiros','${t.id}')">excluir</button></td></tr>`;
  };

  return head('Terceiros','Dinheiro de vocês que está com outra pessoa — no cartão, por Pix ou na mão.')
  +`<div class="kpis">
    ${kpi('A receber',BRL(aReceber()),abertos.length+' em aberto','amb')}
    ${kpi('Já recebido',BRL(recebido()),'','pos')}
    ${kpi('Fora do cartão',BRL(fora.reduce((s,t)=>s+ +t.valor,0)),'Pix, dinheiro, transferência')}
    ${kpi('Sem prazo há 30 dias ou mais',BRL(parados.reduce((s,t)=>s+ +t.valor,0)),
      parados.length?parados.length+' registro'+(parados.length===1?'':'s'):'nenhum',
      parados.length?'amb':'')}
  </div>

  ${vencidos.length?`<div class="warn" style="margin-bottom:16px">
    <b>${vencidos.length} ${vencidos.length===1?'cobrança passou':'cobranças passaram'} do prazo combinado.</b>
    ${vencidos.map(t=>esc(t.pessoa)+' ('+BRL(t.valor)+')').join(', ')}.</div>`:''}

  <div class="panel"><h2>Filtrar <small>vale para as duas tabelas abaixo</small></h2>
    <div class="pbody" style="padding-bottom:14px">
      ${barraFiltro('terc', {placeholder:'Buscar por pessoa ou descrição…',
        tipos:[['pendente','Pendentes'],['recebido','Recebidos']], categorias:pessoasTodas})}
    </div>
  </div>

  ${pes.length?`<div class="panel"><h2>Por pessoa</h2><div class="pbody"><div class="bars">
    ${pes.map(p=>{
      const v=abertos.filter(t=>t.pessoa===p).reduce((s,t)=>s+ +t.valor,0);
      const mx=Math.max(...pes.map(q=>abertos.filter(t=>t.pessoa===q).reduce((s,t)=>s+ +t.valor,0)),1);
      return `<div class="bar"><span>${esc(p)}</span><span class="track">
        <span class="fill" style="width:${v/mx*100}%"></span></span>
        <span class="r" style="font-weight:600">${BRL(v)}</span></div>`;}).join('')}
  </div></div></div>`:''}

  <div class="panel"><h2>Fora do cartão <small>${filtrados.filter(t=>!noCartao(t)).length} de ${D.terceiros.filter(t=>!noCartao(t)).length} · Pix, dinheiro, transferência — com ou sem prazo</small></h2>
  <div class="tw"><table><thead><tr><th class="c">Recebido</th><th>Quem</th><th>O que é</th>
    <th>Origem</th><th>Quando volta</th><th class="r">Valor</th><th></th></tr></thead><tbody>
  ${filtrados.filter(t=>!noCartao(t)).map(linha).join('')
    ||`<tr><td colspan="7" class="note" style="padding:18px;text-align:center">${
      D.terceiros.some(t=>!noCartao(t))?'Nada bate com o filtro.':'Nada emprestado fora do cartão.'}</td></tr>`}
  </tbody></table></div>
  <div class="pbody">
    <div class="kgroup sub">Registrar o que você emprestou</div>
    <div class="form">
      <div class="fld"><label>Quem</label><input id="t_p" placeholder="Ex.: Tia Rose"></div>
      <div class="fld" style="grid-column:span 2"><label>O que é</label>
        <input id="t_d" placeholder="Ex.: Pix emprestado para o conserto"></div>
      <div class="fld"><label>Saiu de onde</label><select id="t_o" onchange="setTercOrig(this.value)">
        <optgroup label="Fora do cartão">
          <option ${TERC_ORIG==='Pix'?'selected':''}>Pix</option>
          <option ${TERC_ORIG==='Dinheiro'?'selected':''}>Dinheiro</option>
          <option ${TERC_ORIG==='Transferência'?'selected':''}>Transferência</option>
        </optgroup>
        <optgroup label="Nos cartões de vocês">
          ${D.cartoes.filter(c=>c.ativo).map(c=>
            `<option ${TERC_ORIG===c.nome?'selected':''}>${esc(c.nome)}</option>`).join('')}
        </optgroup>
      </select></div>
      <div class="fld"><label>Valor</label><input type="number" step="0.01" id="t_v"></div>
      ${D.cartoes.some(c=>c.nome===TERC_ORIG)
        ? `<div class="fld"><label>Em qual fatura</label>
            <select id="t_cp">${mesesDisponiveis().map(m=>
              `<option value="${mLabel(m)}">${mLabel(m)}</option>`).join('')}</select></div>`
        : `<div class="fld"><label>Quando saiu</label><input type="date" id="t_ds" value="${hoje()}"></div>
           <div class="fld"><label>Previsão de volta</label><input type="date" id="t_pv"></div>`}
      <div class="fld"><label>&nbsp;</label><button class="btn" onclick="addTerc()">Registrar</button></div>
    </div>
    <p class="note" style="margin-top:10px">${D.cartoes.some(c=>c.nome===TERC_ORIG)
      ? 'Compra de terceiro no cartão: escolha a fatura em que ela cai. O valor é abatido da parte de vocês.'
      : 'Deixe a previsão em branco quando não houver prazo combinado. O app conta os dias e destaca quando passa de 30, 60 e 90.'}</p>
  </div></div>

  <div class="panel"><h2>Nos cartões de vocês <small>${agrupar(filtrados.filter(noCartao)).length} de ${agrupar(D.terceiros.filter(noCartao)).length} compromissos · compras de terceiros que entram na fatura</small></h2>
  <div class="tw"><table><thead><tr><th class="c">Recebido</th><th>Quem</th><th>O que é</th>
    <th>Cartão</th><th>Competência</th><th class="r">Valor</th><th></th></tr></thead><tbody>
  ${agrupar(filtrados.filter(noCartao)).map(g=>{
    const pend=g.itens.filter(x=>!x.recebido);
    return `<tr class="${g.recebido?'dim':''}">
      <td class="c">${g.n===1
        ? `<input type="checkbox" ${g.itens[0].recebido?'checked':''} style="width:auto;cursor:pointer"
            onchange="receberTerc('${g.itens[0].id}',this.checked)">`
        : `<span class="tag ${g.recebido?'t-ok':g.parcial?'t-w':'t-g'}">${
            g.itens.filter(x=>x.recebido).length}/${g.n}</span>`}</td>
      <td><b>${esc(g.pessoa)}</b></td>
      <td>${esc(g.descricao)}</td>
      <td><span class="tag t-i">${esc(g.origem||'—')}</span></td>
      <td>${g.n>1
        ? `<span class="tag t-i">${pend.length} de ${g.n} parcelas${
            g.ate?' até '+g.ate:''}</span>`
        : (g.itens[0].competencia?`<span class="note">fatura de ${esc(g.itens[0].competencia)}</span>`:'—')}</td>
      <td class="r" style="font-weight:600;color:${g.recebido?'var(--pos)':'var(--amber)'}">${
        BRL(pend.reduce((s,x)=>s+ +x.valor,0)||g.total)}${
        g.n>1?`<span class="note" style="display:block;font-weight:400">${BRL(g.total)} no total</span>`:''}</td>
      <td class="r">${g.n===1
        ? `<button class="btn dgr" onclick="delRow('terceiros','${g.itens[0].id}')">excluir</button>`
        : `<button class="btn alt sm" onclick="abrirGrupo('${esc(g.pessoa)}','${esc(g.descricao)}')">ver as ${g.n}</button>`}</td>
    </tr>${GRUPO_ABERTO===g.pessoa+'|'+g.descricao
      ? g.itens.sort((a,b)=>String(a.competencia||'').localeCompare(String(b.competencia||''))).map((x,i)=>`
        <tr class="sub ${x.recebido?'dim':''}"><td class="c">
          <input type="checkbox" ${x.recebido?'checked':''} style="width:auto;cursor:pointer"
            onchange="receberTerc('${x.id}',this.checked)"></td>
          <td colspan="3" class="note" style="padding-left:28px">parcela ${i+1} de ${g.n}${
            x.competencia?' · fatura de '+esc(x.competencia):''}</td>
          <td></td>
          <td class="r">${BRL(x.valor)}</td>
          <td class="r"><button class="btn dgr" onclick="delRow('terceiros','${x.id}')">excluir</button></td>
        </tr>`).join('')
      : ''}`;}).join('')
    ||`<tr><td colspan="7" class="note" style="padding:18px;text-align:center">${
      D.terceiros.some(noCartao)?'Nada bate com o filtro.':'Nenhuma compra de terceiro nos cartões.'}</td></tr>`}
  </tbody></table></div>
  <div class="pbody"><p class="note">Estes vêm das faturas e são abatidos da parte de vocês.
  Enquanto não voltam, ocupam <b>limite dos cartões</b> — hoje ${BRL(porCartao.reduce((s,t)=>s+ +t.valor,0))}
  do limite de vocês está sustentando compra de outra pessoa.</p></div></div>`;
}
window.addTerc=async()=>{
  const p=$('t_p').value.trim(), d=$('t_d').value.trim(), v=parseFloat($('t_v').value);
  if(!p||!d||!v) return toast('Preencha quem, o que é e o valor');
  const origem=$('t_o')?.value||'Pix';
  TERC_ORIG=origem;
  const ehCartao=D.cartoes.some(c=>c.nome===origem);
  const ok=await inserir('terceiros',{
    pessoa:p, descricao:d, valor:v, recebido:false, origem,
    cartao: ehCartao?origem:null,
    competencia: ehCartao ? ($('t_cp')?.value || mLabel(MREF)) : null,
    data_saida: ehCartao ? null : ($('t_ds')?.value || hoje()),
    previsao:   ehCartao ? null : ($('t_pv')?.value || null)});
  if(ok){ render(); toast(p+' deve '+BRL(v)+(ehCartao?' na fatura':'')); }
};
/* marcar como recebido guarda também a data */
window.setTercOrig=v=>{ TERC_ORIG=v; render(); };
window.setPlano=(campo,v)=>{
  if(campo==='vida') PLANO_VIDA=+v; else if(campo==='caixa') PLANO_CAIXA=+v; else if(campo==='colchao') PLANO_COLCHAO=+v;
  render();
};
window.addEvento=(finId,tipo)=>{
  if(!PLANO_EVENTOS[finId]) PLANO_EVENTOS[finId]=[];
  const hj=hoje();
  PLANO_EVENTOS[finId].push({id:'ev'+(++PLANO_ID), tipo, data:hj,
    valor: tipo==='guardar'?500:0, parcelas: tipo==='antecipar'?1:0,
    controla: tipo==='antecipar'?'parcelas':'valor'});
  render();
};
window.delEvento=(finId,id)=>{
  PLANO_EVENTOS[finId]=(PLANO_EVENTOS[finId]||[]).filter(e=>e.id!==id);
  render();
};
window.setEvento=(finId,id,campo,v)=>{
  const ev=(PLANO_EVENTOS[finId]||[]).find(e=>e.id===id); if(!ev) return;
  if(campo==='tipo'){ ev.tipo=v; ev.controla = v==='antecipar'?'parcelas':'valor'; }
  else if(campo==='data'){ ev.data=v; }
  else if(campo==='valor'){ ev.valor=+v||0; ev.controla='valor'; }
  else if(campo==='parcelas'){ ev.parcelas=Math.max(0,+v||0); ev.controla='parcelas'; }
  render();
};
window.gerarSugestaoPlano=(finId)=>{
  const fin=D.financiamentos.find(x=>x.id===finId); if(!fin) return;
  const auto=sugestaoAutomatica(fin, PLANO_VIDA, PLANO_COLCHAO, PLANO_HORIZ);
  PLANO_EVENTOS[finId]=auto;
  render(); toast('Sugestão gerada — edite ou exclua o que quiser');
};
window.limparPlano=(finId)=>{
  if(!confirm('Apagar todos os eventos deste financiamento?')) return;
  PLANO_EVENTOS[finId]=[]; render();
};
window.abrirGrupo=(p,d)=>{ const ch=p+'|'+d; GRUPO_ABERTO = GRUPO_ABERTO===ch?null:ch; render(); };
window.receberTerc=async(id,v)=>{
  if(await atualizar('terceiros',id,{recebido:v, recebido_em: v?hoje():null})){
    render(); toast(v?'Marcado como recebido':'Voltou para a lista');
  }
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
  const tabela=(titulo,tab,campos,total)=>{
    const chave='cad_'+tab;
    const campoBusca=campos.filter(f=>f.tipo!=='num'&&f.tipo!=='check').map(f=>f.k);
    const lista=aplicaFiltro(chave, D[tab], campoBusca);
    const f=filtroDe(chave);
    return `
    <div class="panel"><h2>${titulo} <small>${lista.length} de ${D[tab].length}</small></h2>
    ${D[tab].length>4?`<div class="pbody" style="padding-bottom:0">
      ${barraFiltro(chave, {placeholder:'Buscar…'})}
    </div>`:''}
    <div class="tw"><table><thead><tr>
      ${campos.map(fc=>`<th class="${fc.r?'r':''}">${fc.l}</th>`).join('')}<th></th></tr></thead><tbody>
    ${lista.map(x=>`<tr class="${x.ativo===false?'dim':''}">
      ${campos.map(fc=>`<td class="${fc.r?'r':''}">${
        fc.tipo==='check'?`<input type="checkbox" ${x[fc.k]?'checked':''} style="width:auto;cursor:pointer"
            onchange="setRow('${tab}','${x.id}','${fc.k}',this.checked)">`
        :`<input ${fc.tipo==='num'?'type="number" step="0.01"':''} value="${esc(x[fc.k]??'')}"
            style="border-color:transparent;padding:3px 5px;${fc.r?'text-align:right;width:104px':''}"
            onchange="setRow('${tab}','${x.id}','${fc.k}',${fc.tipo==='num'?'+this.value':'this.value'})">`
      }</td>`).join('')}
      <td class="r"><button class="btn dgr" onclick="delRow('${tab}','${x.id}')">excluir</button></td></tr>`).join('')
      ||`<tr><td colspan="${campos.length+1}" class="note" style="padding:16px;text-align:center">${
        D[tab].length?'Nada bate com o filtro.':'Vazio.'}</td></tr>`}
    </tbody><tfoot><tr><td colspan="${campos.length-1}">Total</td>
      <td class="r">${BRL(total)}</td><td></td></tr></tfoot></table></div>
    <div class="pbody"><button class="btn alt sm" onclick="addCad('${tab}')">+ Adicionar</button></div></div>`;
  };

  return head('Cadastros','Cartões, renda, contas fixas e benefícios. Mudar qualquer coisa aqui recalcula o resto.')
  +`<div class="rowbar"><span class="note">Nesta página:</span>
    ${['Cartões','Renda','Contas fixas','Benefícios'].map(x=>
      `<span class="tag t-i">${x}</span>`).join('')}
  </div>`
  +`<div class="kpis">${kpi('Renda',BRL(totRenda()))}${kpi('Fixas',BRL(totFixas()))}
    ${kpi('Benefícios',BRL(totVA()))}${kpi('Sobra estrutural',BRL(totRenda()-totFixas()),'antes de cartões','pos')}</div>
  <div class="panel"><h2>Cartões <small>${(()=>{const n=aplicaFiltro('cad_cartoes',D.cartoes.map(x=>({...x,_status:x.ativo?'ativo':'inativo'})),'nome','_status','titular').length;return n+' de '+D.cartoes.length;})()} · o dia de vencimento define em qual bloco a fatura cai no painel</small></h2>
  ${D.cartoes.length>3?`<div class="pbody" style="padding-bottom:0">
    ${barraFiltro('cad_cartoes', {placeholder:'Buscar cartão…',
      tipos:[['ativo','Ativos'],['inativo','Inativos']],
      categorias:[...new Set(D.cartoes.map(x=>x.titular).filter(Boolean))].sort()})}
  </div>`:''}
  <div class="tw"><table><thead><tr><th class="c">Ativo</th><th>Cartão</th><th>Titular</th>
    <th class="c">Vence dia</th><th class="r">Limite</th>
    <th class="r">Fatura de ${mLabel(MREF)}</th><th></th></tr></thead><tbody>
  ${aplicaFiltro('cad_cartoes', D.cartoes.map(x=>({...x,_status:x.ativo?'ativo':'inativo'})), 'nome', '_status', 'titular').map(c=>{
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
    <td class="r"><input type="number" step="100" value="${c.limite||''}" placeholder="—"
      style="width:104px;padding:3px 5px;text-align:right"
      onchange="setRow('cartoes','${c.id}','limite',this.value?+this.value:null)"></td>
    <td class="r">${v?BRL(v):'—'} ${v?`<span class="tag ${real?'t-ok':'t-g'}">${real?'lançada':'estimada'}</span>`:''}</td>
    <td class="r"><button class="btn dgr" onclick="delRow('cartoes','${c.id}')">excluir</button></td></tr>`;}).join('')
    ||`<tr><td colspan="7" class="note" style="padding:16px;text-align:center">${
      D.cartoes.length?'Nenhum cartão bate com o filtro.':'Nenhum cartão cadastrado.'}</td></tr>`}
  </tbody></table></div>
  <div class="pbody"><div class="form">
    <div class="fld"><label>Novo cartão</label><input id="ct_n" placeholder="Ex.: Nubank"></div>
    <div class="fld"><label>Titular</label><input id="ct_t" placeholder="Maria ou Jéssica"></div>
    <div class="fld"><label>Vence dia</label><input type="number" min="1" max="31" id="ct_d"></div>
    <div class="fld"><label>Limite</label><input type="number" step="100" id="ct_l" placeholder="opcional"></div>
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
  <div class="panel"><h2>Ciclos de fatura <small>quando fecha e quando vence, mês a mês</small></h2>
  ${FALTANDO.includes('ciclos')
    ? '<div class="pbody"><div class="warn">Rode <b>migracao-ciclos.sql</b> no Supabase para usar esta parte.</div></div>'
    : `<div class="tw"><table><thead><tr><th>Cartão</th><th>Competência</th>
        <th class="c">Fecha</th><th class="c">Vence</th><th>Cobranças fora do padrão</th><th></th></tr></thead><tbody>
    ${D.ciclos.slice().sort((a,b)=>(a.cartao+a.competencia).localeCompare(b.cartao+b.competencia))
      .map(c=>{
        const rep=D.assinaturas.filter(a=>a.projetar&&(a.cartao||'')===c.cartao)
          .map(a=>({a,vz:vezesAssinatura(a,c.competencia)})).filter(x=>x.vz!==1);
        return `<tr>
        <td>${esc(c.cartao)}${c.inferido?' <span class="tag t-w">data inferida</span>':''}</td>
        <td class="mono">${mLabel(c.competencia)}</td>
        <td class="c"><input type="date" value="${c.fecha}" style="padding:3px 5px;width:130px"
          onchange="setRow('ciclos','${c.id}','fecha',this.value)"></td>
        <td class="c"><input type="date" value="${c.vence}" style="padding:3px 5px;width:130px"
          onchange="setRow('ciclos','${c.id}','vence',this.value)"></td>
        <td>${rep.length
          ? rep.map(x=>`<span class="tag ${x.vz>1?'t-no':'t-w'}">${x.vz}x ${esc(x.a.descricao)}</span>`).join(' ')
          : '<span class="note">uma cobrança de cada</span>'}</td>
        <td class="r"><button class="btn dgr" onclick="delRow('ciclos','${c.id}')">excluir</button></td></tr>`;}).join('')
      ||'<tr><td colspan="6" class="note" style="padding:16px;text-align:center">Nenhum ciclo cadastrado.</td></tr>'}
    </tbody></table></div>
    <div class="pbody"><div class="form">
      <div class="fld"><label>Cartão</label><select id="ci_c">
        ${D.cartoes.filter(x=>x.ativo).map(x=>`<option>${esc(x.nome)}</option>`).join('')}</select></div>
      <div class="fld"><label>Competência</label><select id="ci_m">
        ${horizon(14,addM(ym(hoje()),-2)).map(k=>`<option value="${k}">${mLabel(k)}</option>`).join('')}</select></div>
      <div class="fld"><label>Fecha em</label><input type="date" id="ci_f"></div>
      <div class="fld"><label>Vence em</label><input type="date" id="ci_v"></div>
      <div class="fld"><label>&nbsp;</label><button class="btn" onclick="addCiclo()">Adicionar</button></div>
    </div>
    <p class="note" style="margin-top:10px">Sem a data de fechamento, o app assume uma cobrança por mês.
    Com ela, conta quantas vezes o dia de cobrança de cada assinatura cai no intervalo — foi assim que
    a academia apareceu duas vezes na fatura de setembro do BB Elo.</p>
    </div>`}
  </div>

  <div class="info">Cenário da casa e simulações ficam na aba <b>Projeções Casa</b>.</div>`;
}
window.setCfg=async(k,v)=>{if(await atualizar('config',null,{[k]:v})){render();toast('Atualizado');}};
/* Meses irregulares: aceita "10/2026, 12/2026". Em branco, volta ao mês a mês. */
window.setCompetencias=async(id,txt)=>{
  const t=String(txt||'').trim();
  if(!t){
    if(await atualizar('parcelamentos',id,{competencias:null})){ render(); toast('Voltou a contar mês a mês'); }
    return;
  }
  const meses=t.split(/[,;]/).map(x=>x.trim()).filter(Boolean).map(x=>{
    let m=x.match(/^(\d{2})\/(\d{4})$/); if(m) return m[2]+'-'+m[1];
    m=x.match(/^(\d{4})-(\d{2})$/);      if(m) return x;
    return null;
  });
  if(meses.some(m=>!m)) return toast('Use MM/AAAA, separando por vírgula', 4200);
  const p=D.parcelamentos.find(x=>x.id===id);
  if(p && meses.length!==+p.restantes)
    return toast('Você listou '+meses.length+' meses mas faltam '+p.restantes+' parcelas', 4600);
  if(await atualizar('parcelamentos',id,{competencias:meses})){
    render(); toast(meses.length+(meses.length===1?' mês definido':' meses definidos'));
  }
};
window.addCiclo=async()=>{
  const c=$('ci_c').value, m=$('ci_m').value, f=$('ci_f').value, v=$('ci_v').value;
  if(!c||!m||!f||!v) return toast('Preencha cartão, competência e as duas datas');
  if(await inserir('ciclos',{cartao:c,competencia:m,fecha:f,vence:v,inferido:false}))
    {render();toast('Ciclo de '+c+' em '+mLabel(m)+' cadastrado');}
};
window.addCartao=async()=>{
  const n=$('ct_n').value.trim();
  if(!n) return toast('Dê um nome ao cartão');
  const d=parseInt($('ct_d').value);
  const lim=parseFloat($('ct_l')?.value);
  if(await inserir('cartoes',{nome:n,titular:$('ct_t').value.trim()||null,
      dia_venc:isNaN(d)?null:d, limite:isNaN(lim)?null:lim,
      ativo:true})){render();toast(n+' adicionado');}
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
  const guardadoTotal=(+c.reserva_atual)+D.metas.reduce((s,m)=>s+ +m.guardado,0);
  const S=saldoConta();
  /* histórico: tudo que você já guardou, vindo dos lançamentos */
  const depositos=D.lancamentos.filter(l=>l.categoria==='Reserva' && l.tipo==='Saída')
    .sort((a,b)=>String(b.data).localeCompare(String(a.data)));

  return head('Metas e reserva','Guardar dinheiro não é gasto: sai da conta e vira reserva. Aqui os dois lados aparecem.')
  +`<div class="kpis">
    ${kpi('Guardado no total',BRL(guardadoTotal),'reserva + metas','pos')}
    ${kpi('Na conta corrente',S.atual!=null?BRL(S.atual):'—','disponível para o mês')}
    ${kpi('Patrimônio',S.atual!=null?BRL(S.atual+guardadoTotal):BRL(guardadoTotal),'conta + guardado','pos')}
    ${kpi('Já depositado',BRL(depositos.reduce((s,l)=>s+ +l.valor,0)),depositos.length+' depósito'+(depositos.length===1?'':'s'))}
  </div>

  <div class="panel"><h2>Reserva de emergência</h2><div class="pbody">
    <div class="bar" style="grid-template-columns:110px 1fr 90px;margin-bottom:14px"><span>Progresso</span>
      <span class="track" style="height:22px"><span class="fill" style="width:${prog*100}%;background:var(--pos)"></span></span>
      <span class="r" style="font-weight:600">${PCT(prog)}</span></div>
    <div class="kpis" style="margin:0 0 14px">
      ${kpi('Tem guardado',BRL(c.reserva_atual))}
      ${kpi('Meta (6 meses de custo)',BRL(meta),'fixas + assinaturas')}
      ${kpi('Falta',BRL(falta),'','amb')}
      ${kpi('Meses até lá',meses!==null?meses:'—',meses!==null?'no ritmo atual':'defina um aporte')}
    </div>
    <div class="kgroup sub">Lançar um depósito na reserva</div>
    <div class="form">
      <div class="fld"><label>Quanto guardou</label><input type="number" step="50" id="dp_r" placeholder="0,00"></div>
      <div class="fld"><label>Quando</label><input type="date" id="dp_rd" value="${hoje()}"></div>
      <div class="fld"><label>&nbsp;</label><button class="btn" onclick="guardar('reserva',null)">Guardar</button></div>
    </div>
    <p class="note" style="margin-top:8px">Soma ao que já está guardado e lança a saída da conta,
    com categoria <b>Reserva</b>. Assim o saldo em conta baixa e o dinheiro não desaparece.</p>
    <div class="form" style="margin-top:14px">
      <div class="fld"><label>Corrigir o total guardado</label><input type="number" step="100" value="${c.reserva_atual}"
        onchange="setCfg('reserva_atual',+this.value)"></div>
      <div class="fld"><label>Aporte planejado por mês</label><input type="number" step="50" value="${c.aporte_mensal}"
        onchange="setCfg('aporte_mensal',+this.value)"></div>
    </div>
  </div></div>

  <div class="panel"><h2>Outras metas</h2>
  ${D.metas.length?`<div class="tw"><table><thead><tr><th>Meta</th><th class="r">Alvo</th>
      <th class="r">Guardado</th><th class="r">Falta</th><th style="width:290px">Lançar depósito</th><th></th>
    </tr></thead><tbody>
    ${D.metas.map(m=>{
      const p=m.alvo>0?Math.min(1,m.guardado/m.alvo):0;
      return `<tr>
      <td><b>${esc(m.nome)}</b>
        <span class="track" style="display:block;height:5px;margin-top:4px;max-width:150px">
          <span class="fill" style="width:${p*100}%;background:var(--pos)"></span></span></td>
      <td class="r">${BRL(m.alvo)}</td>
      <td class="r"><input type="number" value="${m.guardado}" style="width:100px;padding:3px 5px;text-align:right;border-color:transparent"
        onchange="setRow('metas','${m.id}','guardado',+this.value)"></td>
      <td class="r" style="color:${m.guardado>=m.alvo?'var(--pos)':'var(--amber)'}">${
        m.guardado>=m.alvo?'completa':BRL(m.alvo-m.guardado)}</td>
      <td><div style="display:flex;gap:5px;align-items:center">
        <input type="number" step="50" id="dp_${m.id}" placeholder="0,00" style="width:96px;padding:4px 6px">
        <input type="date" id="dpd_${m.id}" value="${hoje()}" style="width:132px;padding:4px 6px">
        <button class="btn sm" onclick="guardar('meta','${m.id}')">Guardar</button>
      </div></td>
      <td class="r"><button class="btn dgr" onclick="delRow('metas','${m.id}')">excluir</button></td></tr>`;}).join('')}
    </tbody></table></div>`:'<div class="pbody"><p class="note">Nenhuma meta ainda.</p></div>'}
    <div class="pbody"><div class="form">
      <div class="fld" style="grid-column:span 2"><label>Nova meta</label><input id="m_n" placeholder="Ex.: Entrada da casa"></div>
      <div class="fld"><label>Valor alvo</label><input type="number" id="m_a"></div>
      <div class="fld"><label>Já guardado</label><input type="number" id="m_g"></div>
      <div class="fld"><label>&nbsp;</label><button class="btn" onclick="addMeta()">Adicionar</button></div>
    </div></div>
  </div>

  ${depositos.length?`<div class="panel"><h2>Depósitos lançados <small>saíram da conta e viraram reserva</small></h2>
  <div class="tw"><table><thead><tr><th>Data</th><th>Para onde</th><th class="r">Valor</th><th></th></tr></thead><tbody>
  ${depositos.slice(0,15).map(l=>`<tr>
    <td class="mono">${String(l.data).split('-').reverse().join('/')}</td>
    <td>${esc(l.descricao)}</td>
    <td class="r" style="font-weight:600">${BRL(l.valor)}</td>
    <td class="r"><button class="btn dgr" onclick="delRow('lancamentos','${l.id}')">excluir</button></td>
  </tr>`).join('')}
  </tbody></table></div>
  <div class="pbody"><p class="note">Excluir aqui apaga só o lançamento, não desconta do total guardado —
  para isso, corrija o valor na linha da meta.</p></div></div>`:''}`;
}
window.addMeta=async()=>{
  const n=$('m_n').value.trim(),a=parseFloat($('m_a').value);
  if(!n||!a) return toast('Preencha nome e valor alvo');
  if(await inserir('metas',{nome:n,alvo:a,guardado:parseFloat($('m_g').value)||0}))
    {render();toast('Meta adicionada');}
};
/* Guardar dinheiro: soma no destino e lança a saída da conta. */
window.guardar=async(tipo,id)=>{
  const campo = tipo==='reserva' ? 'dp_r' : 'dp_'+id;
  const campoData = tipo==='reserva' ? 'dp_rd' : 'dpd_'+id;
  const v=parseFloat($(campo)?.value);
  const d=$(campoData)?.value || hoje();
  if(!v || v<=0) return toast('Informe quanto você guardou');

  const nome = tipo==='reserva' ? 'Reserva de emergência'
                                : (D.metas.find(m=>m.id===id)?.nome || 'Meta');
  const ok = tipo==='reserva'
    ? await atualizar('config',null,{reserva_atual:(+cfg().reserva_atual)+v})
    : await atualizar('metas',id,{guardado:(+D.metas.find(m=>m.id===id).guardado)+v});
  if(!ok) return;

  await inserir('lancamentos',{
    data:d, descricao:'Guardado — '+nome, categoria:'Reserva', tipo:'Saída',
    quem:'Casal', valor:v, status:'Confirmado',
    protegido:false, beneficio:false,
    observacao:'Depósito lançado na aba Metas', criado_por:USER?.id||null});
  render(); toast(BRL(v)+' guardado em '+nome);
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
    return head('Projeções Casa','Esta aba precisa de uma tabela que ainda não existe no seu banco.')
      +'<div class="warn">Rode <b>'+MIGRACAO_DE.casa_itens+'</b> no SQL Editor e recarregue.</div>';
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
window.conferirSaldo=async()=>{
  const v=$('sc_v').value, d=$('sc_d').value;
  if(v===''||v==null) return toast('Informe o saldo que aparece no banco');
  if(!d) return toast('Informe a data do extrato');
  if(await atualizar('config',null,{saldo_conferido:+v, saldo_conferido_em:d})){
    render(); toast('Saldo fixado em '+BRL(+v)+' a partir de '+d.split('-').reverse().join('/'));
  }
};
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
let FIN_SEL=null;
/* =====================================================================
   PLANO DE ANTECIPAÇÃO COM FLUXO DE CAIXA REAL
   Simula dia a dia, usando os mesmos dados que alimentam o Painel — não
   um número por mês. "Vida" é uma suposição de gasto do dia a dia que o
   app não rastreia (por pedido da usuária); os outros números vêm todos
   do banco: blocosDoMes() já inclui rendas, fixas, faturas e qualquer
   13º/férias que tenha sido lançado como um avulso de data futura.
   ===================================================================== */
let PLANO_VIDA=1800, PLANO_COLCHAO=300, PLANO_HORIZ=18;
let PLANO_EVENTOS={};   /* { finId: [{id,tipo,data,valor,parcelas,controla}] } — a lista que a usuária monta */
let PLANO_ID=0;
let BUSCA_Q='', BUSCA_ABERTA=false;
const ym2 = d => d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');

/* Cada linha é um evento que a usuária controla — quando, quanto, pra onde.
   Roda em ordem de data: quem vem primeiro consome as parcelas mais caras (do
   fim do contrato) primeiro. Depois, soma isso ao fluxo real do Painel dia a
   dia, pra mostrar exatamente onde o saldo passa e onde ele fura o colchão —
   sem travar nada, só avisando. */
function ordemParcelas(fin){
  const L=tabelaAmortizacao(fin);
  return L.filter(l=>!l.paga).map(l=>l.k);   // crescente: 11,12,...,36 — o fim é o mais caro de antecipar
}
function custoParcela(fin, k, data){
  const L=tabelaAmortizacao(fin), i=taxaEfetiva(fin), diaria=Math.pow(1+i,1/30)-1;
  const item=L.find(l=>l.k===k);
  const dias=Math.max(0, Math.round((item.venc-data)/86400000));
  return (+fin.valor_parcela)/Math.pow(1+diaria,dias);
}

/* Resolve os eventos em ordem de data: pra cada 'antecipar', decide quais
   parcelas ele compra (dado valor OU quantidade — o que a usuária travou) e
   registra o valor/quantidade reais. 'guardar' só passa direto. */
function resolverEventos(fin, eventos){
  const pend=[...ordemParcelas(fin)];
  const L=tabelaAmortizacao(fin), i=taxaEfetiva(fin), diaria=Math.pow(1+i,1/30)-1;
  const vencMap={}; L.forEach(l=>vencMap[l.k]=l.venc);
  function vp(k,data){
    const dias=Math.max(0,Math.round((vencMap[k]-data)/86400000));
    return (+fin.valor_parcela)/Math.pow(1+diaria,dias);
  }
  const ordenados=[...eventos].sort((a,b)=>a.data-b.data || String(a.id).localeCompare(String(b.id)));
  const resolvidos=[];
  for(const ev of ordenados){
    if(ev.tipo==='guardar'){
      resolvidos.push({...ev, valorReal:+ev.valor||0, compradas:[]});
      continue;
    }
    const compradas=[]; let custo=0;
    if(ev.controla==='parcelas'){
      const alvo=Math.max(0,+ev.parcelas||0);
      for(let c=0;c<alvo && pend.length;c++){
        const k=pend.pop(); const v=vp(k,ev.data);
        compradas.push({parcela:k,valor:v}); custo+=v;
      }
    } else {
      const alvo=Math.max(0,+ev.valor||0);
      while(pend.length){
        const k=pend[pend.length-1]; const v=vp(k,ev.data);
        if(custo+v>alvo) break;
        pend.pop(); compradas.push({parcela:k,valor:v}); custo+=v;
      }
    }
    resolvidos.push({...ev, valorReal:custo, parcelasReais:compradas.length, compradas});
  }
  return {resolvidos, restam:pend.length,
    quitadoEm: pend.length===0 ? resolvidos.filter(e=>e.compradas.length).pop()?.data : null};
}

/* Constrói a curva de saldo dia a dia — o fluxo real do Painel, menos "vida",
   menos os eventos resolvidos em suas datas. Não decide nada, só mostra a
   consequência do que está na lista. */
function curvaComEventos(fin, eventos, vida, horizM){
  const {resolvidos, restam, quitadoEm} = resolverEventos(fin, eventos);
  const kIni=ym(hoje());
  const meses=horizon(horizM,kIni);
  const porData=new Map();
  resolvidos.forEach(ev=>{
    const t=ev.data.getTime();
    porData.set(t, (porData.get(t)||0) - (ev.valorReal||0));
  });
  const dias=[]; let saldo=saldoConta().atual ?? (+cfg().saldo_conferido||0);
  let pior={data:null,saldo};
  meses.forEach(k=>{
    const blocos=blocosDoMes(k);
    const nDias=ultimoDiaDoMes(k);
    const porDia={};
    blocos.forEach(b=>{ const d=Math.min(b.dia,nDias); porDia[d]=(porDia[d]||0)+b.saldo; });
    const [ay,am]=k.split('-').map(Number);
    for(let d=1; d<=nDias; d++){
      const data=new Date(ay,am-1,d);
      if(k===kIni && data<new Date(new Date().setHours(0,0,0,0))) continue;
      let delta=(porDia[d]||0)-vida/nDias;
      delta += porData.get(data.getTime())||0;
      saldo+=delta;
      if(pior.data===null || saldo<pior.saldo) pior={data,saldo};
      dias.push({data, saldo, k});
    }
  });
  return {curva:dias, pior, resolvidos, restam, quitadoEm};
}

/* Ponto de partida editável: o antigo motor guloso, olhando 30 dias à frente
   pra nunca sugerir algo que fure o colchão. A usuária edita ou apaga depois —
   isso não é mais a palavra final, é só um rascunho. */
function sugestaoAutomatica(fin, vida, colchao, horizM){
  const L=tabelaAmortizacao(fin), i=taxaEfetiva(fin), diaria=Math.pow(1+i,1/30)-1;
  const PMT=+fin.valor_parcela;
  const vencMap={}; L.forEach(l=>vencMap[l.k]=l.venc);
  let pend=L.filter(l=>!l.paga).map(l=>l.k);
  function vp(k,pagamento){
    const dias=Math.max(0,Math.round((vencMap[k]-pagamento)/86400000));
    return PMT/Math.pow(1+diaria,dias);
  }
  const kIni=ym(hoje());
  const meses=horizon(horizM,kIni);
  const dias=[];
  meses.forEach(k=>{
    const blocos=blocosDoMes(k);
    const nDias=ultimoDiaDoMes(k);
    const porDia={};
    blocos.forEach(b=>{ const d=Math.min(b.dia,nDias); porDia[d]=(porDia[d]||0)+b.saldo; });
    const [ay,am]=k.split('-').map(Number);
    for(let d=1; d<=nDias; d++){
      const data=new Date(ay,am-1,d);
      if(k===kIni && data<new Date(new Date().setHours(0,0,0,0))) continue;
      dias.push({data, delta:(porDia[d]||0)-vida/nDias, k});
    }
  });
  const n=dias.length;
  const acum=[0]; dias.forEach(dd=>acum.push(acum[acum.length-1]+dd.delta));
  const LOOKAHEAD=30;
  function folgaFutura(idx){
    const fim=Math.min(n, idx+1+LOOKAHEAD); let m=0;
    for(let j=idx+1;j<=fim;j++){ const rel=acum[j]-acum[idx+1]; if(rel<m) m=rel; }
    return m;
  }
  let saldo = saldoConta().atual ?? (+cfg().saldo_conferido||0);
  const eventos=[]; let cMesKey=null;
  for(let idx=0; idx<n && pend.length; idx++){
    const dd=dias[idx];
    saldo+=dd.delta;
    const f=folgaFutura(idx);
    let feitos=0;
    while(pend.length){
      const k=pend[pend.length-1], v=vp(k,dd.data);
      if(saldo-colchao+f>=v){ saldo-=v; pend.pop(); feitos++; } else break;
    }
    if(feitos) eventos.push({id:'ev'+(++PLANO_ID), tipo:'antecipar', data:dd.data.toISOString().slice(0,10),
      parcelas:feitos, valor:0, controla:'parcelas'});
    if(dd.k!==cMesKey && saldo-colchao+f>=500){
      saldo-=500; cMesKey=dd.k;
      eventos.push({id:'ev'+(++PLANO_ID), tipo:'guardar', data:dd.data.toISOString().slice(0,10),
        valor:500, parcelas:0, controla:'valor'});
    }
  }
  return eventos;
}

function vAmort(){
  if(FALTANDO.includes('financiamentos'))
    return head('Amortização','Esta aba precisa de uma tabela que ainda não existe no seu banco.')
      +'<div class="warn">Rode <b>'+MIGRACAO_DE.financiamentos+'</b> no SQL Editor e recarregue.</div>';
  const fins=D.financiamentos.filter(f=>f.ativo);
  if(!fins.length)
    return head('Amortização','Nenhum financiamento cadastrado.')
      +`<div class="info">Rode <b>migracao-financiamento.sql</b> para carregar o contrato do carro,
        ou cadastre um financiamento no banco.</div>`;
  const f = fins.find(x=>x.id===FIN_SEL) || fins[0];
  const R = resumoFin(f);
  const fmtD = d => d ? String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+d.getFullYear() : '—';
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

    <div class="painel-plano">
  ${(()=>{
    const eventos=(PLANO_EVENTOS[f.id]||[]).map(e=>({...e, data:new Date(e.data+'T12:00:00')}));
    if(!eventos.length){
      return `<div class="panel"><h2>Nenhum evento ainda</h2><div class="pbody">
        <p class="note" style="margin-bottom:12px">Monte sua própria lista: quando você antecipa,
        quanto, ou quando guarda na caixinha. O app mostra o efeito real, dia a dia — sem decidir
        por você.</p>
        <button class="btn" onclick="gerarSugestaoPlano('${f.id}')">Começar com uma sugestão</button>
        <button class="btn alt" onclick="addEvento('${f.id}','antecipar')">Adicionar do zero</button>
      </div></div>`;
    }
    const R=curvaComEventos(f, eventos, PLANO_VIDA, PLANO_HORIZ);
    const temPerigo = R.curva.some(d=>d.saldo<PLANO_COLCHAO);

    const C=R.curva;
    const vs=C.map(x=>x.saldo);
    const mn=Math.min(0,PLANO_COLCHAO,...vs), mx=Math.max(...vs,PLANO_COLCHAO+100);
    const larg=760, alt=170;
    const px=idx=>20+idx*((larg-30)/Math.max(1,C.length-1));
    const py=v=>alt-((v-mn)/((mx-mn)||1))*(alt-16)+8;
    const pts=C.map((x,idx)=>px(idx)+','+py(x.saldo)).join(' ');
    const marcas=R.resolvidos.map(ev=>{
      const idx=C.findIndex(x=>x.data.getTime()===ev.data.getTime());
      if(idx<0) return '';
      const cor = ev.tipo==='guardar' ? 'var(--amber)' : 'var(--pos)';
      const emPerigo = C[idx].saldo < PLANO_COLCHAO;
      return `<circle cx="${px(idx)}" cy="${py(C[idx].saldo)}" r="3.5" fill="${emPerigo?'var(--neg)':cor}"/>`;
    }).join('');
    let ultimoK=null; const rotulosX=[];
    C.forEach((x,idx)=>{ if(x.k!==ultimoK){ rotulosX.push({idx,k:x.k}); ultimoK=x.k; } });

    return `<div class="hero-plano">
      <div class="rot">Carro quitado em</div>
      <div class="val">${R.quitadoEm?fmtD(R.quitadoEm):(R.restam+' parcelas ainda sem evento')}</div>
      <div class="sub">
        <div>Economia em juros<b>${BRL(R.resolvidos.filter(e=>e.tipo==='antecipar').reduce((s,e)=>s+(e.parcelasReais*(+f.valor_parcela)-e.valorReal),0))}</b></div>
        <div>Total antecipado<b>${BRL(R.resolvidos.filter(e=>e.tipo==='antecipar').reduce((s,e)=>s+e.valorReal,0))}</b></div>
        <div>Guardado na caixinha<b>${BRL(R.resolvidos.filter(e=>e.tipo==='guardar').reduce((s,e)=>s+e.valorReal,0))}</b></div>
        <div>Pior momento<b style="color:${R.pior.saldo<0?'#FFB4A8':'#fff'}">${BRL(R.pior.saldo)}</b></div>
      </div>
    </div>

    ${temPerigo?`<div class="warn" style="margin-bottom:14px">
      <b>Essa lista fura o colchão em algum momento.</b> Os pontos vermelhos no gráfico e as linhas
      marcadas embaixo mostram onde — ajuste a data, o valor, ou tire uma linha pra corrigir.</div>`:''}

    <div class="panel"><h2>Fluxo de caixa<small>consequência real da sua lista, dia a dia</small></h2>
      <div class="pbody">
        <svg width="100%" height="${alt+34}" viewBox="0 0 ${larg} ${alt+34}" preserveAspectRatio="none" role="img">
          <line x1="14" y1="${py(PLANO_COLCHAO)}" x2="${larg-10}" y2="${py(PLANO_COLCHAO)}"
            stroke="var(--amber)" stroke-dasharray="4 3" stroke-width="1"/>
          <line x1="14" y1="${py(0)}" x2="${larg-10}" y2="${py(0)}" stroke="var(--rule)" stroke-width="1"/>
          <polyline points="${pts}" fill="none" stroke="var(--steel)" stroke-width="1.6"/>
          ${marcas}
          ${rotulosX.filter((_,i)=>i%2===0).map(r=>
            `<text x="${px(r.idx)}" y="${alt+22}" font-size="9" fill="var(--muted)" text-anchor="middle">${mLabel(r.k).slice(0,3)}</text>`
          ).join('')}
        </svg>
        <div class="legenda" style="margin-top:2px">
          <span><i style="background:var(--pos)"></i>antecipa</span>
          <span><i style="background:var(--amber)"></i>guarda</span>
          <span><i style="background:var(--neg)"></i>fura o colchão</span>
          <span style="color:var(--amber)">┄ colchão (${BRL(PLANO_COLCHAO)})</span>
        </div>
      </div>
    </div>

    <div class="panel"><h2>Seus eventos<small>edite valor ou parcelas — um trava o outro</small></h2>
    <div class="tw"><table><thead><tr>
      <th style="width:96px">Tipo</th><th style="width:126px">Data</th><th class="r">Valor</th>
      <th class="r" style="width:92px">Parcelas</th><th>Quais</th><th></th>
    </tr></thead><tbody>
    ${eventos.slice().sort((a,b)=>a.data-b.data).map(ev=>{
      const res=R.resolvidos.find(r=>r.id===ev.id);
      const emPerigo = res && C.find(x=>x.data.getTime()===ev.data.getTime())?.saldo < PLANO_COLCHAO;
      return `<tr style="${emPerigo?'background:var(--neg-bg)':''}">
        <td><select onchange="setEvento('${f.id}','${ev.id}','tipo',this.value)">
          <option value="antecipar" ${ev.tipo==='antecipar'?'selected':''}>Antecipar</option>
          <option value="guardar" ${ev.tipo==='guardar'?'selected':''}>Guardar</option>
        </select></td>
        <td><input type="date" value="${ev.data.toISOString().slice(0,10)}"
          onchange="setEvento('${f.id}','${ev.id}','data',this.value)"></td>
        <td class="r"><input type="number" min="0" step="10" value="${(res?.valorReal ?? ev.valor ?? 0).toFixed(2)}"
          style="width:100px;text-align:right;${ev.controla==='valor'?'font-weight:700':''}"
          onchange="setEvento('${f.id}','${ev.id}','valor',this.value)"></td>
        <td class="r">${ev.tipo==='antecipar'
          ? `<input type="number" min="0" max="30" step="1" value="${res?.parcelasReais ?? ev.parcelas ?? 0}"
              style="width:56px;text-align:center;${ev.controla==='parcelas'?'font-weight:700':''}"
              onchange="setEvento('${f.id}','${ev.id}','parcelas',this.value)">`
          : '<span class="note">—</span>'}</td>
        <td>${res&&res.compradas&&res.compradas.length
          ? res.compradas.map(c=>`<span class="tag t-g">${c.parcela}</span>`).join(' ')
          : (ev.tipo==='guardar'?'<span class="note">caixinha</span>':'<span class="note">nenhuma</span>')}
          ${emPerigo?' <span class="tag t-no">fura o colchão</span>':''}</td>
        <td class="r"><button class="btn dgr" onclick="delEvento('${f.id}','${ev.id}')">excluir</button></td>
      </tr>`;
    }).join('')}
    </tbody></table></div>
    <div class="pbody">
      <button class="btn" onclick="addEvento('${f.id}','antecipar')">+ antecipar parcela</button>
      <button class="btn alt" onclick="addEvento('${f.id}','guardar')">+ guardar na caixinha</button>
      <button class="btn alt" onclick="gerarSugestaoPlano('${f.id}')">recomeçar com sugestão automática</button>
      <button class="btn alt" onclick="limparPlano('${f.id}')">limpar tudo</button>
    </div>
    </div>

    <div class="panel"><h2>Ajustes gerais</h2><div class="pbody">
      <p class="note" style="margin-bottom:14px">"Vida" é a única suposição do app — gasolina, mercado
      e lazer não são rastreados por pedido seu. O colchão só marca a linha no gráfico; ele não trava
      seus eventos, só avisa quando alguma data fica abaixo dele.</p>
      <div class="sliders-plano">
        <div class="sl-plano">
          <label>Vida — gasolina, mercado, lazer <span>${BRL(PLANO_VIDA)}</span></label>
          <input type="range" min="1000" max="3000" step="50" value="${PLANO_VIDA}"
            oninput="setPlano('vida',this.value)">
          <div class="faixa"><span>1.000</span><span>3.000</span></div>
        </div>
        <div class="sl-plano">
          <label>Colchão mínimo (linha de referência) <span>${BRL(PLANO_COLCHAO)}</span></label>
          <input type="range" min="100" max="800" step="50" value="${PLANO_COLCHAO}"
            oninput="setPlano('colchao',this.value)">
          <div class="faixa"><span>100</span><span>800</span></div>
        </div>
      </div>
    </div></div>

    <div class="panel"><h2>Mês a mês</h2>
    <div class="tw"><table><thead><tr><th>Mês</th><th class="r">Renda</th>
      <th class="r">Comprometido</th><th class="r">Eventos do mês</th><th class="r">Sobra livre</th>
    </tr></thead><tbody>
    ${horizon(PLANO_HORIZ,ym(hoje())).map(k=>{
      const bl=blocosDoMes(k);
      const renda=bl.reduce((s,b)=>s+b.tIn,0), comprometido=bl.reduce((s,b)=>s+b.tOut,0);
      const doMes=R.resolvidos.filter(e=>ym2(e.data)===k);
      const gastoMes=doMes.reduce((s,e)=>s+(e.valorReal||0),0);
      const sobra=renda-comprometido-PLANO_VIDA-gastoMes;
      if(!doMes.length && renda===0 && comprometido===0) return '';
      return `<tr><td>${mLabel(k)}</td><td class="r">${BRL(renda)}</td><td class="r">${BRL(comprometido)}</td>
        <td class="r">${doMes.length?doMes.map(e=>e.tipo==='antecipar'?e.parcelasReais+'x':'caixinha').join(', '):'—'}
          ${gastoMes?` (${BRL(gastoMes)})`:''}</td>
        <td class="r" style="color:${sobra<0?'var(--neg)':'inherit'}"><b>${BRL(sobra)}</b></td></tr>`;
    }).join('')}
    </tbody></table></div></div>`;
  })()}
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

/* =====================================================================
   CALENDÁRIO
   ===================================================================== */
let CAL_MES=null, CAL_DIA=null;
const DIAS_SEM=['dom','seg','ter','qua','qui','sex','sáb'];
const CORES={entrada:'var(--pos)',saida:'var(--neg)',fatura:'var(--steel)',
  reserva:'var(--amber)',protegido:'#7E57C2',beneficio:'#8A6A12',
  compromisso:'var(--ink)',lembrete:'var(--amber)',financeiro:'var(--steel)',
  lancado:'var(--muted)'};
const ROTULO={entrada:'entra',saida:'sai',fatura:'fatura',reserva:'reserva',
  protegido:'Reports',beneficio:'benefício',compromisso:'compromisso',
  lembrete:'lembrete',financeiro:'financeiro',lancado:'lançado'};

function vCal(){
  if(FALTANDO.includes('agenda'))
    return head('Calendário','Esta aba precisa da tabela de agenda, que ainda não existe no seu banco.')
      +`<div class="warn">Rode <b>migracao-agenda.sql</b> no Supabase e recarregue.</div>`;
  const k = CAL_MES || MREF;
  const [ano,m] = k.split('-').map(Number);
  const primeiro = new Date(ano, m-1, 1);
  const nDias = ultimoDiaDoMes(k);
  const off = primeiro.getDay();
  const hojeStr = hoje();
  const diaSel = CAL_DIA && CAL_DIA.startsWith(k) ? +CAL_DIA.slice(8) : null;

  const celulas=[];
  for(let i=0;i<off;i++) celulas.push('<div class="cd vazio"></div>');
  for(let d=1; d<=nDias; d++){
    const data=k+'-'+String(d).padStart(2,'0');
    const ev=eventosDoDia(k,d);
    const fds=new Date(ano,m-1,d).getDay();
    const pontos=[...new Set(ev.map(e=>e.t))].slice(0,5)
      .map(t=>`<i style="background:${CORES[t]||'var(--muted)'}"></i>`).join('');
    celulas.push(`<button class="cd ${data===hojeStr?'hoje':''} ${d===diaSel?'sel':''} ${
      fds===0||fds===6?'fds':''}" onclick="selDia('${data}')">
      <span class="dn">${d}</span>
      <span class="pontos">${pontos}</span>
      ${ev.length>5?`<span class="mais">+${ev.length-5}</span>`:''}
    </button>`);
  }

  const evSel = diaSel ? eventosDoDia(k,diaSel) : [];
  const meses=mesesDisponiveis();

  return head('Calendário','Compromissos que você marca, junto com o que o app já sabe que vence.')
  +`<div class="rowbar">
    <div class="fld" style="max-width:170px"><label>Mês</label>
      <select onchange="setCalMes(this.value)">
        ${meses.map(x=>`<option value="${x}" ${x===k?'selected':''}>${mLabel(x)}</option>`).join('')}
      </select></div>
    <div style="flex:1"></div>
    <button class="btn alt sm" onclick="setCalMes('${addM(k,-1)}')">← anterior</button>
    <button class="btn alt sm" onclick="setCalMes('${addM(k,1)}')">próximo →</button>
  </div>

  <div class="panel"><div class="cal">
    <div class="chead">${DIAS_SEM.map(x=>`<span>${x}</span>`).join('')}</div>
    <div class="cgrid">${celulas.join('')}</div>
    <div class="cleg">
      ${['entrada','saida','fatura','reserva','compromisso','lembrete'].map(t=>
        `<span><i style="background:${CORES[t]}"></i>${ROTULO[t]}</span>`).join('')}
    </div>
  </div></div>

  ${diaSel?`<div class="panel"><h2>${String(diaSel).padStart(2,'0')}/${mLabel(k)}
    <small>${DIAS_SEM[new Date(ano,m-1,diaSel).getDay()]}${
      k+'-'+String(diaSel).padStart(2,'0')===hojeStr?' · hoje':''}</small></h2>
    <div class="pbody">
      ${evSel.length?evSel.map(e=>`
        <div class="dline ${e.feito?'dim':''}">
          <span>
            <i class="pt" style="background:${CORES[e.t]||'var(--muted)'}"></i>
            ${e.id&&e.t!=='lancado'?`<input type="checkbox" ${e.feito?'checked':''}
              style="width:auto;margin-right:6px;cursor:pointer"
              onchange="concluirAgenda('${e.id}',this.checked)">`:''}
            ${esc(e.txt)}
            <span class="tag t-g">${ROTULO[e.t]||e.t}</span>
            ${e.quem?`<span class="tag t-i">${esc(e.quem)}</span>`:''}
            ${e.obs?`<br><span class="note" style="margin-left:16px">${esc(e.obs)}</span>`:''}
          </span>
          <span style="white-space:nowrap">
            ${e.v!=null?`<b style="color:${e.t==='entrada'?'var(--pos)':(e.t==='saida'||e.t==='fatura'?'var(--neg)':'inherit')}">${BRL(e.v)}</b>`:''}
            ${e.id&&e.t!=='lancado'?`<button class="btn dgr" onclick="delRow('agenda','${e.id}')">excluir</button>`:''}
          </span>
        </div>`).join('')
      :'<p class="note">Nada marcado neste dia.</p>'}

      <div class="kgroup sub" style="margin-top:16px">Marcar algo neste dia</div>
      <div class="form">
        <div class="fld" style="grid-column:span 2"><label>O quê</label>
          <input id="ag_t" placeholder="Ex.: Cartório da casa, consulta, cobrar a Jaqueline"></div>
        <div class="fld"><label>Tipo</label>
          <select id="ag_tp">
            <option value="compromisso">Compromisso</option>
            <option value="financeiro">Financeiro</option>
            <option value="lembrete">Lembrete</option>
          </select></div>
        <div class="fld"><label>Valor (opcional)</label>
          <input type="number" step="0.01" id="ag_v" placeholder="—"></div>
        <div class="fld"><label>&nbsp;</label>
          <button class="btn" onclick="addAgenda('${k}-${String(diaSel).padStart(2,'0')}')">Marcar</button></div>
      </div>
    </div></div>`
  :`<div class="info">Toque num dia para ver o que tem e marcar algo.</div>`}

  ${(()=>{
    const prox=D.agenda.filter(a=>!a.concluido && a.data>=hojeStr)
      .sort((a,b)=>a.data.localeCompare(b.data)).slice(0,6);
    if(!prox.length) return '';
    return `<div class="panel"><h2>Próximos compromissos</h2><div class="pbody">
      ${prox.map(a=>{
        const dias=Math.round((new Date(a.data+'T12:00:00')-new Date(hojeStr+'T12:00:00'))/86400000);
        return `<div class="dline"><span>
          <i class="pt" style="background:${CORES[a.tipo]}"></i>
          ${esc(a.titulo)} <span class="note">${a.data.split('-').reverse().join('/')}</span>
          <span class="tag ${dias<=3?'t-w':'t-g'}">${dias===0?'hoje':dias===1?'amanhã':'em '+dias+' dias'}</span>
        </span><span>${a.valor?BRL(a.valor):''}</span></div>`;}).join('')}
    </div></div>`;
  })()}`;
}
window.setCalMes=v=>{ CAL_MES=v; CAL_DIA=null; render(); };
window.selDia=v=>{ CAL_DIA = CAL_DIA===v ? null : v; render(); };
window.addAgenda=async(data)=>{
  const t=$('ag_t').value.trim();
  if(!t) return toast('Escreva o que é');
  const v=parseFloat($('ag_v').value);
  if(await inserir('agenda',{data, titulo:t, tipo:$('ag_tp').value,
      valor:isNaN(v)?null:v, concluido:false, criado_por:USER?.id||null})){
    render(); toast('Marcado em '+data.split('-').reverse().join('/'));
  }
};
window.concluirAgenda=async(id,v)=>{
  if(await atualizar('agenda',id,{concluido:v})){ render(); toast(v?'Concluído':'Reaberto'); }
};

/* =====================================================================
   CÓPIAS DE SEGURANÇA
   ===================================================================== */
function vBackup(){
  if(FALTANDO.includes('snapshots'))
    return head('Cópias de segurança','Esta aba precisa da tabela de cópias, que ainda não existe no seu banco.')
      +`<div class="warn">Rode <b>migracao-backup.sql</b> no Supabase e recarregue.</div>`;
  const snaps=[...D.snapshots].sort((a,b)=>String(b.criado_em).localeCompare(String(a.criado_em)));
  const ultima=snaps[0];
  const qdo=x=>{ const d=new Date(x.criado_em);
    return String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+
           ' às '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
  const dias = ultima ? Math.floor((Date.now()-new Date(ultima.criado_em))/86400000) : null;

  return head('Cópias de segurança','O plano gratuito do Supabase não faz backup automático. Estas cópias são a sua rede de proteção.')
  +(dias!==null && dias>=7
    ? `<div class="warn" style="margin-bottom:16px"><b>A última cópia tem ${dias} dias.</b>
       Vale tirar uma nova antes de mexer em qualquer coisa.</div>`
    : '')
  +`<div class="panel"><h2>Tirar uma cópia agora</h2><div class="pbody">
    <div class="form">
      <div class="fld" style="grid-column:span 2"><label>Para lembrar depois do que é</label>
        <input id="bk_r" placeholder="Ex.: antes de acertar as faturas de outubro"></div>
      <div class="fld"><label>&nbsp;</label><button class="btn" onclick="tirarCopia()">Tirar cópia</button></div>
    </div>
    <p class="note" style="margin-top:10px">Guarda tudo: renda, contas, cartões, parcelas, lançamentos,
    terceiros, metas, agenda e configuração. Ficam salvas as 20 mais recentes.</p>
  </div></div>

  <div class="panel"><h2>Cópias guardadas <small>${snaps.length} de 20</small></h2>
  <div class="tw"><table><thead><tr>
    <th>Quando</th><th>O que é</th><th class="r">Linhas</th><th></th>
  </tr></thead><tbody>
  ${snaps.map((x,i)=>`<tr>
    <td class="mono">${qdo(x)}</td>
    <td>${esc(x.rotulo)}${x.automatico?' <span class="tag t-g">automática</span>':''}${
      i===0?' <span class="tag t-ok">mais recente</span>':''}</td>
    <td class="r">${x.linhas}</td>
    <td class="r"><button class="btn alt sm" onclick="restaurarCopia('${x.id}','${esc(x.rotulo)}')">Restaurar</button></td>
  </tr>`).join('')||'<tr><td colspan="4" class="note" style="padding:18px;text-align:center">Nenhuma cópia ainda.</td></tr>'}
  </tbody></table></div></div>

  <div class="panel"><h2>Como isso protege vocês</h2><div class="pbody"><div class="dl">
    <div class="di"><b>Cópia dentro do banco</b><p>É o desfazer rápido. Restaurar devolve tudo ao
      estado da foto, e antes disso o app guarda automaticamente como está agora — se a restauração
      for o erro, dá para voltar dela também.</p></div>
    <div class="di"><b>Arquivo no seu computador</b><p>O botão <b>Exportar backup</b>, ali em cima,
      baixa um JSON com tudo. Serve para o caso do projeto no Supabase sumir. Guarde no Git ou
      em qualquer pasta que você já faça backup.</p></div>
    <div class="di"><b>Quando tirar uma cópia</b><p>Antes de rodar qualquer SQL, antes de mexer em
      cadastro em lote, e uma vez por mês depois de fechar as faturas. Leva dois segundos.</p></div>
  </div></div></div>`;
}
window.tirarCopia=async()=>{
  const r=$('bk_r').value.trim();
  const {error}=await sb.rpc('criar_snapshot',{p_grupo:GRUPO, p_rotulo:r||null, p_auto:false});
  if(error) return toast('Erro ao criar cópia: '+error.message, 4200);
  await carregarTudo(); render(); toast('Cópia guardada');
};
window.restaurarCopia=async(id,rotulo)=>{
  if(!confirm('Restaurar a cópia "'+rotulo+'"?\n\nTudo que mudou depois dela será desfeito.\n'+
              'O estado atual será guardado antes, então dá para voltar.')) return;
  const {data,error}=await sb.rpc('restaurar_snapshot',{p_id:id});
  if(error) return toast('Erro ao restaurar: '+error.message, 4200);
  await carregarTudo(); render(); toast(data||'Restaurado', 4200);
};

/* =====================================================================
   DASHBOARD — tudo calculado a partir do banco, nada fixo no código
   ===================================================================== */

/* Patrimônio separado: bem financiado não é a mesma coisa que dívida de
   cartão. O carro vale dinheiro e entra do lado dos ativos. */
function patrimonio(){
  const S=saldoConta();
  const conta = S.atual==null ? 0 : S.atual;
  const guardado = (+cfg().reserva_atual||0) + D.metas.reduce((s,m)=>s+ +m.guardado,0);
  const receber = aReceber();
  const bens = D.financiamentos.filter(f=>f.ativo)
    .reduce((s,f)=>s+(+f.valor_bem||0),0);
  const divFin = D.financiamentos.filter(f=>f.ativo)
    .reduce((s,f)=>s+resumoFin(f).saldo,0);
  const divCartao = saldoParc();
  return {conta, guardado, receber, bens,
          tem: conta+guardado+receber+bens,
          divFin, divCartao, deve: divFin+divCartao,
          liquido: conta+guardado+receber+bens-divFin-divCartao,
          equity: bens-divFin,
          pctQuitado: bens>0 ? (bens-divFin)/bens : 0,
          saldoConta:S};
}

/* Os indicadores que dizem se as contas estão saudáveis. */
function indicadores(k){
  /* Uma fonte da verdade: a sobra vem do mesmo fluxo que o painel usa,
     incluindo os lançamentos avulsos. Recalcular aqui já fez o Dashboard
     divergir do Painel em R$ 780 uma vez. */
  const F=fluxo(1,null,k)[0];
  const renda=F.renda;
  const fix=F.fix;
  const fat=F.cart;
  const parcelasCartao=parcelasMes(k);
  const financ=D.financiamentos.filter(f=>f.ativo)
    .reduce((s,f)=>s+(+f.valor_parcela||0),0);
  const servico=parcelasCartao+financ;
  const assin=totAssin(k);
  const sobra=F.sal;
  const P=patrimonio();
  const custoMensal=fix+assin;
  const guardadoMes=D.lancamentos
    .filter(l=>mesDeCaixa(l)===k && l.categoria==='Reserva' && l.tipo==='Saída')
    .reduce((s,l)=>s+ +l.valor,0);
  return {
    renda, fix, fat, assin, sobra, servico, financ, parcelasCartao,
    pctSobra: renda?sobra/renda:0,
    pctFix: renda?fix/renda:0,
    pctServico: renda?servico/renda:0,
    pctAssin: renda?assin/renda:0,
    guardadoMes, pctPoupanca: renda?guardadoMes/renda:0,
    mesesReserva: custoMensal>0 ? P.guardado/custoMensal : 0,
    custoMensal, patr:P
  };
}

/* Série da dívida: quanto falta em cada mês, separando cartão de financiamento. */
function serieDivida(n=12, ini){
  const base=ini||ym(hoje());
  return horizon(n,base).map(k=>{
    const cart=D.parcelamentos.reduce((s,p)=>{
      const restam=mesesDaParcela(p).filter(m=>m>=k).length;
      return s + restam*(+p.valor_parcela);
    },0);
    const fin=D.financiamentos.filter(f=>f.ativo).reduce((s,f)=>{
      const L=tabelaAmortizacao(f);
      const pagas=+f.parcelas_pagas + Math.max(0,mesesEntre(ym(hoje()),k));
      const i=Math.min(pagas, L.length-1);
      return s + (pagas>=L.length ? 0 : L[i].ini);
    },0);
    return {k, cart, fin, total:cart+fin};
  });
}

/* Para onde foi o dinheiro, por categoria, no mês. */
function gastosPorCategoria(k){
  const m={};
  const soma=(cat,v)=>{ m[cat]=(m[cat]||0)+v; };
  D.fixas.filter(f=>f.ativo).forEach(f=>soma(f.categoria||'Outros',+f.valor));
  D.cartoes.filter(c=>c.ativo).forEach(c=>{
    const v=venceNoDia1(c.nome)?faturaCartao(c.nome,addM(k,1)):faturaCartao(c.nome,k);
    if(v>0) soma('Cartão',v);
  });
  avulsosDoMes(k).filter(l=>l.tipo==='Saída').forEach(l=>soma(l.categoria||'Outros',+l.valor));
  return Object.entries(m).map(([cat,v])=>({cat,v})).sort((a,b)=>b.v-a.v);
}

/* Previsto contra realizado nos meses já fechados. */
function previstoRealizado(n=3){
  const atual=ym(hoje());
  const out=[];
  for(let i=n;i>=1;i--){
    const k=addM(atual,-i);
    const f=fluxo(1,null,k)[0];
    const r=realizado(k);
    out.push({k, prevRenda:f.renda, prevSaida:f.out,
              realRenda:r.ent, realSaida:r.sai,
              difSaida:r.sai-f.out, temDados:r.n>0});
  }
  return out;
}

/* ---- Motor de observações ----
   Cada detector olha um aspecto dos dados e decide sozinho se tem algo a
   dizer. Devolve nada quando não tem. Cada achado traz uma relevância, e só
   os mais relevantes aparecem — assim o painel muda de assunto conforme a
   situação muda, em vez de repetir as mesmas frases todo mês. */
const DETECTORES=[

/* --- reserva --- */
(c)=>{
  const {I,P}=c;
  if(I.custoMensal<=0) return null;
  if(I.mesesReserva>=6) return {t:'bom',rel:20,h:'A reserva cobre '+I.mesesReserva.toFixed(1)+' meses',
    p:`Com <b>${BRL(P.guardado)}</b> guardados vocês aguentam bem mais que os 3 meses recomendados.`};
  if(I.mesesReserva>=3) return {t:'bom',rel:35,h:'A reserva já cobre 3 meses',
    p:`<b>${BRL(P.guardado)}</b> guardados contra ${BRL(I.custoMensal)} de custo mensal.
       O próximo degrau são 6 meses: faltam ${BRL(I.custoMensal*6-P.guardado)}.`};
  const alvo=I.custoMensal*3, falta=alvo-P.guardado;
  return {t:P.guardado<=0?'ruim':'aten', rel:P.guardado<=0?95:70,
    h:P.guardado<=0?'Vocês não têm colchão nenhum':'A reserva ainda não cobre 3 meses',
    p:`${P.guardado>0?`Têm <b>${BRL(P.guardado)}</b>, que dá ${I.mesesReserva.toFixed(1)} mês.`:''}
       Para 3 meses faltam <b>${BRL(falta)}</b> — cerca de ${BRL(Math.round(falta/12/50)*50)} por mês num ano.`};
},

/* --- comprometimento --- */
(c)=>{
  const {I}=c;
  if(!I.renda) return null;
  if(I.pctServico>0.40) return {t:'ruim',rel:90,h:'As dívidas comem quase metade da renda',
    p:`Estão em <b>${PCT(I.pctServico)}</b>, ou ${BRL(I.servico)} por mês. Acima de 40% é zona de risco:
       sobra pouco para viver e qualquer tropeço vira dívida nova.`};
  if(I.pctServico>0.30) return {t:'aten',rel:65,h:'As dívidas passam de 30% da renda',
    p:`Estão em <b>${PCT(I.pctServico)}</b>, ${BRL(I.servico)} por mês.
       Para voltar aos 30% seria preciso reduzir ${BRL(I.servico-I.renda*0.30)} mensais.`};
  return {t:'bom',rel:15,h:'As dívidas cabem na renda',
    p:`Comprometem <b>${PCT(I.pctServico)}</b>, abaixo dos 30% considerados saudáveis.`};
},

/* --- tipo de dívida --- */
(c)=>{
  const {P}=c;
  if(P.deve<=0) return {t:'bom',rel:40,h:'Vocês não devem nada',p:'Nenhuma parcela em aberto.'};
  if(P.bens<=0) return null;
  return {t:'info',rel:30,h:'Nem toda dívida é igual',
    p:`Dos ${BRL(P.deve)} que vocês devem, <b>${BRL(P.divFin)}</b> têm um bem atrás que vale
       ${BRL(P.bens)} — ${PCT(P.pctQuitado)} já é de vocês. A que pesa de verdade são os
       <b>${BRL(P.divCartao)}</b> de cartão.`};
},

/* --- terceiros --- */
(c)=>{
  const {P,k}=c;
  if(P.receber<=0) return null;
  const abertos=D.terceiros.filter(t=>!t.recebido);
  const velhos=abertos.filter(t=>t.data_saida &&
    (new Date(hoje())-new Date(t.data_saida))/86400000>=60);
  const venc=abertos.filter(t=>t.previsao && t.previsao<hoje());
  if(venc.length) return {t:'aten',rel:72,h:venc.length+' cobrança'+(venc.length===1?'':'s')+' passou do prazo',
    p:`${venc.map(t=>esc(t.pessoa)+' ('+BRL(t.valor)+')').join(', ')}.
       No total, ${BRL(P.receber)} estão na mão de terceiros.`};
  if(velhos.length) return {t:'aten',rel:55,
    h:BRL(velhos.reduce((s,t)=>s+ +t.valor,0))+' parados há mais de 60 dias',
    p:`${velhos.map(t=>esc(t.pessoa)).join(', ')} — sem prazo combinado e sem movimento.`};
  const cobre=P.receber>=P.divCartao && P.divCartao>0;
  return {t:'info',rel:cobre?45:25,h:BRL(P.receber)+' estão na mão de terceiros',
    p:cobre?`Se voltasse hoje, pagaria <b>toda</b> a dívida de cartão e ainda sobrariam
             ${BRL(P.receber-P.divCartao)}.`
           :`Dinheiro de vocês que saiu e não voltou.`};
},

/* --- bloco frágil do mês --- */
(c)=>{
  const {k}=c;
  const b=blocosDoMes(k);
  const neg=b.filter(x=>x.saldo<0).sort((a,b2)=>a.saldo-b2.saldo)[0];
  if(!neg) return null;
  return {t:'aten',rel:60,h:'O '+neg.label.toLowerCase()+' é o ponto frágil do mês',
    p:`Saem <b>${BRL(neg.tOut)}</b> e ${neg.tIn>0?`entram só ${BRL(neg.tIn)}`:'não entra nada'}.
       Esse bloco vive do que sobrou do anterior.`};
},

/* --- meses negativos à frente --- */
(c)=>{
  const {k}=c;
  const neg=fluxo(12,null,k).filter(x=>x.sal<0);
  if(!neg.length) return null;
  return {t:'ruim',rel:88,h:neg.length===1?'Um mês fecha no vermelho':neg.length+' meses fecham no vermelho',
    p:`${neg.map(x=>mLabel(x.k)+' ('+BRL(x.sal)+')').join(', ')} pela projeção atual.`};
},

/* --- assinatura cobrando em dobro --- */
(c)=>{
  const {k}=c;
  const dobro=[];
  D.cartoes.filter(x=>x.ativo).forEach(ct=>{
    D.assinaturas.filter(a=>a.projetar&&(a.cartao||'')===ct.nome).forEach(a=>{
      const vz=vezesAssinatura(a,k);
      if(vz>1) dobro.push({a,vz,ct:ct.nome});
    });
  });
  if(!dobro.length) return null;
  const extra=dobro.reduce((s,x)=>s+(+x.a.valor)*(x.vz-1),0);
  return {t:'aten',rel:68,h:'Assinatura cobrando mais de uma vez neste ciclo',
    p:`${dobro.map(x=>esc(x.a.descricao)+' ('+x.vz+'x)').join(', ')} — <b>${BRL(extra)}</b> a mais
       que um mês normal, porque o fechamento do cartão pegou dois débitos.`};
},

/* --- salto de gasto por categoria --- */
(c)=>{
  const {k}=c;
  const ant=addM(k,-1);
  const atual=gastosPorCategoria(k), anterior=gastosPorCategoria(ant);
  const mapa=Object.fromEntries(anterior.map(x=>[x.cat,x.v]));
  const saltos=atual.filter(x=>{
    const a=mapa[x.cat]||0;
    return a>0 && x.v>a*1.4 && (x.v-a)>150;
  }).sort((a,b)=>(b.v-(mapa[b.cat]||0))-(a.v-(mapa[a.cat]||0)));
  if(!saltos.length) return null;
  const s0=saltos[0], antes=mapa[s0.cat];
  return {t:'aten',rel:58,h:esc(s0.cat)+' subiu '+PCT((s0.v-antes)/antes)+' em relação ao mês passado',
    p:`De ${BRL(antes)} para <b>${BRL(s0.v)}</b>.${saltos.length>1
      ?` Também subiram: ${saltos.slice(1,3).map(x=>esc(x.cat)).join(', ')}.`:''}`};
},

/* --- fatura muito acima do previsto --- */
(c)=>{
  const {k}=c;
  const fora=[];
  D.cartoes.filter(x=>x.ativo).forEach(ct=>{
    const real=faturaLancada(ct.nome,k), calc=faturaCalculada(ct.nome,k);
    if(real && calc>0 && real.valor>calc*1.5 && (real.valor-calc)>200)
      fora.push({nome:ct.nome, real:real.valor, calc});
  });
  if(!fora.length) return null;
  const f0=fora.sort((a,b)=>(b.real-b.calc)-(a.real-a.calc))[0];
  return {t:'info',rel:50,h:'A fatura do '+f0.nome+' veio bem acima do previsto',
    p:`<b>${BRL(f0.real)}</b> contra ${BRL(f0.calc)} de parcelas e assinaturas.
       Os ${BRL(f0.real-f0.calc)} de diferença são compras do dia a dia — o gasto que o app
       não consegue prever porque não está cadastrado.`};
},

/* --- dívida cara sobrando dinheiro --- */
(c)=>{
  const {I,P}=c;
  if(I.sobra<500 || !D.financiamentos.filter(f=>f.ativo).length) return null;
  const f=D.financiamentos.filter(x=>x.ativo)[0];
  const i=taxaEfetiva(f);
  if(i<0.01) return null;
  return {t:'info',rel:42,h:'Sobrando '+BRL(I.sobra)+', amortizar rende mais que poupar',
    p:`O ${esc(f.descricao)} cobre <b>${(i*100).toFixed(2)}% ao mês</b>. Nenhuma aplicação
       segura paga isso. ${P.guardado<I.custoMensal*3
         ? 'Mas a reserva vem primeiro: sem colchão, um imprevisto vira dívida nova a juros de cartão.'
         : 'Com a reserva feita, é o melhor destino para o que sobra.'}`};
},

/* --- parcelamento terminando --- */
(c)=>{
  const {k}=c;
  const acabando=D.parcelamentos.filter(p=>+p.restantes===1);
  if(!acabando.length) return null;
  const v=acabando.reduce((s,p)=>s+ +p.valor_parcela,0);
  return {t:'bom',rel:38,h:acabando.length===1?'Uma parcela está acabando':acabando.length+' parcelas estão acabando',
    p:`${acabando.map(p=>esc(p.descricao)).join(', ')} — última parcela.
       A partir do mês seguinte sobram <b>${BRL(v)}</b> a mais.`};
},

/* --- assinaturas pesando --- */
(c)=>{
  const {I}=c;
  if(!I.renda || I.pctAssin<0.05) return null;
  const lista=D.assinaturas.filter(a=>a.projetar).sort((a,b)=>b.valor-a.valor);
  return {t:'aten',rel:44,h:'Assinaturas já são '+PCT(I.pctAssin)+' da renda',
    p:`${BRL(I.assin)} por mês, ${BRL(I.assin*12)} no ano. A maior é
       ${esc(lista[0].descricao)}, com ${BRL(lista[0].valor)}.`};
},

/* --- nada lançado no mês --- */
(c)=>{
  const {k}=c;
  if(k>=ym(hoje())) return null;
  if(realizado(k).n>0) return null;
  return {t:'info',rel:75,h:mLabel(k)+' não tem nenhum lançamento',
    p:`Os números deste mês são projeção, não o que aconteceu de verdade.`};
},
];

/* Roda todos os detectores e devolve os mais relevantes. */
function insights(k, quantos){
  const I=indicadores(k), P=I.patr;
  const ctx={I,P,k};
  const achados=[];
  for(const det of DETECTORES){
    try{ const r=det(ctx); if(r) achados.push(r); }catch(e){ /* um detector que falha não derruba os outros */ }
  }
  return achados.sort((a,b)=>b.rel-a.rel).slice(0, quantos||5);
}

/* ---- Curva do saldo dia a dia ----
   Mostra o ponto mais baixo do mês, que é quando o cheque especial entra. */
function curvaDiaria(k){
  const n=ultimoDiaDoMes(k);
  const S=saldoConta();
  const blocos=blocosDoMes(k);
  /* ponto de partida: o saldo de hoje, ou o do fim do mês anterior */
  let saldo = (k===ym(hoje()) && S.atual!=null) ? S.atual
            : (S.base!=null ? S.base : 0);
  const porDia={};
  blocos.forEach(b=>{
    const d=Math.min(b.dia,n);
    porDia[d]=porDia[d]||{ent:0,sai:0,itens:[]};
    porDia[d].ent+=b.tIn; porDia[d].sai+=b.tOut;
    porDia[d].itens.push(...b.entradas.map(x=>({...x,sinal:1})),
                         ...b.saidas.map(x=>({...x,sinal:-1})));
  });
  const linha=[];
  for(let d=1; d<=n; d++){
    const m=porDia[d];
    if(m) saldo += m.ent - m.sai;
    linha.push({dia:d, saldo, ent:m?m.ent:0, sai:m?m.sai:0, itens:m?m.itens:[]});
  }
  const min=linha.reduce((a,b)=>b.saldo<a.saldo?b:a);
  const max=linha.reduce((a,b)=>b.saldo>a.saldo?b:a);
  return {linha, min, max, inicio:linha[0].saldo, fim:linha[n-1].saldo};
}

/* ---- Limite dos cartões ---- */
function usoDosLimites(k){
  return D.cartoes.filter(c=>c.ativo && +c.limite>0).map(c=>{
    const fatura=venceNoDia1(c.nome)?faturaCartao(c.nome,addM(k,1)):faturaCartao(c.nome,k);
    const parcelasFuturas=D.parcelamentos.filter(p=>(p.cartao||'')===c.nome)
      .reduce((s,p)=>s+mesesDaParcela(p).filter(m=>m>k).length*(+p.valor_parcela),0);
    const terceiros=D.terceiros.filter(t=>t.cartao===c.nome && !t.recebido)
      .reduce((s,t)=>s+ +t.valor,0);
    const usado=fatura+parcelasFuturas;
    return {nome:c.nome, limite:+c.limite, fatura, parcelasFuturas, terceiros,
            usado, livre:Math.max(0,+c.limite-usado), pct:(+c.limite)?usado/(+c.limite):0};
  }).sort((a,b)=>b.pct-a.pct);
}

/* ---- Comparação com meses anteriores ---- */
function comparativo(k, n){
  const meses=[]; const q=n||6;
  for(let i=q;i>=1;i--){
    const m=addM(k,-i);
    const f=fluxo(1,null,m)[0];
    const r=realizado(m);
    meses.push({k:m, prev:f.out, real:r.sai, temDados:r.n>0, sobra:f.sal});
  }
  const atual=fluxo(1,null,k)[0];
  const comDados=meses.filter(m=>m.temDados);
  const mediaReal=comDados.length?comDados.reduce((s,m)=>s+m.real,0)/comDados.length:null;
  const mediaPrev=meses.reduce((s,m)=>s+m.prev,0)/meses.length;
  return {meses, atual, mediaReal, mediaPrev,
          desvio: mediaPrev? (atual.out-mediaPrev)/mediaPrev : 0,
          melhor: meses.reduce((a,b)=>b.sobra>a.sobra?b:a, meses[0]),
          pior:   meses.reduce((a,b)=>b.sobra<a.sobra?b:a, meses[0])};
}

/* ---- Apoio à decisão ----
   Perguntas concretas que os números conseguem responder. */

/* Quantos meses vocês aguentam se a renda parar hoje. */
function folego(){
  const P=patrimonio();
  const custo=totFixas()+totAssin()+(D.financiamentos.filter(f=>f.ativo)
    .reduce((s,f)=>s+(+f.valor_parcela||0),0));
  const liquido=P.conta+P.guardado;
  return {meses: custo>0?liquido/custo:0, liquido, custo};
}

/* Onde colocar um dinheiro que sobrou: comparação honesta. */
function ondeAplicar(valor){
  const opcoes=[];
  D.financiamentos.filter(f=>f.ativo).forEach(f=>{
    const i=taxaEfetiva(f);
    const L=tabelaAmortizacao(f).filter(l=>!l.paga);
    let resta=valor, quitadas=0, economia=0;
    for(let k=L.length-1;k>=0 && resta>0;k--){
      const meses=(L[k].k)-(+f.parcelas_pagas);
      const vp=(+f.valor_parcela)/Math.pow(1+i,meses);
      if(vp>resta) break;
      resta-=vp; quitadas++; economia+=(+f.valor_parcela)-vp;
    }
    if(quitadas) opcoes.push({
      nome:'Amortizar o '+f.descricao, ganho:economia, detalhe:
        quitadas+' parcela'+(quitadas===1?'':'s')+' a menos · rende '+(i*100).toFixed(2)+'% ao mês',
      tipo:'divida'});
  });
  opcoes.push({nome:'Guardar na reserva', ganho:valor*0.01*12,
    detalhe:'rende perto de 1% ao mês, e vira colchão', tipo:'reserva'});
  const P=patrimonio();
  if(P.guardado < (totFixas()+totAssin())*3)
    opcoes.push({nome:'Completar a reserva primeiro', ganho:null,
      detalhe:'sem colchão, um imprevisto vira dívida nova a juros de cartão', tipo:'alerta'});
  return opcoes.sort((a,b)=>(b.ganho||0)-(a.ganho||0));
}

/* O que cortar rende mais, e quanto por ano. */
function ondeCortar(){
  const itens=[];
  D.assinaturas.filter(a=>a.projetar).forEach(a=>
    itens.push({nome:a.descricao, mes:+a.valor, ano:(+a.valor)*12, tipo:'assinatura'}));
  D.fixas.filter(f=>f.ativo).forEach(f=>
    itens.push({nome:f.descricao, mes:+f.valor, ano:(+f.valor)*12, tipo:'fixa'}));
  return itens.sort((a,b)=>b.mes-a.mes).slice(0,8);
}

/* Meses que vão apertar nos próximos 12. */
function mesesCriticos(k, piso){
  const p=piso!==undefined?piso:(totFixas()*0.3);
  return fluxo(12,null,k).filter(x=>x.sal<p)
    .map(x=>({k:x.k, sal:x.sal, motivo:x.sal<0?'negativo':'abaixo do colchão'}));
}

/* Quando a casa cabe: primeiro mês em que sobra o suficiente. */
function quandoCabeACasa(k){
  const custoCasa=totCasa();
  if(!custoCasa) return null;
  const f=fluxo(24,null,k);
  const achou=f.find(x=>x.sal-custoCasa > totFixas()*0.3);
  return {custoCasa, mes:achou?achou.k:null,
          sobraDepois:achou?achou.sal-custoCasa:null,
          hoje:f[0].sal-custoCasa};
}

let DASH_PER='mes', DASH_CART='', DASH_QUEM='', DASH_CAT='';

function vDash(){
  const k=MREF;
  const I=indicadores(k), P=I.patr;
  const nMeses = DASH_PER==='mes'?1:DASH_PER==='3'?3:DASH_PER==='6'?6:12;
  const serie = fluxo(12,null,k);
  const dividas = serieDivida(12,k);
  const cats = gastosPorCategoria(k);
  const pr = previstoRealizado(3);
  const obs = insights(k);
  const maxCat = Math.max(...cats.map(c=>c.v),1);

  /* gráfico de linha da sobra */
  const vs=serie.map(x=>x.sal), mn=Math.min(0,...vs), mx=Math.max(...vs,1);
  const px=(i)=>20+i*(520/Math.max(1,serie.length-1));
  const py=(v)=>136-((v-mn)/((mx-mn)||1))*106;
  const linha=serie.map((x,i)=>px(i)+','+py(x.sal)).join(' ');

  /* gráfico de barras da dívida */
  const mxD=Math.max(...dividas.map(d=>d.total),1);
  const lw=Math.min(34,(520/dividas.length)-6);

  return head('Dashboard','Os números que dizem se vocês estão indo bem, e o que fazer com eles.')
  +`<div class="filtros">
    <div class="fld"><label>Mês em foco</label>
      <select onchange="setMes(this.value)">
        ${mesesDisponiveis().map(m=>`<option value="${m}" ${m===k?'selected':''}>${mLabel(m)}</option>`).join('')}
      </select></div>
    <div class="fld"><label>Horizonte dos gráficos</label>
      <select onchange="setDashPer(this.value)">
        ${[['mes','Mês a mês, 12 meses'],['3','Próximos 3 meses'],['6','Próximos 6 meses']]
          .map(([v,l])=>`<option value="${v}" ${DASH_PER===v?'selected':''}>${l}</option>`).join('')}
      </select></div>
    <div class="fld"><label>Cartão</label>
      <select onchange="setDashCart(this.value)">
        <option value="">Todos</option>
        ${D.cartoes.filter(c=>c.ativo).map(c=>
          `<option ${DASH_CART===c.nome?'selected':''}>${esc(c.nome)}</option>`).join('')}
      </select></div>
    <div class="fld"><label>Quem</label>
      <select onchange="setDashQuem(this.value)">
        <option value="">Todos</option>
        ${[...new Set(D.rendas.map(r=>r.quem).filter(Boolean))].map(q=>
          `<option ${DASH_QUEM===q?'selected':''}>${esc(q)}</option>`).join('')}
      </select></div>
    <div class="fld"><label>Categoria</label>
      <select onchange="setDashCat(this.value)">
        <option value="">Todas</option>
        ${cats.map(c=>`<option ${DASH_CAT===c.cat?'selected':''}>${esc(c.cat)}</option>`).join('')}
      </select></div>
    ${(DASH_CART||DASH_QUEM||DASH_CAT||DASH_PER!=='mes')
      ? `<button class="btn alt sm" onclick="limparDash()">limpar filtros</button>`:''}
  </div>

  <div class="kgroup">Patrimônio</div>
  <div class="patr">
    <div class="panel"><h2 style="background:var(--pos-bg);color:var(--pos)">O que vocês têm</h2>
      <div class="lista">
        <div class="dline"><span>Na conta corrente</span><span>${BRL(P.conta)}</span></div>
        <div class="dline"><span>Guardado — reserva e metas</span><span>${BRL(P.guardado)}</span></div>
        <div class="dline"><span>A receber de terceiros</span><span>${BRL(P.receber)}</span></div>
        ${D.financiamentos.filter(f=>f.ativo).map(f=>`<div class="dline">
          <span>${esc(f.bem||f.descricao)} <span class="tag t-g">bem</span></span>
          <span>${BRL(f.valor_bem||0)}</span></div>`).join('')}
        <div class="dline tot"><span><b>Total</b></span>
          <b style="color:var(--pos)">${BRL(P.tem)}</b></div>
      </div></div>

    <div class="panel"><h2 style="background:var(--neg-bg);color:var(--neg)">O que vocês devem</h2>
      <div class="lista">
        ${D.financiamentos.filter(f=>f.ativo).map(f=>`<div class="dline">
          <span>${esc(f.descricao)} <span class="tag t-g">tem o bem atrás</span></span>
          <span>${BRL(resumoFin(f).saldo)}</span></div>`).join('')}
        <div class="dline"><span>Parcelas de cartão
          <span class="tag t-no">sem bem atrás</span></span><span>${BRL(P.divCartao)}</span></div>
        <div class="dline tot"><span><b>Total</b></span>
          <b style="color:var(--neg)">${BRL(P.deve)}</b></div>
      </div></div>

    <div class="panel"><h2>Sobra de verdade</h2>
      <div class="pbody" style="text-align:center;padding:18px 15px 10px">
        <div style="font-size:31px;font-weight:700;letter-spacing:-.025em;line-height:1;
          color:${P.liquido<0?'var(--neg)':'var(--pos)'}">${BRL(P.liquido)}</div>
        <div class="note" style="margin-top:4px">patrimônio líquido</div>
      </div>
      <div class="lista">
        ${P.bens>0?`<div class="dline"><span>Do bem já é de vocês</span><span>${BRL(P.equity)}</span></div>
        <div class="dline"><span>Quanto do bem está quitado</span><span>${PCT(P.pctQuitado)}</span></div>`:''}
        <div class="dline"><span>Dívida sem bem atrás</span>
          <span style="color:var(--neg)">${BRL(P.divCartao)}</span></div>
      </div>
      <div class="pbody"><p class="note">Financiar um bem não é o mesmo que dever no cartão.
      ${P.equity>0?'O bem vale mais do que falta pagar, então ele soma.':''}</p></div>
    </div>
  </div>

  <div class="kgroup">Indicadores de ${mLabel(k)}</div>
  <div class="kpis">
    ${kpi('Sobra do mês',BRL(I.sobra),PCT(I.pctSobra)+' da renda',I.sobra<0?'neg':'pos')}
    ${kpi('Comprometimento da renda',PCT(I.pctServico),'saudável é até 30%',
      I.pctServico>0.30?'neg':I.pctServico>0.25?'amb':'pos')}
    ${kpi('Reserva de emergência',I.mesesReserva.toFixed(1)+' meses','o mínimo é 3',
      I.mesesReserva<1?'neg':I.mesesReserva<3?'amb':'pos')}
    ${kpi('Taxa de poupança',PCT(I.pctPoupanca),
      I.guardadoMes>0?BRL(I.guardadoMes)+' este mês':'nada guardado este mês',
      I.pctPoupanca>=0.1?'pos':I.pctPoupanca>0?'amb':'neg')}
    ${kpi('Dívida sem bem atrás',BRL(P.divCartao),
      I.renda?PCT(P.divCartao/I.renda)+' de uma renda':'')}
    ${P.bens>0?kpi('Bem quitado',PCT(P.pctQuitado),
      D.financiamentos.filter(f=>f.ativo).map(f=>f.parcelas_pagas+' de '+f.total_parcelas).join(' · '),'pos'):''}
  </div>

  <div class="grid2">
    <div class="panel"><h2>Para onde vai cada real<small>${mLabel(k)}</small></h2><div class="pbody">
      ${[['Contas fixas',I.fix,I.pctFix,'var(--steel)'],
         ['Dívidas',I.servico,I.pctServico,'var(--neg)'],
         ['Assinaturas',I.assin,I.pctAssin,'var(--amber)'],
         ['Sobra',I.sobra,I.pctSobra,'var(--pos)']].map(([n,v,p,cor])=>`
        <div class="medida"><span class="nome">${n}<b>${PCT(p)}</b></span>
          <span class="track" style="height:22px">
            <span class="fill" style="width:${Math.min(100,Math.max(0,p*100))}%;background:${cor}"></span>
            ${n==='Dívidas'?'<span class="lim" style="left:30%"></span>':''}
            <span class="lbl">${BRL(v)}</span></span></div>`).join('')}
      <p class="note" style="margin-top:10px">A marca escura na barra de dívidas são os 30%
      considerados saudáveis. O dia a dia não aparece porque não está cadastrado —
      ele sai da sobra.</p>
    </div></div>

    <div class="panel"><h2>O que os números dizem<small>${obs.length} observações</small></h2>
      ${obs.map(o=>`<div class="ins ${o.t}"><span class="mk"></span>
        <div><h4>${o.h}</h4><p>${o.p}</p></div></div>`).join('')}
    </div>
  </div>


  ${(()=>{
    const F=folego(), crit=mesesCriticos(k), casa=quandoCabeACasa(k);
    const cortes=ondeCortar();
    const sobra=Math.max(0,Math.round(I.sobra/100)*100);
    const app=sobra>=200?ondeAplicar(sobra):[];
    return `<div class="kgroup">Apoio à decisão</div>

    ${(()=>{
      const C=curvaDiaria(k);
      const larg=520, alt=120;
      const vs=C.linha.map(x=>x.saldo);
      const mn=Math.min(0,...vs), mx=Math.max(...vs,1);
      const px=i=>20+i*(larg/(C.linha.length-1||1));
      const py=v=>alt+14-((v-mn)/((mx-mn)||1))*alt;
      const pts=C.linha.map((x,i)=>px(i)+','+py(x.saldo)).join(' ');
      const iMin=C.linha.indexOf(C.min);
      return `<div class="panel"><h2>Saldo dia a dia<small>${mLabel(k)}</small></h2><div class="pbody">
        <svg width="100%" height="168" viewBox="0 0 560 168" preserveAspectRatio="none" role="img">
          <line x1="20" y1="${py(0)}" x2="540" y2="${py(0)}" stroke="var(--rule)"/>
          <polyline points="${pts}" fill="none" stroke="var(--steel)" stroke-width="2.2"/>
          <polyline points="${pts} ${px(C.linha.length-1)},${py(mn)} ${px(0)},${py(mn)}"
            fill="var(--steel)" opacity=".08" stroke="none"/>
          <circle cx="${px(iMin)}" cy="${py(C.min.saldo)}" r="4.5"
            fill="${C.min.saldo<0?'var(--neg)':'var(--amber)'}"/>
          <text x="${px(iMin)}" y="${py(C.min.saldo)+(C.min.saldo<mx/2?-10:18)}" font-size="11"
            fill="${C.min.saldo<0?'var(--neg)':'var(--amber)'}" font-weight="700" text-anchor="middle"
            >dia ${C.min.dia} · ${BRL(C.min.saldo)}</text>
          <g font-size="10" fill="var(--muted)" text-anchor="middle">
            ${[1,5,10,15,20,25,C.linha.length].map(d=>
              `<text x="${px(d-1)}" y="160">${d}</text>`).join('')}
          </g>
        </svg>
        <div class="tw"><table class="mini"><tbody>
          <tr><td>Começa o mês com</td><td class="r">${BRL(C.inicio)}</td></tr>
          <tr><td><b>Ponto mais baixo</b></td>
            <td class="r"><b style="color:${C.min.saldo<0?'var(--neg)':'inherit'}">${BRL(C.min.saldo)}</b>
              <span class="note">no dia ${C.min.dia}</span></td></tr>
          <tr><td>Termina com</td><td class="r">${BRL(C.fim)}</td></tr>
        </tbody></table></div>
        <p class="note" style="margin-top:10px">${C.min.saldo<0
          ? `Entre o dia ${C.min.dia} e a próxima entrada a conta fica negativa em
             ${BRL(Math.abs(C.min.saldo))}. É aí que o cheque especial entra.`
          : `O mês não fica negativo em nenhum dia. A menor folga é no dia ${C.min.dia}.`}</p>
      </div></div>`;
    })()}

    ${(()=>{
      const U=usoDosLimites(k);
      if(!U.length) return `<div class="panel"><h2>Limite dos cartões</h2><div class="pbody">
        <p class="note">Nenhum cartão tem limite cadastrado. Preencha em
        <b>Cadastros → Cartões</b> para ver quanto de cada um está ocupado.</p></div></div>`;
      const totL=U.reduce((s,x)=>s+x.limite,0), totU=U.reduce((s,x)=>s+x.usado,0);
      const totT=U.reduce((s,x)=>s+x.terceiros,0);
      return `<div class="panel"><h2>Limite dos cartões<small>${PCT(totU/totL)} ocupado</small></h2>
        <div class="pbody">
        ${U.map(x=>`<div class="medida" style="grid-template-columns:118px 1fr">
          <span class="nome">${esc(x.nome)}<b>${PCT(x.pct)}</b></span>
          <span class="track" style="height:22px">
            <span class="fill" style="width:${Math.min(100,x.pct*100)}%;background:${
              x.pct>0.8?'var(--neg)':x.pct>0.5?'var(--amber)':'var(--steel)'}"></span>
            <span class="lbl">${BRL(x.usado)} de ${BRL(x.limite)}</span></span></div>`).join('')}
        <div class="tw" style="margin-top:12px"><table class="mini"><tbody>
          <tr><td>Livre no total</td><td class="r">${BRL(totL-totU)}</td></tr>
          ${totT>0?`<tr><td>Disso, sustentando compra de terceiro</td>
            <td class="r" style="color:var(--amber)">${BRL(totT)}</td></tr>`:''}
        </tbody></table></div>
        <p class="note" style="margin-top:10px">Conta a fatura do mês mais as parcelas que ainda
        vão cair. ${totT>0?`Os ${BRL(totT)} de terceiros ocupam limite de vocês enquanto não voltam.`:''}</p>
      </div></div>`;
    })()}

    ${(()=>{
      const K=comparativo(k,6);
      const comDados=K.meses.filter(m=>m.temDados);
      return `<div class="panel"><h2>Comparando com os meses anteriores<small>últimos 6</small></h2>
        <div class="pbody">
        ${K.mediaReal!=null?`<div class="kpis" style="margin:0 0 12px">
          ${kpi('Saídas deste mês',BRL(K.atual.out),
            (K.desvio>0?'+':'')+PCT(K.desvio)+' da média prevista',
            Math.abs(K.desvio)<0.1?'':K.desvio>0?'amb':'pos')}
          ${kpi('Média realizada',BRL(K.mediaReal),comDados.length+' meses com lançamento')}
          ${kpi('Melhor mês',mLabel(K.melhor.k),'sobrou '+BRL(K.melhor.sobra),'pos')}
          ${kpi('Mês mais apertado',mLabel(K.pior.k),'sobrou '+BRL(K.pior.sobra),'amb')}
        </div>`:''}
        <div class="tw"><table><thead><tr><th>Mês</th><th class="r">Saídas previstas</th>
          <th class="r">Saídas reais</th><th class="r">Sobra</th><th style="width:110px"></th></tr></thead><tbody>
        ${K.meses.map(m=>{
          const mxS=Math.max(...K.meses.map(x=>x.prev),K.atual.out,1);
          return `<tr><td><b>${mLabel(m.k)}</b></td>
          <td class="r">${BRL(m.prev)}</td>
          <td class="r">${m.temDados?BRL(m.real):'<span class="note">sem lançamentos</span>'}</td>
          <td class="r" style="color:${m.sobra<0?'var(--neg)':'inherit'}">${BRL(m.sobra)}</td>
          <td><span class="track" style="height:7px;display:block">
            <span class="fill" style="width:${m.prev/mxS*100}%;background:var(--steel)"></span></span></td>
        </tr>`;}).join('')}
        <tr style="border-top:2px solid var(--rule)"><td><b>${mLabel(k)}</b>
          <span class="tag t-i">este mês</span></td>
          <td class="r"><b>${BRL(K.atual.out)}</b></td>
          <td class="r"><span class="note">em andamento</span></td>
          <td class="r"><b>${BRL(K.atual.sal)}</b></td>
          <td><span class="track" style="height:7px;display:block">
            <span class="fill" style="width:${K.atual.out/Math.max(...K.meses.map(x=>x.prev),K.atual.out,1)*100}%;
              background:var(--amber)"></span></span></td></tr>
        </tbody></table></div>
      </div></div>`;
    })()}

    <div class="grid2">
      <div class="panel"><h2>Meses que vão apertar<small>próximos 12</small></h2>
        <div class="pbody">
          ${crit.length
            ? `<div class="tw"><table class="mini"><thead><tr><th>Mês</th>
                <th class="r">Sobra prevista</th><th>Situação</th></tr></thead><tbody>
              ${crit.map(c=>`<tr><td><b>${mLabel(c.k)}</b></td>
                <td class="r" style="color:${c.sal<0?'var(--neg)':'var(--amber)'}">${BRL(c.sal)}</td>
                <td><span class="tag ${c.sal<0?'t-no':'t-w'}">${c.motivo}</span></td></tr>`).join('')}
              </tbody></table></div>
              <p class="note" style="margin-top:10px">Meses com sobra abaixo de
              ${BRL(totFixas()*0.3)}, que é 30% do custo fixo — a margem mínima para
              absorver um imprevisto.</p>`
            : `<p style="font-size:14px;color:var(--pos);font-weight:600">Nenhum mês aperta nos próximos 12.</p>
               <p class="note" style="margin-top:6px">Todos ficam acima de ${BRL(totFixas()*0.3)} de sobra.</p>`}
        </div></div>
    </div>

    <div class="grid2">
      ${app.length?`<div class="panel"><h2>Se sobrasse ${BRL(sobra)} hoje<small>onde renderia mais</small></h2>
        <div class="pbody">
          ${app.map((o,i)=>`<div class="dline">
            <span>${i===0&&o.ganho?'<span class="tag t-ok">melhor</span> ':''}
              <b>${esc(o.nome)}</b>
              <span class="note" style="display:block">${esc(o.detalhe)}</span></span>
            <span style="white-space:nowrap">${o.ganho!=null
              ? `<b style="color:var(--pos)">${BRL(o.ganho)}</b>
                 <span class="note" style="display:block;text-align:right">de ganho</span>`
              : '<span class="tag t-w">antes de tudo</span>'}</span></div>`).join('')}
          <p class="note" style="margin-top:10px">Amortizar dívida rende a taxa do contrato, que costuma
          ser bem maior que qualquer investimento. Mas reserva não é investimento: é o que evita
          dívida nova.</p>
        </div></div>`:''}

      <div class="panel"><h2>Onde cortaria mais<small>ordenado pelo peso mensal</small></h2>
        <div class="pbody">
          <div class="tw"><table class="mini"><thead><tr><th>Item</th>
            <th class="r">Por mês</th><th class="r">Por ano</th></tr></thead><tbody>
          ${cortes.map(c=>`<tr><td>${esc(c.nome)}
            <span class="tag t-g">${c.tipo}</span></td>
            <td class="r">${BRL(c.mes)}</td>
            <td class="r" style="font-weight:600">${BRL(c.ano)}</td></tr>`).join('')}
          </tbody></table></div>
          <p class="note" style="margin-top:10px">Cortar os três primeiros liberaria
          <b>${BRL(cortes.slice(0,3).reduce((s,c)=>s+c.mes,0))}</b> por mês,
          ou ${BRL(cortes.slice(0,3).reduce((s,c)=>s+c.ano,0))} no ano.</p>
        </div></div>
    </div>

    ${casa?`<div class="panel"><h2>Quando a casa cabe<small>cenário da aba Projeções Casa</small></h2>
      <div class="pbody">
        <div class="kpis" style="margin:0 0 12px">
          ${kpi('Custo mensal da casa',BRL(casa.custoCasa),'parcela e contas')}
          ${kpi('Sobra hoje, já com a casa',BRL(casa.hoje),
            casa.hoje<0?'não cabe ainda':'cabe',casa.hoje<0?'neg':'pos')}
          ${kpi('Primeiro mês confortável',casa.mes?mLabel(casa.mes):'não nos próximos 24',
            casa.mes?'sobrariam '+BRL(casa.sobraDepois):'','amb')}
        </div>
        <p class="note">Confortável aqui significa sobrar mais de ${BRL(totFixas()*0.3)}
        depois de pagar tudo, incluindo a casa. ${casa.mes
          ? 'A partir de '+mLabel(casa.mes)+' isso acontece, porque os parcelamentos vão terminando.'
          : 'Nos próximos 24 meses a conta não fecha com folga — quitar o financiamento antes muda isso.'}</p>
      </div></div>`:''}`;
  })()}

  <div class="grid2">
    <div class="panel"><h2>Sobra mês a mês<small>12 meses à frente</small></h2><div class="pbody">
      <svg width="100%" height="176" viewBox="0 0 560 176" preserveAspectRatio="none" role="img">
        <line x1="20" y1="${py(0)}" x2="540" y2="${py(0)}" stroke="var(--rule)"/>
        <polyline points="${linha}" fill="none" stroke="var(--pos)" stroke-width="2.4"/>
        <polyline points="${linha} ${px(serie.length-1)},${py(mn)} ${px(0)},${py(mn)}"
          fill="var(--pos)" opacity=".08" stroke="none"/>
        ${serie.map((x,i)=>x.sal<0?`<circle cx="${px(i)}" cy="${py(x.sal)}" r="3.5" fill="var(--neg)"/>`:'').join('')}
        <circle cx="${px(0)}" cy="${py(serie[0].sal)}" r="4" fill="var(--pos)"/>
        <text x="${px(0)}" y="${py(serie[0].sal)-9}" font-size="11" fill="var(--pos)"
          font-weight="700" text-anchor="middle">${(serie[0].sal/1000).toFixed(1)}k</text>
        <g font-size="10" fill="var(--muted)" text-anchor="middle">
          ${serie.map((x,i)=>i%2===0?`<text x="${px(i)}" y="160">${mLabel(x.k).slice(0,2)}</text>`:'').join('')}
        </g>
      </svg>
      <p class="note">Cresce conforme os parcelamentos terminam. Pontos vermelhos são meses negativos.</p>
    </div></div>

    <div class="panel"><h2>Dívida caindo<small>cartões e financiamento</small></h2><div class="pbody">
      <svg width="100%" height="176" viewBox="0 0 560 176" role="img">
        <line x1="20" y1="140" x2="540" y2="140" stroke="var(--rule)"/>
        ${dividas.map((d,i)=>{
          const x=20+i*(520/dividas.length);
          const hf=(d.fin/mxD)*110, hc=(d.cart/mxD)*110;
          return `<rect x="${x}" y="${140-hf-hc}" width="${lw}" height="${hf}" fill="var(--steel)"/>
                  <rect x="${x}" y="${140-hc}" width="${lw}" height="${hc}" fill="var(--amber)"/>`;
        }).join('')}
        <text x="${20+lw/2}" y="${140-(dividas[0].total/mxD)*110-6}" font-size="11"
          fill="var(--steel)" font-weight="700" text-anchor="middle">${(dividas[0].total/1000).toFixed(1)}k</text>
        <g font-size="10" fill="var(--muted)" text-anchor="middle">
          ${dividas.map((d,i)=>i%2===0?`<text x="${20+i*(520/dividas.length)+lw/2}" y="160">${mLabel(d.k).slice(0,2)}</text>`:'').join('')}
        </g>
      </svg>
      <div class="legenda">
        <span><i style="background:var(--steel)"></i>financiamento</span>
        <span><i style="background:var(--amber)"></i>parcelas de cartão</span>
      </div>
    </div></div>
  </div>

  <div class="grid2">
    <div class="panel"><h2>Onde o dinheiro foi<small>por categoria, ${mLabel(k)}</small></h2>
    <div class="tw"><table><thead><tr><th>Categoria</th><th class="r">Valor</th>
      <th class="r">% da renda</th><th style="width:110px"></th></tr></thead><tbody>
      ${cats.map(c=>`<tr${DASH_CAT&&DASH_CAT!==c.cat?' class="dim"':''}>
        <td>${esc(c.cat)}</td><td class="r">${BRL(c.v)}</td>
        <td class="r">${I.renda?PCT(c.v/I.renda):'—'}</td>
        <td><span class="track" style="height:7px;display:block">
          <span class="fill" style="width:${c.v/maxCat*100}%;background:var(--steel)"></span></span></td>
      </tr>`).join('')||'<tr><td colspan="4" class="note" style="padding:16px;text-align:center">Sem gastos no mês.</td></tr>'}
    </tbody></table></div></div>

    <div class="panel"><h2>Previsto e realizado<small>meses já fechados</small></h2>
    <div class="tw"><table><thead><tr><th>Mês</th><th class="r">Renda prevista</th>
      <th class="r">Renda real</th><th class="r">Saídas previstas</th>
      <th class="r">Saídas reais</th><th class="r">Diferença</th></tr></thead><tbody>
      ${pr.map(x=>`<tr><td><b>${mLabel(x.k)}</b></td>
        <td class="r">${BRL(x.prevRenda)}</td>
        <td class="r">${x.temDados?BRL(x.realRenda):'—'}</td>
        <td class="r">${BRL(x.prevSaida)}</td>
        <td class="r">${x.temDados?BRL(x.realSaida):'—'}</td>
        <td class="r" style="color:${!x.temDados?'var(--muted)':x.difSaida>0?'var(--neg)':'var(--pos)'}">
          ${x.temDados?(x.difSaida>0?'+':'')+BRL(x.difSaida):'sem lançamentos'}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="pbody"><p class="note">Saída real maior que a prevista costuma ser o dia a dia,
    que não está cadastrado. É o principal buraco de informação do sistema.</p></div></div>
  </div>`;
}
window.setDashPer=v=>{ DASH_PER=v; render(); };
window.setDashCart=v=>{ DASH_CART=v; render(); };
window.setDashQuem=v=>{ DASH_QUEM=v; render(); };
window.setDashCat=v=>{ DASH_CAT=v; render(); };
window.limparDash=()=>{ DASH_PER='mes'; DASH_CART=''; DASH_QUEM=''; DASH_CAT=''; render(); };

/* =====================================================================
   LOG DE ATIVIDADES
   ===================================================================== */
let LOG_TAB='', LOG_ACAO='', LOG_QUEM='', LOG_PER='30', LOG_BUSCA='';

const NOME_TABELA={lancamentos:'Lançamentos',rendas:'Renda',fixas:'Contas fixas',
  beneficios:'Benefícios',cartoes:'Cartões',parcelamentos:'Parcelamentos',
  assinaturas:'Assinaturas',terceiros:'Terceiros',metas:'Metas',casa_itens:'Itens da casa',
  financiamentos:'Financiamentos',agenda:'Agenda',ciclos:'Ciclos de fatura',config:'Configuração'};

function logFiltrado(){
  const lim = LOG_PER==='tudo' ? null
    : new Date(Date.now()-(+LOG_PER)*86400000).toISOString();
  const b=LOG_BUSCA.trim().toLowerCase();
  return D.auditoria.filter(a=>
    (!lim || a.quando>=lim) &&
    (!LOG_TAB  || a.tabela===LOG_TAB) &&
    (!LOG_ACAO || a.acao===LOG_ACAO) &&
    (!LOG_QUEM || (a.quem_nome||'')===LOG_QUEM) &&
    (!b || (String(a.rotulo||'')+' '+String(a.quem_nome||'')).toLowerCase().includes(b))
  ).sort((x,y)=>String(y.quando).localeCompare(String(x.quando)));
}

function vLog(){
  if(FALTANDO.includes('auditoria'))
    return head('Atividade','Esta aba precisa da tabela de auditoria, que ainda não existe no seu banco.')
      +`<div class="warn">Rode <b>migracao-auditoria.sql</b> no Supabase e recarregue.</div>`;

  const L=logFiltrado();
  const todos=D.auditoria;
  const pessoas=[...new Set(todos.map(a=>a.quem_nome).filter(Boolean))];
  const tabelas=[...new Set(todos.map(a=>a.tabela))].sort();
  const hoje7=new Date(Date.now()-7*86400000).toISOString();
  const semana=todos.filter(a=>a.quando>=hoje7);
  const exclusoes=L.filter(a=>a.acao==='excluiu');

  const quando=x=>{
    const d=new Date(x), ag=new Date(), dif=(ag-d)/1000;
    if(dif<60) return 'agora';
    if(dif<3600) return Math.floor(dif/60)+' min atrás';
    if(dif<86400) return Math.floor(dif/3600)+'h atrás';
    if(dif<172800) return 'ontem, '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
    return String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+
           ' às '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  };
  const cor={criou:'t-ok',editou:'t-i',excluiu:'t-no'};
  const verbo={criou:'criou',editou:'editou',excluiu:'excluiu'};
  const fmt=v=>{
    if(v===null||v===undefined||v==='') return '—';
    if(typeof v==='boolean') return v?'sim':'não';
    if(typeof v==='number') return BRL(v);
    if(/^\d{4}-\d{2}-\d{2}$/.test(v)) return v.split('-').reverse().join('/');
    if(/^-?\d+(\.\d+)?$/.test(v)) return BRL(+v);
    return esc(String(v));
  };

  return head('Atividade','Tudo que foi criado, editado ou excluído — por vocês ou por script.')
  +`<div class="kpis">
    ${kpi('Nesta semana',semana.length+'',semana.length===1?'alteração':'alterações')}
    ${kpi('Exclusões no período',exclusoes.length+'','',exclusoes.length?'amb':'')}
    ${kpi('Registros no log',todos.length+'',todos.length>=400?'mostrando os 400 mais recentes':'')}
    ${kpi('Mostrando agora',L.length+'','com os filtros aplicados')}
  </div>

  <div class="filtros">
    <div class="fld"><label>Período</label>
      <select onchange="setLog('per',this.value)">
        ${[['1','Hoje'],['7','Últimos 7 dias'],['30','Últimos 30 dias'],
           ['90','Últimos 90 dias'],['tudo','Tudo']].map(([v,l])=>
          `<option value="${v}" ${LOG_PER===v?'selected':''}>${l}</option>`).join('')}
      </select></div>
    <div class="fld"><label>Onde</label>
      <select onchange="setLog('tab',this.value)">
        <option value="">Tudo</option>
        ${tabelas.map(t=>`<option value="${t}" ${LOG_TAB===t?'selected':''}>${NOME_TABELA[t]||t}</option>`).join('')}
      </select></div>
    <div class="fld"><label>O que aconteceu</label>
      <select onchange="setLog('acao',this.value)">
        <option value="">Tudo</option>
        ${['criou','editou','excluiu'].map(a=>
          `<option value="${a}" ${LOG_ACAO===a?'selected':''}>${a[0].toUpperCase()+a.slice(1)}</option>`).join('')}
      </select></div>
    <div class="fld"><label>Quem</label>
      <select onchange="setLog('quem',this.value)">
        <option value="">Todos</option>
        ${pessoas.map(p=>`<option ${LOG_QUEM===p?'selected':''}>${esc(p)}</option>`).join('')}
      </select></div>
    <div class="fld" style="min-width:180px"><label>Buscar</label>
      <input id="lg_b" value="${esc(LOG_BUSCA)}" placeholder="nome, descrição…"
        oninput="setLog('busca',this.value)"></div>
    ${(LOG_TAB||LOG_ACAO||LOG_QUEM||LOG_BUSCA||LOG_PER!=='30')
      ? `<button class="btn alt sm" onclick="limparLog()">limpar filtros</button>`:''}
  </div>

  ${exclusoes.length?`<div class="warn" style="margin-bottom:16px">
    <b>${exclusoes.length} ${exclusoes.length===1?'exclusão':'exclusões'} no período.</b>
    Se alguma não foi intencional, a aba <b>Cópias</b> permite voltar ao estado anterior.</div>`:''}

  <div class="panel"><h2>O que aconteceu <small>${L.length} ${L.length===1?'registro':'registros'}</small></h2>
  ${L.length?`<div class="tw"><table><thead><tr>
    <th style="width:130px">Quando</th><th style="width:96px">O quê</th>
    <th>Registro</th><th style="width:130px">Onde</th><th style="width:120px">Quem</th>
  </tr></thead><tbody>
  ${L.slice(0,150).map(a=>`<tr>
    <td class="mono" style="white-space:nowrap">${quando(a.quando)}</td>
    <td><span class="tag ${cor[a.acao]}">${verbo[a.acao]}</span></td>
    <td>${esc(a.rotulo||'—')}
      ${a.acao==='editou'&&a.campos&&a.campos.length
        ? `<details class="mini-det" style="margin-top:3px"><summary>
             <span class="note">${a.campos.length} ${a.campos.length===1?'campo mudou':'campos mudaram'}</span></summary>
             <div style="padding:6px 0">
               ${a.campos.map(c=>`<div class="dline">
                 <span class="note">${esc(c)}</span>
                 <span><span class="note" style="text-decoration:line-through">${fmt(a.antes?.[c])}</span>
                 &nbsp;→&nbsp;<b>${fmt(a.depois?.[c])}</b></span></div>`).join('')}
             </div></details>`
        : ''}
      ${a.acao==='excluiu'&&a.antes
        ? `<details class="mini-det" style="margin-top:3px"><summary>
             <span class="note">ver o que foi apagado</span></summary>
             <div style="padding:6px 0">
               ${Object.entries(a.antes).filter(([k,v])=>
                   !['id','grupo_id','criado_em','atualizado_em','criado_por'].includes(k) && v!==null && v!=='')
                 .map(([k,v])=>`<div class="dline"><span class="note">${esc(k)}</span>
                   <span>${fmt(v)}</span></div>`).join('')}
             </div></details>`
        : ''}</td>
    <td><span class="tag t-g">${NOME_TABELA[a.tabela]||a.tabela}</span></td>
    <td>${esc(a.quem_nome||'—')}${a.origem!=='app'?` <span class="tag t-w">${esc(a.origem)}</span>`:''}</td>
  </tr>`).join('')}
  </tbody></table></div>
  ${L.length>150?`<div class="pbody"><p class="note">Mostrando os 150 mais recentes de ${L.length}.
    Use os filtros para estreitar.</p></div>`:''}`
  :`<div class="pbody"><p class="note">Nada no período escolhido.</p></div>`}
  </div>

  <div class="panel"><h2>Como isso ajuda</h2><div class="pbody"><div class="dl">
    <div class="di"><b>O log vem do banco, não do app</b><p>Ele é escrito por gatilho, então
      registra também o que for alterado pelo SQL Editor ou por script. Nada passa despercebido.</p></div>
    <div class="di"><b>Guarda o antes e o depois</b><p>Numa edição, mostra exatamente quais campos
      mudaram e de que valor para qual. Numa exclusão, mostra o registro inteiro que foi apagado.</p></div>
    <div class="di"><b>Ninguém apaga o log</b><p>O app só consegue ler. Isso vale inclusive para
      vocês duas — é proposital, senão não serviria de prova.</p></div>
  </div></div></div>`;
}
window.setLog=(campo,v)=>{
  if(campo==='per') LOG_PER=v; else if(campo==='tab') LOG_TAB=v;
  else if(campo==='acao') LOG_ACAO=v; else if(campo==='quem') LOG_QUEM=v;
  else if(campo==='busca'){ LOG_BUSCA=v; }
  render();
  if(campo==='busca'){ const el=$('lg_b'); if(el){ el.focus(); el.setSelectionRange?.(v.length,v.length); } }
};
window.limparLog=()=>{ LOG_TAB=LOG_ACAO=LOG_QUEM=LOG_BUSCA=''; LOG_PER='30'; render(); };

/* =====================================================================
   FATURA — detalhe de um cartão num mês
   ===================================================================== */
let FAT_CART=null;

/* Move a parcela deste mês para o seguinte, empurrando as que vêm depois.
   É o que acontece quando o cartão pula uma fatura. */
window.pularMes=async(pid,k)=>{
  const p=D.parcelamentos.find(x=>x.id===pid); if(!p) return;
  const meses=mesesDaParcela(p);
  if(!meses.includes(k)) return;
  const novos=meses.map(m=> m>=k ? addM(m,1) : m);
  if(await atualizar('parcelamentos',pid,{competencias:novos})){
    render(); toast(esc(p.descricao)+' passou para '+mLabel(addM(k,1)));
  }
};
/* Traz de volta: desfaz o pulo mais recente deste mês. */
window.voltarMes=async(pid,k)=>{
  const p=D.parcelamentos.find(x=>x.id===pid); if(!p) return;
  const meses=mesesDaParcela(p);
  const novos=meses.map(m=> m>k ? addM(m,-1) : m);
  if(await atualizar('parcelamentos',pid,{competencias:novos})){
    render(); toast(esc(p.descricao)+' voltou para '+mLabel(k));
  }
};
window.setFatCart=v=>{ FAT_CART=v; render(); };

function vFatura(){
  const ativos=D.cartoes.filter(c=>c.ativo);
  if(!ativos.length) return head('Fatura','Nenhum cartão cadastrado.');
  const c = ativos.find(x=>x.nome===FAT_CART) || ativos[0];
  const n = c.nome;
  const k = MREF;
  const comp = venceNoDia1(n) ? addM(k,1) : k;   /* qual competência esta fatura é */
  const jan = janelaFatura(n,comp);
  const ciclo = cicloDe(n,comp);
  const real = faturaLancada(n,comp);
  const calc = faturaCalculada(n,comp);
  const valor = faturaCartao(n,comp);

  const parcelas = D.parcelamentos.filter(p=>(p.cartao||'')===n && parcelaCaiEm(p,comp));
  const assinaturas = D.assinaturas.filter(a=>a.projetar && (a.cartao||'')===n)
    .map(a=>({a, vz:vezesAssinatura(a,comp)})).filter(x=>x.vz>0);
  const terceiros = D.terceiros.filter(t=>t.cartao===n && !t.recebido &&
    (!t.competencia || t.competencia===mLabel(comp)));
  const avulsos = D.lancamentos.filter(l=>l.cartao===n && ym(l.data)===comp &&
    l.categoria!=='Cartão');
  const somaParc = parcelas.reduce((s,p)=>s+ +p.valor_parcela,0);
  const somaAssin = assinaturas.reduce((s,x)=>s+(+x.a.valor)*x.vz,0);
  const somaTerc = terceiros.reduce((s,t)=>s+ +t.valor,0);
  const conhecido = somaParc+somaAssin;
  const naoIdentificado = real ? real.valor-conhecido : null;
  const proximas = D.parcelamentos.filter(p=>(p.cartao||'')===n && +p.restantes>0
    && !parcelaCaiEm(p,comp) && mesesDaParcela(p).some(m=>m>comp));

  return head('Fatura','O que compõe a fatura de cada cartão, item por item.')
  +`<div class="filtros">
    <div class="fld"><label>Cartão</label>
      <select onchange="setFatCart(this.value)">
        ${ativos.map(x=>`<option ${x.nome===n?'selected':''}>${esc(x.nome)}</option>`).join('')}
      </select></div>
    <div class="fld"><label>Mês em foco</label>
      <select onchange="setMes(this.value)">
        ${mesesDisponiveis().map(m=>`<option value="${m}" ${m===k?'selected':''}>${mLabel(m)}</option>`).join('')}
      </select></div>
  </div>

  <div class="kpis">
    ${kpi('Total da fatura',BRL(valor),real?'valor lançado':'estimado pelos cadastros',
      real?'pos':'amb')}
    ${kpi('O que o app conhece',BRL(conhecido),
      parcelas.length+' parcela'+(parcelas.length===1?'':'s')+' · '+
      assinaturas.length+' assinatura'+(assinaturas.length===1?'':'s'))}
    ${naoIdentificado!=null?kpi('Compras do dia a dia',BRL(naoIdentificado),
      'diferença entre o lançado e o conhecido',naoIdentificado<0?'pos':'')
      :kpi('Ainda não lançada','—','o valor real vai substituir a estimativa')}
    ${kpi('De terceiros',BRL(somaTerc),
      somaTerc>0?'abatido da parte de vocês':'nenhum',somaTerc>0?'amb':'')}
  </div>

  ${ciclo?`<div class="info" style="margin-bottom:16px">
    Ciclo de <b>${jan?jan.ini.split('-').reverse().slice(0,2).join('/'):'?'}</b>
    a <b>${ciclo.fecha.split('-').reverse().slice(0,2).join('/')}</b>,
    vence em <b>${ciclo.vence.split('-').reverse().slice(0,2).join('/')}</b>.
    ${ciclo.inferido?' <span class="tag t-w">data inferida</span>':''}
    ${venceNoDia1(n)?' Como vence no dia 1, é paga com a sobra do último dia do mês anterior.':''}
  </div>`:`<div class="warn" style="margin-bottom:16px">
    Sem ciclo cadastrado para ${mLabel(comp)}. O app assume uma cobrança por assinatura.
    Cadastre em <b>Cadastros → Ciclos de fatura</b> para acertar.</div>`}

  <div class="panel"><h2>Parcelamentos <small>${BRL(somaParc)}</small></h2>
  ${parcelas.length?`<div class="tw"><table><thead><tr><th>Compra</th>
    <th class="c">Parcela</th><th class="r">Valor</th><th>Meses em que cai</th><th></th>
  </tr></thead><tbody>
  ${parcelas.map(p=>{
    const ms=mesesDaParcela(p);
    const qual=ms.indexOf(comp)+1;
    const total=+p.total_parcelas||ms.length;
    const jaPagas=total-(+p.restantes);
    return `<tr><td><b>${esc(p.descricao)}</b>
      ${Array.isArray(p.competencias)&&p.competencias.length?' <span class="tag t-w">meses definidos</span>':''}</td>
      <td class="c">${jaPagas+qual} de ${total}</td>
      <td class="r">${BRL(p.valor_parcela)}</td>
      <td class="note">${ms.map(m=>mLabel(m)).join(' · ')}</td>
      <td class="r"><button class="btn alt sm" onclick="pularMes('${p.id}','${comp}')"
        title="O cartão não cobrou esta parcela neste mês">não caiu aqui →</button></td></tr>`;}).join('')}
  </tbody></table></div>
  <div class="pbody"><p class="note">Se o cartão pulou uma fatura, clique em
  <b>não caiu aqui</b>: a parcela passa para o mês seguinte e as posteriores acompanham.
  Foi o que aconteceu com o Folheados Omy, que teve parcela 1 em agosto e parcela 2 só em outubro.</p></div>`
  :'<div class="pbody"><p class="note">Nenhuma parcela neste ciclo.</p></div>'}
  </div>

  ${proximas.length?`<div class="panel"><h2>Parcelas que caem depois
    <small>não entram nesta fatura</small></h2>
    <div class="tw"><table><thead><tr><th>Compra</th><th class="r">Valor</th>
      <th>Próximo mês</th><th></th></tr></thead><tbody>
    ${proximas.map(p=>{
      const prox=mesesDaParcela(p).filter(m=>m>comp)[0];
      return `<tr><td>${esc(p.descricao)}</td><td class="r">${BRL(p.valor_parcela)}</td>
      <td>${mLabel(prox)}</td>
      <td class="r"><button class="btn alt sm" onclick="voltarMes('${p.id}','${comp}')"
        title="Na verdade esta parcela caiu nesta fatura">caiu aqui ←</button></td></tr>`;}).join('')}
    </tbody></table></div>
    <div class="pbody"><p class="note">Se alguma dessas apareceu nesta fatura, clique em
    <b>caiu aqui</b> para trazê-la de volta.</p></div></div>`:''}

  <div class="panel"><h2>Assinaturas <small>${BRL(somaAssin)}</small></h2>
  ${assinaturas.length?`<div class="tw"><table><thead><tr><th>Assinatura</th>
    <th class="c">Dia da cobrança</th><th class="c">Vezes no ciclo</th><th class="r">Valor</th>
  </tr></thead><tbody>
  ${assinaturas.map(x=>`<tr><td>${esc(x.a.descricao)}</td>
    <td class="c">${x.a.dia||'—'}</td>
    <td class="c">${x.vz>1?`<span class="tag t-no">${x.vz}x</span>`:x.vz}</td>
    <td class="r">${BRL((+x.a.valor)*x.vz)}${x.vz>1?
      `<span class="note" style="display:block">${BRL(x.a.valor)} cada</span>`:''}</td></tr>`).join('')}
  </tbody></table></div>`
  :'<div class="pbody"><p class="note">Nenhuma assinatura neste cartão.</p></div>'}
  </div>

  ${terceiros.length?`<div class="panel"><h2>De terceiros <small>${BRL(somaTerc)}</small></h2>
    <div class="tw"><table><thead><tr><th>Quem</th><th>O que é</th><th class="r">Valor</th>
    </tr></thead><tbody>
    ${terceiros.map(t=>`<tr><td><b>${esc(t.pessoa)}</b></td><td>${esc(t.descricao)}</td>
      <td class="r">${BRL(t.valor)}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="pbody"><p class="note">Está na fatura mas não é gasto de vocês.</p></div></div>`:''}

  ${avulsos.length?`<div class="panel"><h2>Outros lançamentos neste cartão</h2>
    <div class="tw"><table><thead><tr><th>Data</th><th>Descrição</th>
      <th class="r">Valor</th></tr></thead><tbody>
    ${avulsos.map(l=>`<tr><td class="mono">${String(l.data).split('-').reverse().join('/')}</td>
      <td>${esc(l.descricao)}${l.tipo==='Entrada'?' <span class="tag t-ok">crédito</span>':''}</td>
      <td class="r" style="color:${l.tipo==='Entrada'?'var(--pos)':'inherit'}">${
        l.tipo==='Entrada'?'− ':''}${BRL(l.valor)}</td></tr>`).join('')}
    </tbody></table></div></div>`:''}

  <div class="panel"><h2>Fechando a conta</h2>
  <div class="tw"><table class="mini"><tbody>
    <tr><td>Parcelamentos</td><td class="r">${BRL(somaParc)}</td></tr>
    <tr><td>Assinaturas</td><td class="r">${BRL(somaAssin)}</td></tr>
    <tr><td><b>O app conhece</b></td><td class="r"><b>${BRL(conhecido)}</b></td></tr>
    ${real?`<tr><td>Valor lançado por você</td><td class="r"><b>${BRL(real.valor)}</b></td></tr>
      <tr><td class="note">Diferença — compras do dia a dia, encargos</td>
        <td class="r note" style="color:${naoIdentificado>0?'var(--neg)':'var(--pos)'}">${
          (naoIdentificado>0?'+':'')+BRL(naoIdentificado)}</td></tr>`
    :`<tr><td class="note">Ainda não lançada: o app usa a estimativa</td>
        <td class="r note">${BRL(calc)}</td></tr>`}
    <tr style="border-top:2px solid var(--rule)"><td><b>Vale nas contas</b></td>
      <td class="r"><b style="font-size:16px">${BRL(valor)}</b></td></tr>
  </tbody></table></div>
  <div class="pbody"><p class="note">Para corrigir o total, edite o lançamento da fatura em
  <b>Lançamentos</b>. Para corrigir a composição, use os botões acima ou os cadastros.</p></div>
  </div>`;
}

/* =====================================================================
   SHELL E INICIALIZAÇÃO
   ===================================================================== */
const VIEWS={painel:vPainel,dash:vDash,fatura:vFatura,compra:vCompra,lanc:vLanc,parc:vParc,assin:vAssin,
             terc:vTerc,cal:vCal,proj:vProj,amort:vAmort,casa:vCasa,cad:vCad,metas:vMetas,backup:vBackup,log:vLog};

function render(){
  const m=$('main'); if(!m) return montarShell();
  montarNav();
  montarBusca();                      /* a barra já marca a aba certa */
  m.innerHTML=(VIEWS[CUR]||vPainel)();
}
window.go=id=>{CUR=id;MENU_ABERTO=null;render();window.scrollTo(0,0);};

function montarShell(){
  $('root').innerHTML=`<div class="shell">
    <div class="rail"><div class="railin">
      <div class="brand"><b>Financeiro</b><span>${esc(EU||'')}</span>
        <button class="eng" id="btntema" onclick="alternarTema()"
          title="Trocar entre claro e escuro">${temaAtual()==='light'?'☀':'☾'}</button>
        <button class="eng" onclick="abrirMenu('config')" aria-expanded="false"
          title="Cadastros, cópias e atividade">⚙</button></div>
      <div id="busca"></div>
      <nav id="nav"></nav>
      <div id="menus"></div>
      <div class="railfoot">
        <span class="sync"><span class="dot ${SYNC}" id="syncdot"></span><span id="synctxt">Sincronizado</span></span>
        <span style="color:var(--barra-sub);font-size:11px;opacity:.7">${APP_VER}</span>
        <span style="flex:1"></span>
        <button onclick="exportar()">Exportar backup</button>
        <button onclick="sair()">Sair</button>
      </div>
    </div></div>
    <main class="main" id="main"></main></div>`;
  render();
}
/* Tema: claro ou escuro, salvo no aparelho. Sem escolha salva, começa escuro. */
function temaAtual(){ return document.documentElement.getAttribute('data-theme')==='light'?'light':'dark'; }
window.alternarTema=()=>{
  const novo = temaAtual()==='light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', novo);
  try{ localStorage.setItem('tema', novo); }catch(e){}
  const b=$('btntema'); if(b) b.textContent = novo==='light'?'☀':'☾';
};

/* Busca no centro: telas E lançamentos no mesmo resultado. */
function resultadosBusca(q){
  const termo=q.trim().toLowerCase();
  if(!termo) return {paginas:[], lancs:[]};
  const paginas = PAGES.filter(([id,nome])=>nome.toLowerCase().includes(termo)).slice(0,4);
  const lancs = D.lancamentos
    .filter(l=>l.descricao.toLowerCase().includes(termo))
    .sort((a,b)=>String(b.data).localeCompare(String(a.data)))
    .slice(0,5);
  return {paginas, lancs};
}
function montarBusca(){
  const box=$('busca'); if(!box) return;
  if(!BUSCA_ABERTA){
    box.innerHTML = `<button class="buscabar" onclick="toggleBusca()" aria-expanded="false">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <span>Ir para uma tela, ou buscar um lançamento…</span></button>`;
    return;
  }

  const q = BUSCA_Q.trim();
  const R = q ? resultadosBusca(q) : {paginas:[], lancs:[]};

  let corpo;
  if(!q){
    corpo = `<div class="buscavazio">Digite pra buscar uma tela ou um lançamento</div>`;
  } else if(!R.paginas.length && !R.lancs.length){
    corpo = `<div class="buscavazio">Nada encontrado para "${esc(q)}"</div>`;
  } else {
    const blocoPaginas = R.paginas.length ? (
      `<div class="buscasep">Telas</div>` +
      R.paginas.map(([id,nome]) =>
        `<button class="buscaitem" onclick="irBusca('pagina','${id}')"><span>${esc(nome)}</span></button>`
      ).join('')
    ) : '';
    const blocoLancs = R.lancs.length ? (
      `<div class="buscasep">Lançamentos</div>` +
      R.lancs.map(l => {
        const dataFmt = String(l.data).split('-').reverse().join('/');
        const cor = l.tipo==='Entrada' ? 'var(--pos)' : 'var(--neg)';
        return `<button class="buscaitem" onclick="irBusca('lanc','${l.id}')">
          <span>${esc(l.descricao)} <span class="note">${dataFmt}</span></span>
          <b style="color:${cor}">${BRL(l.valor)}</b></button>`;
      }).join('')
    ) : '';
    corpo = blocoPaginas + blocoLancs;
  }

  box.innerHTML = `<button class="buscabar aberta" onclick="toggleBusca()" aria-expanded="true">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    </button>
    <div class="buscapainel">
      <input id="buscainput" type="text" value="${esc(BUSCA_Q)}"
        placeholder="Ir para uma tela, ou buscar um lançamento…"
        oninput="setBusca(this.value)" onkeydown="if(event.key==='Escape')toggleBusca()">
      ${corpo}
    </div>`;

  const el=$('buscainput');
  if(el){ el.focus(); el.setSelectionRange?.(BUSCA_Q.length,BUSCA_Q.length); }
}
window.toggleBusca=()=>{ BUSCA_ABERTA=!BUSCA_ABERTA; if(!BUSCA_ABERTA) BUSCA_Q=''; montarBusca(); };
window.setBusca=v=>{ BUSCA_Q=v; montarBusca(); };
window.irBusca=(tipo,id)=>{
  if(tipo==='pagina'){ go(id); }
  else if(tipo==='lanc'){
    const l=D.lancamentos.find(x=>x.id===id);
    if(l){ MREF=ym(l.data); CUR='lanc'; }
  }
  BUSCA_ABERTA=false; BUSCA_Q=''; render(); window.scrollTo(0,0);
};

/* Desenha a barra: telas do dia a dia, o "Mais" e a engrenagem. */
function montarNav(){
  const nav=$('nav'); if(!nav) return;
  const emMais = MENU_MAIS.some(([,ids])=>ids.includes(CUR));
  const emConfig = MENU_CONFIG.includes(CUR);
  const ddMais = MENU_ABERTO==='mais'
    ? `<div class="ddmenu mais-dd">${MENU_MAIS.map(([g,ids])=>
        `<div class="sep">${g}</div>`+ids.map(id=>
          `<button onclick="go('${id}')" aria-current="${CUR===id}">${rotulo(id)}</button>`).join('')
        ).join('')}</div>`
    : '';
  nav.innerHTML =
    MENU_FIXO.map(id=>`<button data-p="${id}" onclick="go('${id}')"
      aria-current="${CUR===id}">${rotulo(id)}</button>`).join('')
    + `<span class="maiswrap">
        <button class="mais" onclick="abrirMenu('mais')"
          aria-current="${emMais}" aria-expanded="${MENU_ABERTO==='mais'}">
          ${emMais?rotulo(CUR):'Mais'} <span class="seta">▾</span></button>
        ${ddMais}
      </span>`
    + (emConfig?`<button aria-current="true" onclick="abrirMenu('config')">${rotulo(CUR)}</button>`:'');

  const box=$('menus'); if(!box) return;
  if(MENU_ABERTO==='config'){
    box.innerHTML=`<div class="ddmenu dir"><div class="sep">Ajustes e manutenção</div>
      ${MENU_CONFIG.map(id=>`<button onclick="go('${id}')"
        aria-current="${CUR===id}">${rotulo(id)}</button>`).join('')}</div>`;
  } else box.innerHTML='';
}
window.abrirMenu=q=>{ MENU_ABERTO = MENU_ABERTO===q ? null : q; montarNav(); };

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
