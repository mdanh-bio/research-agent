# Scientific Quality

Research Agent accelerates work; it does not replace expert judgment. Every final scientific claim
should be auditable from evidence available to the researcher.

## Evidence rules

- Prefer persistent identifiers (DOI, PMID, PMCID, accession, stable repository URL) and resolve them
  before citing.
- Separate observed results, model interpretation, literature-supported claims, and hypotheses.
- Record unavailable evidence as unavailable; never synthesize a plausible provenance value.
- Preserve raw inputs and immutable artifact versions. Link derived files to code, parameters,
  environment, input checksums, and execution records.
- Report sample size, uncertainty, multiple-testing handling, missing data, batch effects, data leakage,
  and relevant negative controls when applicable.
- Independent review should use a separate attempt/model route when practical and record disagreements.

## Data handling

- Default examples and tests to synthetic or explicitly authorized public data.
- Keep PHI, controlled-access genomic data, and sensitive sample metadata out of prompts and external
  providers unless an explicit project policy and authorization allow the transfer.
- Detect OneDrive `dataless` placeholders from metadata before reading. Materialize only named files
  within a declared size/scope; never recursively download a study directory.
- Dataset and software licenses, access terms, and redistribution limits travel with the project data
  catalog and final report.

The first vertical slice is accepted only when its literature identifiers resolve, local analysis is
deterministic, remote execution is approved and recoverable, output checksums verify, and the figure
and report link back to the full evidence chain.
