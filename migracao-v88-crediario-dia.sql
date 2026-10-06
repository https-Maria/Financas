-- v88 — dia do crediário com vigência histórica
-- Estrutura idempotente: pode ser executada mais de uma vez.

alter table public.parcelamentos
  add column if not exists dia smallint;

alter table public.parcelamentos
  add column if not exists dia_desde date;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'parcelamentos_dia_check'
      and conrelid = 'public.parcelamentos'::regclass
  ) then
    alter table public.parcelamentos
      add constraint parcelamentos_dia_check
      check (dia is null or (dia >= 1 and dia <= 31));
  end if;
end $$;

comment on column public.parcelamentos.dia is
  'Dia de pagamento para crediário/carnê. 31 = último dia útil.';

comment on column public.parcelamentos.dia_desde is
  'Data a partir da qual o campo dia passa a valer; meses anteriores preservam a regra histórica.';
