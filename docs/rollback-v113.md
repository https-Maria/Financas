# Dueto — plano de retorno da v113.0

## Cópias feitas em 09/11/2026
- Código original: branch `backup/pre-refatoracao-2026-11-09`, commit `9a5e46df6f1ba085af2f0e320922aeda33e138cb`.
- Dados: schema privado `backup_dueto_20261109` no projeto Supabase `ulukjixlbxgmkyzmvxjm`.
- Conferência: 27 tabelas, 991 registros, 411 definições de colunas/policies/funções/constraints. Cada tabela tem contagem e checksum em `_manifest`.
- A cópia do banco é **interna ao projeto**, não é um dump off-site nem inclui dados de `auth` e Storage.

## Recuperação do código
Reimplantar o commit do backup via GitHub, após revisar mudanças feitas depois do snapshot.
Nunca sobrescrever `main` à força sem comparar os commits.

## Recuperação de dados
1. Suspender gravações e comparar `public` com `backup_dueto_20261109._manifest`.
2. Restaurar apenas as tabelas/linhas afetadas com transação e conferência de IDs, chaves estrangeiras e contagens.
3. O schema de backup é uma cópia de dados (CTAS), não um backup físico completo do Postgres. Para recuperação de desastre, usar `supabase db dump`/backup da plataforma em armazenamento externo.
4. Não substituir dados criados após 09/11 sem conciliação.

## Proteção de faturas
A migração `migracao-v113-snapshots-imutaveis.sql` só deve ser aplicada **depois** de publicar o app v113.0, pois a versão antiga ainda permite descongelar faturas. Para rollback, reverter conscientemente a política e o trigger com uma nova migração; não restaurar automaticamente os 5 snapshots.
