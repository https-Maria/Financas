# Dueto v113.0 — refatoração de integridade financeira

## Escopo implementado
- Motor puro `finance-core.mjs` para cálculos auditáveis, com 14 testes automatizados.
- Parcelamentos, crediários, simulações, projeções e datas de término respeitam `competencias` reais, inclusive meses pulados.
- Ajustes sem competência explícita seguem a janela do cartão. Ajustes presentes em snapshot antigo permanecem vinculados à competência congelada, mesmo que a data civil seja diferente.
- Terceiros sem competência não são repetidos em todas as faturas.
- Fotografias novas usam o total bancário quando disponível, conferem a partilha e fazem `INSERT`, não `UPSERT`.
- Congelamento automático por simples fechamento removido. A fotografia é criada na confirmação explícita no Painel.
- Realizado é baseado em caixa: pagamento da fatura conta uma vez; compra no cartão não duplica a despesa. Transferências e reembolsos não são renda do casal.
- Regra de deslocamento para o mês anterior aplica-se somente a pagamento de cartão que vence dia 1, não a compras no dia 1.
- Projeções e gráficos de categoria ignoram movimentações neutras; a interface diferencia orçamento previsto e caixa realizado.
- O campo `responsavel_fatura_atual` não recebe mais o texto `Banco conferido`; a interface ignora esse valor legado.
- Tela Integridade mostra competências incoerentes, snapshots ausentes, divergência de composição, transferências sem pareamento, categorias de renda com saída e dados antigos a revisar.
- `migracao-v113-snapshots-imutaveis.sql` endurece RLS e bloqueia edição/exclusão de snapshots; aplicar **após publicar a versão nova**.

## Validação com dados reais (09/11/2026)
- 13 parcelamentos; valor por competências reais: novembro R$ 1.370,00, dezembro R$ 1.192,60.
- 5 snapshots históricos; 4 conciliam integralmente com os itens, 1 tem diferença de R$ 29,89 (BB Elo outubro). **Não alterado.**
- 3 ciclos fechados sem snapshot (BB Visa setembro, BB Jéssica outubro, Nubank outubro). **Não preenchidos automaticamente.**
- Ajustes legados do BB Elo em 31/10 já pertencem ao snapshot de outubro; preservados ali, sem migração para dezembro.
- 27 tabelas / 991 registros salvos em schema privado antes de qualquer refatoração.

## Pendências que exigem conferência humana
- Confirmar ou cancelar lançamentos projetados em datas passadas.
- Conferir possíveis pedágios duplicados (podem ser passagens reais).
- Corrigir categorias incorretas apenas com autorização, especialmente saídas rotuladas `Salário/Renda`.
- Investigar diferença histórica de R$ 29,89 sem reescrever a fatura antiga.
- Reconciliar transferências entre contas: não existe identificador de par origem/destino, portanto o sistema não pode compensá-las com segurança.
- Conferir terceiros sem competência e os recebimentos sem data.
- Preencher limites dos cartões, se desejado; índices FK e otimizações de RLS ficam para avaliação por carga.
- Proteção contra senhas vazadas deve ser habilitada nas configurações do Supabase Auth, quando disponível.

## Publicação segura
1. Revisar o PR e conferir o resultado dos testes automatizados.
2. Testar a versão em ambiente de pré-produção, especialmente Painel, Fatura, Extrato, Lançamentos e login.
3. Publicar a versão v113.0 no GitHub `main`.
4. Só depois aplicar a migração de imutabilidade no Supabase.
5. Validar login, leitura de snapshots, criação de um snapshot em ambiente de teste, e bloqueio de UPDATE/DELETE.
6. Não rodar scripts de correção de dados históricos sem conciliação com extratos.

**Atenção:** a cópia `backup_dueto_20261109` está no mesmo banco. Para proteção contra perda do projeto inteiro, exportar também um dump para local seguro.
