# Root Cause Tracing

- Start at the observed failure and trace backward until you find where the bad state originates.
- Ask: what called this with the bad value, and what called that, until you reach the source.
- Fix the origin, not the symptom layer.
- In multi-step pipelines, instrument input and output at each boundary before changing logic.
- If the trace reveals that the current structure makes root cause hard to isolate, say so explicitly.
