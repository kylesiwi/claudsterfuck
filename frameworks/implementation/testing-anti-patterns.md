# Testing Anti-Patterns

- Do not test mocks when you should be testing behavior.
- Do not add production-only seams or helper methods just to satisfy weak tests.
- Do not treat integration tests as an afterthought if the bug lives at boundaries.
- Do not rewrite assertions to match incorrect implementation without first verifying the requirement.
- If a test passes immediately, check whether you are testing existing behavior or the wrong thing.
