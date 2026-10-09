import { Router, Request, Response } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { prisma } from '@/lib/prisma';
import { authorize } from '@/middlewares/rbac.middleware';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { PayMongoError } from '@/services/paymongo';
import { cancelCheckout, CheckoutError } from '@/services/subscriptionCheckout';
import { withFinancialOperation } from '@/services/financialOperation';
import writeXlsxFile, { type Cell, type SheetData } from 'write-excel-file/node';
import { calculateSafeToSpend } from '@/utils/safeToSpend';

const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function excelText(value: unknown): Cell {
  if (value === null || value === undefined) return '';
  let cellText = Array.isArray(value) ? value.join(', ') : String(value);
  if (/^[=+\-@]/.test(cellText)) cellText = `'${cellText}`;
  if (cellText.length > 32_767) cellText = `${cellText.slice(0, 32_740)}... [truncated for Excel]`;
  return cellText;
}

function excelNumber(value: unknown): Cell {
  const number = Number(value ?? 0);
  return { value: Number.isFinite(number) ? number : 0, type: Number, format: '#,##0.00' };
}

function excelDate(value: Date | null | undefined): Cell {
  return value ? { value, type: Date, format: 'yyyy-mm-dd hh:mm' } : '';
}

function exportSheet(headers: string[], rows: Cell[][]): { data: SheetData; columns: Array<{ width: number }> } {
  return {
    data: [
      headers.map((value) => ({
        value,
        type: String,
        fontWeight: 'bold' as const,
        backgroundColor: '#D1FAE5',
      })),
      ...rows,
    ],
    columns: headers.map((header) => ({
      width: /description|question|answer|value/i.test(header)
        ? 42
        : /\bid\b/i.test(header)
          ? 38
          : /date|created|updated|completed|verified|active|exported/i.test(header)
            ? 22
            : Math.max(14, Math.min(28, header.length + 4)),
    })),
  };
}

const profileUpdateSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  gender: z.enum(["Male", "Female"]).nullable().optional(),
  avatarUrl: z.string().max(400_000).refine((value) => {
    if (/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return true;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && (url.hostname === 'googleusercontent.com' || url.hostname.endsWith('.googleusercontent.com'));
    } catch {
      return false;
    }
  }, 'Avatar must be an uploaded image or a Google profile photo').nullable().optional(),
  roles: z.array(z.enum(['STUDENT', 'WORKING', 'FREELANCE', 'MARRIED'])).max(4),
  customRole: z.string().trim().max(80).nullable().optional(),
  region: z.string().trim().max(80).nullable().optional(),
}).refine((data) => data.roles.length > 0 || Boolean(data.customRole), { path: ['roles'], message: 'Select a role or enter a custom role' });

const onboardingSchema = z.object({ step: z.coerce.number().int().min(1).max(5), complete: z.boolean().optional() });

const router = Router();

// Current User Profile
router.get('/me', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        gender: true,
        avatarUrl: true,
        accountRole: true,
        accountStatus: true,
        roles: true,
        customRole: true,
        region: true,
        onboardingStep: true,
        onboardingCompletedAt: true,
        lastActiveAt: true,
        createdAt: true,
        incomeSetup: { select: { id: true } },
      }
    });

    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    res.json({
      ...user,
      authMethod: req.user!.authMethod,
      onboardingComplete: Boolean(user.onboardingCompletedAt),
      incomeSetup: undefined,
    });
  } catch {
    res.status(500).json({ message: "Error fetching profile" });
  }
});

