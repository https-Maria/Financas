-- Dueto v102 — Atividade, desfazer e histórico de login

create table if not exists public.auditoria (
  id bigserial primary key,
  grupo_id uuid not null,
  tabela text not null,
  registro_id text not null,
  acao text not null check (acao in ('criou','editou','excluiu')),
  rotulo text,
  antes jsonb,
  depois jsonb,
  campos text[] not null default '{}',
  quem_id uuid,
  quem_nome text,
  origem text not null default 'app',
  quando timestamptz not null default now()
);
create index if not exists auditoria_grupo_quando_idx on public.auditoria (grupo_id, quando desc);
create index if not exists auditoria_registro_idx on public.auditoria (grupo_id, tabela, registro_id, quando desc);
alter table public.auditoria enable row level security;
revoke all on public.auditoria from anon;
revoke insert, update, delete on public.auditoria from authenticated;
grant select on public.auditoria to authenticated;
drop policy if exists auditoria_select on public.auditoria;
create policy auditoria_select on public.auditoria for select to authenticated
using (public.e_membro(grupo_id));

create table if not exists public.login_historico (
  id uuid primary key default gen_random_uuid(),
  grupo_id uuid not null,
  user_id uuid not null,
  nome text,
  metodo text not null default 'senha',
  user_agent text,
  plataforma text,
  idioma text,
  quando timestamptz not null default now()
);
create index if not exists login_historico_grupo_quando_idx on public.login_historico (grupo_id, quando desc);
alter table public.login_historico enable row level security;
revoke all on public.login_historico from anon;
grant select, insert on public.login_historico to authenticated;
revoke update, delete on public.login_historico from authenticated;
drop policy if exists login_historico_select on public.login_historico;
create policy login_historico_select on public.login_historico for select to authenticated
using (public.e_membro(grupo_id));
drop policy if exists login_historico_insert on public.login_historico;
create policy login_historico_insert on public.login_historico for insert to authenticated
with check (auth.uid()=user_id and public.e_membro(grupo_id));

create or replace function public.dueto_auditar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  j_old jsonb; j_new jsonb; j_ref jsonb; g uuid; u uuid;
  nome_usuario text; ato text; r_id text; rot text; diffs text[]; orig text;
begin
  j_old := case when TG_OP in ('UPDATE','DELETE') then to_jsonb(OLD) else null end;
  j_new := case when TG_OP in ('INSERT','UPDATE') then to_jsonb(NEW) else null end;
  j_ref := coalesce(j_new,j_old,'{}'::jsonb);
  g := nullif(j_ref->>'grupo_id','')::uuid;
  if g is null then
    if TG_OP='DELETE' then return OLD; else return NEW; end if;
  end if;

  u := auth.uid();
  if u is not null then
    select m.nome into nome_usuario from public.membros m
    where m.grupo_id=g and m.user_id=u limit 1;
  end if;

  ato := case TG_OP when 'INSERT' then 'criou' when 'UPDATE' then 'editou' else 'excluiu' end;
  r_id := coalesce(j_ref->>'id',j_ref->>'grupo_id','sem-id');
  rot := coalesce(nullif(j_ref->>'descricao',''),nullif(j_ref->>'nome',''),
                  nullif(j_ref->>'titulo',''),nullif(j_ref->>'cartao',''),
                  case when TG_TABLE_NAME='config' then 'Configuração' else TG_TABLE_NAME end);

  if TG_OP='UPDATE' then
    select coalesce(array_agg(k order by k),'{}'::text[]) into diffs
    from (
      select coalesce(n.key,o.key) k
      from jsonb_each(coalesce(j_new,'{}'::jsonb)) n
      full join jsonb_each(coalesce(j_old,'{}'::jsonb)) o on o.key=n.key
      where n.value is distinct from o.value and coalesce(n.key,o.key) not in ('atualizado_em')
    ) d;
    if cardinality(diffs)=0 then return NEW; end if;
  else diffs := '{}'::text[];
  end if;

  orig := nullif(current_setting('dueto.audit_origin',true),'');
  if orig is null then orig := case when u is null then 'banco/script' else 'app' end; end if;

  insert into public.auditoria
    (grupo_id,tabela,registro_id,acao,rotulo,antes,depois,campos,quem_id,quem_nome,origem)
  values
    (g,TG_TABLE_NAME,r_id,ato,rot,j_old,j_new,diffs,u,
     coalesce(nome_usuario,case when u is null then 'Sistema' end),orig);

  if TG_OP='DELETE' then return OLD; else return NEW; end if;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'rendas','fixas','beneficios','cartoes','parcelamentos','assinaturas',
    'assinatura_excecoes','lancamentos','terceiros','metas','casa_itens',
    'financiamentos','agenda','ciclos','faturas_fechadas','config','notas','notas_salvas'
  ]
  loop
    if to_regclass('public.'||t) is not null then
      execute format('drop trigger if exists dueto_audit_trg on public.%I',t);
      execute format('create trigger dueto_audit_trg after insert or update or delete on public.%I for each row execute function public.dueto_auditar()',t);
    end if;
  end loop;
