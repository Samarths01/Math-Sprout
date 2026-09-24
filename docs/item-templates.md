# Item templates

Templates are data. A server interpreter draws operands, computes the answer, and stores an `item_instances` row. The client never generates a problem and never sends an answer key.

Progression in this release is `rules-v0`. Issuance reads `assigned_step` and serves step 1 only. The kid-facing word for that step is Warm-up. Steady and Stretch are the words for steps 2 and 3, which are not served yet.

Each skill has one legacy `v0` seed (the original fixed item, `provenance: seed`) and at least three generated templates. Legacy rows do not count toward that bar. Finding an equivalent fraction has four generated templates so the written form can be required: lowest terms, improper, or mixed. Other fraction skills compare equal values, so `2/4` matches `1/2`.

A template version is immutable. Changing a spec means adding a new version. `tests/template-version-snapshot.test.ts` hashes each spec and checks the committed snapshot.

`parent_prior_grade` and `parent_prior_difficulty` are nullable columns on the template version. Every seed leaves them null. Issuance does not read them.

An unparseable answer locks the instance, writes no estimator evidence, and mints no qualifying event, XP, or streak. A blank answer is not that path. A blank is an `empty_answer` review-lane try: it mints no XP, it is not a celebrate miss, and it still occupies a slot in the mastery window.
