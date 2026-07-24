// Local ONNX embeddings (all-MiniLM-L6-v2, 384-dim) via fastembed. First init
// downloads ~90 MB into the XDG cache once. Everything degrades to BM25-only if the
// model can't load, so search never hard-fails on this layer.

import { join } from "node:path";
import { CACHE_DIR, ensureDirs } from "./config";

type Embedder = {
	embed(texts: string[], batchSize?: number): AsyncIterable<number[][]>;
	queryEmbed(query: string): Promise<number[]>;
};

let instance: Embedder | null = null;
let failed = false;

async function load(): Promise<Embedder | null> {
	if (instance) return instance;
	if (failed) return null;
	try {
		const { EmbeddingModel, FlagEmbedding } = await import("fastembed");
		ensureDirs();
		instance = (await FlagEmbedding.init({
			model: EmbeddingModel.AllMiniLML6V2,
			cacheDir: join(CACHE_DIR, "models"),
			showDownloadProgress: false,
		})) as unknown as Embedder;
		return instance;
	} catch (err) {
		failed = true;
		console.warn(`[embed] model unavailable, BM25-only: ${err}`);
		return null;
	}
}

export async function embedTexts(texts: string[]): Promise<number[][] | null> {
	const model = await load();
	if (!model) return null;
	const out: number[][] = [];
	for await (const batch of model.embed(texts, 16)) {
		for (const v of batch) out.push(Array.from(v));
	}
	return out;
}

export async function embedQuery(query: string): Promise<number[] | null> {
	const model = await load();
	if (!model) return null;
	return Array.from(await model.queryEmbed(query));
}
