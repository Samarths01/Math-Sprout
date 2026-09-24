# Item templates

Templates are data. A server interpreter draws operands, computes the answer, and stores an `item_instances` row. The client never generates a problem and never sends an answer key.

Progression in this release is `rules-v0`. Issuance reads `assigned_step` and serves step 1 only. The kid-facing word for that step is Warm-up. Steady and Stretch are the words for steps 2 and 3, which are not served yet.

Each skill has one legacy `v0` seed (the original fixed item, `provenance: seed`) and at least three generated templates. Legacy rows do not count toward that bar. Finding an equivalent fraction has four generated templates so the written form can be required: lowest terms, improper, or mixed. Other fraction skills compare equal values, so `2/4` matches `1/2`.

A template version is immutable. Changing a spec means adding a new version. `tests/template-version-snapshot.test.ts` hashes each spec and checks the committed snapshot.

`parent_prior_grade` and `parent_prior_difficulty` are nullable columns on the template version. Every seed leaves them null. Issuance does not read them.

An unreadable answer is not an attempt (Architecture §29). The server writes no attempt row, mints nothing, and returns `format_rejected` with no verdict and no fuel line. The idempotency key is not consumed, so the next readable answer on that issued item scores normally. The item stays in the 7-day no-repeat window because it was already issued. Rejects are logged in `answer_format_rejects` (template version, provenance, prompt type, answer type, timestamp) with no raw child text, and they never enter the attempt log.

`parseAnswer` lives in `lib/answer-parser.ts`, which imports nothing. The client and the offline queue use that same function. The server is the only scorer.

Blank answers are unchanged: an `empty_answer` review-lane try mints no XP, is not a celebrate miss, and still occupies a slot in the mastery window.

`UNPARSEABLE_BEHAVIOR` in `lib/unparseable.ts` is the only switch (`'retry' | 'lock'`). It defaults to `'retry'`: the item stays open and the child sees `UNPARSEABLE_HINT` (`Type a number like 3 or 1/2.`). `'lock'` consumes the instance and does not write an attempt. Changing that one constant is the whole decision.
