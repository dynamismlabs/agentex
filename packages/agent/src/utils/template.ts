export function resolvePathValue(obj: unknown, dottedPath: string): unknown {
  const keys = dottedPath.split(".");
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function renderTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
    const value = resolvePathValue(data, path.trim());
    return value == null ? "" : String(value);
  });
}
