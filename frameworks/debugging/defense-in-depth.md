# Defense In Depth

When invalid data or unsafe behavior caused the bug:

- validate at the entry point
- validate again where business logic depends on the value
- add environment guards where context-specific damage is possible
- add enough debug instrumentation to make the next failure diagnosable

Goal:

- not just "we handled this one bug"
- but "this class of bug is much harder to reintroduce"
