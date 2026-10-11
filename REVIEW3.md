Verified REVIEW2.md's remaining finding 2 in HEAD `6cdf952` (`git diff HEAD~1`): playback failure survives empty/remote-only voice lists and restoration of a local voice; Peek and the fallback note remain until playback starts successfully.

No new P1/P2 issues found in the diff.

Validation: only `npm test -- "review 2 again"` ran, from a temporary copy of HEAD; all 45 checks passed in Chromium (20.6s). WebKit was unavailable. Only REVIEW3.md was changed in the repository.
