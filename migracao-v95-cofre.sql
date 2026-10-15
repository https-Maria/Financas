-- Dueto v95 — Cofre de cartões
-- PAN/número completo nunca fica em texto puro. CVV/CVC não é armazenado.
-- A chave do cofre é gerada no navegador e fica embrulhada por senha-mestra
-- e, opcionalmente, por WebAuthn PRF (biometria/Windows Hello).

create table if not exists public.cofre_config (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  grupo_id uuid not null,
  salt_password text not null,
  wrapped_key_password text not null,
  wrap_iv_password text not null,
  kdf_iterations integer not null default 310000,
  credential_id text,
  prf_salt text,
  wrapped_key_biometria text,
  wrap_iv_biometria text,
  biometric_label text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique(user_id, grupo_id)
);

create table if not exists public.cartoes_cofre (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  grupo_id uuid not null,
  cartao_id uuid not null references public.cartoes(id) on delete cascade,
  payload_ciphertext text not null,
  payload_iv text not null,
  versao smallint not null default 1,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique(user_id, cartao_id)
);

alter table public.cofre_config enable row level security;
alter table public.cartoes_cofre enable row level security;

revoke all on public.cofre_config from anon;
revoke all on public.cartoes_cofre from anon;
grant select,insert,update,delete on public.cofre_config to authenticated;
grant select,insert,update,delete on public.cartoes_cofre to authenticated;

drop policy if exists cofre_config_owner on public.cofre_config;
create policy cofre_config_owner
on public.cofre_config for all to authenticated
using (auth.uid() = user_id and public.e_membro(grupo_id))
with check (auth.uid() = user_id and public.e_membro(grupo_id));

drop policy if exists cartoes_cofre_owner on public.cartoes_cofre;
create policy cartoes_cofre_owner
on public.cartoes_cofre for all to authenticated
using (auth.uid() = user_id and public.e_membro(grupo_id))
with check (auth.uid() = user_id and public.e_membro(grupo_id));