router.patch('/me', authenticate, authorize(['USER']), async (req: Request, res: Response) => {
  const parsed = profileUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Invalid profile details', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const user = await prisma.user.update({
      where: { id: req.user!.userId },
      data: parsed.data,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        gender: true,
        avatarUrl: true,
        accountRole: true,
        accountStatus: true,
        roles: true,
        customRole: true,
        region: true,
        onboardingStep: true,
        onboardingCompletedAt: true,
        lastActiveAt: true,
        createdAt: true,
        incomeSetup: { select: { id: true } },
      },
    });
    if (user.onboardingStep < 2 && (parsed.data.roles.length > 0 || Boolean(parsed.data.customRole))) {
      await prisma.user.update({ where: { id: user.id }, data: { onboardingStep: 2 } });
      user.onboardingStep = 2;
    }
    res.json({ ...user, onboardingComplete: Boolean(user.onboardingCompletedAt), incomeSetup: undefined });
  } catch {
    res.status(500).json({ message: 'Error updating profile' });
  }
});

router.patch('/me/onboarding', authenticate, authorize(['USER']), async (req: Request, res: Response) => {
  const parsed = onboardingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid onboarding progress' });
  const user = await prisma.user.update({
    where: { id: req.user!.userId },
    data: { onboardingStep: parsed.data.step, onboardingCompletedAt: parsed.data.complete ? new Date() : undefined },
    select: { onboardingStep: true, onboardingCompletedAt: true },
  });
  res.json({ ...user, onboardingComplete: Boolean(user.onboardingCompletedAt) });
});

