-- v87 — histórico imutável de faturas + vigência de assinaturas + exceções por competência

alter table public.assinaturas
  add column if not exists cancelado_em date;

-- Preserva o comportamento atual das assinaturas já desativadas:
-- a data da última atualização vira o fim da vigência histórica.
update public.assinaturas
set cancelado_em = atualizado_em::date
where projetar = false
  and cancelado_em is null;

create table if not exists public.assinatura_excecoes (
  id uuid primary key default gen_random_uuid(),
  grupo_id uuid not null references public.grupos(id) on delete cascade,
  assinatura_id uuid not null references public.assinaturas(id) on delete cascade,
  competencia text not null check (competencia ~ '^\\d{4}-\\d{2}$'),
  vezes smallint not null check (vezes between 0 and 6),
  observacao text,
  atualizado_em timestamptz not null default now(),
  unique (grupo_id, assinatura_id, competencia)
);

alter table public.assinatura_excecoes enable row level security;
drop policy if exists assinatura_excecoes_rw on public.assinatura_excecoes;
create policy assinatura_excecoes_rw
  on public.assinatura_excecoes
  for all
  using (public.e_membro(grupo_id))
  with check (public.e_membro(grupo_id));

create index if not exists idx_assinatura_excecoes_grupo_comp
  on public.assinatura_excecoes(grupo_id, competencia);

create table if not exists public.faturas_fechadas (
  id uuid primary key default gen_random_uuid(),
  grupo_id uuid not null references public.grupos(id) on delete cascade,
  cartao text not null,
  competencia text not null check (competencia ~ '^\\d{4}-\\d{2}$'),
  fecha date,
  vence date,
  sua_parte numeric not null default 0,
  total_real numeric not null default 0,
  composicao jsonb not null default '{}'::jsonb,
  fechado_em timestamptz not null default now(),
  criado_por uuid references auth.users(id) on delete set null,
  unique (grupo_id, cartao, competencia)
);

alter table public.faturas_fechadas enable row level security;
drop policy if exists faturas_fechadas_rw on public.faturas_fechadas;
create policy faturas_fechadas_rw
  on public.faturas_fechadas
  for all
  using (public.e_membro(grupo_id))
  with check (public.e_membro(grupo_id));

create index if not exists idx_faturas_fechadas_grupo_comp
  on public.faturas_fechadas(grupo_id, competencia);

comment on column public.assinaturas.cancelado_em is
  'Último dia em que a assinatura existiu nesta versão/cartão. O histórico anterior permanece válido.';
comment on table public.assinatura_excecoes is
  'Override por competência para bancos que cobram 0x, 1x, 2x etc. diferente do ciclo previsto.';
comment on table public.faturas_fechadas is
  'Foto imutável da composição da fatura quando ela é confirmada/paga.';
