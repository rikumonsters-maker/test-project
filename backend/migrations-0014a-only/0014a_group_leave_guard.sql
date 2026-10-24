-- Install before migration 0015, while the pre-0015 Worker may still run.
-- Its leave endpoint deletes group_members last in one D1 batch. Rejecting
-- that final delete rolls back its earlier wish, calendar and event deletes.
-- Current and future departures retain the historical member row instead.
CREATE TRIGGER group_members_preserve_history BEFORE DELETE ON group_members
BEGIN
  SELECT RAISE(ABORT, 'group membership must be retained');
END;