router.get('/me/export', authenticate, authorize(['USER']), async (req: Request, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      omit: { password: true },
      include: { wallets: true, transactions: true, budgets: { include: { categories: true } }, loans: true, incomeSetup: true, fixedExpenses: true, savingsGoals: true, aiSessions: true },
    });

    if (!user) return res.status(404).json({ message: 'User not found' });

    if (user.incomeSetup) user.incomeSetup.safeToSpend = (await calculateSafeToSpend(req.user!.userId)).safeToSpend as unknown as typeof user.incomeSetup.safeToSpend;
    const exportedAt = new Date();
    const workbook = writeXlsxFile([
      {
        sheet: 'Profile',
        ...exportSheet(['Field', 'Value'], [
          ['Exported at', excelDate(exportedAt)],
          ['User ID', excelText(user.id)],
          ['First name', excelText(user.firstName)],
          ['Last name', excelText(user.lastName)],
          ['Email', excelText(user.email)],
          ['Gender', excelText(user.gender)],
          ['Account role', excelText(user.accountRole)],
          ['Account status', excelText(user.accountStatus)],
          ['Roles', excelText(user.roles)],
          ['Custom role', excelText(user.customRole)],
          ['Region', excelText(user.region)],
          ['Onboarding step', user.onboardingStep],
          ['Onboarding completed', excelDate(user.onboardingCompletedAt)],
          ['Email verified', excelDate(user.emailVerified)],
          ['Last active', excelDate(user.lastActiveAt)],
          ['Created', excelDate(user.createdAt)],
          ['Updated', excelDate(user.updatedAt)],
        ]),
      },
      {
        sheet: 'Wallets',
        ...exportSheet(['Name', 'Institution', 'Account type', 'Kind', 'Opening balance', 'Created', 'Updated'], user.wallets.map((wallet) => [
          excelText(wallet.name), excelText(wallet.institution), excelText(wallet.accountType), excelText(wallet.kind), excelNumber(wallet.openingBalance), excelDate(wallet.createdAt), excelDate(wallet.updatedAt),
        ])),
      },
      {
        sheet: 'Transactions',
        ...exportSheet(['Date', 'Description', 'Type', 'Category', 'Amount', 'Wallet ID', 'Destination wallet ID', 'Loan ID', 'Savings goal ID', 'Obligation ID', 'Deleted', 'Created'], user.transactions.map((transaction) => [
          excelDate(transaction.date), excelText(transaction.description), excelText(transaction.type), excelText(transaction.category), excelNumber(transaction.amount), excelText(transaction.walletId), excelText(transaction.destinationWalletId), excelText(transaction.loanId), excelText(transaction.savingsGoalId), excelText(transaction.fixedExpenseId), excelDate(transaction.deletedAt), excelDate(transaction.createdAt),
        ])),
      },
      {
        sheet: 'Budgets',
        ...exportSheet(['Month', 'Year', 'Target amount', 'Amount spent', 'Created'], user.budgets.map((budget) => [
          budget.month, budget.year, excelNumber(budget.targetAmount), excelNumber(budget.amountSpent), excelDate(budget.createdAt),
        ])),
      },
      {
        sheet: 'Budget Categories',
        ...exportSheet(['Month', 'Year', 'Category', 'Limit amount'], user.budgets.flatMap((budget) => budget.categories.map((category) => [
          budget.month, budget.year, excelText(category.category), excelNumber(category.limitAmount),
        ]))),
      },
      {
        sheet: 'Loans',
        ...exportSheet(['Title', 'Type', 'Status', 'Amount', 'Amount paid', 'Installment paid', 'Repayment amount', 'Repayment frequency', 'Start date', 'Deadline', 'Created', 'Updated'], user.loans.map((loan) => [
          excelText(loan.title), excelText(loan.type), excelText(loan.status), excelNumber(loan.amount), excelNumber(loan.amountPaid), excelNumber(loan.installmentPaid), excelNumber(loan.repaymentAmount), excelText(loan.repaymentFrequency), excelDate(loan.startDate), excelDate(loan.deadline), excelDate(loan.createdAt), excelDate(loan.updatedAt),
        ])),
      },
      {
        sheet: 'Income',
        ...exportSheet(['Total income', 'Income period', 'Safe to spend', 'Updated'], user.incomeSetup ? [[
          excelNumber(user.incomeSetup.totalIncome), excelText(user.incomeSetup.incomePeriod), excelNumber(user.incomeSetup.safeToSpend), excelDate(user.incomeSetup.updatedAt),
        ]] : []),
      },
      {
        sheet: 'Obligations',
        ...exportSheet(['Name', 'Category', 'Amount', 'Amount paid', 'Due date', 'Frequency', 'Status', 'Reminder days', 'Wallet ID', 'Created', 'Updated'], user.fixedExpenses.map((expense) => [
          excelText(expense.name), excelText(expense.category), excelNumber(expense.amount), excelNumber(expense.amountPaid), excelDate(expense.dueDate), excelText(expense.frequency), excelText(expense.status), expense.reminderDays, excelText(expense.walletId), excelDate(expense.createdAt), excelDate(expense.updatedAt),
        ])),
      },
      {
        sheet: 'Savings Goals',
        ...exportSheet(['Name', 'Target amount', 'Current amount', 'Monthly allocation', 'Completed', 'Created'], user.savingsGoals.map((goal) => [
          excelText(goal.name), excelNumber(goal.targetAmount), excelNumber(goal.currentAmount), excelNumber(goal.monthlyAllocation), goal.isCompleted, excelDate(goal.createdAt),
        ])),
      },
      {
        sheet: 'AI History',
        ...exportSheet(['Question', 'Answer', 'Model', 'Prompt tokens', 'Response tokens', 'Total tokens', 'State', 'Created'], user.aiSessions.map((session) => [
          excelText(session.question), excelText(session.answer), excelText(session.model), session.promptTokens, session.responseTokens, session.totalTokens, excelText(session.state), excelDate(session.createdAt),
        ])),
      },
    ]);
    const buffer = await workbook.toBuffer();
    const filename = `casha-ba-export-${exportedAt.toISOString().slice(0, 10)}.xlsx`;

    res.setHeader('Content-Type', EXCEL_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (error) {
    console.error('Error exporting user data:', error);
    res.status(500).json({ message: 'Unable to export your data right now' });
  }
});

