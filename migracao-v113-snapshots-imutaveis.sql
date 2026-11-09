-- Dueto v113.0 — executar SOMENTE depois de publicar o app refatorado.
-- Os 5 snapshots existentes permanecem intactos.
-- Aplicar em transação, com backup_dueto_20261109 já conferido.
BEGIN;

REVOKE ALL ON TABLE public.faturas_fechadas FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.faturas_fechadas TO authenticated;

DROP POLICY IF EXISTS faturas_fechadas_rw ON public.faturas_fechadas;
DROP POLICY IF EXISTS faturas_fechadas_select ON public.faturas_fechadas;
DROP POLICY IF EXISTS faturas_fechadas_insert ON public.faturas_fechadas;

CREATE POLICY faturas_fechadas_select
  ON public.faturas_fechadas FOR SELECT TO authenticated
  USING (public.e_membro(grupo_id));

CREATE POLICY faturas_fechadas_insert
  ON public.faturas_fechadas FOR INSERT TO authenticated
  WITH CHECK (public.e_membro(grupo_id));

CREATE OR REPLACE FUNCTION public.dueto_bloquear_edicao_snapshot()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'Fatura histórica imutável. Use correção em fatura aberta.'
      USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE ALL ON FUNCTION public.dueto_bloquear_edicao_snapshot() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS dueto_snapshot_immutavel ON public.faturas_fechadas;
CREATE TRIGGER dueto_snapshot_immutavel
  BEFORE UPDATE OR DELETE ON public.faturas_fechadas
  FOR EACH ROW EXECUTE FUNCTION public.dueto_bloquear_edicao_snapshot();

COMMIT;

-- Pós-deploy: testar SELECT/INSERT com conta do grupo e verificar que
-- UPDATE/DELETE/TRUNCATE são negados para authenticated.
