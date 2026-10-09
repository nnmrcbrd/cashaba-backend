import 'dotenv/config';
import { setTimeout as delay } from 'node:timers/promises';
import { prisma } from '@/lib/prisma';
import bank from '@/evaluation/aiQuestions.v1.json';
import { PLANNING_OPERATIONS } from '@/utils/planningIntent';
import { GUIDANCE_DOCUMENTS } from '@/utils/assistantKnowledge';
import { EMBEDDING_VERSION, contentHash, knowledgeText, knowledgeBaseInput, knowledgeDocumentInput } from '@/utils/rag';
import { KnowledgeBaseRepository, KnowledgeDocumentRepository } from '@/repositories/knowledge.repository';
import { saveKnowledgeBase, saveKnowledgeDocument } from '@/services/knowledgeManagement';

// Only approved public guidance is indexed. Never embed private ledger records
// or synthetic fixture balances as knowledge answers. Safe to resume by hash.
const knowledge = new KnowledgeBaseRepository(), documents = new KnowledgeDocumentRepository();
let indexed = 0, skipped = 0;
try {
  for (const row of bank.questions) {
    const instruction = PLANNING_OPERATIONS[row.completeInput.operation as keyof typeof PLANNING_OPERATIONS];
    if (!instruction) throw new Error('Unknown question-bank operation');
    const data = knowledgeBaseInput.parse({ question: row.question, category: row.completeInput.operation,
      tags: row.tools, answer: `${instruction} Required inputs: ${row.requiredInputs.join('; ')}. Use the authenticated user's fresh recorded finances and explicitly supplied scenario details. Missing entries do not establish zero costs. Ask only for still-missing fields; preserve previously supplied values. Financial amounts and dates must come from backend calculation tools. Never infer a product price or use another user's records.` });
    const existing = await knowledge.findByQuestion(data.question);
    if (existing?.indexed && existing.embeddingVersion === EMBEDDING_VERSION && existing.contentHash === contentHash(knowledgeText(data))) { skipped++; continue; }
    await saveKnowledgeBase(data); indexed++;
    console.log(JSON.stringify({ type: 'question', id: row.id, indexed, skipped }));
    await delay(750);
  }
  for (const guide of GUIDANCE_DOCUMENTS) {
    const data = knowledgeDocumentInput.parse({ slug: `casha-ba-${guide.source}`, title: `Casha-Ba: ${guide.source}`, content: guide.text, excerpt: guide.text.slice(0, 200), category: [guide.source] });
    const existing = await documents.findBySlug(data.slug);
    if (existing?.indexed && existing.embeddingVersion === EMBEDDING_VERSION && existing.contentHash === contentHash(data.title + '\n' + data.content)) { skipped++; continue; }
    await saveKnowledgeDocument(data); indexed++;
    console.log(JSON.stringify({ type: 'document', source: guide.source, indexed, skipped }));
    await delay(750);
  }
  console.log(JSON.stringify({ completed: true, indexed, skipped, expectedQuestions: bank.questions.length, expectedDocuments: GUIDANCE_DOCUMENTS.length, embeddingVersion: EMBEDDING_VERSION }));
} catch (error) {
  // Failed embeddings never replace a previously indexed entry or invent a vector.
  console.error(JSON.stringify({ completed: false, indexed, skipped, error: error instanceof Error ? error.name : 'PROVIDER_ERROR',
    status: error && typeof error === 'object' && 'status' in error ? error.status : null }));
  process.exitCode = 1;
} finally { await prisma.$disconnect(); }
