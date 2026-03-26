# Security Checklist

When writing code, always check for:
- SQL injection: use parameterized queries, never interpolate user input
- XSS: sanitize all user-provided content before rendering
- Path traversal: validate and normalize file paths
- Secrets: never hardcode API keys, tokens, or passwords
- Dependencies: prefer well-maintained packages with no known vulnerabilities
