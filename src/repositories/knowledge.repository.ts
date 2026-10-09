import { randomUUID } from 'node:crypto';
import { prisma, qualifiedTable } from '@/lib/prisma';
import { EMBEDDING_VERSION, contentHash, knowledgeText, vectorLiteral, type KnowledgeBaseInput, type KnowledgeDocumentInput, type KnowledgePassage } from '@/utils/rag';

export type StoredKnowledge = { id: string; contentHash: string; embeddingVersion: string | null; indexed: boolean };
type QueryDatabase = Pick<typeof prisma, '$queryRawUnsafe'>;

export class KnowledgeBaseRepository {
  constructor(private readonly db: QueryDatabase = prisma) {}
  async findByQuestion(question: string) {
    const rows = await this.db.$queryRawUnsafe<StoredKnowledge[]>(`SELECT "id", "contentHash", "embeddingVersion", "embedding" IS NOT NULL AS indexed FROM ${qualifiedTable('KnowledgeBase')} WHERE "question"=$1`, question);
    return rows[0] ?? null;
  }
  async save(data: KnowledgeBaseInput, vector: number[], id = randomUUID()) {
    return this.db.$queryRawUnsafe<Array<{ id: string }>>(`INSERT INTO ${qualifiedTable('KnowledgeBase')} ("id","question","answer","category","tags","embedding","embeddingVersion","contentHash","isActive")
      VALUES ($1,$2,$3,$4,$5,$6::vector,$7,$8,$9)
      ON CONFLICT ("question") DO UPDATE SET "answer"=EXCLUDED."answer", "category"=EXCLUDED."category", "tags"=EXCLUDED."tags", "embedding"=EXCLUDED."embedding", "embeddingVersion"=EXCLUDED."embeddingVersion", "contentHash"=EXCLUDED."contentHash", "isActive"=EXCLUDED."isActive", "updatedAt"=CURRENT_TIMESTAMP RETURNING "id"`,
    id, data.question, data.answer, data.category ?? null, data.tags, vectorLiteral(vector), EMBEDDING_VERSION, contentHash(knowledgeText(data)), data.isActive);
  }
  async searchSimilar(vector: number[], limit = 3, maxDistance = 0.4): Promise<KnowledgePassage[]> {
    const rows = await this.db.$queryRawUnsafe<Array<{ id: string; question: string; answer: string; contentHash: string; distance: number }>>(`SELECT "id","question","answer","contentHash", ("embedding" <=> $1::vector) AS distance
      FROM ${qualifiedTable('KnowledgeBase')} WHERE "isActive" AND "embedding" IS NOT NULL AND "embeddingVersion"=$2 AND ("embedding" <=> $1::vector) <= $3
      ORDER BY "embedding" <=> $1::vector, "id" LIMIT $4`, vectorLiteral(vector), EMBEDDING_VERSION, maxDistance, Math.min(3, Math.max(1, limit)));
    return rows.map(row => ({ id: `kb:${row.id}`, source: row.question, version: row.contentHash, embeddingVersion: EMBEDDING_VERSION, text: `Question: ${row.question}\nAnswer: ${row.answer}`, distance: row.distance }));
  }
  async list() { return this.db.$queryRawUnsafe(`SELECT "id","question","answer","category","tags","isActive","embeddingVersion","contentHash","embedding" IS NOT NULL AS indexed,"createdAt","updatedAt" FROM ${qualifiedTable('KnowledgeBase')} ORDER BY "question" LIMIT 500`); }
  async deactivate(id: string) { return this.db.$queryRawUnsafe<Array<{ id: string }>>(`UPDATE ${qualifiedTable('KnowledgeBase')} SET "isActive"=FALSE,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 RETURNING "id"`, id); }
}

export class KnowledgeDocumentRepository {
  constructor(private readonly db: QueryDatabase = prisma) {}
  async findBySlug(slug: string) {
    const rows = await this.db.$queryRawUnsafe<StoredKnowledge[]>(`SELECT "id", "contentHash", "embeddingVersion", "embedding" IS NOT NULL AS indexed FROM ${qualifiedTable('KnowledgeDocument')} WHERE "slug"=$1`, slug);
    return rows[0] ?? null;
  }
  async save(data: KnowledgeDocumentInput, vector: number[], id = randomUUID()) {
    return this.db.$queryRawUnsafe<Array<{ id: string }>>(`INSERT INTO ${qualifiedTable('KnowledgeDocument')} ("id","slug","title","content","excerpt","category","embedding","embeddingVersion","contentHash","isActive")
      VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8,$9,$10)
      ON CONFLICT ("slug") DO UPDATE SET "title"=EXCLUDED."title", "content"=EXCLUDED."content", "excerpt"=EXCLUDED."excerpt", "category"=EXCLUDED."category", "embedding"=EXCLUDED."embedding", "embeddingVersion"=EXCLUDED."embeddingVersion", "contentHash"=EXCLUDED."contentHash", "isActive"=EXCLUDED."isActive", "updatedAt"=CURRENT_TIMESTAMP RETURNING "id"`,
    id, data.slug, data.title, data.content, data.excerpt, data.category, vectorLiteral(vector), EMBEDDING_VERSION, contentHash(data.title + '\n' + data.content), data.isActive);
  }
  async searchSimilar(vector: number[], limit = 3, maxDistance = 0.4): Promise<KnowledgePassage[]> {
    const rows = await this.db.$queryRawUnsafe<Array<{ id: string; title: string; content: string; contentHash: string; distance: number }>>(`SELECT "id","title","content","contentHash", ("embedding" <=> $1::vector) AS distance
      FROM ${qualifiedTable('KnowledgeDocument')} WHERE "isActive" AND "embedding" IS NOT NULL AND "embeddingVersion"=$2 AND ("embedding" <=> $1::vector) <= $3
      ORDER BY "embedding" <=> $1::vector, "id" LIMIT $4`, vectorLiteral(vector), EMBEDDING_VERSION, maxDistance, Math.min(3, Math.max(1, limit)));
    return rows.map(row => ({ id: `document:${row.id}`, source: row.title, version: row.contentHash, embeddingVersion: EMBEDDING_VERSION, text: row.content, distance: row.distance }));
  }
  async list() { return this.db.$queryRawUnsafe(`SELECT "id","slug","title","content","excerpt","category","isActive","embeddingVersion","contentHash","embedding" IS NOT NULL AS indexed,"createdAt","updatedAt" FROM ${qualifiedTable('KnowledgeDocument')} ORDER BY "title" LIMIT 200`); }
  async deactivate(id: string) { return this.db.$queryRawUnsafe<Array<{ id: string }>>(`UPDATE ${qualifiedTable('KnowledgeDocument')} SET "isActive"=FALSE,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 RETURNING "id"`, id); }
}
