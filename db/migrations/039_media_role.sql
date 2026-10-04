-- Media / Photographer role: read-only access to results + winners poster only.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'Media';
