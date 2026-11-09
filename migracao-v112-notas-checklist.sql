-- Dueto v112 — notas editáveis e checklist
-- Mantém todas as notas existentes. Linhas antigas continuam como tipo "valor".

alter table public.notas
  add column if not exists tipo text not null default 'valor',
  add column if not exists concluido boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname='notas_tipo_check'
      and conrelid='public.notas'::regclass
  ) then
    alter table public.notas
      add constraint notas_tipo_check check (tipo in ('valor','check'));
  end if;
end $$;

alter table public.notas_salvas
  add column if not exists atualizado_em timestamptz not null default now();

update public.notas
set tipo='valor'
where tipo is null or tipo not in ('valor','check');
