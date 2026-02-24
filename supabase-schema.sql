-- Run this in Supabase SQL Editor.
-- This schema supports multi-tenant storefronts:
-- - each owner has one store slug
-- - product links can carry ?store=<slug>
-- - visitors only browse the selected store

create extension if not exists pgcrypto;

-- Profiles (auth user + app role).
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'customer' check (role in ('owner', 'customer')),
  display_name text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_insert_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;

create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Stores (1 store per owner; public slug for sharing).
create table if not exists public.stores (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  slug text not null unique,
  name text not null default 'My Store',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stores_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

alter table public.stores
  add column if not exists owner_id uuid references auth.users(id) on delete cascade;
alter table public.stores
  add column if not exists slug text;
alter table public.stores
  add column if not exists name text not null default 'My Store';
alter table public.stores
  add column if not exists created_at timestamptz not null default now();
alter table public.stores
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists stores_owner_id_key on public.stores(owner_id);
create unique index if not exists stores_slug_key on public.stores(slug);

alter table public.stores enable row level security;

drop policy if exists "stores_select_public" on public.stores;
drop policy if exists "stores_insert_own" on public.stores;
drop policy if exists "stores_update_own" on public.stores;
drop policy if exists "stores_delete_own" on public.stores;

create policy "stores_select_public"
  on public.stores for select
  using (true);

create policy "stores_insert_own"
  on public.stores for insert
  with check (auth.uid() = owner_id);

create policy "stores_update_own"
  on public.stores for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "stores_delete_own"
  on public.stores for delete
  using (auth.uid() = owner_id);

-- Backfill stores for existing owners (idempotent).
insert into public.stores (owner_id, slug, name)
select
  p.id,
  left(
    coalesce(
      nullif(trim(both '-' from regexp_replace(lower(coalesce(p.display_name, 'store')), '[^a-z0-9]+', '-', 'g')), ''),
      'store'
    ) || '-' || substr(p.id::text, 1, 6),
    48
  ) as slug,
  coalesce(nullif(trim(p.display_name), ''), 'My Store') as name
from public.profiles p
left join public.stores s on s.owner_id = p.id
where p.role = 'owner'
  and s.owner_id is null;

-- Products (tenant-bound by owner_id).
create table if not exists public.products (
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

alter table public.products
  add column if not exists owner_id uuid references auth.users(id) on delete set null;
alter table public.products
  add column if not exists badge_label text not null default '';
alter table public.products
  add column if not exists size text not null default '';
alter table public.products
  add column if not exists color text not null default '';
alter table public.products
  add column if not exists qty text not null default '';

create index if not exists products_owner_id_idx on public.products(owner_id);
create index if not exists products_created_at_idx on public.products(created_at desc);

alter table public.products enable row level security;

drop policy if exists "products_select_public" on public.products;
drop policy if exists "products_insert_owner" on public.products;
drop policy if exists "products_update_owner" on public.products;
drop policy if exists "products_delete_owner" on public.products;

-- Public storefront listing by selected store.
create policy "products_select_public"
  on public.products for select
  using (owner_id is not null);

-- Owner can only write their own rows.
create policy "products_insert_owner"
  on public.products for insert
  with check (auth.uid() = owner_id);

create policy "products_update_owner"
  on public.products for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "products_delete_owner"
  on public.products for delete
  using (auth.uid() = owner_id);

-- Carts (one row per signed-in user).
create table if not exists public.carts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  items jsonb not null default '[]',
  updated_at timestamptz not null default now()
);

alter table public.carts enable row level security;

drop policy if exists "carts_select_own" on public.carts;
drop policy if exists "carts_insert_own" on public.carts;
drop policy if exists "carts_update_own" on public.carts;
drop policy if exists "carts_delete_own" on public.carts;

create policy "carts_select_own"
  on public.carts for select
  using (auth.uid() = user_id);

create policy "carts_insert_own"
  on public.carts for insert
  with check (auth.uid() = user_id);

create policy "carts_update_own"
  on public.carts for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "carts_delete_own"
  on public.carts for delete
  using (auth.uid() = user_id);

-- Orders (server-side checkout table).
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  reference text unique not null,
  email text not null,
  amount_kobo bigint not null,
  items jsonb not null default '[]',
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.orders enable row level security;

drop policy if exists "orders_select" on public.orders;
drop policy if exists "orders_insert" on public.orders;
drop policy if exists "orders_update" on public.orders;
drop policy if exists "orders_select_service" on public.orders;
drop policy if exists "orders_insert_service" on public.orders;
drop policy if exists "orders_update_service" on public.orders;

-- Keep orders writable for server integrations.
-- In production, prefer SUPABASE_SERVICE_KEY and move to stricter policies.
create policy "orders_select"
  on public.orders for select
  using (true);

create policy "orders_insert"
  on public.orders for insert
  with check (true);

create policy "orders_update"
  on public.orders for update
  using (true);
