-- Dueto v114 — notas ricas e anexos privados.
-- Mudança aditiva: não altera linhas de notas existentes.
begin;

alter table public.notas_salvas
  add column if not exists pasta text not null default 'Geral',
  add column if not exists etiquetas text[] not null default '{}'::text[],
  add column if not exists fixada boolean not null default false,
  add column if not exists fonte text not null default 'padrao';

create index if not exists idx_dueto_notas_busca_grupo
  on public.notas_salvas (grupo_id, pasta, fixada);

create table if not exists public.notas_anexos (
  id uuid primary key default gen_random_uuid(),
  grupo_id uuid not null,
  nota_id uuid not null references public.notas_salvas(id) on delete cascade,
  caminho text not null unique,
  nome text not null,
  mime text not null,
  tamanho bigint not null check (tamanho between 1 and 10485760),
  criado_por uuid default auth.uid(),
  criado_em timestamptz not null default now(),
  constraint notas_anexos_mime_ok check (mime in (
    'image/jpeg','image/png','image/webp','application/pdf'))
);
create index if not exists idx_dueto_notas_anexos_nota
  on public.notas_anexos (grupo_id, nota_id);

alter table public.notas_anexos enable row level security;
revoke all on public.notas_anexos from anon, authenticated;
grant select, insert, delete on public.notas_anexos to authenticated;

drop policy if exists dueto_anexos_ler on public.notas_anexos;
create policy dueto_anexos_ler on public.notas_anexos
  for select to authenticated
  using (public.e_membro(grupo_id) and exists(
    select 1 from public.notas_salvas n
    where n.id=nota_id and n.grupo_id=notas_anexos.grupo_id
  ));
drop policy if exists dueto_anexos_criar on public.notas_anexos;
create policy dueto_anexos_criar on public.notas_anexos
  for insert to authenticated
  with check (
    public.e_membro(grupo_id)
    and split_part(caminho,'/',1)=grupo_id::text
    and split_part(caminho,'/',2)=nota_id::text
    and exists(select 1 from public.notas_salvas n
      where n.id=nota_id and n.grupo_id=notas_anexos.grupo_id)
  );
drop policy if exists dueto_anexos_apagar on public.notas_anexos;
create policy dueto_anexos_apagar on public.notas_anexos
  for delete to authenticated
  using (public.e_membro(grupo_id) and exists(
    select 1 from public.notas_salvas n
    where n.id=nota_id and n.grupo_id=notas_anexos.grupo_id
  ));

-- Nunca público; restrições aplicadas também pelo próprio Storage.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dueto-notas','dueto-notas',false,10485760,
  array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update set
  public=false, file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

-- A pasta física segue grupo/nota/arquivo.ext e deve pertencer
-- a uma nota salva no grupo do usuário autenticado.
drop policy if exists dueto_notas_storage_ler on storage.objects;
create policy dueto_notas_storage_ler on storage.objects
  for select to authenticated
  using (bucket_id='dueto-notas' and exists(
    select 1 from public.notas_salvas n
    where n.grupo_id::text=(storage.foldername(name))[1]
      and n.id::text=(storage.foldername(name))[2]
      and public.e_membro(n.grupo_id)
  ));
drop policy if exists dueto_notas_storage_criar on storage.objects;
create policy dueto_notas_storage_criar on storage.objects
  for insert to authenticated
  with check (bucket_id='dueto-notas' and exists(
    select 1 from public.notas_salvas n
    where n.grupo_id::text=(storage.foldername(name))[1]
      and n.id::text=(storage.foldername(name))[2]
      and public.e_membro(n.grupo_id)
  ));
drop policy if exists dueto_notas_storage_apagar on storage.objects;
create policy dueto_notas_storage_apagar on storage.objects
  for delete to authenticated
  using (bucket_id='dueto-notas' and exists(
    select 1 from public.notas_salvas n
    where n.grupo_id::text=(storage.foldername(name))[1]
      and n.id::text=(storage.foldername(name))[2]
      and public.e_membro(n.grupo_id)
  ));

commit;
