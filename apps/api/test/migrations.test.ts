import { describe, expect, it } from 'vitest';
import { Db } from '../src/db/database';
import { migrate, migrations } from '../src/db/migrations';

describe('migrations', () => {
  it('applies every migration once and is idempotent', () => {
    const db = new Db(':memory:');
    const first = migrate(db);
    expect(first).toEqual(migrations.map((m) => m.id));
    expect(migrate(db)).toEqual([]);
    expect(db.all<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id')).toHaveLength(
      migrations.length,
    );
    db.close();
  });

  it('rolls a failing migration back completely', () => {
    const db = new Db(':memory:');
    expect(() =>
      migrate(db, [
        { id: '900_broken', sql: 'CREATE TABLE ok (id TEXT); CREATE TABLE ok (id TEXT);' },
      ]),
    ).toThrow();
    expect(db.get('SELECT name FROM sqlite_master WHERE name = ?', 'ok')).toBeUndefined();
    db.close();
  });
});

describe('Db.transaction', () => {
  it('commits, rolls back on error and supports nesting through savepoints', () => {
    const db = new Db(':memory:');
    db.exec('CREATE TABLE t (n INTEGER)');

    db.transaction(() => {
      db.run('INSERT INTO t VALUES (?)', 1);
      expect(() =>
        db.transaction(() => {
          db.run('INSERT INTO t VALUES (?)', 2);
          throw new Error('inner failure');
        }),
      ).toThrow('inner failure');
      db.run('INSERT INTO t VALUES (?)', 3);
    });

    expect(db.all<{ n: number }>('SELECT n FROM t ORDER BY n').map((r) => r.n)).toEqual([1, 3]);

    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t VALUES (?)', 4);
        throw new Error('outer failure');
      }),
    ).toThrow('outer failure');
    expect(db.all('SELECT n FROM t')).toHaveLength(2);
    db.close();
  });
});
