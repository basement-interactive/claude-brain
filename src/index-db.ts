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

/**
 * Persistent index in XDG data (survives restarts and vault unmounts).
 *
 * Two memory systems share the file, mirroring how declarative memory splits:
 *  - semantic: docs/chunks/links — distilled knowledge, curated by hand in the vault
 *  - episodic: sessions/episodes — raw traces of what happened, captured automatically
 * Both carry access counters, so retrieving a memory strengthens it.
 */
export function openBrainDb(path?: string): BrainDb {
	if (opened) return opened;
	ensureDirs();
	const db = new Database(path ?? join(DATA_DIR, "index.sqlite"));
	db.run("PRAGMA journal_mode = WAL");
	// Every row here is reconstructible from the vault or the session transcripts, so
	// durability past a process crash isn't worth an fsync per transaction.
	db.run("PRAGMA synchronous = NORMAL");
	db.run("PRAGMA foreign_keys = ON");
	db.run("PRAGMA temp_store = MEMORY");
	db.run("PRAGMA cache_size = -32000");
	db.run("PRAGMA mmap_size = 268435456");
	// Unchecked, the WAL grew past 5 MB: embedding passes write constantly and a
	// long-lived read connection keeps deferring the default checkpoint.
	db.run("PRAGMA wal_autocheckpoint = 512");

	let vectors = false;
	try {
		sqliteVec.load(db);
		vectors = true;
	} catch (err) {
		console.warn(`[index] sqlite-vec unavailable, BM25-only: ${err}`);
	}

	createSemanticTables(db, vectors);
	createEpisodicTables(db, vectors);
	migrate(db);

	opened = { db, vectors };
	return opened;
}

