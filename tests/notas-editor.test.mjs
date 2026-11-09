import test from 'node:test';
import assert from 'node:assert/strict';
import {notaRenderRich,notaFormatarTexto,notaTagsParse,notaFiltrar,
  notaArquivoAceito,notaExtensao,NOTA_MAX_ARQUIVO} from '../notas-editor.mjs';

test('formatação de título, negrito, itálico, sublinhado, riscado e manuscrita',()=>{
  const s=notaRenderRich('# Título\n**forte** *itálico* ~~feito~~ [[u]]sublinhado[[/u]] [[hand]]cursiva[[/hand]]');
  assert.match(s,/<h3>Título<\/h3>/);
  assert.match(s,/<strong>forte<\/strong>/);
  assert.match(s,/<em>itálico<\/em>/);
  assert.match(s,/<s>feito<\/s>/);
  assert.match(s,/<u>sublinhado<\/u>/);
  assert.match(s,/class="nota-hand"/);
});
test('texto HTML malicioso nunca vira elementos executáveis',()=>{
  const s=notaRenderRich('<img src=x onerror=alert(1)>\n<script>alert(1)</script>\n[[verde]]ok[[/verde]]');
  assert.doesNotMatch(s,/<img\b|<script\b/i);
  assert.match(s,/&lt;img/);
  assert.match(s,/nota-verde/);
});
test('inserir marcações preserva texto original e seleção',()=>{
  const r=notaFormatarTexto('comprar pão',8,11,'riscado');
  assert.equal(r.texto,'comprar ~~pão~~');
  assert.equal(r.inicio,10);
  assert.equal(r.fim,13);
});
test('etiquetas são deduplicadas e pesquisa não depende de acento',()=>{
  assert.deepEqual(notaTagsParse('Casa, viagem, Casa; urgente'),['Casa','viagem','urgente']);
  const n=[{titulo:'Férias',pasta:'Viagens',etiquetas:['Páscoa'],fixada:true,
    criado_em:'2026-11-01',linhas:[]},
  {titulo:'Casa',pasta:'Geral',etiquetas:[],fixada:false,criado_em:'2026-11-03',linhas:[]}];
  assert.equal(notaFiltrar(n,'ferias').length,1);
  assert.equal(notaFiltrar(n,'pascoa').length,1);
  assert.equal(notaFiltrar(n,'','Viagens').length,1);
  assert.equal(notaFiltrar(n)[0].titulo,'Férias');
});
test('arquivos aceitam somente imagens e PDF até 10MB',()=>{
  assert.equal(notaArquivoAceito({type:'application/pdf',size:1024}),true);
  assert.equal(notaArquivoAceito({type:'image/webp',size:NOTA_MAX_ARQUIVO}),true);
  assert.equal(notaArquivoAceito({type:'text/html',size:1}),false);
  assert.equal(notaArquivoAceito({type:'image/png',size:NOTA_MAX_ARQUIVO+1}),false);
  assert.equal(notaExtensao('image/jpeg'),'jpg');
});
