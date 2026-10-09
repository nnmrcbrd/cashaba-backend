import { KnowledgeBaseRepository, KnowledgeDocumentRepository } from '@/repositories/knowledge.repository';
import { knowledgeBaseInput, knowledgeDocumentInput, knowledgeText } from '@/utils/rag';
import { reserveIndexingTokens } from './aiRuntime';
import { generateEmbedding } from './embedding';

export async function saveKnowledgeBase(value: unknown) {
  const data = knowledgeBaseInput.parse(value);
  const embedding = await generateEmbedding(knowledgeText(data), 'document', data.question, { reserve: reserveIndexingTokens });
  return (await new KnowledgeBaseRepository().save(data, embedding))[0];
}
export async function saveKnowledgeDocument(value: unknown) {
  const data = knowledgeDocumentInput.parse(value);
  const embedding = await generateEmbedding(data.content, 'document', data.title, { reserve: reserveIndexingTokens });
  return (await new KnowledgeDocumentRepository().save(data, embedding))[0];
}
