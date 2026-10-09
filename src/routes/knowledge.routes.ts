import { Router } from 'express';
import { ZodError } from 'zod';
import { authenticate } from '@/middlewares/auth.middleware';
import { authorize } from '@/middlewares/rbac.middleware';
import { rateLimit } from '@/middlewares/rateLimit.middleware';
import { KnowledgeBaseRepository, KnowledgeDocumentRepository } from '@/repositories/knowledge.repository';
import { saveKnowledgeBase, saveKnowledgeDocument } from '@/services/knowledgeManagement';

const router = Router();
router.use(authenticate, authorize(['ADMIN']), rateLimit({ windowMs: 60000, max: 10, identity: 'user' }));
router.get('/questions', async (_req, res, next) => { try { res.json(await new KnowledgeBaseRepository().list()); } catch (error) { next(error); } });
router.get('/documents', async (_req, res, next) => { try { res.json(await new KnowledgeDocumentRepository().list()); } catch (error) { next(error); } });
for (const [path, save] of [['questions', saveKnowledgeBase], ['documents', saveKnowledgeDocument]] as const) {
  router.post(`/${path}`, async (req, res) => {
    try { res.status(201).json(await save(req.body)); }
    catch (error) {
      if (error instanceof ZodError) { res.status(400).json({ message: 'Invalid knowledge entry', issues: error.issues.map(issue => ({ path: issue.path, message: issue.message })) }); return; }
      res.status(503).json({ message: 'Knowledge indexing unavailable; the existing entry was preserved.' });
    }
  });
}
for (const [path, repository] of [['questions', new KnowledgeBaseRepository()], ['documents', new KnowledgeDocumentRepository()]] as const) {
  router.delete(`/${path}/:id`, async (req, res, next) => {
    if (typeof req.params.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(req.params.id)) { res.status(400).json({ message: 'Invalid entry ID' }); return; }
    try { const rows = await repository.deactivate(req.params.id); res.status(rows.length ? 200 : 404).json({ deactivated: !!rows.length }); }
    catch (error) { next(error); }
  });
}
export default router;
