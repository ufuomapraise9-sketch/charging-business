const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const defaultSettings = {
  businessName: 'Just Electricals',
  currency: 'NGN',
  basePrice: 5,
  minimumPrice: 0,
  paymentMethods: ['Cash', 'Moniepoint transfer', 'Card (external terminal)']
};
const demoJobs = [
  ['DEMO-A7K9-P2XM', 'Walk-in customer 1', 'Blue Android phone', 3, 5, 'Cracked screen; handle carefully', 'active', 0],
  ['DEMO-B4D2-Q8WR', 'Alex (demo)', 'Wireless earbuds', 8, 3.5, '', 'active', 0],
  ['DEMO-C6N1-T5JP', 'Walk-in customer 2', 'Tablet, black case', 12, 8, '', 'collected', 60],
  ['DEMO-D3F8-Z1KL', 'Walk-in customer 3', 'Smart watch', 16, 2, 'Cancelled at customer request', 'cancelled', 120]
];

function failure(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function mapJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    claimCode: row.claim_code,
    customer: row.customer,
    gadget: row.gadget,
    socket: Number(row.socket),
    price: Number(row.price),
    notes: row.notes,
    status: row.status,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    collectedAt: row.collected_at instanceof Date ? row.collected_at.toISOString() : row.collected_at,
    paymentMethod: row.payment_method,
    amountPaid: row.amount_paid === null ? null : Number(row.amount_paid)
  };
}

function mapSettings(row, postgres) {
  return {
    businessName: row.business_name,
    currency: row.currency,
    basePrice: Number(row.base_price),
    minimumPrice: Number(row.minimum_price),
    paymentMethods: postgres ? row.payment_methods : JSON.parse(row.payment_methods)
  };
}

function getCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return code && code.length <= 64 ? code : '';
}

class Store {
  constructor() {
    this.postgres = Boolean(process.env.DATABASE_URL);
    if (process.env.VERCEL && !this.postgres) {
      throw new Error('DATABASE_URL is required on Vercel. Connect a PostgreSQL database before deploying.');
    }
    this.initialization = null;
    this.localDatabases = new Map();
    this.localLoginAttempts = new Map();
    if (this.postgres) {
      const { Pool } = require('pg');
      this.pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    } else {
      this.dataDirectory = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
      fs.mkdirSync(this.dataDirectory, { recursive: true });
    }
  }

  async initialize() {
    if (!this.initialization) {
      this.initialization = this.postgres ? this.initializePostgres() : Promise.resolve();
    }
    try {
      await this.initialization;
    } catch (error) {
      this.initialization = null;
      throw error;
    }
  }

  async initializePostgres() {
    const statements = [
      `CREATE TABLE IF NOT EXISTS sockets (
        mode TEXT NOT NULL CHECK (mode IN ('live', 'demo')),
        number INTEGER NOT NULL CHECK (number BETWEEN 1 AND 60),
        service_status TEXT NOT NULL DEFAULT 'available'
          CHECK (service_status IN ('available', 'out_of_service')),
        PRIMARY KEY (mode, number)
      )`,
      `CREATE TABLE IF NOT EXISTS settings (
        mode TEXT PRIMARY KEY CHECK (mode IN ('live', 'demo')),
        business_name TEXT NOT NULL,
        currency TEXT NOT NULL,
        base_price NUMERIC NOT NULL CHECK (base_price >= 0),
        minimum_price NUMERIC NOT NULL CHECK (minimum_price >= 0),
        payment_methods JSONB NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS jobs (
        id UUID PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('live', 'demo')),
        claim_code TEXT NOT NULL,
        customer TEXT NOT NULL,
        gadget TEXT NOT NULL,
        socket INTEGER NOT NULL,
        price NUMERIC NOT NULL CHECK (price >= 0),
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'collected', 'cancelled')),
        created_at TIMESTAMPTZ NOT NULL,
        collected_at TIMESTAMPTZ,
        payment_method TEXT,
        amount_paid NUMERIC,
        UNIQUE (mode, claim_code),
        FOREIGN KEY (mode, socket) REFERENCES sockets(mode, number)
      )`,
      `CREATE INDEX IF NOT EXISTS jobs_mode_status_created_idx ON jobs(mode, status, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS jobs_mode_claim_code_idx ON jobs(mode, claim_code)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_per_socket_idx ON jobs(mode, socket)
        WHERE status = 'active'`,
      `CREATE TABLE IF NOT EXISTS login_attempts (
        ip TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL,
        reset_at TIMESTAMPTZ NOT NULL
      )`
    ];
    for (const statement of statements) await this.pool.query(statement);

    for (const mode of ['live', 'demo']) {
      await this.pool.query(
        `INSERT INTO sockets (mode, number)
         SELECT $1, generate_series(1, 60)
         ON CONFLICT (mode, number) DO NOTHING`,
        [mode]
      );
      await this.pool.query(
        `INSERT INTO settings (mode, business_name, currency, base_price, minimum_price, payment_methods)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (mode) DO NOTHING`,
        [mode, defaultSettings.businessName, defaultSettings.currency, defaultSettings.basePrice,
          defaultSettings.minimumPrice, JSON.stringify(defaultSettings.paymentMethods)]
      );
    }

    const demoCount = await this.pool.query("SELECT COUNT(*) AS count FROM jobs WHERE mode = 'demo'");
    if (Number(demoCount.rows[0].count) === 0) {
      for (const [code, customer, gadget, socket, price, notes, status, minutesAgo] of demoJobs) {
        const createdAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
        await this.pool.query(
          `INSERT INTO jobs (id, mode, claim_code, customer, gadget, socket, price, notes, status,
            created_at, collected_at, payment_method, amount_paid)
           VALUES ($1, 'demo', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (mode, claim_code) DO NOTHING`,
          [crypto.randomUUID(), code, customer, gadget, socket, price, notes, status, createdAt,
            status === 'collected' ? createdAt : null, status === 'collected' ? 'Cash' : null,
            status === 'collected' ? price : null]
        );
      }
      await this.pool.query("UPDATE sockets SET service_status = 'out_of_service' WHERE mode = 'demo' AND number = 21");
    }
  }

