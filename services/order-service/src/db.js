'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'order-db',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'order_user',
  password: process.env.PGPASSWORD || 'order_pass',
  database: process.env.PGDATABASE || 'order_db',
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[db] unexpected error on idle client', err);
});

module.exports = { pool };
