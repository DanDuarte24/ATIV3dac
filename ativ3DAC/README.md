# Persistência coordenada em PostgreSQL e MongoDB

Este projeto executa os três cenários da atividade usando uma coordenação em duas fases (2PC) implementada pela aplicação. Os resultados de cada cenário são exibidos no terminal. Esta cópia não gera nem atualiza arquivo de relatório.

## O que precisa estar instalado

- Docker Desktop aberto
- Node.js 18 ou mais novo
- Acesso ao cluster MongoDB Atlas configurado em `src/coordinator.js`

A aplicação usa o PostgreSQL local do Docker e o MongoDB Atlas. O Compose inicia apenas o PostgreSQL.

## Como executar no Windows

Abra o PowerShell nesta pasta (`ativ3DAC`) e execute:

```powershell
docker compose up -d postgres
npm.cmd install
```

Rode os três cenários em sequência:

```powershell
npm.cmd run demo
```

Para executar somente um cenário:

```powershell
npm.cmd run demo:1
npm.cmd run demo:2
npm.cmd run demo:3
```

- `demo:1`: prepara no PostgreSQL primeiro, força falha no MongoDB e demonstra o aborto.
- `demo:2`: prepara no MongoDB primeiro, força falha no PostgreSQL e demonstra o aborto.
- `demo:3`: atualiza os dois bancos enquanto agenda consultas pareadas a cada 10 ms.

Para parar o PostgreSQL depois da atividade:

```powershell
docker compose stop postgres
```

## Arquivos principais

- `src/main.js`: seleciona e executa os cenários; imprime apenas os resultados no terminal.
- `src/coordinator.js`: implementa preparação, decisão, confirmação/aborto e recuperação; contém as configurações de conexão.
- `src/scenarios/scenario1-postgres-first.js`: falha no preparo MongoDB após iniciar pelo PostgreSQL.
- `src/scenarios/scenario2-mongo-first.js`: falha no PostgreSQL após iniciar pelo MongoDB.
- `src/scenarios/scenario3-concurrent-update.js`: executa atualização coordenada e consultas a cada 10 ms.
- `docker-compose.yml`: inicia PostgreSQL com suporte a transações preparadas.
- `package.json` e `package-lock.json`: dependências e comandos de execução.

## Como o 2PC funciona neste projeto

1. **Prepare:** o coordenador registra `PREPARING`. O PostgreSQL executa a operação e usa `PREPARE TRANSACTION`. O MongoDB grava a intenção em `twopc_pending` e responde que está pronto.
2. **Decisão:** se ambos responderem que estão prontos, o coordenador grava `COMMIT`; se algum falhar, grava `ABORT`.
3. **Finalização:** em `COMMIT`, o PostgreSQL usa `COMMIT PREPARED` e o coordenador publica o estágio MongoDB. Em `ABORT`, o PostgreSQL usa `ROLLBACK PREPARED` e o estágio MongoDB é removido.
4. **Recuperação:** se o processo parar no meio, a próxima execução consulta o log: uma transação sem decisão final é abortada; uma decisão `COMMIT` já gravada é concluída.

Isso implementa o **conceito de 2PC no coordenador da aplicação**. O MongoDB não oferece ao driver Node um participante XA `prepare` compartilhado com PostgreSQL; por isso, o voto MongoDB é representado por um estágio durável. O lock que impede o leitor do cenário 3 de observar a operação pela metade vale apenas para esta instância do app.

## Se der erro de conexão

- Se o erro mencionar `max_prepared_transactions`, rode `docker compose up -d --force-recreate postgres` e tente novamente.
- Se o Atlas recusar a conexão, confira se o endereço IP está permitido na lista de acesso do cluster e se a URI em `src/coordinator.js` está atualizada.
- Se `npm` for bloqueado pela política do PowerShell, use os comandos `npm.cmd` mostrados acima.