  sqlite(mode) {
    if (this.localDatabases.has(mode)) return this.localDatabases.get(mode);
    const filename = mode === 'demo' ? 'charging-demo.sqlite' : 'charging.sqlite';
    const db = new DatabaseSync(path.join(this.dataDirectory, filename));
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS sockets (
        number INTEGER PRIMARY KEY CHECK(number BETWEEN 1 AND 60),
        service_status TEXT NOT NULL DEFAULT 'available'
          CHECK(service_status IN ('available', 'out_of_service'))
      );
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        business_name TEXT NOT NULL,
        currency TEXT NOT NULL,
        base_price REAL NOT NULL,
        minimum_price REAL NOT NULL,
        payment_methods TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        claim_code TEXT NOT NULL UNIQUE,
        customer TEXT NOT NULL,
        gadget TEXT NOT NULL,
        socket INTEGER NOT NULL REFERENCES sockets(number),
        price REAL NOT NULL CHECK(price >= 0),
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active', 'collected', 'cancelled')),
        created_at TEXT NOT NULL,
        collected_at TEXT,
        payment_method TEXT,
        amount_paid REAL
      );
      CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
      CREATE INDEX IF NOT EXISTS jobs_claim_code_idx ON jobs(claim_code);
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_per_socket_idx ON jobs(socket)
        WHERE status = 'active';
    `);

    const insertSocket = db.prepare('INSERT OR IGNORE INTO sockets (number) VALUES (?)');
    for (let number = 1; number <= 60; number += 1) insertSocket.run(number);
    db.prepare(`
      INSERT OR IGNORE INTO settings
        (id, business_name, currency, base_price, minimum_price, payment_methods)
      VALUES (1, ?, ?, ?, ?, ?)
    `).run(defaultSettings.businessName, defaultSettings.currency, defaultSettings.basePrice,
      defaultSettings.minimumPrice, JSON.stringify(defaultSettings.paymentMethods));

    const migrateDefaults = db.prepare(`
      INSERT OR IGNORE INTO app_meta (key, value) VALUES ('business_name_default_just_electricals', 'done')
    `).run();
    if (migrateDefaults.changes) {
      db.prepare(`
        UPDATE settings SET business_name = ?, currency = CASE WHEN currency = 'USD' THEN ? ELSE currency END
        WHERE id = 1 AND business_name = 'Charge & Go'
      `).run(defaultSettings.businessName, defaultSettings.currency);
    }

    this.localDatabases.set(mode, db);
    if (mode === 'demo' && db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count === 0) {
      const insert = db.prepare(`
        INSERT INTO jobs (id, claim_code, customer, gadget, socket, price, notes, status, created_at,
          collected_at, payment_method, amount_paid)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [code, customer, gadget, socket, price, notes, status, minutesAgo] of demoJobs) {
        const createdAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
        insert.run(crypto.randomUUID(), code, customer, gadget, socket, price, notes, status, createdAt,
          status === 'collected' ? createdAt : null, status === 'collected' ? 'Cash' : null,
          status === 'collected' ? price : null);
      }
      db.prepare("UPDATE sockets SET service_status = 'out_of_service' WHERE number = 21").run();
    }
    return db;
  }

  async getSettings(mode) {
    if (this.postgres) {
      const result = await this.pool.query('SELECT * FROM settings WHERE mode = $1', [mode]);
      return mapSettings(result.rows[0], true);
    }
    return mapSettings(this.sqlite(mode).prepare('SELECT * FROM settings WHERE id = 1').get(), false);
  }

  async bootstrap(mode) {
    if (this.postgres) {
      const [socketResult, countsResult, settings] = await Promise.all([
        this.pool.query(`
          SELECT s.number, s.service_status AS "serviceStatus", j.claim_code AS "claimCode",
            j.gadget, j.customer, j.created_at AS "createdAt"
          FROM sockets s LEFT JOIN jobs j
            ON j.mode = s.mode AND j.socket = s.number AND j.status = 'active'
          WHERE s.mode = $1 ORDER BY s.number
        `, [mode]),
        this.pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE s.service_status = 'available' AND j.id IS NULL)::int AS available,
            COUNT(j.id)::int AS occupied,
            COUNT(*) FILTER (WHERE s.service_status = 'out_of_service')::int AS "outOfService"
          FROM sockets s LEFT JOIN jobs j
            ON j.mode = s.mode AND j.socket = s.number AND j.status = 'active'
          WHERE s.mode = $1
        `, [mode]),
        this.getSettings(mode)
      ]);
      return { settings, sockets: socketResult.rows, counts: countsResult.rows[0] };
    }
    const db = this.sqlite(mode);
    const sockets = db.prepare(`
      SELECT s.number, s.service_status AS serviceStatus,
        j.claim_code AS claimCode, j.gadget, j.customer, j.created_at AS createdAt
      FROM sockets s LEFT JOIN jobs j ON j.socket = s.number AND j.status = 'active'
      ORDER BY s.number
    `).all();
    const counts = db.prepare(`
      SELECT
        SUM(CASE WHEN s.service_status = 'available' AND j.id IS NULL THEN 1 ELSE 0 END) AS available,
        SUM(CASE WHEN j.id IS NOT NULL THEN 1 ELSE 0 END) AS occupied,
        SUM(CASE WHEN s.service_status = 'out_of_service' THEN 1 ELSE 0 END) AS outOfService
      FROM sockets s LEFT JOIN jobs j ON j.socket = s.number AND j.status = 'active'
    `).get();
    return {
      settings: await this.getSettings(mode),
      sockets,
      counts: {
        available: Number(counts.available),
        occupied: Number(counts.occupied),
        outOfService: Number(counts.outOfService)
      }
    };
  }

  async listJobs(mode, status, search) {
    if (this.postgres) {
      const result = await this.pool.query(`
        SELECT * FROM jobs
        WHERE mode = $1 AND ($2 = 'all' OR status = $2)
          AND ($3 = '' OR customer ILIKE '%' || $3 || '%' OR gadget ILIKE '%' || $3 || '%'
            OR claim_code ILIKE '%' || $3 || '%' OR socket::text ILIKE '%' || $3 || '%')
        ORDER BY created_at DESC LIMIT 500
      `, [mode, status, search]);
      return result.rows.map(mapJob);
    }
    const db = this.sqlite(mode);
    const conditions = [];
    const values = [];
    if (status !== 'all') {
      conditions.push('status = ?');
      values.push(status);
    }
    if (search) {
      conditions.push('(customer LIKE ? OR gadget LIKE ? OR claim_code LIKE ? OR CAST(socket AS TEXT) LIKE ?)');
      const query = `%${search}%`;
      values.push(query, query, query, query);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return db.prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT 500`)
      .all(...values).map(mapJob);
  }

  async jobByCode(mode, value) {
    const code = getCode(value);
    if (!code) return null;
    if (this.postgres) {
      const result = await this.pool.query('SELECT * FROM jobs WHERE mode = $1 AND claim_code = $2', [mode, code]);
      return mapJob(result.rows[0]);
    }
    return mapJob(this.sqlite(mode).prepare('SELECT * FROM jobs WHERE claim_code = ?').get(code));
  }

  async jobBySocket(mode, number) {
    if (this.postgres) {
      const result = await this.pool.query(
        "SELECT * FROM jobs WHERE mode = $1 AND socket = $2 AND status = 'active'",
        [mode, number]
      );
      return mapJob(result.rows[0]);
    }
    return mapJob(this.sqlite(mode).prepare("SELECT * FROM jobs WHERE socket = ? AND status = 'active'").get(number));
  }

  async createJob(mode, input) {
    const id = crypto.randomUUID();
    const claimCode = `CHG-${crypto.randomBytes(18).toString('hex').toUpperCase()}`;
    const createdAt = new Date().toISOString();

    if (this.postgres) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        let socketNumber = input.socket;
        if (socketNumber === null) {
          const available = await client.query(`
            SELECT s.number FROM sockets s
            WHERE s.mode = $1 AND s.service_status = 'available'
              AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.mode = s.mode AND j.socket = s.number AND j.status = 'active')
            ORDER BY s.number LIMIT 1 FOR UPDATE OF s SKIP LOCKED
          `, [mode]);
          if (!available.rows[0]) throw failure(409, 'There are no available sockets. Return one to service or collect an active job.');
          socketNumber = available.rows[0].number;
        } else {
          const socket = await client.query('SELECT service_status FROM sockets WHERE mode = $1 AND number = $2 FOR UPDATE', [mode, socketNumber]);
          const active = await client.query("SELECT 1 FROM jobs WHERE mode = $1 AND socket = $2 AND status = 'active'", [mode, socketNumber]);
          if (!socket.rows[0] || socket.rows[0].service_status !== 'available' || active.rows.length) {
            throw failure(409, `Socket ${socketNumber} is not available. Choose another socket.`);
          }
        }
        const result = await client.query(`
          INSERT INTO jobs (id, mode, claim_code, customer, gadget, socket, price, notes, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *
        `, [id, mode, claimCode, input.customer, input.gadget, socketNumber, input.price, input.notes, createdAt]);
        await client.query('COMMIT');
        return mapJob(result.rows[0]);
      } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === '23505') throw failure(409, 'That socket was just assigned to another job. Refresh and choose again.');
        throw error;
      } finally {
        client.release();
      }
    }

    const db = this.sqlite(mode);
    db.exec('BEGIN IMMEDIATE');
    try {
      let socketNumber = input.socket;
      if (socketNumber === null) {
        const available = db.prepare(`
          SELECT s.number FROM sockets s
          WHERE s.service_status = 'available'
            AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.socket = s.number AND j.status = 'active')
          ORDER BY s.number LIMIT 1
        `).get();
        if (!available) throw failure(409, 'There are no available sockets. Return one to service or collect an active job.');
        socketNumber = available.number;
      }
      const socket = db.prepare(`
        SELECT s.service_status,
          EXISTS(SELECT 1 FROM jobs j WHERE j.socket = s.number AND j.status = 'active') AS occupied
        FROM sockets s WHERE s.number = ?
      `).get(socketNumber);
      if (!socket || socket.service_status !== 'available' || socket.occupied) {
        throw failure(409, `Socket ${socketNumber} is not available. Choose another socket.`);
      }
      db.prepare(`
        INSERT INTO jobs (id, claim_code, customer, gadget, socket, price, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, claimCode, input.customer, input.gadget, socketNumber, input.price, input.notes, createdAt);
      const job = mapJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
      db.exec('COMMIT');
      return job;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async collectJob(mode, job, paymentMethod, amountPaid) {
    const collectedAt = new Date().toISOString();
    if (this.postgres) {
      const result = await this.pool.query(`
        UPDATE jobs SET status = 'collected', collected_at = $1, payment_method = $2, amount_paid = $3
        WHERE mode = $4 AND id = $5 AND status = 'active' RETURNING *
      `, [collectedAt, paymentMethod, amountPaid, mode, job.id]);
      return mapJob(result.rows[0]);
    }
    const db = this.sqlite(mode);
    const result = db.prepare(`
      UPDATE jobs SET status = 'collected', collected_at = ?, payment_method = ?, amount_paid = ?
      WHERE id = ? AND status = 'active'
    `).run(collectedAt, paymentMethod, amountPaid, job.id);
    return result.changes ? mapJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id)) : null;
  }

  async cancelJob(mode, job) {
    if (this.postgres) {
      const result = await this.pool.query(
        "UPDATE jobs SET status = 'cancelled' WHERE mode = $1 AND id = $2 AND status = 'active' RETURNING *",
        [mode, job.id]
      );
      return mapJob(result.rows[0]);
    }
    const db = this.sqlite(mode);
    const result = db.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ? AND status = 'active'").run(job.id);
    return result.changes ? mapJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id)) : null;
  }

  async setSocketStatus(mode, number, status) {
    if (this.postgres) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const socket = await client.query('SELECT number FROM sockets WHERE mode = $1 AND number = $2 FOR UPDATE', [mode, number]);
        if (!socket.rows[0]) throw failure(404, 'Socket not found.');
        const active = await client.query("SELECT 1 FROM jobs WHERE mode = $1 AND socket = $2 AND status = 'active'", [mode, number]);
        if (status === 'out_of_service' && active.rows.length) {
          throw failure(409, 'Collect or cancel the active job before taking this socket out of service.');
        }
        await client.query('UPDATE sockets SET service_status = $1 WHERE mode = $2 AND number = $3', [status, mode, number]);
        await client.query('COMMIT');
        return { number, status };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    const db = this.sqlite(mode);
    db.exec('BEGIN IMMEDIATE');
    try {
      const socket = db.prepare(`
        SELECT s.number,
          EXISTS(SELECT 1 FROM jobs j WHERE j.socket = s.number AND j.status = 'active') AS occupied
        FROM sockets s WHERE s.number = ?
      `).get(number);
      if (!socket) throw failure(404, 'Socket not found.');
      if (status === 'out_of_service' && socket.occupied) {
        throw failure(409, 'Collect or cancel the active job before taking this socket out of service.');
      }
      db.prepare('UPDATE sockets SET service_status = ? WHERE number = ?').run(status, number);
      db.exec('COMMIT');
      return { number, status };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async saveSettings(mode, settings) {
    if (this.postgres) {
      const result = await this.pool.query(`
        UPDATE settings SET business_name = $1, currency = $2, base_price = $3, minimum_price = $4,
          payment_methods = $5::jsonb WHERE mode = $6 RETURNING *
      `, [settings.businessName, settings.currency, settings.basePrice, settings.minimumPrice,
        JSON.stringify(settings.paymentMethods), mode]);
      return mapSettings(result.rows[0], true);
    }
    this.sqlite(mode).prepare(`
      UPDATE settings SET business_name = ?, currency = ?, base_price = ?, minimum_price = ?, payment_methods = ?
      WHERE id = 1
    `).run(settings.businessName, settings.currency, settings.basePrice, settings.minimumPrice,
      JSON.stringify(settings.paymentMethods));
    return this.getSettings(mode);
  }

  async isLoginLimited(ip) {
    const now = new Date();
    if (this.postgres) {
      const result = await this.pool.query('SELECT attempts, reset_at FROM login_attempts WHERE ip = $1', [ip]);
      const row = result.rows[0];
      if (!row) return false;
      if (new Date(row.reset_at) <= now) {
        await this.pool.query('DELETE FROM login_attempts WHERE ip = $1', [ip]);
        return false;
      }
      return Number(row.attempts) >= 10;
    }
    const attempt = this.localLoginAttempts.get(ip);
    if (!attempt || attempt.resetAt <= now.getTime()) {
      this.localLoginAttempts.delete(ip);
      return false;
    }
    return attempt.count >= 10;
  }

  async recordFailedLogin(ip) {
    if (this.postgres) {
      await this.pool.query(`
        INSERT INTO login_attempts (ip, attempts, reset_at)
        VALUES ($1, 1, NOW() + INTERVAL '15 minutes')
        ON CONFLICT (ip) DO UPDATE SET
          attempts = CASE WHEN login_attempts.reset_at <= NOW() THEN 1 ELSE login_attempts.attempts + 1 END,
          reset_at = CASE WHEN login_attempts.reset_at <= NOW()
            THEN NOW() + INTERVAL '15 minutes' ELSE login_attempts.reset_at END
      `, [ip]);
      return;
    }
    const now = Date.now();
    const attempt = this.localLoginAttempts.get(ip);
    if (!attempt || attempt.resetAt <= now) {
      this.localLoginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    } else {
      attempt.count += 1;
    }
  }

  async clearLoginFailures(ip) {
    if (this.postgres) {
      await this.pool.query('DELETE FROM login_attempts WHERE ip = $1', [ip]);
    } else {
      this.localLoginAttempts.delete(ip);
    }
  }
}

module.exports = new Store();
