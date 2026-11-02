const fs = require('node:fs/promises');
const path = require('node:path');
const coordinator = require('./coordinator');
const scenario1 = require('./scenarios/scenario1-postgres-first');
const scenario2 = require('./scenarios/scenario2-mongo-first');
const scenario3 = require('./scenarios/scenario3-concurrent-update');

const scenarios = new Map([
  ['1', scenario1],
  ['2', scenario2],
  ['3', scenario3],
]);

function formatScenario(result) {
  if (result.scenario === 1 || result.scenario === 2) {
    return [
      `Cenário ${result.scenario} — ${result.title}`,
      `Erro do participante: ${result.error}`,
      `Decisão do coordenador: ${result.decision}. ${result.rollback}`,
      `Estado final: PostgreSQL=${result.state.postgres}, MongoDB=${result.state.mongodb}.`,
    ];
  }

  return [
    `Cenário 3 — ${result.title}`,
    `Consultas agendadas: ${result.scheduledReads}; divergências observadas: ${result.mismatches}.`,
    `Estado final: PostgreSQL=${result.finalState.postgres?.name}/${result.finalState.postgres?.value}; MongoDB=${result.finalState.mongodb?.name}/${result.finalState.mongodb?.value}.`,
    'O leitor pareado aguarda o fim da operação coordenada.',
  ];
}

function formatConsoleResult(result) {
  if (result.scenario === 1 || result.scenario === 2) {
    return [
      `Cenário ${result.scenario}: ${result.title}`,
      `Falha: ${result.error}`,
      `Decisão: ${result.decision}. ${result.rollback}`,
      `Estado final: PostgreSQL=${result.state.postgres}, MongoDB=${result.state.mongodb}.`,
      '',
    ].join('\n');
  }
  return [
    `Cenário 3: ${result.title}`,
    `Consultas agendadas: ${result.scheduledReads}; divergências: ${result.mismatches}.`,
    `Estado final: PostgreSQL=${result.finalState.postgres?.name}/${result.finalState.postgres?.value}; MongoDB=${result.finalState.mongodb?.name}/${result.finalState.mongodb?.value}.`,
    '',
  ].join('\n');
}

function formatReport(results) {
  const lines = [
    'RELATÓRIO DE EXECUÇÃO — 2PC EM NÍVEL DE APLICAÇÃO',
    `Data: ${new Date().toLocaleString('pt-BR')}`,
    '',
  ];
  for (const result of results) lines.push(...formatScenario(result), '');
  lines.push(
    'Arquitetura: o coordenador persiste a decisão no PostgreSQL; PostgreSQL usa PREPARE TRANSACTION, COMMIT PREPARED e ROLLBACK PREPARED. Cada cenário está em seu próprio arquivo em src/scenarios/. MongoDB registra a intenção em twopc_pending como voto YES e publica os dados após a decisão COMMIT. Na inicialização, PREPARING sem decisão final vira ABORT e COMMIT pendente é concluído de forma idempotente.',
    'Limite: o estágio MongoDB implementa prepare em nível de aplicação; não é um participante XA nativo compartilhado com PostgreSQL. A trava do leitor vale apenas neste processo.',
  );
  return `${lines.join('\n')}\n`;
}

function selectScenarios(argument) {
  if (!argument || argument === 'all') return [...scenarios.entries()];
  if (!scenarios.has(argument)) {
    throw new Error('Escolha "all", "1", "2" ou "3". Exemplo: npm.cmd run demo:2');
  }
  return [[argument, scenarios.get(argument)]];
}

async function main() {
  const selected = selectScenarios(process.argv[2]);
  await coordinator.initialize();
  try {
    await coordinator.recoverCoordinator();
    await coordinator.resetDemoData([
      'falha-pg-mongo',
      'falha-mongo-pg',
      'atualizacao-concorrente',
    ]);

    const results = [];
    for (const [, runScenario] of selected) {
      const result = await runScenario(coordinator);
      results.push(result);
      process.stdout.write(`${formatConsoleResult(result)}\n`);
    }

    // O relatório é salvo para entrega, mas não é impresso no terminal.
    const reportPath = path.resolve('relatorio.txt');
    await fs.writeFile(reportPath, formatReport(results), 'utf8');
  } finally {
    await coordinator.close();
  }
}

main().catch((error) => {
  console.error('Falha ao executar os cenários:', error.message);
  process.exitCode = 1;
});