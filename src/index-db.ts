import { Database } from "bun:sqlite";
import { join } from "node:path";
import * as sqliteVec from "sqlite-vec";
import { POOLING_VERSION } from "./embedder";
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
	reembedIfPoolingChanged(db, vectors);
	createDesignTables(db);
	migrate(db);
	repairDesignSourcesKey(db);
	backfillDesignSources(db);

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
	/**
	 * One 384-dim vector per note, the mean of its chunk vectors. Persisted rather than
	 * re-aggregated because the similarity pass compares every pair: re-reading all chunk
	 * vectors on each rebuild was 8 ms at 1100 chunks and grows with the corpus, and
	 * keeping them lets a rebuild touch only the notes that actually changed.
	 */
	db.run(`CREATE TABLE IF NOT EXISTS doc_centroids (
		doc_id INTEGER PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
		embedding BLOB NOT NULL
	)`);
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

	/**
	 * Which transcript files have already been mined, and at what size/mtime. Without this
	 * every consolidate() re-read and re-parsed the whole of ~/.claude/projects — measured
	 * at 1.4 s over 118 MB to produce zero new episodes, on a path the SessionEnd hook
	 * blocks on. recordEpisode is fingerprint-idempotent, so skipping an unchanged file
	 * can only ever skip work that would have changed nothing.
	 */
	db.run(`CREATE TABLE IF NOT EXISTS mined_transcripts (
		path TEXT PRIMARY KEY,
		mtime INTEGER NOT NULL,
		size INTEGER NOT NULL,
		mined_at INTEGER NOT NULL
	)`);

	// What a live session already had injected, so associative recall never repeats
	// itself into the same context window.
	db.run(`CREATE TABLE IF NOT EXISTS injected (
		session_id TEXT NOT NULL,
		ref TEXT NOT NULL,
		ts INTEGER NOT NULL,
		PRIMARY KEY (session_id, ref)
	)`);
}

/**
 * Design images: the bytes and their provenance. There is deliberately no FTS or vec
 * table here — a design's searchable text is the note written into the vault, and a
 * second copy would mean two rankings of the same memory, plus a second thing to keep
 * in step with the user's edits. `spec` is frozen provenance (what the model actually
 * said); the vault note is live and a user edit always wins.
 *
 * `next_attempt_at` is a column rather than a live timer so a restart mid-backoff does
 * not lose the retry.
 */
function createDesignTables(db: Database): void {
	db.run(`CREATE TABLE IF NOT EXISTS designs (
		id TEXT PRIMARY KEY,
		vault TEXT NOT NULL DEFAULT '',
		note_path TEXT NOT NULL DEFAULT '',
		note_missing INTEGER NOT NULL DEFAULT 0,
		name TEXT NOT NULL DEFAULT '',
		caption TEXT NOT NULL DEFAULT '',
		source_name TEXT NOT NULL,
		mime TEXT NOT NULL,
		bytes INTEGER NOT NULL,
		width INTEGER NOT NULL DEFAULT 0,
		height INTEGER NOT NULL DEFAULT 0,
		thumb INTEGER NOT NULL DEFAULT 0,
		render INTEGER NOT NULL DEFAULT 0,
		status TEXT NOT NULL DEFAULT 'queued',
		attempts INTEGER NOT NULL DEFAULT 0,
		next_attempt_at INTEGER NOT NULL DEFAULT 0,
		error TEXT NOT NULL DEFAULT '',
		spec TEXT NOT NULL DEFAULT '',
		palette TEXT NOT NULL DEFAULT '[]',
		mood TEXT NOT NULL DEFAULT '',
		created INTEGER NOT NULL,
		extracted INTEGER NOT NULL DEFAULT 0
	)`);
	// Every entry point (server, CLI, all three hooks) calls openBrainDb, so a bare
	// CREATE INDEX here would throw "already exists" on the second run and brick the
	// install for everyone.
	db.run("CREATE INDEX IF NOT EXISTS designs_status ON designs(status, created DESC)");

	// A design started life as exactly one image, so its reference lived in the columns
	// above. It is really a BOARD — several screenshots of the same product, or a site
	// whose style you liked — and one picture is a poor description of a design language.
	// Each reference is now a row here, and a reference is not necessarily an image: a URL
	// is the same kind of evidence arriving in a different format.
	//
	// `id` stays the content hash for images, so the blob on disk keeps its filename and
	// identical uploads still dedupe. The legacy columns on `designs` are left alone rather
	// than dropped: SQLite would need a table rebuild, and the migration below reads them.
	// (design_id, id) rather than a global id: the same screenshot is legitimately a
	// reference on more than one board — a colour study and a layout study can both cite
	// it — and a global primary key made the second board's INSERT OR IGNORE a silent no-op.
	db.run(`CREATE TABLE IF NOT EXISTS design_sources (
		id TEXT NOT NULL,
		design_id TEXT NOT NULL,
		kind TEXT NOT NULL DEFAULT 'image',
		ordinal INTEGER NOT NULL DEFAULT 0,
		source_name TEXT NOT NULL DEFAULT '',
		url TEXT NOT NULL DEFAULT '',
		mime TEXT NOT NULL DEFAULT '',
		bytes INTEGER NOT NULL DEFAULT 0,
		width INTEGER NOT NULL DEFAULT 0,
		height INTEGER NOT NULL DEFAULT 0,
		thumb INTEGER NOT NULL DEFAULT 0,
		render INTEGER NOT NULL DEFAULT 0,
		/** For url sources: the extracted evidence handed to the model. */
		extract TEXT NOT NULL DEFAULT '',
		created INTEGER NOT NULL,
		PRIMARY KEY (design_id, id)
	)`);
	db.run("CREATE INDEX IF NOT EXISTS design_sources_design ON design_sources(design_id, ordinal)");
	db.run("CREATE INDEX IF NOT EXISTS design_sources_id ON design_sources(id)");
}

