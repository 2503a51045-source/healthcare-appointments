-- Healthcare appointment requests, Supabase/PostgreSQL. Apply once to a NEW project.
-- No medical history, patient emails, payments, or production doctor seeds.
begin;
create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;
grant usage on schema app_private to anon, authenticated;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  full_name text not null check (length(btrim(full_name)) between 1 and 120),
  role text not null default 'patient' check (role in ('patient','doctor','admin')),
  approved boolean not null default false
);
create table public.hospitals (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200),
  city text not null check (length(btrim(city)) between 1 and 120),
  address text not null check (length(btrim(address)) between 1 and 500),
  source_url text check (source_url is null or source_url ~ '^https://'),
  specializations text[] not null default '{}',
  last_verified_at timestamptz
);
create table public.doctors (
  id uuid primary key references public.profiles(id) on delete restrict,
  hospital_id uuid not null references public.hospitals(id) on delete restrict,
  specialization text not null check (length(btrim(specialization)) between 1 and 160),
  bio text not null default '' check (length(bio) <= 2000)
);
create table public.slots (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references public.doctors(id) on delete restrict,
  starts_at timestamptz not null,
  unique (doctor_id, starts_at)
);
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.profiles(id) on delete restrict,
  slot_id uuid not null references public.slots(id) on delete restrict,
  status text not null default 'requested' check (status in ('requested','confirmed','cancelled')),
  created_at timestamptz not null default now()
);
-- A request immediately reserves its slot; cancellation releases it.
create unique index appointments_one_active_per_slot on public.appointments(slot_id)
  where status in ('requested','confirmed');
create index appointments_patient_idx on public.appointments(patient_id);
create index appointments_slot_idx on public.appointments(slot_id);
create index slots_doctor_starts_idx on public.slots(doctor_id,starts_at);
create index doctors_hospital_idx on public.doctors(hospital_id);

-- Definer helpers bypass RLS only for narrowly scoped boolean checks.
-- Every identifier is schema-qualified; never add caller-writable schemas to search_path.
create function app_private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'admin' and approved);
$$;
create function app_private.is_patient() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'patient' and approved);
$$;
create function app_private.approved_doctor(who uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles p join public.doctors d on d.id=p.id
    where p.id=who and p.role='doctor' and p.approved);
