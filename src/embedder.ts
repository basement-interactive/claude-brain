// Local ONNX embeddings (all-MiniLM-L6-v2, 384-dim). Model files live next to the server;
// first init downloads ~90 MB once. Everything degrades to BM25-only if the model can't
// load, so search never hard-fails on this layer.
//
// fastembed loads the model and owns the tokenizer, but its own embed path is not used:
// it configures the tokenizer to pad every input to the model's full 512-token window, so
// a three-word query costs the same forward pass as a full page. Measured on this vault:
// 94 ms for "wine audio crash", and 8 texts cost 8x one text — batching bought nothing
// because every row was padded to 512 regardless.
//
// Driving the session directly with tight batches instead takes the same query to 3 ms.
// The vectors are unchanged, not merely close: cos = 1.00000001 against fastembed's own
// output for both a query and a document, which is float rounding on an identical result.
// That matters because the index already holds ~1100 vectors made the old way, and a
// subtly different query vector would quietly degrade every ranking.

import { join } from "node:path";
import { CACHE_DIR, ensureDirs } from "./config";

const MODEL_DIR = join(CACHE_DIR, "models");

/**
 * fastembed's `queryEmbed` prepends this; `embed` does not. The asymmetry is baked into
 * every stored vector, so it has to be reproduced exactly rather than tidied away.
 */
const QUERY_PREFIX = "query: ";
/**
 * Bumped whenever the produced vector changes for the same input. openBrainDb compares it
 * against the stored value and flags everything for re-embedding on a mismatch, because a
 * half-migrated index silently ranks old and new vectors against each other.
 *   1 = fastembed CLS pooling
 *   2 = mean pooling over the attention mask
 */
export const POOLING_VERSION = 2;
/** Keep batch tensors bounded: a batch is padded to its longest row, so a few very long
 *  texts alongside short ones would allocate the product. */
const MAX_BATCH_TOKENS = 8192;
const MAX_BATCH_ROWS = 32;

interface Encoding {
	getIds(): number[];
	getAttentionMask(): number[];
	getTypeIds(): number[];
}

interface Tokenizer {
	encode(text: string): Promise<Encoding>;
	disablePadding(): void;
}

interface Session {
	run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: number[] }>>;
}

interface Loaded {
	tokenizer: Tokenizer;
	session: Session;
	Tensor: new (type: string, data: BigInt64Array | bigint[], dims: number[]) => unknown;
}

let loaded: Loaded | null = null;
let failed = false;

async function load(): Promise<Loaded | null> {
	if (loaded) return loaded;
	if (failed) return null;
	try {
		ensureDirs();
		const ort = await import("onnxruntime-node");
		const { EmbeddingModel, FlagEmbedding } = await import("fastembed");
		const model = (await FlagEmbedding.init({
			model: EmbeddingModel.AllMiniLML6V2,
			cacheDir: MODEL_DIR,
			showDownloadProgress: false,
		})) as unknown as { tokenizer: Tokenizer; session: Session };
		// Truncation stays where fastembed set it (512), so an over-long chunk is cut at
		// exactly the same token as before. Only the padding goes.
		model.tokenizer.disablePadding();
		loaded = { tokenizer: model.tokenizer, session: model.session, Tensor: ort.Tensor as never };
		return loaded;
	} catch (err) {
		failed = true;
		console.warn(`[embed] model unavailable, BM25-only: ${err}`);
		return null;
	}
}

/**
 * Mean pooling over the unpadded positions, then L2.
 *
 * fastembed takes the CLS token instead, and that is what every vector in the index used
 * to be. all-MiniLM-L6-v2's model card specifies mean pooling, and the difference is not
 * academic — measured on a labelled set over this vault, vector-only retrieval went from
 * P@1 50% / MRR 0.591 (CLS) to P@1 80% / MRR 0.819 (mean). Changing it invalidates every
 * stored vector, which is why POOLING_VERSION exists.
 */
