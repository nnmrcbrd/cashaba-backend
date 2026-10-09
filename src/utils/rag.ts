import { createHash } from 'node:crypto';
import { z } from 'zod';

export const EMBEDDING_MODEL = 'gemini-embedding-2';
export const EMBEDDING_DIMENSIONS = 768;
export const EMBEDDING_VERSION = 'gemini-embedding-2:768:search-prefix:chunks-2000-200:normalized-v1';
export const knowledgeBaseInput = z.object({
  question: z.string().trim().min(3).max(2000), answer: z.string().trim().min(10).max(8000),
  category: z.string().trim().max(100).nullable().optional(), tags: z.array(z.string().trim().min(1).max(60)).max(15).default([]),
  isActive: z.boolean().default(true),
}).strict();
export const knowledgeDocumentInput = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120), title: z.string().trim().min(3).max(200),
  content: z.string().trim().min(10).max(8000), excerpt: z.string().trim().max(500).default(''),
  category: z.array(z.string().trim().min(1).max(60)).max(10).default([]), isActive: z.boolean().default(true),
}).strict();
export type KnowledgeBaseInput = z.infer<typeof knowledgeBaseInput>;
export type KnowledgeDocumentInput = z.infer<typeof knowledgeDocumentInput>;
export type KnowledgePassage = { id: string; source: string; version: string; embeddingVersion: string; text: string; distance: number };
export type RetrievalResult = { mode: 'semantic' | 'fixture' | 'empty' | 'unavailable'; passages: KnowledgePassage[]; errorCode?: string };
export type KnowledgeRetriever = (query: string) => Promise<RetrievalResult>;
export function contentHash(text: string) { return createHash('sha256').update(text).digest('hex'); }
export function embeddingChunks(text: string) {
  if (!text.trim() || text.length > 11000) throw new Error('AI_EMBEDDING_INPUT_INVALID');
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += 1800) {
    chunks.push(text.slice(start, start + 2000));
    if (start + 2000 >= text.length) break;
  }
  return chunks;
}
export function normalizedEmbedding(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS || value.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new Error('AI_EMBEDDING_INVALID');
  const length = Math.sqrt(value.reduce((sum, n) => sum + n * n, 0));
  if (!Number.isFinite(length) || length <= 0) throw new Error('AI_EMBEDDING_INVALID');
  return value.map(n => n / length);
}
export function vectorLiteral(value: unknown) { return '[' + normalizedEmbedding(value).join(',') + ']'; }
export function knowledgeText(data: KnowledgeBaseInput) { return `Question: ${data.question}\nAnswer: ${data.answer}`; }
