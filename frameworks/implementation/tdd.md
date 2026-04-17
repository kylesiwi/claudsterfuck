# Test-Driven Development

Core law:

- No production code without a failing test first.

Cycle:

1. Write one small test for one behavior.
2. Run it and confirm it fails for the expected reason.
3. Write the smallest code that makes it pass.
4. Run the test again and confirm it passes.
5. Refactor only while staying green.

Guardrails:

- If you did not watch the test fail, you do not know whether it tests the right thing.
- Do not change the test to match buggy behavior unless the requirement itself was wrong.
- Prefer tests of real behavior over tests of mock choreography.
- If the task explicitly exempts TDD, obey the task. Otherwise treat TDD as the default.
