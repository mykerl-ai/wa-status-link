-- Run this in your Supabase project: SQL Editor → New query → paste and run

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  public_id text not null,
  price text not null default 'Contact for Price',
  link text not null,
  preview_url text not null,
  bg_color text default 'white',
  created_at timestamptz default now()
);

-- Optional: enable Row Level Security (RLS) and allow read/write with anon key if needed
-- alter table products enable row level security;
-- create policy "Allow anon read" on products for select using (true);
-- create policy "Allow anon insert" on products for insert with check (true);
