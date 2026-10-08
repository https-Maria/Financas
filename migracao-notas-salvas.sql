-- v92 — notas salvas com observação
create table if not exists public.notas_salvas (
  id uuid primary key default gen_random_uuid(),
  grupo_id uuid not null,
  titulo text,
  observacao text,
  linhas jsonb not null default '[]'::jsonb,
  total numeric(14,2) not null default 0,
  criado_por uuid,
  criado_em timestamptz not null default now()
);

alter table public.notas_salvas enable row level security;

drop policy if exists notas_salvas_rw on public.notas_salvas;
create policy notas_salvas_rw
on public.notas_salvas
for all
using (e_membro(grupo_id))
with check (e_membro(grupo_id));

create index if not exists notas_salvas_grupo_criado_idx
  on public.notas_salvas (grupo_id, criado_em desc);
