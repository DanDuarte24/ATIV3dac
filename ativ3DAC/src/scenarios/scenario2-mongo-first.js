module.exports = async function scenario2(coordinator) {
  const record = coordinator.createItem('falha-mongo-pg', 'Cenário MongoDB → PostgreSQL', 20);
  try {
    await coordinator.coordinate2PC({
      recordId: record.id,
      operation: 'insert',
      document: record,
      postgresSql: 'INSERT INTO items(id,name,value) VALUES($1,$2,$3)',
      postgresParams: [record.id, record.name, record.value],
      order: ['mongodb', 'postgres'],
      failPostgres: true,
    });
    return { scenario: 2, title: 'MongoDB primeiro; depois PostgreSQL', unexpected: 'A falha PostgreSQL não ocorreu.' };
  } catch (error) {
    const state = await coordinator.countInBoth(record.id);
    return {
      scenario: 2,
      title: 'MongoDB primeiro; depois PostgreSQL',
      error: error.message,
      decision: 'ABORT',
      rollback: 'O estágio MongoDB foi removido; PostgreSQL executou ROLLBACK.',
      state,
    };
  }
};