// Regression tests for the two failures that took the server down or made it lie.
// Both reproduce the original condition against a scratch database, so a future change
// that reintroduces either one fails here instead of at boot.

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as sqliteVec from "sqlite-vec";

const DIM = 384;
const dbPath = join(tmpdir(), `brain-regressions-${process.pid}.sqlite`);

function scratchDb(): Database {
	const db = new Database(dbPath);
	sqliteVec.load(db);
	db.run(`CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY, text TEXT NOT NULL)`);
	db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_rows USING vec0(
		row_id INTEGER PRIMARY KEY, embedding FLOAT[${DIM}]
	)`);
	db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS rows_fts USING fts5(text)`);
	return db;
}

const vector = (seed: number) => new Float32Array(DIM).fill(seed);

afterAll(() => {
	for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
});

describe("sqlite-vec vec0 write path", () => {
	test("INSERT OR REPLACE still throws — the assumption the crash was built on", () => {
		const db = scratchDb();
		db.query("INSERT INTO vec_rows (row_id, embedding) VALUES (?, ?)").run(1, vector(0.1));
		// If a future sqlite-vec implements xUpdate conflict handling this will start
		// passing, and the delete-then-insert dance below becomes optional rather than
		// load-bearing. Until then, this is why it exists.
		expect(() =>
			db.query("INSERT OR REPLACE INTO vec_rows (row_id, embedding) VALUES (?, ?)").run(1, vector(0.2)),
		).toThrow();
		db.close();
	});

	test("delete-then-insert replaces a vector for a reused id", () => {
		const db = scratchDb();
		db.query("DELETE FROM vec_rows WHERE row_id = ?").run(2);
		db.query("INSERT INTO vec_rows (row_id, embedding) VALUES (?, ?)").run(2, vector(0.3));
		db.query("DELETE FROM vec_rows WHERE row_id = ?").run(2);
		db.query("INSERT INTO vec_rows (row_id, embedding) VALUES (?, ?)").run(2, vector(0.4));

		const stored = db.query("SELECT embedding FROM vec_rows WHERE row_id = ?").get(2) as {
			embedding: Uint8Array;
		};
		const floats = new Float32Array(stored.embedding.buffer, stored.embedding.byteOffset, DIM);
		expect(floats[0]).toBeCloseTo(0.4, 5);
		db.close();
	});
});

describe("orphan sweep", () => {
	test("removes satellite rows whose parent is gone", () => {
		const db = scratchDb();
		db.query("INSERT INTO rows (id, text) VALUES (?, ?)").run(10, "kept");
		db.query("INSERT INTO rows_fts (rowid, text) VALUES (?, ?)").run(10, "kept");
		db.query("INSERT INTO vec_rows (row_id, embedding) VALUES (?, ?)").run(10, vector(0.5));

		// The failure mode: parent deleted, satellites stranded. SQLite cannot cascade
		// into FTS5 or vec0, so any delete path that misses them leaves this behind.
		db.query("INSERT INTO rows (id, text) VALUES (?, ?)").run(11, "orphaned soon");
		db.query("INSERT INTO rows_fts (rowid, text) VALUES (?, ?)").run(11, "orphaned soon");
		db.query("INSERT INTO vec_rows (row_id, embedding) VALUES (?, ?)").run(11, vector(0.6));
		db.query("DELETE FROM rows WHERE id = ?").run(11);

		// A stranded FTS row still matches — this is the silent hole in recall.
		const beforeSweep = db.query("SELECT rowid FROM rows_fts WHERE rows_fts MATCH ?").all("orphaned");
		expect(beforeSweep).toHaveLength(1);

		db.run("DELETE FROM rows_fts WHERE rowid NOT IN (SELECT id FROM rows)");
		const strandedVectors = (db.query("SELECT row_id AS id FROM vec_rows").all() as Array<{ id: number }>).filter(
			({ id }) => !db.query("SELECT 1 FROM rows WHERE id = ?").get(id),
		);
		for (const { id } of strandedVectors) db.query("DELETE FROM vec_rows WHERE row_id = ?").run(id);

		expect(db.query("SELECT rowid FROM rows_fts WHERE rows_fts MATCH ?").all("orphaned")).toHaveLength(0);
		expect(db.query("SELECT row_id FROM vec_rows WHERE row_id = ?").get(11)).toBeNull();
		// ...and the live row is untouched.
		expect(db.query("SELECT row_id FROM vec_rows WHERE row_id = ?").get(10)).not.toBeNull();
		db.close();
	});
});
