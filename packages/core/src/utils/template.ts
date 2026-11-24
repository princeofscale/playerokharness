/**
 * Safe placeholder formatter supporting nested dot-paths like
 * `{user.username}`, `{item.name}`, `{deal.id}`, `{account.username}`, `{review_rating}`.
 * Unknown keys are preserved verbatim (`{unknown.key}`), matching Python SafeDict behavior.
 */
export function formatTemplate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (fullMatch, path: string) => {
    const parts = path.split('.');
    let current: unknown = variables;

    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return fullMatch;
      }
      if (!Object.prototype.hasOwnProperty.call(current, part)) {
        return fullMatch;
      }
      current = (current as Record<string, unknown>)[part];
    }

    if (current === null || current === undefined) {
      return fullMatch;
    }
    return String(current);
  });
}

export function formatTemplateLines(lines: string[], variables: Record<string, unknown>): string {
  return formatTemplate(lines.join('\n'), variables);
}
