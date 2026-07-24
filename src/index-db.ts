import { Database } from "bun:sqlite";
import { join } from "node:path";
import * as sqliteVec from "sqlite-vec";
import { DATA_DIR, ensureDirs } from "./config";

export const EMBED_DIM = 384;

export interface BrainDb {
	db: Database;
	/** false when the sqlite-vec extension failed to load — search degrades to BM25-only. */
	vectors: boolean;
}

let opened: BrainDb | null = null;

/** Persistent index — survives restarts and vault unmounts. */
export function openBrainDb(path?: string): BrainDb {
	if (opened) return opened;
	ensureDirs();
	const db = new Database(path ?? join(DATA_DIR, "index.sqlite"));
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");

	let vectors = false;
	try {
		sqliteVec.load(db);
		vectors = true;
	} catch (err) {
		console.warn(`[index] sqlite-vec unavailable, BM25-only: ${err}`);
	}

	db.run(`CREATE TABLE IF NOT EXISTS docs (
		id INTEGER PRIMARY KEY,
		path TEXT NOT NULL UNIQUE,
		title TEXT NOT NULL,
		hash TEXT NOT NULL,
		mtime INTEGER NOT NULL,
		size INTEGER NOT NULL
	)`);
	db.run(`CREATE TABLE IF NOT EXISTS chunks (
		id INTEGER PRIMARY KEY,
		doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
		heading TEXT NOT NULL,
		pos INTEGER NOT NULL,
		text TEXT NOT NULL,
		embedded INTEGER NOT NULL DEFAULT 0
	)`);
	db.run("CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id)");
	// FTS keeps its own copy of the text: rowid-addressed deletes stay trivial and a
	// personal vault is small enough that external-content bookkeeping isn't worth it.
	db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
		title, heading, text, tokenize = 'porter unicode61'
	)`);
	db.run(`CREATE TABLE IF NOT EXISTS links (
		source_doc INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
		target_doc INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
		PRIMARY KEY (source_doc, target_doc)
	)`);
	db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	if (vectors) {
		db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
			chunk_id INTEGER PRIMARY KEY,
			embedding FLOAT[${EMBED_DIM}]
		)`);
	}

	opened = { db, vectors };
	return opened;
}

export function getMeta(db: Database, key: string): string | null {
	const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as
		| { value: string }
		| null;
	return row?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string): void {
	db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** Drop every indexed row — used when the user switches to a different vault. */
export function resetIndex(): void {
	const { db, vectors } = openBrainDb();
	db.transaction(() => {
		db.run("DELETE FROM chunks_fts");
		if (vectors) db.run("DELETE FROM vec_chunks");
		db.run("DELETE FROM links");
		db.run("DELETE FROM chunks");
		db.run("DELETE FROM docs");
		db.run("DELETE FROM meta");
	})();
}
