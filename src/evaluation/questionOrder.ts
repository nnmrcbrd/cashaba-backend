// Prioritize untested/regression cases without excluding any requested question.
export function orderEvaluationQuestions<T extends { id: number }>(questions: T[], raw?: string) {
  if (!raw?.trim()) return { questions: [...questions], priorityIds: [] as number[] };
  const tokens = raw.split(',').map(value => value.trim());
  if (tokens.some(value => !/^\d+$/.test(value))) throw new Error('Invalid evaluation priority IDs');
  const priorityIds = tokens.map(Number);
  if (new Set(priorityIds).size !== priorityIds.length || priorityIds.some(id => !questions.some(row => row.id === id))) {
    throw new Error('Evaluation priority IDs must be unique IDs from the requested questions');
  }
  const selected = new Set(priorityIds);
  return { priorityIds, questions: [
    ...priorityIds.map(id => questions.find(row => row.id === id)!),
    ...questions.filter(row => !selected.has(row.id)),
  ] };
}
