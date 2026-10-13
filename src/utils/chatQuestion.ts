// Ignore presentation around a copied question. Do not use this normalizer for
// confirmation/cancellation controls or mutate the original stored message.
export function normalizeChatQuestion(value: string): string {
  let text = value.normalize('NFKC').trim();
  for (let index = 0; index < 4; index++) {
    const before = text;
    text = text.replace(/^(?:\d{1,3}[.)]|[-*+])\s+(?=[“‘"'`*_]*\p{L})/u, '').trim();
    for (const [open, close] of [['**', '**'], ['__', '__'], ['“', '”'], ['‘', '’'], ['"', '"'], ["'", "'"], ['`', '`']]) {
      if (text.length > open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
        text = text.slice(open.length, -close.length).trim();
      }
    }
    if (text === before) break;
  }
  return text;
}
