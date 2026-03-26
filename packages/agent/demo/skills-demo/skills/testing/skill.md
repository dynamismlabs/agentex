# Testing Standards

When writing tests:
- Use descriptive test names that explain the expected behavior
- Follow Arrange-Act-Assert pattern
- Test edge cases: empty inputs, null values, boundary conditions
- Never mock what you don't own — use integration tests for external dependencies
- Each test should be independent and not rely on execution order
