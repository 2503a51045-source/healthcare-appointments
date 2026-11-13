# Careway database setup

Use a separate Supabase project for development. The current test project is `careway-demo-test` (`vqrkzjymfoinfeurwgtl`). Do not run tests, demo seeds, or these initial migrations against the live Careway database.

## Schema

On a new, empty database, apply `migrations/202611130001_initial.sql` once. It creates the five application tables, signup trigger, role checks, RLS policies, active-slot uniqueness constraint, and `available_slots` RPC. Apply `202611130002_restrict_internal_trigger.sql` afterward; it restricts client access to Supabase's optional internal RLS event trigger if present.

The test project already has both migrations applied. Do not reapply the initial schema there.

## Authentication and roles

Patient and doctor signup create `profiles` automatically. Patients are approved at signup; doctors wait for administrator approval and must save a hospital and specialization before approval.

The first administrator must be created deliberately by a trusted operator. After the intended person registers and confirms their email, verify their auth user UUID, then use a privileged database session to update exactly that profile's role to `admin` and `approved` to true. Never grant admin from signup metadata or a browser client. This step is already complete for the isolated test administrator.

Use confirmed-email authentication for real users, configure the production Site URL and allowed redirect URLs, and test actual email delivery. The synthetic test accounts were pre-confirmed for isolated password-login tests; this does not validate signup emails or password-reset delivery.

## Local demo

Create an ignored `.env.demo.local` containing:

```
VITE_SUPABASE_URL=https://vqrkzjymfoinfeurwgtl.supabase.co
VITE_SUPABASE_ANON_KEY=<test project's publishable or anon key>
VITE_DEMO_MODE=true
```

Run `npm ci`, then `npm run dev -- --mode demo --host 127.0.0.1`. The demo displays a warning banner, adds a noindex/nofollow meta tag, and refuses to start in demo mode against any other database. A public key is not an administrator secret; authorization remains enforced by RLS. Never place a service-role key in any `VITE_` variable.

## Repeatable appointment tests

Run `node scripts/test-appointments.mjs`. It refuses any database URL other than the isolated test project's URL. It needs an ignored `.env.test-fixtures.json`, provisioned privately, with `url`, `key`, `hospital` UUID, and a `users` array containing two patients, one doctor, and one administrator. Each user entry contains `id`, `email`, `password`, `role`, and `name` such as `TEST ONLY patient`. Credentials are not committed.

The suite deliberately resets the synthetic doctor's approval, reapproves that account, creates future slots, and creates/cancels synthetic requests. Test records are retained as history. It is not a read-only test and is never suitable for production.

Public free/busy lookup intentionally uses a narrowly scoped SECURITY DEFINER function so anonymous users can see unreserved slots without reading appointments. Do not replace it with a client query of private patient bookings.

## Still required before real appointment use

Verify clinician identity and consent, configure and test email verification and recovery, establish privacy/retention and provider contact procedures, and complete broader security, accessibility, mobile, and operational checks. Directory inclusion is not affiliation, and a request is not confirmed until the provider accepts it. No payments or paid services were added.