function pool(data: Float32Array, dims: number[], mask: bigint[]): number[][] {
	const [rows, seq, width] = dims as [number, number, number];
	const out: number[][] = [];
	for (let i = 0; i < rows; i++) {
		const vec = new Float64Array(width);
		let counted = 0;
		for (let s = 0; s < seq; s++) {
			// Padding contributes nothing; averaging over it would make a short text's
			// vector depend on whatever else shared its batch.
			if (mask[i * seq + s] === 0n) continue;
			counted++;
			const base = i * seq * width + s * width;
			for (let h = 0; h < width; h++) vec[h]! += data[base + h]!;
		}
		let norm = 0;
		const divisor = Math.max(counted, 1);
		for (let h = 0; h < width; h++) {
			const averaged = vec[h]! / divisor;
			vec[h] = averaged;
			norm += averaged * averaged;
		}
		norm = Math.max(Math.sqrt(norm), 1e-12);
		out.push(Array.from(vec, (v) => v / norm));
	}
	return out;
}

async function runBatch(model: Loaded, encodings: Encoding[]): Promise<number[][]> {
	const width = Math.max(...encodings.map((e) => e.getIds().length));
	const ids: bigint[] = [];
	const mask: bigint[] = [];
	const types: bigint[] = [];
	for (const enc of encodings) {
		const rowIds = enc.getIds();
		const pad = width - rowIds.length;
		// Pad id 0 is [PAD]; the attention mask zeroes those positions, which is what makes
		// the result independent of how much padding a row happens to carry.
		ids.push(...rowIds.map(BigInt), ...Array<bigint>(pad).fill(0n));
		mask.push(...enc.getAttentionMask().map(BigInt), ...Array<bigint>(pad).fill(0n));
		types.push(...enc.getTypeIds().map(BigInt), ...Array<bigint>(pad).fill(0n));
	}
	const dims = [encodings.length, width];
	const output = await model.session.run({
		input_ids: new model.Tensor("int64", ids, dims),
		attention_mask: new model.Tensor("int64", mask, dims),
		token_type_ids: new model.Tensor("int64", types, dims),
	});
	const hidden = output.last_hidden_state;
	if (!hidden) throw new Error("embedding session returned no last_hidden_state");
	return pool(hidden.data, hidden.dims, mask);
}

/**
 * Group by length before batching. A batch is padded to its longest row, so mixing a
 * 500-token chunk with twenty 20-token ones would pay 500 for all of them.
 */
function batches(encodings: Encoding[]): number[][] {
	const order = encodings.map((_, i) => i).sort((a, b) => encodings[a]!.getIds().length - encodings[b]!.getIds().length);
	const out: number[][] = [];
	let current: number[] = [];
	let widest = 0;
	for (const index of order) {
		const length = encodings[index]!.getIds().length;
		const nextWidest = Math.max(widest, length);
		if (current.length > 0 && (current.length >= MAX_BATCH_ROWS || nextWidest * (current.length + 1) > MAX_BATCH_TOKENS)) {
			out.push(current);
			current = [];
			widest = 0;
		}
		current.push(index);
		widest = Math.max(widest, length);
	}
	if (current.length > 0) out.push(current);
	return out;
}

export async function embedTexts(texts: string[]): Promise<number[][] | null> {
	const model = await load();
	if (!model) return null;
	if (texts.length === 0) return [];
	const encodings = await Promise.all(texts.map((text) => model.tokenizer.encode(text)));
	const result: number[][] = new Array(texts.length);
	for (const group of batches(encodings)) {
		const vectors = await runBatch(
			model,
			group.map((i) => encodings[i]!),
		);
		group.forEach((originalIndex, position) => {
			result[originalIndex] = vectors[position]!;
		});
	}
	return result;
}

export async function embedQuery(query: string): Promise<number[] | null> {
	const model = await load();
	if (!model) return null;
	const encoding = await model.tokenizer.encode(`${QUERY_PREFIX}${query}`);
	const [vector] = await runBatch(model, [encoding]);
	return vector ?? null;
}
