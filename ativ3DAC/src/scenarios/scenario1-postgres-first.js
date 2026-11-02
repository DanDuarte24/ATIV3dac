module.exports = async function scenario1(coordinator) {
  const record = coordinator.createItem('falha-pg-mongo', 'Cenário PostgreSQL → MongoDB', 10);
  try {
    await coordinator.coordinate2PC({
      recordId: record.id,
      operation: 'insert',
      document: record,
      postgresSql: 'INSERT INTO items(id,name,value) VALUES($1,$2,$3)',
      postgresParams: [record.id, record.name, record.value],
      order: ['postgres', 'mongodb'],
      failMongo: true,
    });
    return { scenario: 1, title: 'PostgreSQL primeiro; depois MongoDB', unexpected: 'A falha MongoDB não ocorreu.' };
  } catch (error) {
    const state = await coordinator.countInBoth(record.id);
    return {
      scenario: 1,
      title: 'PostgreSQL primeiro; depois MongoDB',
      error: error.message,
      decision: 'ABORT',
      rollback: 'PostgreSQL executou ROLLBACK PREPARED; a preparação MongoDB foi abortada.',
      state,
    };
  }
};