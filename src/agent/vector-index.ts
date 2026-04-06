import { promises as fs } from "node:fs";
import path from "node:path";

const INDEX_PATH = ".agent-memory/vector-index.json";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text";
const CHUNK_LINES = 60;
const CHUNK_OVERLAP = 10;
const MAX_CHUNKS_PER_FILE = 8;
const EMBED_TIMEOUT_MS = 10_000;

export interface VectorChunk {
  file: string;
  startLine: number;
  endLine: number;
  text: string;       // full chunk text for context retrieval
  embedding: number[];
}

export interface VectorIndex {
  model: string;
  chunks: VectorChunk[];
  fileHashes: Record<string, string>; // file → content hash for staleness check
  builtAt: string;
}

export class VectorStore {
  private index: VectorIndex | null = null;
  private available: boolean | null = null;

  constructor(private readonly root: string) {}

  /** Check if Ollama embedding is reachable. Cached after first call. */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      const res = await fetchWithTimeout(`${OLLAMA_URL}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL, input: "test" }),
      }, 5000);
      this.available = res.ok;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  /**
   * Index files: chunk + embed. Only re-embeds changed files.
   * Returns number of chunks indexed.
   */
  async indexFiles(files: Array<{ path: string; content: string }>): Promise<number> {
    if (!(await this.isAvailable())) return 0;

    const existing = await this.loadIndex();
    const newChunks: VectorChunk[] = [];
    const newHashes: Record<string, string> = {};

    for (const file of files) {
      const hash = simpleHash(file.content);
      newHashes[file.path] = hash;

      // Skip if unchanged
      if (existing?.fileHashes[file.path] === hash) {
        const kept = existing.chunks.filter(c => c.file === file.path);
        newChunks.push(...kept);
        continue;
      }

      // Chunk the file
      const chunks = chunkFile(file.path, file.content);

      // Batch embed (Ollama supports multiple inputs)
      const texts = chunks.map(c => c.text);
      const embeddings = await this.batchEmbed(texts);
      if (!embeddings) continue;

      for (let i = 0; i < chunks.length; i++) {
        newChunks.push({
          ...chunks[i],
          text: chunks[i].text,
          embedding: embeddings[i],
        });
      }
    }

    this.index = {
      model: EMBED_MODEL,
      chunks: newChunks,
      fileHashes: newHashes,
      builtAt: new Date().toISOString(),
    };

    await this.saveIndex();
    return newChunks.length;
  }

  /**
   * Semantic search: embed the query, find top-K most similar chunks.
   * Returns file paths with similarity scores.
   */
  async search(query: string, topK = 10): Promise<Array<{ file: string; score: number; startLine: number; preview: string }>> {
    if (!(await this.isAvailable())) return [];

    const index = this.index ?? await this.loadIndex();
    if (!index || index.chunks.length === 0) return [];

    const queryEmbedding = await this.embed(query);
    if (!queryEmbedding) return [];

    // Score all chunks
    const scored = index.chunks.map(chunk => ({
      file: chunk.file,
      startLine: chunk.startLine,
      preview: chunk.text.slice(0, 200),
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }));

    // Sort by similarity, deduplicate by file (keep best chunk per file)
    scored.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    const results: typeof scored = [];
    for (const item of scored) {
      if (seen.has(item.file)) continue;
      seen.add(item.file);
      results.push(item);
      if (results.length >= topK) break;
    }

    return results;
  }

  /**
   * Get the full text of the most relevant chunks for a query.
   * Returns chunks with full code content, not just previews.
   */
  async getRelevantChunks(query: string, topK = 15): Promise<Array<{ file: string; startLine: number; endLine: number; text: string; score: number }>> {
    if (!(await this.isAvailable())) return [];

    const index = this.index ?? await this.loadIndex();
    if (!index || index.chunks.length === 0) return [];

    const queryEmbedding = await this.embed(query);
    if (!queryEmbedding) return [];

    const scored = index.chunks.map(chunk => ({
      file: chunk.file,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      text: chunk.text,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** Clear the index (call after edits). */
  clear(): void {
    this.index = null;
  }

  // --- Internal ---

  private async embed(text: string): Promise<number[] | null> {
    try {
      const res = await fetchWithTimeout(`${OLLAMA_URL}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL, input: text.slice(0, 2000) }),
      }, EMBED_TIMEOUT_MS);
      if (!res.ok) return null;
      const body = await res.json() as { embeddings?: number[][] };
      return body.embeddings?.[0] ?? null;
    } catch {
      return null;
    }
  }

  private async batchEmbed(texts: string[]): Promise<number[][] | null> {
    if (texts.length === 0) return [];
    try {
      // Ollama supports batch via array input
      const res = await fetchWithTimeout(`${OLLAMA_URL}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL, input: texts.map(t => t.slice(0, 2000)) }),
      }, EMBED_TIMEOUT_MS * 2);
      if (!res.ok) return null;
      const body = await res.json() as { embeddings?: number[][] };
      return body.embeddings ?? null;
    } catch {
      return null;
    }
  }

  private async loadIndex(): Promise<VectorIndex | null> {
    if (this.index) return this.index;
    try {
      const raw = await fs.readFile(path.join(this.root, INDEX_PATH), "utf8");
      this.index = JSON.parse(raw) as VectorIndex;
      return this.index;
    } catch {
      return null;
    }
  }

  private async saveIndex(): Promise<void> {
    if (!this.index) return;
    try {
      const target = path.join(this.root, INDEX_PATH);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(this.index), "utf8");
    } catch { /* non-critical */ }
  }
}

// --- Pure functions ---

function chunkFile(filePath: string, content: string): Array<{ file: string; startLine: number; endLine: number; text: string }> {
  const lines = content.split("\n");
  const chunks: Array<{ file: string; startLine: number; endLine: number; text: string }> = [];

  for (let i = 0; i < lines.length && chunks.length < MAX_CHUNKS_PER_FILE; i += CHUNK_LINES - CHUNK_OVERLAP) {
    const end = Math.min(i + CHUNK_LINES, lines.length);
    const text = lines.slice(i, end).join("\n");
    if (text.trim().length < 20) continue; // skip near-empty chunks
    chunks.push({ file: filePath, startLine: i + 1, endLine: end, text });
  }

  return chunks;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function simpleHash(content: string): string {
  // Fast non-crypto hash for change detection
  let h = 0;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) - h + content.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
