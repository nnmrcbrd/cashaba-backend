CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "AiSession" ADD COLUMN "context_metadata" JSONB;

CREATE TABLE "KnowledgeBase" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "question" TEXT NOT NULL UNIQUE,
  "answer" TEXT NOT NULL,
  "category" TEXT,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "metadata" JSONB,
  "embedding" vector(768),
  "embeddingVersion" TEXT,
  "contentHash" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "KnowledgeBase_category_idx" ON "KnowledgeBase" ("category");
CREATE INDEX "KnowledgeBase_embedding_idx" ON "KnowledgeBase" USING hnsw ("embedding" vector_cosine_ops);

CREATE TABLE "KnowledgeDocument" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "slug" TEXT NOT NULL UNIQUE,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "excerpt" TEXT NOT NULL,
  "category" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "embedding" vector(768),
  "embeddingVersion" TEXT,
  "contentHash" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "KnowledgeDocument_embedding_idx" ON "KnowledgeDocument" USING hnsw ("embedding" vector_cosine_ops);
