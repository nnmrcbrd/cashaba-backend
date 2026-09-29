export interface FinancialReviewInput {
  totalIncome: number;
  configuredIncome: number;
  totalExpenses: number;
  netCashFlow: number;
  projectedBalance: number;
  budgetConfigured: boolean;
  budgetTarget: number;
  budgetSpent: number;
  savingsTarget: number;
  savingsSaved: number;
  expenseChangePct: number | null;
  topCategory: { name: string; amount: number; percentage: number } | null;
}

export interface FinancialReviewSummary {
  status: { label: string; detail: string; tone: 'positive' | 'warning' | 'critical' | 'neutral' };
  strongestArea: string;
  mainConcern: string;
  recommendedAction: string;
}

function peso(amount: number): string {
  return `₱${Math.abs(amount).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function buildFinancialReview(input: FinancialReviewInput): FinancialReviewSummary {
  const baselineIncome = input.totalIncome || input.configuredIncome;
  const hasFinancialData = baselineIncome > 0 || input.totalExpenses > 0 || input.savingsTarget > 0;
  const budgetPercentage = input.budgetTarget > 0 ? Math.round((input.budgetSpent / input.budgetTarget) * 100) : 0;
  const savingsPercentage = input.savingsTarget > 0 ? Math.round((input.savingsSaved / input.savingsTarget) * 100) : 0;

  let status: FinancialReviewSummary['status'];
  if (!hasFinancialData) {
    status = {
      label: 'Getting started',
      detail: 'Add income, transactions, or savings goals to generate a complete financial review.',
      tone: 'neutral',
    };
  } else if (input.projectedBalance < 0) {
    status = {
      label: 'Needs attention',
      detail: `Projected expenses exceed available income by ${peso(input.projectedBalance)} for this period.`,
      tone: 'critical',
    };
  } else if (input.budgetConfigured && input.budgetTarget > 0 && input.budgetSpent > input.budgetTarget) {
    status = {
      label: 'Over budget',
      detail: `Spending is ${budgetPercentage}% of the configured budget for this period.`,
      tone: 'warning',
    };
  } else {
    status = {
      label: 'On track',
      detail: `The projected remaining balance is ${peso(input.projectedBalance)} for this period.`,
      tone: 'positive',
    };
  }

  let strongestArea = 'More financial history is needed to identify a strongest area.';
  if (input.totalIncome > 0 && input.netCashFlow > 0) {
    strongestArea = `Positive cash flow: income exceeds expenses by ${peso(input.netCashFlow)}.`;
  } else if (input.expenseChangePct !== null && input.expenseChangePct < 0) {
    strongestArea = `Improved spending control: expenses are ${Math.abs(input.expenseChangePct)}% lower than the previous period.`;
  } else if (input.savingsTarget > 0 && input.savingsSaved > 0) {
    strongestArea = `Savings progress has reached ${savingsPercentage}% of the combined goal target.`;
  } else if (input.budgetConfigured && input.budgetTarget > 0 && input.budgetSpent <= input.budgetTarget) {
    strongestArea = `Budget control remains within the configured limit at ${budgetPercentage}% used.`;
  }

  let mainConcern = 'No major concern can be identified until more transactions are recorded.';
  let recommendedAction = 'Continue recording transactions so the next review can identify meaningful trends.';
  if (input.projectedBalance < 0) {
    mainConcern = `A projected shortfall of ${peso(input.projectedBalance)} may affect upcoming obligations.`;
    recommendedAction = 'Reduce flexible spending or increase available income before adding new commitments.';
  } else if (input.budgetConfigured && input.budgetTarget > 0 && input.budgetSpent > input.budgetTarget) {
    mainConcern = `The budget has been exceeded by ${peso(input.budgetSpent - input.budgetTarget)}.`;
    recommendedAction = 'Review the largest expense categories and pause non-essential spending for the rest of the period.';
  } else if (input.expenseChangePct !== null && input.expenseChangePct > 0) {
    mainConcern = `Expenses are ${input.expenseChangePct}% higher than the previous equivalent period.`;
    recommendedAction = 'Compare recent transactions with the previous period and set a limit for the categories that increased.';
  } else if (input.topCategory) {
    mainConcern = `${input.topCategory.name} is the largest expense category at ${peso(input.topCategory.amount)} (${input.topCategory.percentage}%).`;
    recommendedAction = `Review ${input.topCategory.name} transactions and set a category limit if the spending is not essential.`;
  }

  return { status, strongestArea, mainConcern, recommendedAction };
}
