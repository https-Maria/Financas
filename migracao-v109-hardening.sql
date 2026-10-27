-- Dueto v109 — hardening de segurança e snapshots consistentes
-- 27/10/2026
--
-- Objetivos:
-- 1) bloquear acesso anônimo aos dados/RPCs do Dueto;
-- 2) expor a authenticated somente RPCs realmente usadas;
-- 3) tornar snapshots completos e versionados;
-- 4) impedir restauração de snapshots legados incompletos;
-- 5) preservar o cofre criptografado ao restaurar cartões.

alter table public.snapshots
  add column if not exists versao smallint not null default 1;

update public.snapshots
set versao = coalesce(
  case when (dados->>'versao') ~ '^[0-9]+$' then (dados->>'versao')::smallint end,
  1
);

create or replace function public.criar_snapshot(
  p_grupo uuid,
  p_rotulo text default null,
  p_auto boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d jsonb;
  n int;
  novo uuid;
begin
  if auth.uid() is null then raise exception 'Sessão inválida'; end if;
  if not public.e_membro(p_grupo) then raise exception 'Você não é membro deste grupo'; end if;

  select jsonb_build_object(
    'versao',2,'quando',now(),
    'rendas',coalesce((select jsonb_agg(to_jsonb(t)) from public.rendas t where t.grupo_id=p_grupo),'[]'::jsonb),
    'fixas',coalesce((select jsonb_agg(to_jsonb(t)) from public.fixas t where t.grupo_id=p_grupo),'[]'::jsonb),
    'beneficios',coalesce((select jsonb_agg(to_jsonb(t)) from public.beneficios t where t.grupo_id=p_grupo),'[]'::jsonb),
    'cartoes',coalesce((select jsonb_agg(to_jsonb(t)) from public.cartoes t where t.grupo_id=p_grupo),'[]'::jsonb),
    'parcelamentos',coalesce((select jsonb_agg(to_jsonb(t)) from public.parcelamentos t where t.grupo_id=p_grupo),'[]'::jsonb),
    'assinaturas',coalesce((select jsonb_agg(to_jsonb(t)) from public.assinaturas t where t.grupo_id=p_grupo),'[]'::jsonb),
    'assinatura_excecoes',coalesce((select jsonb_agg(to_jsonb(t)) from public.assinatura_excecoes t where t.grupo_id=p_grupo),'[]'::jsonb),
    'lancamentos',coalesce((select jsonb_agg(to_jsonb(t)) from public.lancamentos t where t.grupo_id=p_grupo),'[]'::jsonb),
    'terceiros',coalesce((select jsonb_agg(to_jsonb(t)) from public.terceiros t where t.grupo_id=p_grupo),'[]'::jsonb),
    'metas',coalesce((select jsonb_agg(to_jsonb(t)) from public.metas t where t.grupo_id=p_grupo),'[]'::jsonb),
    'casa_itens',coalesce((select jsonb_agg(to_jsonb(t)) from public.casa_itens t where t.grupo_id=p_grupo),'[]'::jsonb),
    'financiamentos',coalesce((select jsonb_agg(to_jsonb(t)) from public.financiamentos t where t.grupo_id=p_grupo),'[]'::jsonb),
    'agenda',coalesce((select jsonb_agg(to_jsonb(t)) from public.agenda t where t.grupo_id=p_grupo),'[]'::jsonb),
    'ciclos',coalesce((select jsonb_agg(to_jsonb(t)) from public.ciclos t where t.grupo_id=p_grupo),'[]'::jsonb),
    'faturas_fechadas',coalesce((select jsonb_agg(to_jsonb(t)) from public.faturas_fechadas t where t.grupo_id=p_grupo),'[]'::jsonb),
    'notas',coalesce((select jsonb_agg(to_jsonb(t)) from public.notas t where t.grupo_id=p_grupo),'[]'::jsonb),
    'notas_salvas',coalesce((select jsonb_agg(to_jsonb(t)) from public.notas_salvas t where t.grupo_id=p_grupo),'[]'::jsonb),
    'config',coalesce((select jsonb_agg(to_jsonb(t)) from public.config t where t.grupo_id=p_grupo),'[]'::jsonb)
  ) into d;

  select coalesce(sum(jsonb_array_length(v)),0)::int into n
  from jsonb_each(d) e(k,v) where jsonb_typeof(v)='array';

  insert into public.snapshots
    (grupo_id,rotulo,automatico,dados,linhas,criado_por,versao)
  values
    (p_grupo,coalesce(p_rotulo,to_char(now() at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI')),
     p_auto,d,n,auth.uid(),2)
  returning id into novo;

  delete from public.snapshots s
  where s.grupo_id=p_grupo
    and s.id not in (
      select id from public.snapshots where grupo_id=p_grupo
      order by criado_em desc limit 20
    );

  return novo;
end;
$$;

create or replace function public.restaurar_snapshot(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.snapshots%rowtype;
  t text;
  vault_rows jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then raise exception 'Sessão inválida'; end if;

  select * into s from public.snapshots where id=p_id;
  if not found then raise exception 'Cópia não encontrada'; end if;
  if not public.e_membro(s.grupo_id) then raise exception 'Você não é membro deste grupo'; end if;
  if coalesce(s.versao,1)<2 then
    raise exception 'Cópia antiga incompleta: não pode ser restaurada com segurança';
  end if;

  perform public.criar_snapshot(s.grupo_id,'Antes de restaurar '||s.rotulo,true);

  select coalesce(jsonb_agg(to_jsonb(v)),'[]'::jsonb)
  into vault_rows from public.cartoes_cofre v where v.grupo_id=s.grupo_id;

  perform set_config('dueto.audit_origin','restaurar_snapshot',true);

  foreach t in array array[
    'assinatura_excecoes','lancamentos','terceiros','metas','casa_itens','agenda',
    'financiamentos','parcelamentos','assinaturas','beneficios','fixas','rendas',
    'ciclos','faturas_fechadas','notas_salvas','notas','cartoes','config'
  ] loop
    execute format('delete from public.%I where grupo_id=$1',t) using s.grupo_id;
  end loop;

  foreach t in array array[
    'config','cartoes','rendas','fixas','beneficios','assinaturas',
    'assinatura_excecoes','parcelamentos','financiamentos','metas','casa_itens',
    'agenda','ciclos','faturas_fechadas','terceiros','lancamentos','notas','notas_salvas'
  ] loop
    execute format(
      'insert into public.%I select * from jsonb_populate_recordset(null::public.%I,$1)',t,t
    ) using coalesce(s.dados->t,'[]'::jsonb);
  end loop;

  if jsonb_array_length(vault_rows)>0 then
    insert into public.cartoes_cofre
    select v.*
    from jsonb_populate_recordset(null::public.cartoes_cofre,vault_rows) v
    join public.cartoes c on c.id=v.cartao_id and c.grupo_id=s.grupo_id
    on conflict (user_id,cartao_id) do update set
      payload_ciphertext=excluded.payload_ciphertext,
      payload_iv=excluded.payload_iv,
      versao=excluded.versao,
      atualizado_em=excluded.atualizado_em;
  end if;

  return 'Restaurado: '||s.rotulo||' ('||s.linhas||' linhas)';
end;
$$;

-- O aplicativo não usa dados antes do login.
revoke select,insert,update,delete on table
  public.agenda,public.assinatura_excecoes,public.assinaturas,public.auditoria,
  public.beneficios,public.cartoes,public.cartoes_cofre,public.casa_itens,
  public.ciclos,public.cofre_config,public.config,public.convites,
  public.faturas_fechadas,public.financiamentos,public.fixas,public.grupos,
  public.lancamentos,public.login_historico,public.membros,public.metas,
  public.notas,public.notas_salvas,public.parcelamentos,public.rendas,
  public.simulacoes,public.snapshots,public.terceiros
from anon;

revoke usage,select on sequence public.auditoria_id_seq from anon;

-- Retira o grant PUBLIC implícito e libera apenas RPCs necessárias.
revoke execute on function public.criar_grupo(text,text) from public,anon,authenticated;
revoke execute on function public.criar_snapshot(uuid,text,boolean) from public,anon;
revoke execute on function public.dueto_auditar() from public,anon,authenticated;
revoke execute on function public.dueto_desfazer_auditoria(bigint) from public,anon;
revoke execute on function public.e_membro(uuid) from public,anon;
revoke execute on function public.entrar_com_convite(text,text) from public,anon;
revoke execute on function public.gerar_convite(uuid) from public,anon,authenticated;
revoke execute on function public.grupo_vazio(uuid) from public,anon;
revoke execute on function public.instalar_grupo(text,text,text) from public,anon,authenticated;
revoke execute on function public.instalar_membro(uuid,text,text) from public,anon,authenticated;
revoke execute on function public.restaurar_snapshot(uuid) from public,anon;

grant execute on function public.criar_snapshot(uuid,text,boolean) to authenticated;
grant execute on function public.dueto_desfazer_auditoria(bigint) to authenticated;
grant execute on function public.e_membro(uuid) to authenticated;
grant execute on function public.entrar_com_convite(text,text) to authenticated;
grant execute on function public.grupo_vazio(uuid) to authenticated;
grant execute on function public.restaurar_snapshot(uuid) to authenticated;

alter default privileges in schema public revoke execute on functions from public,anon,authenticated;
alter default privileges in schema public revoke select,insert,update,delete on tables from anon;
alter default privileges in schema public revoke usage,select on sequences from anon;

notify pgrst, 'reload schema';