/**
 * Give every pre-existing design the source row it always implicitly had. Idempotent: a
 * design that already has sources is skipped, so this is safe on every open. The source
 * keeps the design's own id, which is what makes the blob on disk resolve unchanged.
 */
/**
 * An earlier build of this release created design_sources with a global `id PRIMARY KEY`,
 * which silently refused to let a second board cite the same image. SQLite cannot alter a
 * primary key, so rebuild the table when the old shape is found. Unreleased, so this only
 * ever fires on a machine that ran a pre-release build.
 */
function repairDesignSourcesKey(db: Database): void {
	const sql = (
		db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='design_sources'").get() as
			| { sql: string }
			| undefined
	)?.sql;
	if (!sql || !/id TEXT PRIMARY KEY/.test(sql)) return;
	db.transaction(() => {
		db.run("ALTER TABLE design_sources RENAME TO design_sources_old");
		createDesignTables(db);
		db.run(`INSERT OR IGNORE INTO design_sources
			(id, design_id, kind, ordinal, source_name, url, mime, bytes, width, height, thumb, render, extract, created)
			SELECT id, design_id, kind, ordinal, source_name, url, mime, bytes, width, height, thumb, render, extract, created
			FROM design_sources_old`);
		db.run("DROP TABLE design_sources_old");
	})();
	console.log("[designs] rebuilt design_sources so one image can be cited by several boards");
}

function backfillDesignSources(db: Database): void {
	// "Has no references" is not the same as "was never migrated". A user who detaches every
	// reference from a board leaves it empty on purpose, and re-adding one on the next open
	// resurrects what they removed. A URL board is empty of IMAGE bytes by construction, so
	// the same query would fabricate an image reference pointing at a blob that never
	// existed. Restrict to rows that actually have bytes, and only ever run this once.
	if (getMeta(db, "design_sources_migrated") === "1") return;
	const orphans = db
		.query(
			`SELECT d.id, d.source_name, d.mime, d.bytes, d.width, d.height, d.thumb, d.render, d.created
			 FROM designs d
			 WHERE d.bytes > 0 AND d.mime != ''
			   AND NOT EXISTS (SELECT 1 FROM design_sources s WHERE s.design_id = d.id)`,
		)
		.all() as Array<{
		id: string;
		source_name: string;
		mime: string;
		bytes: number;
		width: number;
		height: number;
		thumb: number;
		render: number;
		created: number;
	}>;
	if (orphans.length === 0) {
		setMeta(db, "design_sources_migrated", "1");
		return;
	}
	const insert = db.prepare(
		`INSERT OR IGNORE INTO design_sources
		 (id, design_id, kind, ordinal, source_name, url, mime, bytes, width, height, thumb, render, extract, created)
		 VALUES (?, ?, 'image', 0, ?, '', ?, ?, ?, ?, ?, ?, '', ?)`,
	);
	const run = db.transaction(() => {
		for (const o of orphans) {
			insert.run(o.id, o.id, o.source_name, o.mime, o.bytes, o.width, o.height, o.thumb, o.render, o.created);
		}
	});
	run();
	setMeta(db, "design_sources_migrated", "1");
	console.log(`[designs] moved ${orphans.length} design(s) onto the multi-reference layout`);
}

/**
 * A change to how a vector is produced makes every stored vector incomparable with a
 * freshly computed query vector — and the failure is silent: recall keeps working and
 * quietly ranks worse. Flagging the rows costs nothing; the existing background passes
 * refill them.
 */
function reembedIfPoolingChanged(db: Database, vectors: boolean): void {
	if (!vectors) return;
	const stored = Number(getMeta(db, "pooling_version") ?? "1");
	if (stored === POOLING_VERSION) return;
	const chunks = (db.query("SELECT count(*) AS n FROM chunks WHERE embedded = 1").get() as { n: number }).n;
	const episodes = (db.query("SELECT count(*) AS n FROM episodes WHERE embedded = 1").get() as { n: number }).n;
	db.transaction(() => {
		db.run("DELETE FROM vec_chunks");
		db.run("DELETE FROM vec_episodes");
		db.run("UPDATE chunks SET embedded = 0");
		db.run("UPDATE episodes SET embedded = 0");
		setMeta(db, "pooling_version", String(POOLING_VERSION));
	})();
	if (chunks + episodes > 0) {
		console.log(`[index] pooling v${stored} -> v${POOLING_VERSION}: re-embedding ${chunks} chunks, ${episodes} episodes`);
	}
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
 * you did, which stays true regardless of which vault is mounted. Designs survive for the
 * same reason — the image and what the model saw in it are facts about an upload, not
 * about whichever vault happens to be mounted; each row carries the vault it was filed
 * into, so a switch back finds its notes again.
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
