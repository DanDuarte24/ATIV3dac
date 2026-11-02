module.exports = async function scenario3(coordinator) {
  const record = coordinator.createItem('atualizacao-concorrente', 'Versão inicial', 1);
  await coordinator.coordinate2PC({
    recordId: record.id,
    operation: 'insert',
    document: record,
    postgresSql: 'INSERT INTO items(id,name,value) VALUES($1,$2,$3)',
    postgresParams: [record.id, record.name, record.value],
  });

  let mismatches = 0;
  let pollingError = null;
  const scheduledReads = [];
  const poller = setInterval(() => {
    scheduledReads.push(coordinator.readPair(record.id).then((pair) => {
      if (!coordinator.sameRecord(pair.postgres, pair.mongodb)) mismatches += 1;
    }).catch((error) => { pollingError = pollingError || error; }));
  }, 10);

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const updated = coordinator.createItem(record.id, 'Versão atualizada', 2);
    await coordinator.coordinate2PC({
      recordId: updated.id,
      operation: 'update',
      document: updated,
      postgresSql: 'UPDATE items SET name=$2,value=$3,updated_at=NOW() WHERE id=$1',
      postgresParams: [updated.id, updated.name, updated.value],
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    clearInterval(poller);
    await Promise.all(scheduledReads);
  }

  if (pollingError) throw pollingError;
  return {
    scenario: 3,
    title: 'Atualização com consultas pareadas a cada 10 ms',
    scheduledReads: scheduledReads.length,
    mismatches,
    finalState: await coordinator.readPair(record.id),
  };
};