/**
 * Recursively walk an object and replace `$VAR` / `${VAR}` patterns
 * in all string values with environment variable values.
 *
 * Throws on missing vars with field path context.
 */
export function substituteEnvVars<T>(
  obj: T,
  env: Record<string, string | undefined> = process.env,
  path: string = "",
): T {
  if (typeof obj === "string") {
    return substituteString(obj, env, path) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item, i) =>
      substituteEnvVars(item, env, path ? `${path}[${i}]` : `[${i}]`),
    ) as T;
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const fieldPath = path ? `${path}.${key}` : key;
      result[key] = substituteEnvVars(value, env, fieldPath);
    }
    return result as T;
  }
  return obj;
}

function substituteString(
  str: string,
  env: Record<string, string | undefined>,
  path: string,
): string {
  // Match ${VAR} and $VAR patterns
  return str.replace(/\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/g, (_match, braced: string | undefined, bare: string | undefined) => {
    const varName = braced ?? bare;
    if (!varName) return _match;
    const value = env[varName];
    if (value === undefined) {
      throw new Error(
        `Config error: ${path} references $${varName} which is not set`,
      );
    }
    return value;
  });
}
