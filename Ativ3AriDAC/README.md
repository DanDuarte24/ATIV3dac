# Persistência coordenada em PostgreSQL e MongoDB

Este projeto executa os três cenários pedidos na atividade. Os cenários ficam separados em arquivos JavaScript e cada um retorna os dados que o `main.js` imprime e salva em `relatorio.txt`.

## O que precisa estar instalado

- Docker Desktop aberto
- Node.js 18 ou mais novo
- Acesso ao cluster MongoDB Atlas usado pelo projeto

A aplicação usa o PostgreSQL local do Docker e o MongoDB Atlas. O Compose inicia apenas o PostgreSQL; o app conecta ao MongoDB Atlas usando a URI em `src/coordinator.js`.

## Como executar no Windows

1. Abra o PowerShell na pasta do projeto. Se abriu outra pasta, entre nela com `cd`, usando o caminho onde está este README:

   ```powershell
   cd "C:\Users\danil\OneDrive\Documentos\Tralhas ADS\Ativ3AriDAC - Copia"
   ```

2. Inicie o PostgreSQL do projeto:

   ```powershell
   docker compose up -d postgres
   ```

   O Compose configura `max_prepared_transactions=10`, necessário para o PostgreSQL preparar transações antes da decisão do coordenador.

3. Instale as dependências. Faça isso na primeira execução ou quando o `package.json` mudar:

   ```powershell
   npm.cmd install
   ```

4. Execute os três cenários em sequência:

   ```powershell
   npm.cmd run demo
   ```

5. Para executar somente um cenário, use o comando correspondente:

   ```powershell
   npm.cmd run demo:1
   npm.cmd run demo:2
   npm.cmd run demo:3
   ```

   `demo:1` roda PostgreSQL primeiro; `demo:2` roda MongoDB primeiro; `demo:3` roda a atualização com consultas a cada 10 ms. Cada comando roda somente aquele cenário e substitui `relatorio.txt` pelo resultado dele.

6. Leia o relatório produzido:

   ```powershell
   Get-Content .\relatorio.txt
   ```

   Também é possível abrir `relatorio.txt` no Bloco de Notas ou no editor usado para o código. Antes de cada execução, o app limpa somente os três registros reservados à demonstração.

Para parar o PostgreSQL depois da atividade:

```powershell
docker compose stop postgres
```

## O que cada arquivo faz

- `src/main.js`: inicia o coordenador, chama os três cenários em sequência e gera `relatorio.txt`.
- `src/coordinator.js`: implementa as fases de preparação, decisão, confirmação/aborto e recuperação. Também contém as configurações de conexão.
- `src/scenarios/scenario1-postgres-first.js`: grava/prepara no PostgreSQL primeiro; força uma falha no preparo MongoDB e retorna o erro, a decisão e o estado final dos dois bancos.
- `src/scenarios/scenario2-mongo-first.js`: prepara a intenção no MongoDB primeiro; força uma falha PostgreSQL e retorna o erro, a decisão e o estado final.
- `src/scenarios/scenario3-concurrent-update.js`: insere e atualiza usando o coordenador enquanto agenda consultas pareadas a cada 10 ms; retorna leituras, divergências e valores finais.
- `docker-compose.yml`: inicia o PostgreSQL com suporte a transações preparadas.
- `relatorio.txt`: resultados da última execução.

## Como o 2PC funciona neste projeto

1. **Prepare:** o coordenador registra `PREPARING`. O PostgreSQL executa a operação e usa `PREPARE TRANSACTION`. O MongoDB grava a intenção em `twopc_pending` e responde que está pronto.
2. **Decisão:** se ambos responderem que estão prontos, o coordenador grava `COMMIT`; se algum falhar, grava `ABORT`.
3. **Finalização:** em `COMMIT`, o PostgreSQL usa `COMMIT PREPARED` e o coordenador publica o estágio MongoDB. Em `ABORT`, o PostgreSQL usa `ROLLBACK PREPARED` e o estágio MongoDB é removido.
4. **Recuperação:** se o processo parar no meio, a próxima execução consulta o log: uma transação sem decisão final é abortada; uma decisão `COMMIT` já gravada é concluída.

Isso implementa o **conceito de 2PC no coordenador da aplicação**. O MongoDB não oferece ao driver Node um participante XA `prepare` compartilhado com PostgreSQL; por isso, o voto MongoDB é representado por um estágio durável. Não chame isso de XA nativo entre os dois bancos. O lock que impede o leitor do cenário 3 de observar a operação pela metade vale apenas para esta instância do app.

## Se der erro de conexão

- Se o erro mencionar `max_prepared_transactions`, rode `docker compose up -d --force-recreate postgres` e tente novamente.
- Se o Atlas recusar a conexão, confira se o endereço IP está permitido na lista de acesso do cluster e se a URI em `src/coordinator.js` está atualizada.
- Se `npm` for bloqueado pela política do PowerShell, use os comandos `npm.cmd` mostrados acima.