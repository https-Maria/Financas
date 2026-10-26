-- v107 — pagamento parcial de terceiros
-- Mantém o valor original da compra para a composição da fatura,
-- enquanto controla separadamente quanto a pessoa já reembolsou.

alter table public.terceiros
  add column if not exists valor_recebido numeric not null default 0;

update public.terceiros
set valor_recebido = valor
where recebido = true
  and coalesce(valor_recebido, 0) = 0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'terceiros_valor_recebido_check'
      and conrelid = 'public.terceiros'::regclass
  ) then
    alter table public.terceiros
      add constraint terceiros_valor_recebido_check
      check (valor_recebido >= 0 and valor_recebido <= valor);
  end if;
end $$;
