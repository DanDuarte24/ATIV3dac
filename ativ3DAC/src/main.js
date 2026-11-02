const coordinator = require('./coordinator');
const scenario1 = require('./scenarios/scenario1-postgres-first');
const scenario2 = require('./scenarios/scenario2-mongo-first');
const scenario3 = require('./scenarios/scenario3-concurrent-update');

const scenarios = new Map([
  ['1', scenario1],
  ['2', scenario2],
  ['3', scenario3],
]);

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

    for (const [, runScenario] of selected) {
      const result = await runScenario(coordinator);
      process.stdout.write(`${formatConsoleResult(result)}\n`);
    }
  } finally {
    await coordinator.close();
  }
}

main().catch((error) => {
  console.error('Falha ao executar os cenários:', error.message);
  process.exitCode = 1;
});