-- Event Staff role: event-day desk only — check participants, mark present/
-- absent, assign chest numbers, and view (not edit) the schedule. Nothing else.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'EventStaff';