function createSemanticTables(db: Database, vectors: boolean): void {
	db.run(`CREATE TABLE IF NOT EXISTS docs (
		id INTEGER PRIMARY KEY,
		path TEXT NOT NULL UNIQUE,
		title TEXT NOT NULL,
		hash TEXT NOT NULL,
		mtime INTEGER NOT NULL,
		size INTEGER NOT NULL,
		access_count INTEGER NOT NULL DEFAULT 0,
		last_access INTEGER NOT NULL DEFAULT 0
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
	db.run("CREATE INDEX IF NOT EXISTS chunks_pending ON chunks(embedded) WHERE embedded = 0");
	// FTS keeps its own copy of the text: rowid-addressed deletes stay trivial and the
	// vault is small enough (~few MB) that external-content bookkeeping isn't worth it.
	db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
		title, heading, text, tokenize = 'porter unicode61'
	)`);
	db.run(`CREATE TABLE IF NOT EXISTS links (
		source_doc INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
		target_doc INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
		relation TEXT NOT NULL DEFAULT 'references',
		context TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (source_doc, target_doc)
	)`);
	db.run("CREATE INDEX IF NOT EXISTS links_target ON links(target_doc)");

	/**
	 * Edges the author never wrote. `kind` records how each was derived so traversal
	 * can trust an explicit wikilink more than a similarity guess, and so `explain`
	 * can tell the user why two notes are connected.
	 */
	db.run(`CREATE TABLE IF NOT EXISTS derived_links (
		source_doc INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
		target_doc INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
		kind TEXT NOT NULL,
		weight REAL NOT NULL DEFAULT 1,
		detail TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (source_doc, target_doc, kind)
	)`);
	db.run("CREATE INDEX IF NOT EXISTS derived_target ON derived_links(target_doc)");
	db.run("CREATE INDEX IF NOT EXISTS derived_kind ON derived_links(kind)");

	db.run(`CREATE TABLE IF NOT EXISTS communities (
		doc_id INTEGER PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
		community INTEGER NOT NULL
	)`);
	db.run("CREATE INDEX IF NOT EXISTS communities_id ON communities(community)");
	db.run(`CREATE TABLE IF NOT EXISTS community_labels (
		community INTEGER PRIMARY KEY,
		label TEXT NOT NULL,
		size INTEGER NOT NULL
	)`);
	db.run(`CREATE TABLE IF NOT EXISTS doc_tags (
		doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
		tag TEXT NOT NULL,
		PRIMARY KEY (doc_id, tag)
	)`);
	db.run("CREATE INDEX IF NOT EXISTS doc_tags_tag ON doc_tags(tag)");
	db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	if (vectors) {
		db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
			chunk_id INTEGER PRIMARY KEY,
			embedding FLOAT[${EMBED_DIM}]
		)`);
	}
}

function createEpisodicTables(db: Database, vectors: boolean): void {
	db.run(`CREATE TABLE IF NOT EXISTS sessions (
		id TEXT PRIMARY KEY,
		cwd TEXT NOT NULL DEFAULT '',
		started INTEGER NOT NULL,
		ended INTEGER,
		summary TEXT,
		consolidated INTEGER NOT NULL DEFAULT 0
	)`);
	db.run("CREATE INDEX IF NOT EXISTS sessions_cwd ON sessions(cwd, started DESC)");

	// kind is the coarse event taxonomy shared by the hooks and the transcript miner:
	// prompt | decision | outcome | error | preference | summary.
	// fingerprint makes ingestion idempotent — replaying a transcript can't duplicate.
	db.run(`CREATE TABLE IF NOT EXISTS episodes (
		id INTEGER PRIMARY KEY,
		session_id TEXT NOT NULL,
		cwd TEXT NOT NULL DEFAULT '',
		kind TEXT NOT NULL,
		ts INTEGER NOT NULL,
		text TEXT NOT NULL,
		salience REAL NOT NULL DEFAULT 1,
		embedded INTEGER NOT NULL DEFAULT 0,
		access_count INTEGER NOT NULL DEFAULT 0,
		last_access INTEGER NOT NULL DEFAULT 0,
		fingerprint TEXT NOT NULL UNIQUE
	)`);
	db.run("CREATE INDEX IF NOT EXISTS episodes_session ON episodes(session_id, ts)");
	db.run("CREATE INDEX IF NOT EXISTS episodes_recent ON episodes(ts DESC)");
	db.run("CREATE INDEX IF NOT EXISTS episodes_pending ON episodes(embedded) WHERE embedded = 0");
	db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
		text, tokenize = 'porter unicode61'
	)`);
	if (vectors) {
		db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_episodes USING vec0(
			episode_id INTEGER PRIMARY KEY,
			embedding FLOAT[${EMBED_DIM}]
		)`);
	}

	// What a live session already had injected, so associative recall never repeats
	// itself into the same context window.
	db.run(`CREATE TABLE IF NOT EXISTS injected (
		session_id TEXT NOT NULL,
		ref TEXT NOT NULL,
		ts INTEGER NOT NULL,
		PRIMARY KEY (session_id, ref)
	)`);
}

/** Additive column adds for indexes written before a given feature existed. */
function migrate(db: Database): void {
	const columns = (table: string) =>
		new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));

	const docCols = columns("docs");
	if (!docCols.has("access_count")) db.run("ALTER TABLE docs ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0");
	if (!docCols.has("last_access")) db.run("ALTER TABLE docs ADD COLUMN last_access INTEGER NOT NULL DEFAULT 0");

	const linkCols = columns("links");
	if (!linkCols.has("relation")) db.run("ALTER TABLE links ADD COLUMN relation TEXT NOT NULL DEFAULT 'references'");
	if (!linkCols.has("context")) db.run("ALTER TABLE links ADD COLUMN context TEXT NOT NULL DEFAULT ''");
}

/**
 * Wipe everything derived from the vault, so switching vaults can't leave the previous
 * one's notes in the index. Episodes and sessions deliberately survive: they record what
 * you did, which stays true regardless of which vault is mounted.
 */
export function resetIndex(): void {
	const { db, vectors } = openBrainDb();
	db.transaction(() => {
		db.run("DELETE FROM chunks_fts");
		if (vectors) db.run("DELETE FROM vec_chunks");
		db.run("DELETE FROM derived_links");
		db.run("DELETE FROM communities");
		db.run("DELETE FROM community_labels");
		db.run("DELETE FROM doc_tags");
		db.run("DELETE FROM links");
		db.run("DELETE FROM chunks");
		db.run("DELETE FROM docs");
		db.run("DELETE FROM meta");
	})();
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