$$;
create function app_private.has_doctor_role(who uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id=who and role='doctor');
$$;
create function app_private.owns_slot(which uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.slots where id=which and doctor_id=auth.uid());
$$;
create function app_private.has_own_booking(which uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.appointments where slot_id=which and patient_id=auth.uid());
$$;
create function app_private.patient_of_current_doctor(who uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app_private.approved_doctor(auth.uid()) and exists(
    select 1 from public.appointments a join public.slots s on s.id=a.slot_id
    where a.patient_id=who and s.doctor_id=auth.uid());
$$;

create function app_private.on_auth_signup() returns trigger
language plpgsql security definer set search_path = '' as $$
declare requested_role text; display_name text;
begin
  requested_role := case when new.raw_user_meta_data->>'role'='doctor' then 'doctor' else 'patient' end;
  display_name := left(btrim(coalesce(new.raw_user_meta_data->>'full_name','')),120);
  if display_name='' then display_name := 'New user'; end if;
  insert into public.profiles(id,full_name,role,approved)
  values(new.id,display_name,requested_role,requested_role='patient');
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app_private.on_auth_signup();

create function app_private.guard_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.id is distinct from old.id then raise exception 'Profile identity is immutable' using errcode='42501'; end if;
  -- Manual SQL/service maintenance is trusted; API users cannot impersonate that context.
  if auth.uid() is not null and not app_private.is_admin() and
     (new.role is distinct from old.role or new.approved is distinct from old.approved) then
    raise exception 'Only an administrator may change role or approval' using errcode='42501';
  end if;
  return new;
end;
$$;
create trigger guard_profile before update on public.profiles
 for each row execute function app_private.guard_profile();

create function app_private.guard_doctor() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='UPDATE' and new.id is distinct from old.id then
    raise exception 'Doctor identity is immutable' using errcode='42501';
  end if;
  if not app_private.has_doctor_role(new.id) then
    raise exception 'Doctor directory entries require a doctor profile' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger guard_doctor before insert or update on public.doctors
 for each row execute function app_private.guard_doctor();

create function app_private.guard_slot() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('UPDATE','DELETE') then
    if exists(select 1 from public.appointments where slot_id=old.id) then
      raise exception 'A slot with appointment history cannot be changed or deleted' using errcode='42501';
    end if;
    if old.starts_at <= clock_timestamp() then
      raise exception 'Past slots cannot be changed or deleted' using errcode='42501';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  if tg_op='UPDATE' and (new.id is distinct from old.id or new.doctor_id is distinct from old.doctor_id) then
    raise exception 'Slot identity and doctor are immutable' using errcode='42501';
  end if;
  if new.starts_at <= clock_timestamp() or not app_private.approved_doctor(new.doctor_id) then
    raise exception 'Slots must be future times for an approved doctor' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger guard_slot before insert or update or delete on public.slots
 for each row execute function app_private.guard_slot();

create function app_private.guard_appointment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare target public.slots%rowtype;
begin
  if tg_op='DELETE' then raise exception 'Appointments cannot be deleted; cancel instead' using errcode='42501'; end if;
  -- Lock the slot on every booking transition, serializing booking vs slot edits and bookings.
  select * into target from public.slots where id=new.slot_id for update;
  if not found then raise exception 'Slot not found' using errcode='23503'; end if;
  if tg_op='INSERT' then
    if auth.uid() is null or new.patient_id is distinct from auth.uid() or not app_private.is_patient() then
      raise exception 'Only patients can request appointments for themselves' using errcode='42501';
    end if;
    if new.status <> 'requested' then raise exception 'New appointments must be requested' using errcode='42501'; end if;
    if target.starts_at <= clock_timestamp() or not app_private.approved_doctor(target.doctor_id) then
      raise exception 'Choose a future slot for an approved doctor' using errcode='23514';
    end if;
    new.created_at := clock_timestamp();
    return new;
  end if;
  if new.id is distinct from old.id or new.patient_id is distinct from old.patient_id
     or new.slot_id is distinct from old.slot_id or new.created_at is distinct from old.created_at then
    raise exception 'Appointment identity, patient, slot, and creation time are immutable' using errcode='42501';
  end if;
  if new.status=old.status then return new; end if;
  if old.status='cancelled' or new.status not in ('confirmed','cancelled') then
    raise exception 'Invalid appointment status transition' using errcode='42501';
  end if;
  if app_private.is_admin() then return new; end if;
  if auth.uid()=old.patient_id and new.status='cancelled' then return new; end if;
  if auth.uid()=target.doctor_id and app_private.approved_doctor(auth.uid()) then
    if new.status='confirmed' and target.starts_at <= clock_timestamp() then
      raise exception 'Past appointments cannot be confirmed' using errcode='42501';
    end if;
    return new;
  end if;
  raise exception 'Appointment status change is not permitted' using errcode='42501';
end;
$$;
create trigger guard_appointment before insert or update or delete on public.appointments
 for each row execute function app_private.guard_appointment();

alter table public.profiles enable row level security;
alter table public.hospitals enable row level security;
alter table public.doctors enable row level security;
alter table public.slots enable row level security;
alter table public.appointments enable row level security;

create policy profiles_read on public.profiles for select to anon, authenticated using (
  (role='doctor' and approved and app_private.approved_doctor(id))
  or id=(select auth.uid()) or app_private.is_admin() or app_private.patient_of_current_doctor(id)
);
create policy profiles_update on public.profiles for update to authenticated
 using (id=(select auth.uid()) or app_private.is_admin())
 with check (id=(select auth.uid()) or app_private.is_admin());
-- Hospitals are curated by admins; there is no untrusted hospital-submission surface.
create policy hospitals_read on public.hospitals for select to anon, authenticated using (true);
create policy hospitals_admin on public.hospitals for all to authenticated
 using (app_private.is_admin()) with check (app_private.is_admin());
create policy doctors_read on public.doctors for select to anon, authenticated
 using (app_private.approved_doctor(id) or id=(select auth.uid()) or app_private.is_admin());
create policy doctors_insert on public.doctors for insert to authenticated
 with check ((id=(select auth.uid()) and app_private.has_doctor_role(id)) or app_private.is_admin());
create policy doctors_update on public.doctors for update to authenticated
 using (id=(select auth.uid()) or app_private.is_admin())
 with check (id=(select auth.uid()) or app_private.is_admin());
create policy slots_read on public.slots for select to anon, authenticated
 using ((starts_at>now() and app_private.approved_doctor(doctor_id)) or doctor_id=(select auth.uid())
   or app_private.is_admin() or app_private.has_own_booking(id));
create policy slots_insert on public.slots for insert to authenticated
 with check ((doctor_id=(select auth.uid()) and app_private.approved_doctor(doctor_id)) or app_private.is_admin());
create policy slots_update on public.slots for update to authenticated
 using ((doctor_id=(select auth.uid()) and app_private.approved_doctor(doctor_id)) or app_private.is_admin())
 with check ((doctor_id=(select auth.uid()) and app_private.approved_doctor(doctor_id)) or app_private.is_admin());
create policy slots_delete on public.slots for delete to authenticated
 using ((doctor_id=(select auth.uid()) and app_private.approved_doctor(doctor_id)) or app_private.is_admin());
create policy appointments_read on public.appointments for select to authenticated
 using (patient_id=(select auth.uid()) or app_private.is_admin()
   or (app_private.approved_doctor((select auth.uid())) and app_private.owns_slot(slot_id)));
create policy appointments_insert on public.appointments for insert to authenticated
 with check (patient_id=(select auth.uid()) and app_private.is_patient() and status='requested');
create policy appointments_update on public.appointments for update to authenticated
 using (patient_id=(select auth.uid()) or app_private.is_admin()
   or (app_private.approved_doctor((select auth.uid())) and app_private.owns_slot(slot_id)))
 with check (patient_id=(select auth.uid()) or app_private.is_admin()
   or (app_private.approved_doctor((select auth.uid())) and app_private.owns_slot(slot_id)));

-- Public free/busy RPC returns only safe slot fields, never appointment/patient rows.
-- Bound result volume; callers may narrow by a public doctor UUID.
create function public.available_slots(p_doctor_id uuid default null) returns setof public.slots
language sql stable security definer set search_path = '' as $$
  select s.* from public.slots s
  where s.starts_at > now() and app_private.approved_doctor(s.doctor_id)
    and (p_doctor_id is null or s.doctor_id=p_doctor_id)
    and not exists(select 1 from public.appointments a where a.slot_id=s.id and a.status in ('requested','confirmed'))
  order by s.starts_at,s.id limit 500;
$$;
revoke all on function public.available_slots(uuid) from public;
grant execute on function public.available_slots(uuid) to anon, authenticated;

-- Supabase default table grants can be broad: replace them explicitly.
revoke all on public.profiles, public.hospitals, public.doctors, public.slots, public.appointments from anon, authenticated;
grant select on public.profiles, public.hospitals, public.doctors, public.slots to anon;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.hospitals to authenticated;
grant select, insert, update on public.doctors to authenticated;
grant select, insert, update, delete on public.slots to authenticated;
grant select, insert, update on public.appointments to authenticated;
-- Triggers are not callable RPC endpoints. Boolean helpers cannot read patient fields.
revoke all on all functions in schema app_private from public, anon, authenticated;
grant execute on function app_private.is_admin(), app_private.is_patient(), app_private.approved_doctor(uuid),
 app_private.has_doctor_role(uuid), app_private.owns_slot(uuid), app_private.has_own_booking(uuid),
 app_private.patient_of_current_doctor(uuid) to anon, authenticated;
commit;
