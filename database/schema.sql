CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.family_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_user_id TEXT UNIQUE NOT NULL,
  discord_username TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_family_members_discord_user_id
  ON public.family_members (discord_user_id);

CREATE TABLE IF NOT EXISTS public.stream_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('youtube', 'tiktok')),
  username TEXT NOT NULL,
  profile_url TEXT NOT NULL,
  platform_user_id TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_live BOOLEAN NOT NULL DEFAULT false,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stream_accounts_member_id
  ON public.stream_accounts (member_id);

CREATE INDEX IF NOT EXISTS idx_stream_accounts_active_platform
  ON public.stream_accounts (is_active, platform);

CREATE UNIQUE INDEX IF NOT EXISTS uq_stream_accounts_platform_user_id
  ON public.stream_accounts (platform, platform_user_id)
  WHERE platform_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_stream_accounts_platform_username
  ON public.stream_accounts (platform, lower(username));

CREATE TABLE IF NOT EXISTS public.live_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.stream_accounts(id) ON DELETE CASCADE,
  stream_id TEXT NOT NULL,
  title TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_live_sessions_account_id
  ON public.live_sessions (account_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_live_sessions_account_stream
  ON public.live_sessions (account_id, stream_id);

CREATE TABLE IF NOT EXISTS public.notification_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.stream_accounts(id) ON DELETE CASCADE,
  stream_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_logs_account_id
  ON public.notification_logs (account_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_logs_account_stream_channel
  ON public.notification_logs (account_id, stream_id, channel_id);

ALTER TABLE public.family_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stream_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_logs ENABLE ROW LEVEL SECURITY;
