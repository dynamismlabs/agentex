/**
 * Resolve a dotted path like "sender.name" from a data object.
 */
function resolvePathValue(data: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = data;
  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Render a template string with `{{variable}}` substitution and
 * `{{#if var}}...{{/if}}` conditional blocks.
 *
 * - Variables use dotted paths: `{{sender.name}}`
 * - Missing values render as empty string
 * - Conditional blocks are included only if the variable is truthy
 * - Nested conditionals are supported
 */
export function renderGatewayTemplate(
  template: string,
  data: Record<string, unknown>,
): string {
  // Process {{#if var}}...{{/if}} blocks (innermost first)
  let result = template;
  const ifPattern = /\{\{#if\s+(\S+?)\}\}([\s\S]*?)\{\{\/if\}\}/g;

  // Iterate until no more conditionals remain (handles nesting)
  let prev = "";
  while (prev !== result) {
    prev = result;
    result = result.replace(ifPattern, (_match, varName: string, body: string) => {
      const value = resolvePathValue(data, varName);
      if (value) {
        return body;
      }
      return "";
    });
  }

  // Process {{variable}} substitutions
  result = result.replace(/\{\{(\S+?)\}\}/g, (_match, varName: string) => {
    const value = resolvePathValue(data, varName);
    if (value == null) {
      return "";
    }
    return String(value);
  });

  return result;
}
