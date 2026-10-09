import { embeddingChunks, normalizedEmbedding, EMBEDDING_DIMENSIONS } from '@/utils/rag';
import { embedBounded, type Embed } from './aiRuntime';
export type EmbeddingDependencies = { embed?: Embed; reserve?: (units: number) => Promise<void>; signal?: AbortSignal };
// Match the reference's chunk -> embed -> averaged document vector, with an
// explicit version and normalized average. Documents and queries share a space.
export async function generateEmbedding(text: string, kind: 'query' | 'document', title = 'none', dependencies?: EmbeddingDependencies) {
  const signal = AbortSignal.any([dependencies?.signal ?? AbortSignal.timeout(25000), AbortSignal.timeout(25000)]);
  if (!text.trim()) throw new Error('AI_EMBEDDING_INPUT_INVALID');
  const chunks = kind === 'query' ? [text.slice(0, 2000)] : embeddingChunks(text);
  const vectors: number[][] = [];
  for (const chunk of chunks) {
    const input = kind === 'query' ? `task: search result | query: ${chunk}` : `title: ${title.slice(0, 200)} | text: ${chunk}`;
    const response = await embedBounded(input, { ...dependencies, signal });
    if (response.embeddings?.length !== 1) throw new Error('AI_EMBEDDING_INVALID');
    vectors.push(normalizedEmbedding(response.embeddings[0].values));
  }
  return normalizedEmbedding(Array.from({ length: EMBEDDING_DIMENSIONS }, (_, dimension) => vectors.reduce((sum, vector) => sum + vector[dimension], 0) / vectors.length));
}
