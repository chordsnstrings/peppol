-- The two halves of a pension contribution, on the payslip that produced them.
--
-- Kept apart because they are different things and are shown differently: the
-- employee's share is withheld from pay and reduces what reaches their bank; the
-- employer's is a cost of employing them and never touches net pay. Adding them
-- into one column would make the net-pay reconciliation impossible to follow and
-- would misstate the WPS file, which carries what the employee is actually paid.

ALTER TABLE "Payslip"
  ADD COLUMN "pensionEmployeeMinor" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "pensionEmployerMinor" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "Payslip"
  ADD CONSTRAINT "Payslip_pension_check"
  CHECK ("pensionEmployeeMinor" >= 0 AND "pensionEmployerMinor" >= 0);

-- Article 51 of Federal Decree-Law 33/2021 gives end-of-service gratuity to the
-- foreign worker. An employee in a pension scheme is provided for by the scheme,
-- so a payslip cannot carry both.
ALTER TABLE "Payslip"
  ADD CONSTRAINT "Payslip_gratuity_or_pension_check"
  CHECK ("gratuityMinor" = 0 OR ("pensionEmployeeMinor" = 0 AND "pensionEmployerMinor" = 0));
