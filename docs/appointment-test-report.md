# Careway appointment test report

Tested on 13 November 2026 against the separate free `careway-demo-test` project, `vqrkzjymfoinfeurwgtl`. No production database changes were made. All demo providers and accounts are labelled TEST ONLY and are not public Careway providers.

## Previously completed, not repeated unnecessarily

- Live Careway homepage and 57 sourced hospital listings were available.
- The existing 8 directory-sync tests and original production build had passed. Those tests do not cover appointments.
- The free test Supabase project existed, but its first browser-entered schema attempt had failed with SQL syntax error 42601. The database was verified empty before applying the initial migration through the connected Supabase tool.

## Completed in this continuation

- Applied the initial appointment schema to the empty test database.
- Created two synthetic patients, one synthetic doctor, one test administrator, and one labelled test hospital in the test database only. Test accounts were pre-confirmed; no emails were sent.
- Added a repeatable demo-only API integration suite. First run: 26 passed, 0 failed. After adding repeatable approval reset: 27 passed, 0 failed.
- Browser-tested patient login, patient dashboard, time selection, and appointment request submission.
- Browser-tested doctor login, loaded practice details, doctor workspace, and request confirmation. Database inspection confirmed the resulting confirmed status.
- Browser-tested admin login, admin dashboard, pending-doctor display, and account approval.
- Browser-tested patient cancellation through the confirmation dialog. Database inspection confirmed the browser-created appointment became cancelled.
- API tests verified wrong-password rejection, prevention of patient self-promotion, unapproved-doctor scheduling rejection, approval, future-slot publishing, public safe availability, single-winner concurrent booking, private patient history, patient confirmation denial, doctor confirmation, cancellation, released availability, invalid status-transition rejection, history-preserving slot deletion rejection, and past-slot rejection.
- Added a visible demo banner, test-database allowlist in demo mode, and a rendered noindex/nofollow hint.
- Added availability refresh without resetting unsaved practice forms, and refresh after booking conflicts.
- Restricted client EXECUTE permissions on an optional internal Supabase event-trigger function. Verified both anonymous and authenticated client access are false.
- Modified demo build succeeded. Credentials and local environment files remain ignored and are not included in the review branch.

## Pending / not claimed as tested

- Signup email delivery, email confirmation links, and password-reset email delivery. Pre-confirmed synthetic users validate password login, not the email lifecycle.
- A separately hosted demo URL. Current demo runs locally; the live URL remains https://healthcare-appointments-kappa.vercel.app/ and has not received these review-branch changes.
- Merge/release of reviewed code. No automatic merge or production database migration is part of this work.
- Broad mobile/accessibility/browser coverage, dependency/security review, and operational readiness for real patient data.
- Actual provider onboarding and consent. No real providers were invented or added.

## Security notices and interpretation

Supabase flagged the anonymous/authenticated SECURITY DEFINER permissions on `available_slots`; these are intentional and limited to safe future slot fields. The internal `rls_auto_enable` permissions were restricted. Leaked-password protection is disabled in the test project's Auth settings; no paid upgrade was purchased or proposed. Review the [database linter explanation](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable) and [password security guidance](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

A passing test suite is not a clinical-service launch approval. Requests still require provider confirmation, and directory listings do not imply hospital affiliation.
