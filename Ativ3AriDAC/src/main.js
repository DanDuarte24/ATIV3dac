const { Pool } = require('pg');
const { MongoClient } = require('mongodb');
const fs = require('node:fs/promises');
const path = require('node:path');

const pg = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'twopc',
  user: process.env.PGUSER || 'demo',
  password: process.env.PGPASSWORD || 'demo',
});
const mongoClient = new MongoClient(process.env.MONGO_URL || 'mongodb://localhost:27017/?replicaSet=rs0');
const dbName = process.env.MONGO_DATABASE || 'twopc';
let exclusive = Promise.resolve();

// Serializa operações da demonstração e a leitura pareada deste processo.
// Isso coordena apenas esta instância; não é um lock distribuído.
async function withExclusive(work) {
  const previous = exclusive;
  let release;
  exclusive = new Promise((resolve) => { release = resolve; });
  await previous;
  try { return await work(); } finally { release(); }
}

function item(id, name, value) { return { id, name, value, updatedAt: new Date().toISOString() }; }
function same(a, b) { return Boolean(a && b && a.name === b.name && a.value === b.value); }

async function initialize() {
  await mongoClient.connect();
  await pg.query(`CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, value INTEGER NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await mongoClient.db(dbName).collection('items').createIndex({ id: 1 }, { unique: true });
}

async function insertPgThenMongo(record, injectFailure = true) {
  return withExclusive(async () => {
    const connection = await pg.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('INSERT INTO items(id,name,value) VALUES($1,$2,$3)', [record.id, record.name, record.value]);
      if (injectFailure) throw new Error('falha simulada ao gravar no MongoDB');
      await mongoClient.db(dbName).collection('items').insertOne(record);
      await connection.query('COMMIT');
      return 'commit';
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally { connection.release(); }
  });
}

async function insertMongoThenPg(record, injectFailure = true) {
  return withExclusive(async () => {
    const session = mongoClient.startSession();
    const connection = await pg.connect();
    try {
      session.startTransaction();
      await mongoClient.db(dbName).collection('items').insertOne(record, { session });
      await connection.query('BEGIN');
      if (injectFailure) throw new Error('falha simulada ao gravar no PostgreSQL');
      await connection.query('INSERT INTO items(id,name,value) VALUES($1,$2,$3)', [record.id, record.name, record.value]);
      await connection.query('COMMIT');
      await session.commitTransaction();
      return 'commit';
    } catch (error) {
      try { await connection.query('ROLLBACK'); } catch {}
      if (session.inTransaction()) await session.abortTransaction();
      throw error;
    } finally { connection.release(); await session.endSession(); }
  });
}

async function updateBoth(id, name, value) {
  return withExclusive(async () => {
    const session = mongoClient.startSession();
    const connection = await pg.connect();
    try {
      await connection.query('BEGIN');
      session.startTransaction();
      await connection.query('UPDATE items SET name=$2,value=$3,updated_at=NOW() WHERE id=$1', [id, name, value]);
      await mongoClient.db(dbName).collection('items').updateOne(
        { id }, { $set: { name, value, updatedAt: new Date().toISOString() } }, { session });
      // Duas confirmações locais coordenadas pelo processo. Não existe commit atômico entre os bancos.
      await session.commitTransaction();
      await connection.query('COMMIT');
    } catch (error) {
      try { await connection.query('ROLLBACK'); } catch {}
      if (session.inTransaction()) await session.abortTransaction();
      throw error;
    } finally { connection.release(); await session.endSession(); }
  });
}

async function readPair(id) {
  return withExclusive(async () => {
    const { rows } = await pg.query('SELECT id,name,value FROM items WHERE id=$1', [id]);
    const doc = await mongoClient.db(dbName).collection('items').findOne({ id });
    return { postgres: rows[0] || null, mongodb: doc ? { id: doc.id, name: doc.name, value: doc.value } : null };
  });
}

async function countInBoth(id) {
  const pair = await readPair(id);
  return { postgres: Number(Boolean(pair.postgres)), mongodb: Number(Boolean(pair.mongodb)) };
}

async function run() {
  await initialize();
  // Limpa somente os IDs desta demonstração para permitir execuções repetidas.
  const demoIds = ['falha-pg-mongo', 'falha-mongo-pg', 'atualizacao-concorrente'];
  await pg.query('DELETE FROM items WHERE id = ANY($1::text[])', [demoIds]);
  await mongoClient.db(dbName).collection('items').deleteMany({ id: { $in: demoIds } });
  const out = [];
  out.push('RELATÓRIO DE EXECUÇÃO — DEMONSTRAÇÃO 2PC');
  out.push(`Data: ${new Date().toLocaleString('pt-BR')}`);
  out.push('');

  const first = item('falha-pg-mongo', 'Cenário PostgreSQL → MongoDB', 10);
  try { await insertPgThenMongo(first, true); }
  catch (error) {
    const counts = await countInBoth(first.id);
    out.push('Cenário 1 — PostgreSQL gravado primeiro; falha no MongoDB');
    out.push(`Resultado: ${error.message}. A transação PostgreSQL foi desfeita (ROLLBACK).`);
    out.push(`Estado final: PostgreSQL=${counts.postgres}, MongoDB=${counts.mongodb} (0 significa ausente).`);
    out.push(counts.postgres === 0 && counts.mongodb === 0 ? 'Conclusão: nenhum registro ficou persistido.' : 'Conclusão: estado inesperado; verificar os bancos.');
  }
  out.push('');

  const second = item('falha-mongo-pg', 'Cenário MongoDB → PostgreSQL', 20);
  try { await insertMongoThenPg(second, true); }
  catch (error) {
    const counts = await countInBoth(second.id);
    out.push('Cenário 2 — MongoDB gravado primeiro; falha no PostgreSQL');
    out.push(`Resultado: ${error.message}. O MongoDB abortou sua transação e o PostgreSQL executou ROLLBACK.`);
    out.push(`Estado final: PostgreSQL=${counts.postgres}, MongoDB=${counts.mongodb}.`);
    out.push(counts.postgres === 0 && counts.mongodb === 0 ? 'Conclusão: o documento também não ficou persistido.' : 'Conclusão: estado inesperado; verificar os bancos.');
  }
  out.push('');

  const live = item('atualizacao-concorrente', 'Versão inicial', 1);
  await insertPgThenMongo(live, false);
  let reads = 0;
  let mismatches = 0;
  let running = true;
  const reader = (async () => {
    while (running) {
      const pair = await readPair(live.id);
      reads += 1;
      if (!same(pair.postgres, pair.mongodb)) mismatches += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await updateBoth(live.id, 'Versão atualizada', 2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  running = false;
  await reader;
  const finalPair = await readPair(live.id);
  out.push('Cenário 3 — Atualização simultânea com consultas a cada 10 ms');
  out.push(`O leitor fez ${reads} leituras pareadas; divergências observadas: ${mismatches}.`);
  out.push(`Estado final: PostgreSQL=${finalPair.postgres?.name}/${finalPair.postgres?.value}; MongoDB=${finalPair.mongodb?.name}/${finalPair.mongodb?.value}.`);
  out.push('As leituras pareadas desta instância aguardam o término da atualização coordenada.');
  out.push('');
  out.push('Observação: é uma demonstração didática de coordenação em duas fases, não XA/2PC distribuído estrito. PostgreSQL mantém transação local; MongoDB usa transação local, disponível aqui por replica set. Não há um coordenador de commit atômico comum aos dois bancos. Falhas de processo ou rede entre commits podem deixar divergência. Em produção, considerar outbox, saga com compensação durável ou infraestrutura transacional específica.');

  const reportPath = path.resolve(process.env.REPORT_PATH || 'relatorio.txt');
  await fs.writeFile(reportPath, `${out.join('\n')}\n`, 'utf8');
  process.stdout.write(`${out.join('\n')}\n\nRelatório salvo em: ${reportPath}\n`);
}

run().catch((error) => {
  console.error('Falha ao executar a demonstração:', error.message);
  console.error('Verifique se PostgreSQL e MongoDB estão ativos e se o replica set rs0 foi iniciado.');
  process.exitCode = 1;
}).finally(async () => {
  await pg.end();
  await mongoClient.close();
});