end $$;

create or replace function public.dueto_desfazer_auditoria(p_audit_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a public.auditoria%rowtype; ultimo_id bigint; chave text;
  existe boolean; assigns text;
begin
  if auth.uid() is null then raise exception 'Sessão inválida'; end if;
  select * into a from public.auditoria where id=p_audit_id;
  if not found then raise exception 'Registro de atividade não encontrado'; end if;
  if not public.e_membro(a.grupo_id) then raise exception 'Sem acesso a este grupo'; end if;

  if a.tabela <> all(array[
    'rendas','fixas','beneficios','cartoes','parcelamentos','assinaturas',
    'assinatura_excecoes','lancamentos','terceiros','metas','casa_itens',
    'financiamentos','agenda','config','notas','notas_salvas'
  ]) then raise exception 'Este tipo de registro não pode ser desfeito automaticamente'; end if;

  select id into ultimo_id from public.auditoria
   where grupo_id=a.grupo_id and tabela=a.tabela and registro_id=a.registro_id
   order by quando desc,id desc limit 1;
  if ultimo_id is distinct from a.id then
    raise exception 'Este registro mudou depois. Desfaça primeiro a alteração mais recente.';
  end if;

  chave := case when a.tabela='config' then 'grupo_id' else 'id' end;
  execute format('select exists(select 1 from public.%I where %I::text=$1)',a.tabela,chave)
    into existe using a.registro_id;
  perform set_config('dueto.audit_origin','desfazer',true);

  if a.acao='criou' then
    if not existe then raise exception 'O registro já não existe'; end if;
    execute format('delete from public.%I where %I::text=$1',a.tabela,chave) using a.registro_id;
  elsif a.acao='editou' then
    if not existe then raise exception 'O registro não existe mais'; end if;
    select string_agg(format('%I = x.%I',c.column_name,c.column_name),', ') into assigns
      from information_schema.columns c
     where c.table_schema='public' and c.table_name=a.tabela and a.antes ? c.column_name
       and c.column_name not in ('id','grupo_id','criado_em','criado_por');
    if assigns is null then raise exception 'Nada para restaurar'; end if;
    execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I,$1) x where t.%I::text=$2',
                   a.tabela,assigns,a.tabela,chave)
      using a.antes,a.registro_id;
  elsif a.acao='excluiu' then
    if existe then raise exception 'Já existe um registro com este identificador'; end if;
    execute format('insert into public.%I select * from jsonb_populate_record(null::public.%I,$1)',a.tabela,a.tabela)
      using a.antes;
  end if;

  return jsonb_build_object('ok',true,'tabela',a.tabela,'registro_id',a.registro_id,'acao_desfeita',a.acao);
end;
$$;
revoke all on function public.dueto_desfazer_auditoria(bigint) from public;
grant execute on function public.dueto_desfazer_auditoria(bigint) to authenticated;
