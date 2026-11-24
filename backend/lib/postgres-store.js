import { Pool } from 'pg';

const stateTable = 'chensi_app_state';

function enabledDriver(value) {
  return ['postgres', 'postgresql'].includes(String(value || '').trim().toLowerCase());
}

export function configuredPostgresStore(env = process.env) {
  if (!enabledDriver(env.IP_AGENT_STORE_DRIVER)) return null;
  const connectionString = String(env.IP_AGENT_POSTGRES_URL || '').trim();
  if (!connectionString) {
    throw Object.assign(new Error('IP_AGENT_POSTGRES_URL is required when IP_AGENT_STORE_DRIVER=postgres'), {
      code: 'POSTGRES_STORE_CONFIG_REQUIRED'
    });
  }
  const configuredPoolMax = Number(env.IP_AGENT_POSTGRES_POOL_MAX);
  const max = Number.isFinite(configuredPoolMax) && configuredPoolMax > 0
    ? Math.min(20, Math.max(1, Math.trunc(configuredPoolMax)))
    : 5;
  return { connectionString, max };
}

export function createPostgresStore(config) {
  if (!config?.connectionString) throw new Error('PostgreSQL connection string is required');
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.max || 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    maxUses: 5_000
  });
  pool.on('error', (error) => console.error('postgres store pool error', error?.message || error));
  let ensurePromise = null;

  async function ensure(seed) {
    if (!ensurePromise) {
      ensurePromise = (async () => {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS ${stateTable} (
            id smallint PRIMARY KEY,
            state jsonb NOT NULL,
            updated_at timestamptz NOT NULL DEFAULT now()
          )
        `);
        const current = await pool.query(`SELECT id FROM ${stateTable} WHERE id = 1`);
        if (!current.rowCount) {
          const initial = await seed();
          await pool.query(
            `INSERT INTO ${stateTable} (id, state, updated_at) VALUES (1, $1::jsonb, now()) ON CONFLICT (id) DO NOTHING`,
            [JSON.stringify(initial)]
          );
        }
      })().catch((error) => {
        ensurePromise = null;
        throw error;
      });
    }
    return ensurePromise;
  }

  async function read() {
    const result = await pool.query(`SELECT state FROM ${stateTable} WHERE id = 1`);
    if (!result.rowCount) throw new Error('PostgreSQL store has not been initialized');
    return result.rows[0].state;
  }

  async function write(state) {
    await pool.query(
      `INSERT INTO ${stateTable} (id, state, updated_at) VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(state)]
    );
  }

  async function close() {
    await pool.end();
  }

  return { ensure, read, write, close };
}

