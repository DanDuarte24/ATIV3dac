const { Pool } = require('pg');
const { MongoClient } = require('mongodb');
const { randomUUID } = require('node:crypto');

// Dados de conexão da atividade. Ajuste aqui se usar outras instâncias.
const POSTGRES_CONFIG = {
  host: 'localhost',
  port: 5432,
  database: 'Bancoari',
  user: 'd',
  password: '123456',
};
// URI padrão com os três nós do Atlas; evita consulta DNS SRV.
const MONGODB_URI = 'mongodb://daniloduarte_db_user:gaW0dLsxpxE0ypyb@ac-wzw9zqd-shard-00-00.q2tv9bl.mongodb.net:27017,ac-wzw9zqd-shard-00-01.q2tv9bl.mongodb.net:27017,ac-wzw9zqd-shard-00-02.q2tv9bl.mongodb.net:27017/?authSource=admin&replicaSet=atlas-2x416g-shard-0&tls=true&retryWrites=true&w=majority';
const MONGODB_DATABASE = 'twopc';

const pg = new Pool(POSTGRES_CONFIG);
const mongoClient = new MongoClient(MONGODB_URI);
const mongoDb = () => mongoClient.db(MONGODB_DATABASE);
let exclusive = Promise.resolve();

async function withExclusive(work) {
  const previous = exclusive;
  let release;
  exclusive = new Promise((resolve) => { release = resolve; });
  await previous;
  try { return await work(); } finally { release(); }
}

function createItem(id, name, value) {
  return { id, name, value, updatedAt: new Date().toISOString() };
}

function sameRecord(a, b) {
  return Boolean(a && b && a.name === b.name && a.value === b.value);
}

function quoteGid(gid) {
  // IDs são UUIDs gerados internamente, não texto enviado pelo usuário.
  return `'${gid.replaceAll("'", "''")}'`;
}

