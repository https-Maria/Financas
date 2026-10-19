-- Dueto v103 — conciliação banco x orçamento + competência real de fatura
alter table public.lancamentos
  add column if not exists competencia_fatura text,
  add column if not exists valor_bancario numeric(14,2),
  add column if not exists conta text;

comment on column public.lancamentos.competencia_fatura is
  'Competência YYYY-MM que prevalece sobre a data para alocação em fatura.';
comment on column public.lancamentos.valor_bancario is
  'Valor efetivamente debitado/creditado na conta; quando nulo, usa valor.';
comment on column public.lancamentos.conta is
  'Conta bancária onde o movimento aconteceu, quando aplicável.';
