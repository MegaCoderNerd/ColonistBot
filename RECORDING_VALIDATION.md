# Recording-based validation

The deterministic unit and regression tests run without captured recordings. The larger empirical
tests use the recording bundle only when it is available.

Set `COLONIST_RECORDINGS_PATH` to the absolute path of a compatible JSON bundle, then run:

```powershell
$env:COLONIST_RECORDINGS_PATH = 'C:\path\to\colonist-recordings-2026-10-08.json'
npm test
```

The bundle must contain a top-level `recordings` array with the IDs used by the tests, including
`farm9373`, `edge9896`, and `deck7708`. If the path is absent, only tests explicitly marked
`recording fixture required` are skipped; no synthetic data is substituted for empirical checks.
