# Root Cause Debugging

Core law:

- No fixes without root-cause investigation first.

Required sequence:

1. Read the failure carefully.
2. Reproduce it reliably.
3. Check recent changes and likely boundaries.
4. Gather evidence across component boundaries if multiple systems are involved.
5. Form one concrete hypothesis.
6. Make the smallest possible change to test that hypothesis.

Red flags:

- "Just try this quick fix."
- changing multiple things at once
- proposing solutions before tracing the failure path
- repeated failed fixes without revisiting the architecture

If three serious fix attempts fail, stop thrashing and question the approach.