async function initialize() {
  await mongoClient.connect();
  await pg.query(`CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, value INTEGER NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pg.query(`CREATE TABLE IF NOT EXISTS twopc_coordinator (
    transaction_id TEXT PRIMARY KEY,
    decision TEXT NOT NULL CHECK (decision IN ('PREPARING','COMMIT','ABORT','COMMITTED','ABORTED')),
    operation TEXT NOT NULL,
    record_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const { rows } = await pg.query('SHOW max_prepared_transactions');
  if (Number(rows[0].max_prepared_transactions) < 1) {
    throw new Error('PostgreSQL está sem transações preparadas. Rode docker compose up -d postgres para aplicar a configuração do projeto.');
  }
  await mongoDb().collection('items').createIndex({ id: 1 }, { unique: true });
  await mongoDb().collection('twopc_pending').createIndex({ transactionId: 1 }, { unique: true });
}

async function setDecision(transactionId, decision) {
  await pg.query(
    'UPDATE twopc_coordinator SET decision=$2,updated_at=NOW() WHERE transaction_id=$1',
    [transactionId, decision]);
}

async function commitPreparedIfPresent(transactionId) {
  const { rows } = await pg.query('SELECT gid FROM pg_prepared_xacts WHERE gid=$1', [transactionId]);
  if (rows.length) await pg.query(`COMMIT PREPARED ${quoteGid(transactionId)}`);
}

async function rollbackPreparedIfPresent(transactionId) {
  const { rows } = await pg.query('SELECT gid FROM pg_prepared_xacts WHERE gid=$1', [transactionId]);
  if (rows.length) await pg.query(`ROLLBACK PREPARED ${quoteGid(transactionId)}`);
}

async function finishCommit(transactionId, recordId) {
  const pending = mongoDb().collection('twopc_pending');
  const staged = await pending.findOne({ transactionId });
  const active = mongoDb().collection('items');
  const alreadyPublished = await active.findOne({ id: recordId });
  if (!staged && !alreadyPublished) {
    throw new Error(`Transação ${transactionId} tem decisão COMMIT, mas não há estágio MongoDB para recuperar.`);
  }

  // A decisão COMMIT já está persistida. Os passos seguintes podem ser repetidos.
  await commitPreparedIfPresent(transactionId);
  if (staged) {
    if (staged.operation === 'delete') {
      await active.deleteOne({ id: staged.recordId });
    } else {
      await active.replaceOne({ id: staged.recordId }, staged.document, { upsert: true });
    }
    await pending.deleteOne({ transactionId });
  }
  await setDecision(transactionId, 'COMMITTED');
}

async function finishAbort(transactionId) {
  // Sem decisão COMMIT, a recuperação presume ABORT.
  await setDecision(transactionId, 'ABORT');
  await rollbackPreparedIfPresent(transactionId);
  await mongoDb().collection('twopc_pending').deleteOne({ transactionId });
  await setDecision(transactionId, 'ABORTED');
}

async function recoverCoordinator() {
  const { rows } = await pg.query(`
    SELECT transaction_id,decision,record_id
    FROM twopc_coordinator
    WHERE decision IN ('PREPARING','COMMIT','ABORT')
    ORDER BY created_at
  `);
  for (const tx of rows) {
    if (tx.decision === 'COMMIT') await finishCommit(tx.transaction_id, tx.record_id);
    else await finishAbort(tx.transaction_id);
  }
}

async function preparePostgres(transactionId, sql, params) {
  const connection = await pg.connect();
  try {
    await connection.query('BEGIN');
    await connection.query(sql, params);
    // Voto YES: o PostgreSQL guarda a transação preparada até a decisão global.
    await connection.query(`PREPARE TRANSACTION ${quoteGid(transactionId)}`);
  } catch (error) {
    try { await connection.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    connection.release();
  }
}

async function prepareMongo(transactionId, stage, injectFailure = false) {
  const session = mongoClient.startSession();
  const pending = mongoDb().collection('twopc_pending');
  try {
    session.startTransaction();
    if (injectFailure) {
      // Provoca erro real do MongoDB por chave _id duplicada durante a preparação.
      await pending.insertOne({ _id: transactionId, transactionId, marker: 'sentinela' }, { session });
      await pending.insertOne({ _id: transactionId, ...stage }, { session });
    } else {
      await pending.insertOne({ _id: transactionId, transactionId, ...stage }, { session });
    }
    // O estágio confirmado, mas ainda não publicado em items, representa o voto YES.
    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
}

async function coordinate2PC({ recordId, operation, document, postgresSql, postgresParams,
  order = ['postgres', 'mongodb'], failMongo = false, failPostgres = false }) {
  return withExclusive(async () => {
    const transactionId = `twopc-${randomUUID()}`;
    await pg.query(
      `INSERT INTO twopc_coordinator(transaction_id,decision,operation,record_id)
       VALUES($1,'PREPARING',$2,$3)`,
      [transactionId, operation, recordId]);

    const stage = { operation, recordId, document };
    try {
      for (const participant of order) {
        if (participant === 'postgres') {
          const params = [...postgresParams];
          if (failPostgres && operation === 'insert') params[2] = 'valor-invalido';
          await preparePostgres(transactionId, postgresSql, params);
        } else {
          await prepareMongo(transactionId, stage, failMongo);
        }
      }

      // Fase 2: persiste a decisão global antes de confirmar os participantes.
      await setDecision(transactionId, 'COMMIT');
      await finishCommit(transactionId, recordId);
      return transactionId;
    } catch (error) {
      const { rows } = await pg.query(
        'SELECT decision FROM twopc_coordinator WHERE transaction_id=$1', [transactionId]);
      // Uma decisão COMMIT já persistida nunca pode ser trocada por ABORT.
      if (rows[0]?.decision !== 'COMMIT' && rows[0]?.decision !== 'COMMITTED') {
        await finishAbort(transactionId);
      }
      throw error;
    }
  });
}

async function readPair(id) {
  return withExclusive(async () => {
    const { rows } = await pg.query('SELECT id,name,value FROM items WHERE id=$1', [id]);
    const document = await mongoDb().collection('items').findOne({ id });
    return {
      postgres: rows[0] || null,
      mongodb: document ? { id: document.id, name: document.name, value: document.value } : null,
    };
  });
}

async function countInBoth(id) {
  const pair = await readPair(id);
  return { postgres: Number(Boolean(pair.postgres)), mongodb: Number(Boolean(pair.mongodb)) };
}

async function resetDemoData(ids) {
  await pg.query('DELETE FROM items WHERE id = ANY($1::text[])', [ids]);
  await mongoDb().collection('items').deleteMany({ id: { $in: ids } });
}

async function close() {
  await pg.end();
  await mongoClient.close();
}

module.exports = {
  initialize,
  recoverCoordinator,
  resetDemoData,
  createItem,
  sameRecord,
  coordinate2PC,
  readPair,
  countInBoth,
  close,
};