### Changed

- Reviews stop hardening against attackers a project will never meet: gate (g) gains an `Exposure:` line in the
  milestone's `ACCEPTANCE`, which the lead copies into verifier briefs. With it, a finding blocks only if reachable
  within that line, or if it breaks authorization, separation of users' data or credentials, or causes data loss.
  The rest goes on the debt issue as `beyond exposure: <class>`, and the close report lists it. No line, no change.
