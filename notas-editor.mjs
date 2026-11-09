/* Editor textual seguro do Dueto v114: texto puro + marcações permitidas.
   Não interpreta HTML fornecido pelo usuário nem executa scripts. */
export const NOTA_MAX_ARQUIVO = 10 * 1024 * 1024;

const ESCAPAR = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const FONTES = new Set(['padrao','manuscrita','mono']);

export function notaFonte(fonte) {
  return FONTES.has(fonte) ? fonte : 'padrao';
}
export function notaTagsParse(entrada) {
  return [...new Set(String(entrada||'').split(/[,;\n]/)
    .map(s=>s.trim().slice(0,30)).filter(Boolean))].slice(0,12);
}
export function notaBusca(texto) {
  return String(texto ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
}
export function notaFiltrar(notas, busca='', pasta='Todas') {
  const q=notaBusca(busca.trim());
  return (notas||[]).filter(n=>{
    const tags=Array.isArray(n.etiquetas)?n.etiquetas:[];
    const matchPasta=pasta==='Todas'||(n.pasta||'Geral')===pasta;
    const matchTexto=!q||notaBusca([n.titulo,n.observacao,n.pasta,...tags,
      ...(Array.isArray(n.linhas)?n.linhas.map(l=>l.descricao):[])].join(' ')).includes(q);
    return matchPasta&&matchTexto;
  }).sort((a,b)=>Number(!!b.fixada)-Number(!!a.fixada)
    ||String(b.criado_em||'').localeCompare(String(a.criado_em||'')));
}
export function notaArquivoAceito(file) {
  const tipos=new Set(['image/jpeg','image/png','image/webp','application/pdf']);
  return !!file && tipos.has(file.type) && file.size > 0 && file.size <= NOTA_MAX_ARQUIVO;
}
export function notaExtensao(tipo) {
  return ({'image/jpeg':'jpg','image/png':'png','image/webp':'webp',
    'application/pdf':'pdf'})[tipo] || null;
}
export function notaFormatarTexto(texto,inicio,fim,acao) {
  const valor=String(texto??''), a=Math.max(0,Math.min(valor.length,inicio||0)),
    b=Math.max(a,Math.min(valor.length,fim??a));
  const chosen=valor.slice(a,b);
  const around={
    negrito:['**','**'],italico:['*','*'],riscado:['~~','~~'],
    sublinhado:['[[u]]','[[/u]]'],manuscrita:['[[hand]]','[[/hand]]'],
    mono:['[[mono]]','[[/mono]]'],rosa:['[[rosa]]','[[/rosa]]'],
    lavanda:['[[lavanda]]','[[/lavanda]]'],verde:['[[verde]]','[[/verde]]'],
    titulo:['\n# ','\n'],subtitulo:['\n## ','\n']
  }[acao];
  if(!around) return {texto:valor,inicio:a,fim:b};
  const [abre,fecha]=around;
  return {texto:valor.slice(0,a)+abre+chosen+fecha+valor.slice(b),
    inicio:a+abre.length,fim:a+abre.length+chosen.length};
}
function notaInline(s) {
  // Escapa ANTES de reconhecer as marcações. Nomes de classes são constantes.
  let txt=ESCAPAR(s);
  const delimitadores=[
    [/\[\[hand\]\]([\s\S]*?)\[\[\/hand\]\]/g,'<span class="nota-hand">$1</span>'],
    [/\[\[mono\]\]([\s\S]*?)\[\[\/mono\]\]/g,'<span class="nota-mono">$1</span>'],
    [/\[\[rosa\]\]([\s\S]*?)\[\[\/rosa\]\]/g,'<span class="nota-rosa">$1</span>'],
    [/\[\[lavanda\]\]([\s\S]*?)\[\[\/lavanda\]\]/g,'<span class="nota-lavanda">$1</span>'],
    [/\[\[verde\]\]([\s\S]*?)\[\[\/verde\]\]/g,'<span class="nota-verde">$1</span>'],
    [/\[\[u\]\]([\s\S]*?)\[\[\/u\]\]/g,'<u>$1</u>'],
    [/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>'],
    [/~~([^~\n]+)~~/g,'<s>$1</s>'],
    [/(^|[^*])\*([^*\n]+)\*/g,'$1<em>$2</em>']
  ];
  for(const [re,rep] of delimitadores) txt=txt.replace(re,rep);
  return txt;
}
export function notaRenderRich(texto,fonte='padrao') {
  const cl='nota-rich nota-fonte-'+notaFonte(fonte);
  const linhas=String(texto??'').replace(/\r\n?/g,'\n').split('\n');
  const html=linhas.map(l=>{
    const t=l.trim();
    if(!t) return '<div class="nota-blank">&nbsp;</div>';
    const h=t.match(/^(#{1,3})\s+(.+)$/);
    if(h){const level=h[1].length+2;return '<h'+level+'>'+notaInline(h[2])+'</h'+level+'>';}
    if(t.startsWith('- ')) return '<p class="nota-bullet">• '+notaInline(t.slice(2))+'</p>';
    return '<p>'+notaInline(l)+'</p>';
  }).join('');
  return '<div class="'+cl+'">'+html+'</div>';
}
