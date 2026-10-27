-- ============================================================
-- PSM InternHub - Production Supabase PostgreSQL Schema
-- Run this in the Supabase Dashboard -> SQL Editor
-- ============================================================

-- 1. Create table with validations and constraints
CREATE TABLE IF NOT EXISTS public.interns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  college TEXT NOT NULL,
  domain TEXT NOT NULL,
  role TEXT NOT NULL,
  days INTEGER NOT NULL DEFAULT 0 CHECK (days >= 0),
  total INTEGER NOT NULL DEFAULT 90 CHECK (total >= 1 AND days <= total),
  score NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 100),
  grade TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'COMPLETED')),
  "mentorName" TEXT DEFAULT '',
  "mentorId" TEXT DEFAULT '',
  "mentorReview" TEXT DEFAULT '',
  evaluation TEXT DEFAULT '',
  project TEXT DEFAULT '',
  description TEXT DEFAULT '',
  github TEXT DEFAULT '',
  photo TEXT DEFAULT '',
  "qrImage" TEXT DEFAULT '',
  skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  marks JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Performance indexes
CREATE INDEX IF NOT EXISTS idx_interns_status ON public.interns (status);
CREATE INDEX IF NOT EXISTS idx_interns_domain ON public.interns (domain);
CREATE INDEX IF NOT EXISTS idx_interns_score ON public.interns (score DESC);
CREATE INDEX IF NOT EXISTS idx_interns_created ON public.interns (created_at DESC);

-- 3. Automatic updated_at trigger function
CREATE OR REPLACE FUNCTION public.set_current_timestamp_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_interns_updated_at ON public.interns;
CREATE TRIGGER trg_interns_updated_at
BEFORE UPDATE ON public.interns
FOR EACH ROW
EXECUTE FUNCTION public.set_current_timestamp_updated_at();

-- 4. Row Level Security (RLS) Configuration
-- Enable RLS and grant read/write access for application operations
ALTER TABLE public.interns ENABLE ROW LEVEL SECURITY;

-- Allow public / anon read access for profile verification
DROP POLICY IF EXISTS "Allow public read access to interns" ON public.interns;
CREATE POLICY "Allow public read access to interns"
  ON public.interns
  FOR SELECT
  TO public
  USING (true);

-- Allow backend operations (insert, update, delete, upsert) using configured credentials
DROP POLICY IF EXISTS "Allow authenticated and service role full access" ON public.interns;
CREATE POLICY "Allow authenticated and service role full access"
  ON public.interns
  FOR ALL
  TO anon, authenticated, service_role
  USING (true)
  WITH CHECK (true);
