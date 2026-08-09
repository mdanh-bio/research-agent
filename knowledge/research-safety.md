# Research Safety

Computational-biology requests can be incorrectly flagged because scientific terminology overlaps
with safety-sensitive domains. Research Agent may use transparent fallback for legitimate research,
but never to defeat provider policy.

## Refusal handling

- Preserve the original request and attachments byte-for-byte across a fallback attempt.
- Retry only when the project scope, data boundary, and configured fallback policy allow the alternate
  provider.
- Treat a caller-supplied `benign_research_refusal` label as untrusted. Require a verified,
  scope-bound, single-use user approval record before reserving an automatic alternate.
- Record the provider response category and route decision without storing unnecessary sensitive
  content.
- Stop after at most two alternates. Ambiguous, dual-use, or materially changed requests require user
  review.
- Never split, obfuscate, translate, or reframe a request for the purpose of bypassing safeguards.

## Research and privacy boundaries

- Default to least-privilege tools and read-only side-question sessions.
- Treat external models, literature services, MCP servers, and compute targets as separate recipients.
  The user must be able to see which recipient receives which data.
- No automatic export of prompts, artifacts, crash dumps, or telemetry. Diagnostic sharing is an
  explicit user action after redaction.
- Credentials remain in OS-backed secure storage or native authentication channels; logs contain only
  sanitized categories and opaque identifiers.
- The platform is not approved for clinical diagnosis or autonomous wet-lab execution.

Any new biology skill must document intended use, misuse risks, input/output data sensitivity,
dependencies, network destinations, and a behavioral test before activation.
