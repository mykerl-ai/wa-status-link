-- Run this in your Supabase project: SQL Editor → New query → paste and run

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
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
alter table if exists products
  add column if not exists badge_label text not null default '';
alter table if exists products
  add column if not exists size text not null default '';
alter table if exists products
  add column if not exists color text not null default '';
alter table if exists products
  add column if not exists qty text not null default '';

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
