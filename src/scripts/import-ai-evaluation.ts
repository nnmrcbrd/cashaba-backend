import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { scenarios } from '@/evaluation/questionScenarios';
import { missingFacts } from '@/evaluation/planningFixtures';
import { localFinancialPlan } from '@/services/financialPlanner';

const source = process.argv[2];
if (!source) throw new Error('Pass the original 150-question prompt file path');
const bank = readFileSync(source, 'utf8').split('QUESTION BANK:')[1];
const questions = [...bank.matchAll(/^(\d+)\. (.+)$/gm)].map(match => ({ id: Number(match[1]), question: match[2].replace(/\r$/, '') }));
if (questions.length !== 150 || questions.some((item, index) => item.id !== index + 1)) throw new Error('The original question bank must contain IDs 1–150 exactly');
const inputs: Record<string, string[]> = {
  cash_available: ['accessible accounts', 'confirmed next payday', 'protected cash', 'essential daily cost', 'bill/debt due dates'],
  afford_purchase: ['full purchase price', 'accessible accounts', 'confirmed next payday', 'protected cash', 'essential daily cost', 'bill/debt due dates'],
  daily_limit: ['accessible accounts', 'confirmed next payday', 'protected cash', 'essential daily cost', 'bill/debt due dates'],
  goal_timeline: ['target price', 'dedicated saved amount', 'affordable contribution and frequency', 'first contribution date for completion date'],
  goal_contribution: ['target price', 'dedicated saved amount', 'deadline', 'actual remaining contribution dates'],
  goal_change: ['selected goal', 'current saving plan', 'explicit change', 'actual schedule for completion date'],
  goal_split: ['selected goal priorities', 'shared surplus', 'remaining targets', 'contribution dates for deadline feasibility'],
  budget_review: ['monthly budget', 'recorded spending and coverage'], budget_allocate: ['income scenario', 'essential costs', 'unpaid bill/debt schedule'],
  income_change: ['baseline income', 'stated change', 'essential costs', 'bill/debt schedule'],
  income_history: ['at least two completed comparable income months', 'history coverage'],
  category_spending: ['classified spending', 'date range', 'coverage'], spending_compare: ['equivalent date ranges', 'classified spending', 'coverage'],
  spending_cut: ['category and reduction percentage OR unit/replacement costs and weekdays/date range'],
  debt_payoff: ['selected principal', 'payment', 'interest type', 'rate per period', 'fees', 'frequency'],
  debt_compare: ['selected principal', 'base and extra payments', 'interest type', 'rate per period', 'fees', 'frequency'],
  debt_totals: ['authenticated owner borrowed/lent records'], bill_reserve: ['unpaid bills/debts', 'due dates', 'horizon'],
  debt_budget: ['received period income', 'recorded debt payments', 'outstanding debt schedule'],
  bill_forecast: ['unpaid recurring amounts', 'due dates', 'horizon'], bill_cost: ['selected recurring bill amounts and frequencies'],
  emergency_cover: ['essential daily costs', 'bill/debt schedule', 'user-chosen reserve months'], runway: ['accessible emergency reserve', 'essential costs', 'bill/debt schedule'],
  school_budget: ['allowance or part-time income', 'actual school days', 'daily food', 'return fare', 'other school costs'],
  cost_plan: ['complete first scenario costs', 'comparable alternative costs', 'same period'],
  history_peak: ['spending history', 'category classification', 'coverage'], period_forecast: ['month history coverage', 'actual spending/saving pace', 'forecast end date'],
  missing_info: ['target', 'dedicated savings', 'affordable contribution', 'schedule'],
};
const toolMap: Record<string, string[]> = {
  cash_available: ['accounts', 'income', 'obligations', 'debts', 'what_if'], afford_purchase: ['accounts', 'income', 'obligations', 'debts', 'what_if'],
  daily_limit: ['accounts', 'income', 'obligations', 'debts', 'what_if'], runway: ['accounts', 'obligations', 'debts', 'what_if'],
  goal_timeline: ['goals', 'what_if'], goal_contribution: ['goals', 'what_if'], goal_change: ['goals', 'what_if'], goal_split: ['goals', 'what_if'],
  budget_review: ['spending', 'income'], budget_allocate: ['income', 'obligations', 'debts', 'what_if'], income_change: ['income', 'obligations', 'debts', 'what_if'],
  income_history: ['income', 'spending'], category_spending: ['spending'], spending_compare: ['spending'], spending_cut: ['spending', 'what_if'],
  debt_payoff: ['debts', 'what_if'], debt_compare: ['debts', 'what_if'], debt_totals: ['debts'], bill_reserve: ['obligations', 'debts'], bill_forecast: ['obligations', 'debts'], bill_cost: ['obligations', 'what_if'],
  debt_budget: ['income', 'debts', 'spending', 'obligations', 'what_if'],
  emergency_cover: ['accounts', 'goals', 'obligations', 'debts', 'what_if'], school_budget: ['income', 'what_if'], cost_plan: ['what_if'], missing_info: ['goals', 'what_if'], history_peak: ['spending'], period_forecast: ['accounts', 'spending', 'what_if'],
};
const dataset = { version: 'casha-ai-questions-v1', sourceSha256: createHash('sha256').update(JSON.stringify(questions)).digest('hex'),
  fixture: 'planningFixtures.ts (synthetic only)', note: 'Complete inputs contain supplemental user answers. These are tool and mocked-extraction evaluations; live language understanding is evaluated separately.',
  questions: questions.map(question => {
    const scenario = scenarios.find(row => row.id === question.id)!;
    const missing = localFinancialPlan(question.question, missingFacts());
    if (!missing) throw new Error(`Question ${question.id} is not routed as a financial question`);
    const requiredInputs = scenario.completeInput.costMode === 'total'
      ? ['full move-in total including stated deposits, furniture and fees']
      : scenario.completeInput.costMode === 'income_effect'
        ? ['current and new full costs', 'current and new take-home income, with unchanged income explicitly stated', 'same comparison period; one-time versus recurring costs']
        : inputs[scenario.completeInput.operation];
    return { ...question, ...scenario, requiredInputs, tools: ['summary', ...toolMap[scenario.completeInput.operation]],
      missingInput: { ...missing, operation: scenario.completeInput.operation },
      expectedMissingBehavior: scenario.completeInput.operation === 'debt_totals' ? 'report recorded zero with unrecorded-data caveat' : 'ask for absent fields without asserting affordability or a completion date',
    };
  }),
};
writeFileSync(new URL('../evaluation/aiQuestions.v1.json', import.meta.url), JSON.stringify(dataset, null, 2) + '\n');
console.log(`Preserved ${dataset.questions.length} original questions and wrote versioned evaluation mappings.`);
