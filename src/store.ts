import type { PgPoolLike, SSOConfig, SSOUser, StoredUser, UserData, UsersApi } from "#src/types.js";

export interface UserStore extends UsersApi {
  upsertFromLogin(user: SSOUser): Promise<StoredUser | null>;
  close(): Promise<void>;
}

interface UserRow {
  discord_id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
  guild_nick: string | null;
  data: UserData | null;
  created_at: Date;
  last_login_at: Date;
}

interface Queries {
  createTable: string;
  upsert: string;
  get: string;
  list: string;
  mergeData: string;
  replaceData: string;
  remove: string;
}

const ERROR_PREFIX = "[sso-mussarelos]";
const MISSING_PG_MESSAGE = `${ERROR_PREFIX} SSO_SAVE_USERS está ligado, mas o pacote "pg" não está instalado. `
  + "Rode: npm install pg";
const INVALID_DATA_MESSAGE = `${ERROR_PREFIX} data precisa ser um objeto, ex.: { cargo: "admin" }`;

function buildQueries(table: string): Queries {
  return {
    createTable: `
      CREATE TABLE IF NOT EXISTS ${table} (
          discord_id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          global_name TEXT,
          avatar TEXT,
          guild_nick TEXT,
          data JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_login_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    upsert: `
      INSERT INTO ${table} (discord_id, username, global_name, avatar, guild_nick)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (discord_id) DO UPDATE SET
          username = EXCLUDED.username,
          global_name = EXCLUDED.global_name,
          avatar = EXCLUDED.avatar,
          guild_nick = EXCLUDED.guild_nick,
          last_login_at = now()
      RETURNING *`,
    get: `SELECT * FROM ${table} WHERE discord_id = $1`,
    list: `SELECT * FROM ${table} ORDER BY last_login_at DESC`,
    mergeData: `UPDATE ${table} SET data = data || $2::jsonb WHERE discord_id = $1 RETURNING *`,
    replaceData: `UPDATE ${table} SET data = $2::jsonb WHERE discord_id = $1 RETURNING *`,
    remove: `DELETE FROM ${table} WHERE discord_id = $1`,
  };
}

function mapRow(row: UserRow | undefined): StoredUser | null {
  if (!row) {
    return null;
  }
  return {
    discordId: row.discord_id,
    username: row.username,
    globalName: row.global_name,
    avatar: row.avatar,
    guildNick: row.guild_nick,
    data: row.data ?? {},
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

function assertPlainObject(data: unknown): asserts data is UserData {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new TypeError(INVALID_DATA_MESSAGE);
  }
}

function isModuleNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND";
}

type PgModule = typeof import("pg");

async function importPg(): Promise<PgModule> {
  try {
    return await import("pg");
  } catch (error) {
    if (isModuleNotFound(error)) {
      throw new Error(MISSING_PG_MESSAGE, { cause: error });
    }
    throw error;
  }
}

async function makePool(config: SSOConfig): Promise<PgPoolLike> {
  if (config.pool) {
    return config.pool;
  }

  const pg = await importPg();
  const Pool = pg.Pool ?? (pg as unknown as { default: PgModule }).default.Pool;
  return new Pool({ connectionString: config.databaseUrl });
}

function resetOnFailure<T>(promise: Promise<T>, reset: () => void): Promise<T> {
  return promise.catch((error: unknown) => {
    reset();
    throw error;
  });
}

export function createStore(config: SSOConfig): UserStore {
  const queries = buildQueries(config.tableName);
  let poolPromise: Promise<PgPoolLike> | undefined;
  let tableReady: Promise<unknown> | undefined;

  async function getPool(): Promise<PgPoolLike> {
    poolPromise ??= resetOnFailure(makePool(config), () => {
      poolPromise = undefined;
    });
    return poolPromise;
  }

  async function query(text: string, params?: unknown[]): Promise<{ rows: UserRow[]; rowCount: number | null }> {
    const pool = await getPool();
    tableReady ??= resetOnFailure(pool.query(queries.createTable), () => {
      tableReady = undefined;
    });
    await tableReady;

    const result = await pool.query(text, params);
    return { rows: result.rows as UserRow[], rowCount: result.rowCount };
  }

  async function firstRow(text: string, params: unknown[]): Promise<StoredUser | null> {
    const { rows } = await query(text, params);
    return mapRow(rows[0]);
  }

  return {
    async upsertFromLogin(user: SSOUser): Promise<StoredUser | null> {
      return firstRow(queries.upsert, [user.id, user.username, user.globalName, user.avatar, user.nick]);
    },

    async get(discordId: string): Promise<StoredUser | null> {
      return firstRow(queries.get, [String(discordId)]);
    },

    async list(): Promise<StoredUser[]> {
      const { rows } = await query(queries.list);
      return rows.map((row) => mapRow(row)).filter((user): user is StoredUser => user !== null);
    },

    async update(discordId: string, patch: UserData): Promise<StoredUser | null> {
      assertPlainObject(patch);
      return firstRow(queries.mergeData, [String(discordId), JSON.stringify(patch)]);
    },

    async replaceData(discordId: string, data: UserData): Promise<StoredUser | null> {
      assertPlainObject(data);
      return firstRow(queries.replaceData, [String(discordId), JSON.stringify(data)]);
    },

    async remove(discordId: string): Promise<boolean> {
      const { rowCount } = await query(queries.remove, [String(discordId)]);
      return (rowCount ?? 0) > 0;
    },

    async close(): Promise<void> {
      if (config.pool || !poolPromise) {
        return;
      }
      const pool = await poolPromise;
      await pool.end?.();
    },
  };
}