router.delete('/me', authenticate, authorize(['USER']), async (req: Request, res: Response) => {
  try {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const confirmation = typeof req.body?.confirmation === 'string' ? req.body.confirmation : '';
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, include: { subscription: true } });
    if (!user) return res.status(404).json({ message: 'Account not found' });
    if (confirmation !== 'DELETE') return res.status(400).json({ message: 'Type DELETE to confirm account deletion' });
    if (req.user!.authMethod !== 'GOOGLE' && !(await bcrypt.compare(password, user.password))) return res.status(400).json({ message: 'Password confirmation is incorrect' });
    await withFinancialOperation(user.id, async tx => {
      await cancelCheckout(tx, user.id);
      await tx.user.delete({ where: { id: user.id } });
    });
    res.json({ message: 'Account and associated data permanently deleted' });
  } catch (error) {
    if (error instanceof CheckoutError) return res.status(error.status).json({ message: error.message, code: error.code });
    if (error instanceof PayMongoError) return res.status(error.status).json({ message: 'Account deletion was stopped because PayMongo cancellation could not be confirmed. Your account and billing details are still available. Please try again or contact support.' });
    console.error('Delete account error:', error);
    res.status(500).json({ message: 'Account deletion could not be completed. Please try again.' });
  }
});

// ADMIN MANAGE USERS DASHBOARD ENDPOINT
router.get('/admin/manage-users', authenticate, authorize(['ADMIN']), async (req: Request, res: Response) => {
  try {
    const dbUsers = await prisma.user.findMany({
      where: { accountRole: 'USER' },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        createdAt: true,
        accountRole: true,
        accountStatus: true,
        lastActiveAt: true,
        region: true,
        subscription: { select: { plan: true, status: true, currentPeriodEnd: true, provider: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const transactions = await prisma.transaction.findMany({
      where: { deletedAt: null },
      select: { type: true, createdAt: true },
    });
    const txCount = transactions.length;

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthTxCount = await prisma.transaction.count({
      where: { createdAt: { gte: startOfMonth }, deletedAt: null },
    });

    const mappedUsers = dbUsers.map((u) => {
      return {
        id: u.id,
        name: `${u.firstName} ${u.lastName}`.trim(),
        email: u.email,
        joinedDate: new Date(u.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
        status: u.accountStatus === 'ACTIVE' ? 'Active' : 'Inactive',
        lastActiveAt: u.lastActiveAt,
        subscription: u.subscription ?? { plan: 'FREE', status: 'ACTIVE', currentPeriodEnd: null },
      };
    });

    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const activeCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const chartData = Array.from({ length: 4 }, (_, index) => {
      const bucketStart = new Date(now.getTime() - (3 - index) * weekMs);
      bucketStart.setHours(0, 0, 0, 0);
      const bucketEnd = new Date(bucketStart.getTime() + weekMs);
      const bucket = transactions.filter((transaction) => (
        transaction.createdAt >= bucketStart && transaction.createdAt < bucketEnd
      ));
      return {
        date: bucketStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        green: bucket.filter((transaction) => transaction.type === 'INCOME').length,
        gray: bucket.filter((transaction) => ['EXPENSE', 'BILL_PAYMENT', 'DEBT_PAYMENT'].includes(transaction.type)).length,
      };
    });

    const weekStart = new Date(now.getTime() - weekMs);
    const newUsersThisWeek = dbUsers.filter((user) => user.createdAt >= weekStart).length;
    const weekTransactions = transactions.filter((transaction) => transaction.createdAt >= weekStart).length;

    res.json({
      users: mappedUsers,
      subscriptionCheckedAt: now.toISOString(),
      metrics: {
        totalUsers: dbUsers.length,
        totalTransactions: txCount,
        monthTransactions: monthTxCount,
        activeUsers: dbUsers.filter((user) => user.accountStatus === 'ACTIVE' && user.lastActiveAt && user.lastActiveAt >= activeCutoff).length,
        newUsersThisWeek,
        weekTransactions,
        plusSubscribers: dbUsers.filter(user => user.subscription && user.subscription.plan !== 'FREE' && user.subscription.status === 'ACTIVE' && user.subscription.currentPeriodEnd > now).length,
      },
      locationBreakdown: (() => {
        const grouped = Object.entries(dbUsers.reduce<Record<string, number>>((totals, user) => {
          if (user.region) totals[user.region] = (totals[user.region] || 0) + 1;
          return totals;
        }, {}));
        const visible = grouped.filter(([, count]) => count >= 2).map(([location, count]) => ({ location, count }));
        const suppressed = grouped.filter(([, count]) => count < 2).reduce((sum, [, count]) => sum + count, 0);
        if (suppressed > 0) visible.push({ location: 'Other / not shown', count: suppressed });
        return visible.sort((a, b) => b.count - a.count);
      })(),
      chartData,
    });
  } catch (error) {
    console.error("Admin error:", error);
    res.status(500).json({ message: "Error fetching admin data" });
  }
});

// ADMIN TOGGLE USER STATUS
router.patch('/admin/users/:id/status', authenticate, authorize(['ADMIN']), async (req: Request, res: Response) => {
  const parsed = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Status must be ACTIVE or SUSPENDED' });
  if (req.params.id === req.user!.userId) return res.status(400).json({ message: 'Administrators cannot suspend their own account' });
  const targetId = req.params.id as string;
  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) return res.status(404).json({ message: 'User not found' });
  if (target.accountRole === 'ADMIN') return res.status(403).json({ message: 'Administrator accounts cannot be changed from user management.' });
  try {
    const updated = await withFinancialOperation(targetId, async (tx) => {
      if (parsed.data.status === 'SUSPENDED') await cancelCheckout(tx, targetId);
      const user = await tx.user.update({ where: { id: targetId }, data: { accountStatus: parsed.data.status }, select: { id: true, accountStatus: true } });
      if (parsed.data.status === 'SUSPENDED') await tx.token.updateMany({ where: { userId: targetId, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.adminAuditLog.create({ data: { actorId: req.user!.userId, action: 'USER_STATUS_CHANGED', targetType: 'User', targetId, metadata: { previousStatus: target.accountStatus, newStatus: parsed.data.status } } });
      return user;
    });
    res.json(updated);
  } catch (error) {
    if (error instanceof CheckoutError) return res.status(error.status).json({ message: error.message, code: error.code });
    if (error instanceof PayMongoError) return res.status(error.status).json({ message: 'Suspension stopped because PayMongo cancellation could not be confirmed.' });
    throw error;
  }
});

router.post('/admin/users/:id/cancel-subscription', authenticate, authorize(['ADMIN']), async (req: Request, res: Response) => {
  const targetId = req.params.id as string;
  const subscription = await prisma.subscription.findUnique({ where: { userId: targetId } });
  if (!subscription) return res.status(404).json({ message: 'Subscription not found' });
  if (subscription.status === 'CANCELLED' || subscription.status === 'EXPIRED') return res.json({ cancelled: true, alreadyCancelled: true });
  try {
    await withFinancialOperation(targetId, async tx => {
      await cancelCheckout(tx, targetId);
      await tx.adminAuditLog.create({ data: { actorId: req.user!.userId, action: 'SUBSCRIPTION_CANCELLED', targetType: 'User', targetId, metadata: { provider: subscription.provider, providerSubscriptionId: subscription.providerSubscriptionId } } });
    });
    res.json({ cancelled: true });
  } catch (error) {
    if (error instanceof CheckoutError) return res.status(error.status).json({ message: error.message, code: error.code });
    if (error instanceof PayMongoError) return res.status(error.status).json({ message: 'PayMongo cancellation could not be confirmed. The subscription remains available for a retry.' });
    throw error;
  }
});

router.get('/admin/audit-log', authenticate, authorize(['ADMIN']), async (req: Request, res: Response) => {
  const logs = await prisma.adminAuditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { actor: { select: { firstName: true, lastName: true, email: true } } } });
  res.json(logs);
});

export default router;
