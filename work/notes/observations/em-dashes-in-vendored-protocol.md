# Em dashes in the vendored work/protocol files

2026-09-28: the `scaffold-monorepo` task asks for "no em dash characters in any file", but the vendored dorfl protocol files under `work/protocol/` (WORK-CONTRACT, REVIEW-PROTOCOL, ADR-FORMAT, CLAIM-PROTOCOL, and others) contain them. They were left alone as out of scope (they come from dorfl, not this repo); every file the scaffold added is em-dash free.
