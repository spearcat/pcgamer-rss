import {
    ColumnType,
    FileMigrationProvider,
    Generated,
    Insertable,
    JSONColumnType,
    Migrator,
    Selectable,
    Updateable,
} from 'kysely';

export interface Database {
    entries: FeedEntryTable;
}

export interface FeedEntryTable {
    guid: string;
}

import SQLite from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';

const dialect = new SqliteDialect({
  database: new SQLite('database.db'),
});

// Database interface is passed to Kysely's constructor, and from now on, Kysely
// knows your database structure.
// Dialect is passed to Kysely's constructor, and from now on, Kysely knows how
// to communicate with your database.
export const db = new Kysely<Database>({
  dialect,
});

const migrator = new Migrator({
    db,
    provider: {
        async getMigrations() {
            return {
                '0001': await import('./migrations/0001.js')
            };
        },
    }
})
console.log(await migrator.migrateToLatest());
