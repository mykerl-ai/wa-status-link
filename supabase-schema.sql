-- Run this in your Supabase project: SQL Editor → New query → paste and run
-- Ensure Supabase Auth is enabled (Authentication → Providers → Email).

-- Profiles (links auth.users to app role: owner | customer)
-- Create after enabling Supabase Auth; id = auth.uid()
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'customer' check (role in ('owner', 'customer')),
  display_name text,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_insert_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
create policy "profiles_insert_own" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id);

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete set null,
  public_id text not null,
  price text not null default 'Contact for Price',
  badge_label text not null default '',
  size text not null default '',
  color text not null default '',
  qty text not null default '',
  link text not null,
  preview_url text not null,
  bg_color text default 'white',
  created_at timestamptz default now()
);

-- Ensure new columns exist for existing projects
-- If the line below fails (e.g. cross-schema ref), use: alter table products add column if not exists owner_id uuid;
alter table if exists products
  add column if not exists owner_id uuid references auth.users(id) on delete set null;
-- Backfill: assign existing products to the first owner (run once after adding owner_id)
-- update products set owner_id = (select id from profiles where role = 'owner' order by created_at limit 1) where owner_id is null;
alter table if exists products
  add column if not exists badge_label text not null default '';
alter table if exists products
  add column if not exists size text not null default '';
alter table if exists products
  add column if not exists color text not null default '';
alter table if exists products
  add column if not exists qty text not null default '';

-- Carts (persisted when user is signed in; one row per user)
create table if not exists carts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  items jsonb not null default '[]',
  updated_at timestamptz default now()
);

alter table carts enable row level security;
drop policy if exists "carts_select" on carts;
drop policy if exists "carts_insert" on carts;
drop policy if exists "carts_update" on carts;
create policy "carts_select" on carts for select using (true);
create policy "carts_insert" on carts for insert with check (true);
create policy "carts_update" on carts for update using (true);

-- Orders (for cart checkout / Paystack)
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  reference text unique not null,
  email text not null,
  amount_kobo bigint not null,
  items jsonb not null default '[]',
  status text not null default 'pending',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- RLS: allow server (anon or service_role) to read/write. Run this if you get
-- "new row violates row-level security policy" or products/orders not saving.
-- Option A (recommended): set SUPABASE_SERVICE_KEY in .env – service role bypasses RLS, no policies needed.
-- Option B: use only SUPABASE_ANON_KEY and run the policies below (Supabase → SQL Editor).

alter table products enable row level security;
alter table orders enable row level security;

-- Drop then create so this script can be run multiple times (idempotent)
drop policy if exists "products_select" on products;
drop policy if exists "products_insert" on products;
drop policy if exists "orders_select" on orders;
drop policy if exists "orders_insert" on orders;
drop policy if exists "orders_update" on orders;

create policy "products_select" on products for select using (true);
create policy "products_insert" on products for insert with check (true);
create policy "orders_select" on orders for select using (true);
create policy "orders_insert" on orders for insert with check (true);
create policy "orders_update" on orders for update using (true);
