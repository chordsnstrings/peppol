-- Two people cannot be on annual leave in the same days, and neither can one.
--
-- The module refuses an overlapping annual-leave record, but it does it by
-- reading and then writing — so two requests arriving together both read a
-- clear diary and both write into it. A check that races is not a rule; the
-- entitlement it protects is a real amount of money, and the balance that
-- comes out of a double-counted absence is wrong in the employee's favour or
-- the employer's and nobody can tell which afterwards.
--
-- Postgres can hold this directly. An exclusion constraint over the employee
-- and the date range refuses the second writer rather than letting both
-- through, which is the difference between a guarantee and a habit.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Only annual leave: sick leave runs alongside annual leave by design
-- (Federal Decree-Law 33/2021 Article 31 keeps them separate), and unpaid
-- leave can legitimately sit inside a longer absence.
ALTER TABLE "LeaveRecord" ADD CONSTRAINT "LeaveRecord_no_overlap"
  EXCLUDE USING gist (
    "employeeId" WITH =,
    daterange("startsOn", "endsOn", '[]') WITH &&
  ) WHERE ("kind" = 'ANNUAL');
