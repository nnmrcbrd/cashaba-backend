import { KnowledgeBaseRepository, KnowledgeDocumentRepository } from '@/repositories/knowledge.repository';
import { redactIdentifiers } from '@/utils/aiSafety';
import { contentHash, EMBEDDING_VERSION, type KnowledgePassage, type RetrievalResult } from '@/utils/rag';
import { generateEmbedding } from './embedding';

type Search = (vector: number[], limit: number, threshold: number) => Promise<KnowledgePassage[]>;
export type RetrievalDependencies = { embed: (query: string) => Promise<number[]>; searchKnowledge: Search; searchDocuments: Search };
const queryCache = new Map<string, { vector: number[]; expires: number }>();
// Cache only anonymized query embeddings, not balances, retrieved records or
// document text. Search the current database on every turn, including cache hits.
export async function retrieveRagContext(query: string, dependencies?: RetrievalDependencies): Promise<RetrievalResult> {
  if (!process.env.GEMINI_API_KEY && !dependencies) return { mode: 'unavailable', passages: [], errorCode: 'AI_EMBEDDING_NOT_CONFIGURED' };
  const sanitized = redactIdentifiers(query).slice(0, 2000);
  if (!sanitized.trim()) return { mode: 'empty', passages: [] };
  try {
    const key = contentHash(EMBEDDING_VERSION + sanitized);
    const cached = dependencies ? null : queryCache.get(key);
    const vector = cached && cached.expires > Date.now() ? cached.vector : await (dependencies?.embed ?? (text => generateEmbedding(text, 'query')))(sanitized);
    if (!dependencies && !cached) {
      if (queryCache.size >= 256) queryCache.delete(queryCache.keys().next().value!);
      queryCache.set(key, { vector, expires: Date.now() + 600000 });
    } else if (!dependencies && cached && cached.expires <= Date.now()) queryCache.set(key, { vector, expires: Date.now() + 600000 });
    const configured = Number(process.env.AI_RAG_MAX_DISTANCE ?? 0.4);
    const threshold = Number.isFinite(configured) ? Math.max(0, Math.min(1, configured)) : 0.4;
    const knowledgeRepository = new KnowledgeBaseRepository();
    const documentRepository = new KnowledgeDocumentRepository();
    const [knowledge, documents] = await Promise.all([
      (dependencies?.searchKnowledge ?? knowledgeRepository.searchSimilar.bind(knowledgeRepository))(vector, 3, threshold),
      (dependencies?.searchDocuments ?? documentRepository.searchSimilar.bind(documentRepository))(vector, 3, threshold),
    ]);
    const passages: KnowledgePassage[] = []; let used = 0;
    for (const passage of [...knowledge, ...documents].sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))) {
      if (!Number.isFinite(passage.distance) || passage.distance > threshold || passage.embeddingVersion !== EMBEDDING_VERSION) continue;
      const text = passage.text.slice(0, 900);
      if (passages.length >= 3 || used + text.length > 2400) continue;
      passages.push({ ...passage, text }); used += text.length;
    }
    return { mode: passages.length ? 'semantic' : 'empty', passages };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = /^AI_[A-Z_]+$/.test(message) ? message : error && typeof error === 'object' && 'status' in error ? `HTTP_${Number(error.status)}` : 'AI_RETRIEVAL_UNAVAILABLE';
    return { mode: 'unavailable', passages: [], errorCode: code };
  }
}
