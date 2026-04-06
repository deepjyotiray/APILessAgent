import { promises as fs } from "node:fs";
import path from "node:path";

const FEEDBACK_PATH = ".agent-memory/ranking-feedback.json";
const MAX_ENTRIES = 200;
const DECAY_FACTOR = 0.95; // per-task decay

export interface FileUsageRecord {
  path: string;
  useCount: number;     // times this file appeared in a successful task
  editCount: number;    // times this file was edited in a successful task
  lastUsed: string;
  score: number;        // decayed cumulative score
}

export interface RankingFeedback {
  files: Record<string, FileUsageRecord>;
  totalTasks: number;
  updatedAt: string;
}

export class RankingFeedbackStore {
  private data: RankingFeedback | null = null;

  constructor(private readonly root: string) {}

  async load(): Promise<RankingFeedback> {
    if (this.data) return this.data;
    try {
      const raw = await fs.readFile(path.join(this.root, FEEDBACK_PATH), "utf8");
      this.data = JSON.parse(raw) as RankingFeedback;
    } catch {
      this.data = { files: {}, totalTasks: 0, updatedAt: new Date().toISOString() };
    }
    return this.data;
  }

  /**
   * Record which files were used and edited in a completed task.
   */
  async recordTaskCompletion(
    usedFiles: string[],
    editedFiles: string[]
  ): Promise<void> {
    const fb = await this.load();

    // Decay all existing scores
    for (const record of Object.values(fb.files)) {
      record.score *= DECAY_FACTOR;
    }

    const now = new Date().toISOString();
    const editSet = new Set(editedFiles);

    for (const filePath of usedFiles) {
      const existing = fb.files[filePath];
      if (existing) {
        existing.useCount++;
        existing.score += 5;
        existing.lastUsed = now;
        if (editSet.has(filePath)) {
          existing.editCount++;
          existing.score += 10; // edits are stronger signal
        }
      } else {
        fb.files[filePath] = {
          path: filePath,
          useCount: 1,
          editCount: editSet.has(filePath) ? 1 : 0,
          lastUsed: now,
          score: editSet.has(filePath) ? 15 : 5,
        };
      }
    }

    fb.totalTasks++;
    fb.updatedAt = now;

    // Prune low-score entries to keep file small
    const entries = Object.entries(fb.files);
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => b[1].score - a[1].score);
      fb.files = Object.fromEntries(entries.slice(0, MAX_ENTRIES));
    }

    this.data = fb;
    await this.save();
  }

  /**
   * Get a usage boost score for a file (0 if unknown).
   */
  async getBoost(filePath: string): Promise<number> {
    const fb = await this.load();
    return fb.files[filePath]?.score ?? 0;
  }

  /**
   * Get boost scores for multiple files at once.
   */
  async getBoosts(filePaths: string[]): Promise<Map<string, number>> {
    const fb = await this.load();
    const result = new Map<string, number>();
    for (const p of filePaths) {
      const score = fb.files[p]?.score ?? 0;
      if (score > 0) result.set(p, score);
    }
    return result;
  }

  private async save(): Promise<void> {
    if (!this.data) return;
    try {
      const target = path.join(this.root, FEEDBACK_PATH);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(this.data, null, 2), "utf8");
    } catch { /* non-critical */ }
  }
}
