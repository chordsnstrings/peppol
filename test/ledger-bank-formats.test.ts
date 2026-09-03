import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { importStatement } from "@/lib/server/ledger/bank";
import {
  parseStatement, detectFormat, detectDateOrder, parseMinor, sniffCsv, BankFormatError,
} from "@/lib/server/ledger/bank-formats";

/* -------------------------------------------------------------- fixtures --- */

/** Emirates NBD-shaped MT940: an inward TT, a fee, a payment run, and a return. */
const MT940 = [
  "{1:F01EBILAEADAXXX0000000000}{2:O9401200260630EBILAEADAXXX00000000002606301200N}{4:",
  ":20:STMT260630",
  ":25:AE070331234567890123456",
  ":28C:00042/00001",
  ":60F:C260531AED1250000,00",
  ":61:2606010601C25000,00NTRFINV2026118//FT26152A1B2C",
  ":86:INWARD TT ACME TRADING LLC INVOICE 2026-118",
  ":61:2606030603D500,00NCHGNONREF//BKCHG0603",
  ":86:MONTHLY ACCOUNT MAINTENANCE FEE",
  ":61:2606100610D120000,00NTRFPAYRUN06//FT26161X9Y8Z",
  ":86:OUTWARD TT SUPPLIER PAYMENT RUN JUNE",
  ":61:2606150615RC25000,00NRTIINV2026118//RT26166Q1W2E",
  ":86:RETURN OF INWARD TT ACME TRADING LLC BENEFICIARY DETAILS INCORRECT",
  ":62F:C260630AED1129500,00",
  "-}",
].join("\n");

/** ISO 20022 camt.053: two entries and a reversal of the first. */
const CAMT053 = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>CAMT-2026-06-30</MsgId><CreDtTm>2026-07-01T02:14:07</CreDtTm></GrpHdr>
    <Stmt>
      <Id>AE070331234567890123456-2026-06</Id>
      <LglSeqNb>42</LglSeqNb>
      <Acct><Id><IBAN>AE070331234567890123456</IBAN></Id><Ccy>AED</Ccy></Acct>
      <Bal>
        <Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="AED">5000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-06-01</Dt></Dt>
      </Bal>
      <Bal>
        <Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="AED">4749.25</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-06-30</Dt></Dt>
      </Bal>
      <Ntry>
        <NtryRef>NT0001</NtryRef>
        <Amt Ccy="AED">1500.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts>
        <BookgDt><Dt>2026-06-04</Dt></BookgDt><ValDt><Dt>2026-06-04</Dt></ValDt>
        <AcctSvcrRef>FT26155ZZ01</AcctSvcrRef>
        <BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>RCDT</Cd><SubFmlyCd>ESCT</SubFmlyCd></Fmly></Domn></BkTxCd>
        <NtryDtls><TxDtls>
          <Refs><EndToEndId>E2E-INV-2026-121</EndToEndId></Refs>
          <RmtInf><Ustrd>ACME TRADING LLC</Ustrd><Ustrd>INVOICE 2026-121</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <NtryRef>NT0002</NtryRef>
        <Amt Ccy="AED">250.75</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts>
        <BookgDt><Dt>2026-06-11</Dt></BookgDt><ValDt><Dt>2026-06-11</Dt></ValDt>
        <AcctSvcrRef>DD26162AA9</AcctSvcrRef>
        <NtryDtls><TxDtls><RmtInf><Ustrd>DEWA UTILITIES JUNE</Ustrd></RmtInf></TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <NtryRef>NT0003</NtryRef>
        <Amt Ccy="AED">1500.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts>
        <RvslInd>true</RvslInd>
        <BookgDt><Dt>2026-06-18</Dt></BookgDt><ValDt><Dt>2026-06-18</Dt></ValDt>
        <AcctSvcrRef>RT26169BB4</AcctSvcrRef>
        <AddtlNtryInf>RETURN OF INWARD TRANSFER FT26155ZZ01 &amp; CHARGES WAIVED</AddtlNtryInf>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

/** OFX 1.02 SGML, unclosed value tags exactly as a bank emits them. */
const OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII

<OFX>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1001
<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS>
<CURDEF>AED
<BANKACCTFROM><BANKID>033<ACCTID>1234567890123456<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260601<DTEND>20260630
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260601120000.000[+4:GST]
<TRNAMT>2500.00
<FITID>202606010001
<NAME>ACME TRADING LLC
<MEMO>INWARD TT INVOICE 2026-118
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260603
<TRNAMT>-500.00
<FITID>202606030007
<NAME>EMIRATES NBD
<MEMO>MONTHLY ACCOUNT MAINTENANCE FEE
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260610
<TRNAMT>-1200.00
<FITID>202606100019
<NAME>DU TELECOM
<MEMO>BILL PAYMENT JUNE
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>12345.00<DTASOF>20260630</LEDGERBAL>
<AVAILBAL><BALAMT>11000.00<DTASOF>20260630</AVAILBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

/** Dialect one: plain comma CSV with a signed amount and a balance. */
const CSV_COMMA = [
  "Date,Description,Reference,Amount,Balance",
  "01/06/2026,Inward TT ACME TRADING LLC,FT26152A1B2C,2500.00,12500.00",
  "03/06/2026,Monthly account maintenance fee,BKCHG0603,-500.00,12000.00",
  "15/06/2026,Outward TT supplier payment run,FT26161X9Y8Z,-1200.00,10800.00",
  "22/06/2026,Cheque deposit clearing,CHQ 004411,1200.00,12000.00",
].join("\n");

/** Dialect two: semicolon, a portal preamble, separate debit and credit. */
const CSV_SEMI = [
  "Account Number;AE070331234567890123456",
  "Statement Period;2026-06-01;2026-06-30",
  "",
  "Value Date;Narration;Debit;Credit;Running Balance",
  "2026-06-01;INWARD TT ACME TRADING LLC;;2.500,00;12.500,00",
  "2026-06-03;MONTHLY ACCOUNT MAINTENANCE FEE;500,00;;12.000,00",
  "2026-06-15;OUTWARD TT SUPPLIER PAYMENT RUN;1.200,00;;10.800,00",
].join("\n");

/** Dialect three: tab separated, withdrawal/deposit pair, cheque column. */
const CSV_TAB = [
  "Transaction Date\tValue Date\tParticulars\tCheque No\tWithdrawal\tDeposit\tBalance",
  "01/06/2026\t01/06/2026\tINWARD TT ACME TRADING LLC\t\t\t2,500.00\t12,500.00",
  "03/06/2026\t03/06/2026\tMONTHLY ACCOUNT MAINTENANCE FEE\t\t500.00\t\t12,000.00",
  "15/06/2026\t16/06/2026\tCHEQUE PAID\t004411\t1,200.00\t\t10,800.00",
].join("\n");

/* -------------------------------------------------------------- the unit --- */

describe("bank statement formats", () => {
  it("reads amounts digit by digit, never through a float", () => {
    // 0.1 + 0.2 territory: these are the values a double gets wrong.
    expect(parseMinor("1234.56")).toBe(123456n);
    expect(parseMinor("0.07")).toBe(7n);
    expect(parseMinor("70.07")).toBe(7007n);
    expect(parseMinor("8.1655")).toBe(null); // four decimals: the separator was misread
    expect(parseMinor("8.165")).toBe(816500n); // one separator, three digits: it groups
    expect(parseMinor("1234.567")).toBe(null); // grouping that does not group is refused
    // Where the format itself guarantees the separator, three digits are three
    // decimals, and a careless trailing zero is forgiven while a real one is not.
    expect(parseMinor("100.000", 2, { decimal: "." })).toBe(10000n);
    expect(parseMinor("100.005", 2, { decimal: "." })).toBe(null);
    expect(parseMinor("25000,00", 2, { decimal: ",", grouped: false })).toBe(2500000n);
    expect(parseMinor("25.000,00", 2, { decimal: ",", grouped: false })).toBe(null);
    expect(parseMinor("1,234.56")).toBe(123456n);
    expect(parseMinor("1.234,56")).toBe(123456n);
    expect(parseMinor("1,500")).toBe(150000n);   // grouped: one thousand five hundred
    expect(parseMinor("1,500", 3)).toBe(1500n);  // a three-decimal currency settles it
    expect(parseMinor("(2,000.00)")).toBe(-200000n);
    expect(parseMinor("500.00-")).toBe(-50000n);
    expect(parseMinor("1,23,456.00")).toBe(null); // lakh grouping: refused, not misread
    expect(parseMinor("12.34.56")).toBe(null);
    expect(parseMinor("abc")).toBe(null);
    expect(parseMinor("9007199254740993.99")).toBe(900719925474099399n); // past 2^53
  });

  it("sniffs each format and says what it saw", () => {
    expect(detectFormat(MT940)).toMatchObject({ format: "MT940" });
    expect(detectFormat(MT940).saw).toContain(":61:");
    expect(detectFormat(CAMT053)).toMatchObject({ format: "CAMT053" });
    expect(detectFormat(CAMT053).saw).toContain("<BkToCstmrStmt>");
    expect(detectFormat(OFX)).toMatchObject({ format: "OFX" });
    expect(detectFormat(OFX).saw).toContain("<STMTTRN>");
    expect(detectFormat(CSV_COMMA)).toMatchObject({ format: "CSV" });
    expect(detectFormat(CSV_COMMA).confidence).toBeGreaterThan(50);
    expect(detectFormat("hello, this is not a bank statement")).toMatchObject({ format: null, confidence: 0 });
  });

  it("parses MT940, taking the direction from the D/C mark and the comma as a decimal", () => {
    const s = parseStatement({ text: MT940 });
    expect(s.format).toBe("MT940");
    expect(s.account).toBe("AE070331234567890123456");
    expect(s.statementNumber).toBe("00042/00001");
    expect(s.reference).toBe("STMT260630");
    expect(s.currency).toBe("AED");
    expect(s.openingMinor).toBe("125000000");
    expect(s.closingMinor).toBe("112950000");
    expect(s.lines).toHaveLength(4);

    // "25000,00" is twenty-five thousand dirhams, not twenty-five.
    expect(s.lines[0]).toMatchObject({
      postedOn: "2026-06-01",
      amountMinor: "2500000",
      reference: "INV2026118",
      kind: "NTRF",
    });
    expect(s.lines[0].description).toBe("INWARD TT ACME TRADING LLC INVOICE 2026-118");
    // The mark carries the sign; the amount in the file is a magnitude.
    expect(s.lines[1].amountMinor).toBe("-50000");
    expect(s.lines[1].reference).toBe("BKCHG0603"); // NONREF is not a reference
    expect(s.lines[2].amountMinor).toBe("-12000000");
  });

  it("reads an MT940 RC mark as the reversal of a credit and says so", () => {
    const s = parseStatement({ text: MT940 });
    const reversal = s.lines[3];
    expect(reversal.reversal).toBe(true);
    expect(reversal.amountMinor).toBe("-2500000"); // reversing a credit takes money back out
    expect(s.warnings.join(" ")).toMatch(/marked RC — a reversal of an earlier credit/);
  });

  it("proves an MT940 foots to its own closing balance", () => {
    const p = parseStatement({ text: MT940 }).proof;
    expect(p.provable).toBe(true);
    expect(p.foots).toBe(true);
    expect(p.sumMinor).toBe("-12050000");
    expect(p.expectedClosingMinor).toBe("112950000");
    expect(p.differenceMinor).toBe("0");
    expect(p.lineCount).toBe(4);
  });

  it("catches a line lifted out of an MT940", () => {
    const truncated = MT940.split("\n").filter((l) => !l.includes("PAYRUN06") && !l.includes("SUPPLIER PAYMENT RUN")).join("\n");
    const s = parseStatement({ text: truncated });
    expect(s.lines).toHaveLength(3);
    expect(s.proof.foots).toBe(false);
    // The gap is exactly the missing line, and it is stated rather than hinted at.
    expect(s.proof.differenceMinor).toBe("12000000");
    expect(s.warnings.join(" ")).toMatch(/do not reach the file's own closing balance/);
  });

  it("refuses an MT940 whose closing balance never arrived, naming what is missing", () => {
    const cut = MT940.split("\n").filter((l) => !l.startsWith(":62F:")).join("\n");
    expect(() => parseStatement({ text: cut })).toThrow(/:62F:/);
    try {
      parseStatement({ text: cut });
    } catch (e) {
      expect(e).toBeInstanceOf(BankFormatError);
      expect((e as BankFormatError).detail.missing).toEqual([":62F:"]);
      expect((e as BankFormatError).message).toMatch(/cut short|cannot be proved complete/);
    }
  });

  it("parses CAMT.053 including remittance information and the reversal", () => {
    const s = parseStatement({ text: CAMT053 });
    expect(s.format).toBe("CAMT053");
    expect(s.account).toBe("AE070331234567890123456");
    expect(s.statementNumber).toBe("42");
    expect(s.currency).toBe("AED");
    expect(s.openingMinor).toBe("500000");
    expect(s.closingMinor).toBe("474925");
    expect(s.lines).toHaveLength(3);

    expect(s.lines[0]).toMatchObject({
      postedOn: "2026-06-04",
      amountMinor: "150000",
      reference: "FT26155ZZ01",
      kind: "PMNT/RCDT/ESCT",
    });
    expect(s.lines[0].description).toBe("ACME TRADING LLC INVOICE 2026-121");
    expect(s.lines[1].amountMinor).toBe("-25075"); // DBIT, and 250.75 is not 250.7
    expect(s.lines[1].description).toBe("DEWA UTILITIES JUNE");

    const rev = s.lines[2];
    expect(rev.reversal).toBe(true);
    expect(rev.amountMinor).toBe("-150000"); // a reversed CRDT is money going back
    expect(rev.description).toContain("&"); // the entity was decoded, not left raw
    expect(s.warnings.join(" ")).toMatch(/RvslInd/);

    expect(s.proof.foots).toBe(true);
    expect(s.proof.differenceMinor).toBe("0");
  });

  it("refuses a CAMT.053 truncated mid-entry rather than pairing amounts with the wrong entry", () => {
    const cut = CAMT053.slice(0, CAMT053.indexOf("<AcctSvcrRef>DD26162AA9"));
    expect(() => parseStatement({ text: cut, format: "CAMT053" })).toThrow(/truncated/i);
    try {
      parseStatement({ text: cut, format: "CAMT053" });
    } catch (e) {
      expect((e as BankFormatError).detail.missing).toContain("</Ntry>");
    }
  });

  it("refuses a CAMT.053 with no closing balance, and one with a document type declaration", () => {
    const noClose = CAMT053.replace(/<Bal>[\s\S]*?CLBD[\s\S]*?<\/Bal>/, "");
    expect(() => parseStatement({ text: noClose, format: "CAMT053" })).toThrow(/CLBD/);

    const doctyped = CAMT053.replace("<Document", "<!DOCTYPE Document SYSTEM \"http://example.invalid/x.dtd\">\n<Document");
    expect(() => parseStatement({ text: doctyped, format: "CAMT053" })).toThrow(/declaration/i);
  });

  it("refuses XML that references an entity it does not define", () => {
    const injected = CAMT053.replace("DEWA UTILITIES JUNE", "DEWA &xxe; JUNE");
    expect(() => parseStatement({ text: injected, format: "CAMT053" })).toThrow(/entity/i);
  });

  it("parses OFX, keeping the sign the file already carries", () => {
    const s = parseStatement({ text: OFX });
    expect(s.format).toBe("OFX");
    expect(s.account).toBe("1234567890123456");
    expect(s.currency).toBe("AED");
    expect(s.lines).toHaveLength(3);
    expect(s.lines[0]).toMatchObject({ postedOn: "2026-06-01", amountMinor: "250000", reference: "202606010001", kind: "CREDIT" });
    expect(s.lines[0].description).toBe("ACME TRADING LLC — INWARD TT INVOICE 2026-118");
    expect(s.lines[1].amountMinor).toBe("-50000");
    expect(s.lines[2].amountMinor).toBe("-120000");
    // LEDGERBAL, not the AVAILBAL that follows it.
    expect(s.closingMinor).toBe("1234500");
    // OFX never declares an opening balance, so nothing here is a proof.
    expect(s.proof.provable).toBe(false);
    expect(s.proof.note).toMatch(/only a closing balance/);
    expect(s.openingMinor).toBeNull();
  });

  it("refuses an OFX cut off part way through a transaction", () => {
    const cut = OFX.slice(0, OFX.indexOf("<FITID>202606030007"));
    expect(() => parseStatement({ text: cut, format: "OFX" })).toThrow(/<\/STMTTRN>/);
  });

  it("reads a comma CSV, settling the date order from the data", () => {
    const s = parseStatement({ text: CSV_COMMA });
    expect(s.format).toBe("CSV");
    expect(s.dateOrder).toBe("DMY"); // "15/06/2026" has a day above 12
    expect(s.lines).toHaveLength(4);
    expect(s.lines[0]).toMatchObject({ postedOn: "2026-06-01", amountMinor: "250000", balanceMinor: "1250000", reference: "FT26152A1B2C" });
    expect(s.lines[2].amountMinor).toBe("-120000");
    expect(s.openingMinor).toBe("1000000"); // 12,500.00 less the 2,500.00 that made it
    expect(s.closingMinor).toBe("1200000");
    expect(s.proof.foots).toBe(true);
  });

  it("reads a semicolon CSV with a portal preamble, European decimals and a debit/credit pair", () => {
    const m = sniffCsv(CSV_SEMI);
    expect(m.delimiterName).toBe("semicolon");
    expect(m.headerRow).toBe(3);
    expect(m.columns).toMatchObject({ valueDate: 0, description: 1, debit: 2, credit: 3, balance: 4 });

    const s = parseStatement({ text: CSV_SEMI });
    expect(s.account).toBe("AE070331234567890123456"); // lifted from the preamble
    expect(s.lines).toHaveLength(3);
    expect(s.lines[0].amountMinor).toBe("250000");   // "2.500,00" is two and a half thousand
    expect(s.lines[1].amountMinor).toBe("-50000");   // the debit column is money out
    expect(s.lines[2].amountMinor).toBe("-120000");
    expect(s.proof.foots).toBe(true);
    expect(s.warnings.join(" ")).toMatch(/no posting date column/);
  });

  it("reads a tab CSV with withdrawal and deposit columns and a separate value date", () => {
    const s = parseStatement({ text: CSV_TAB });
    expect(s.lines).toHaveLength(3);
    expect(s.lines[0].amountMinor).toBe("250000");
    expect(s.lines[1].amountMinor).toBe("-50000");
    expect(s.lines[2]).toMatchObject({ postedOn: "2026-06-15", reference: "004411", amountMinor: "-120000" });
    expect(s.proof.foots).toBe(true);
    expect(s.proof.lineCount).toBe(3);
  });

  it("catches a row lifted out of the middle of a CSV", () => {
    const short = CSV_COMMA.split("\n").filter((l) => !l.includes("Monthly account maintenance fee")).join("\n");
    const s = parseStatement({ text: short });
    expect(s.lines).toHaveLength(3);
    expect(s.proof.foots).toBe(false);
    // The lines account for 500.00 more than the bank's own closing balance,
    // which is exactly the debit that went missing.
    expect(s.proof.differenceMinor).toBe("50000");
    expect(s.warnings.join(" ")).toMatch(/does not follow on from the balance above it/);
  });

  it("refuses a date order the file cannot settle, and accepts one it can", () => {
    const ambiguous = [
      "Date,Description,Amount,Balance",
      "03/04/2026,Card payment,-100.00,900.00",
      "05/04/2026,Card payment,-100.00,800.00",
      "07/04/2026,Card payment,-100.00,700.00",
    ].join("\n");
    expect(() => parseStatement({ text: ambiguous })).toThrow(/day-first or month-first/);
    expect(detectDateOrder(["03/04/2026", "05/04/2026"]).order).toBeNull();
    expect(detectDateOrder(["03/04/2026", "05/04/2026"]).candidates).toEqual(["DMY", "MDY"]);

    // Told which way round it is, the same file parses.
    const told = parseStatement({ text: ambiguous, dateOrder: "MDY" });
    expect(told.lines[0].postedOn).toBe("2026-03-04");
    expect(parseStatement({ text: ambiguous, dateOrder: "DMY" }).lines[0].postedOn).toBe("2026-04-03");

    // And one day above the twelfth settles it without being asked.
    expect(detectDateOrder(["03/04/2026", "25/04/2026"])).toMatchObject({ order: "DMY" });
    expect(detectDateOrder(["04/03/2026", "04/25/2026"])).toMatchObject({ order: "MDY" });
    expect(detectDateOrder(["2026-04-03"])).toMatchObject({ order: "YMD" });
    expect(detectDateOrder(["25/04/2026", "04/25/2026"]).order).toBeNull(); // contradiction
  });

  it("returns the detected mapping for confirmation instead of guessing an ambiguous column", () => {
    const twoAmounts = [
      "Date,Narration,Amount,Amount,Balance",
      "01/06/2026,Inward TT,2500.00,2500.00,12500.00",
      "15/06/2026,Outward TT,-500.00,-500.00,12000.00",
    ].join("\n");
    let thrown: BankFormatError | null = null;
    try { parseStatement({ text: twoAmounts }); } catch (e) { thrown = e as BankFormatError; }
    expect(thrown).toBeInstanceOf(BankFormatError);
    expect(thrown?.message).toMatch(/More than one column could be the amount/);
    expect(thrown?.detail.mapping?.ambiguous[0].candidates).toHaveLength(2);
    expect(thrown?.detail.mapping?.columns).toMatchObject({ date: 0, description: 1, balance: 4 });

    // Confirmed by hand, it parses.
    const s = parseStatement({ text: twoAmounts, columns: { date: 0, description: 1, amount: 2, balance: 4 } });
    expect(s.lines).toHaveLength(2);
    expect(s.lines[0].amountMinor).toBe("250000");
  });

  it("refuses a CSV whose header names no amount at all", () => {
    const noAmount = "Date,Description,Balance\n01/06/2026,Something,100.00";
    expect(() => parseStatement({ text: noAmount })).toThrow(/amount/);
  });

  it("fingerprints a line the same way twice and differently when the narrative changes", () => {
    const a = parseStatement({ text: MT940 });
    const b = parseStatement({ text: MT940 });
    expect(a.lines.map((l) => l.fingerprint)).toEqual(b.lines.map((l) => l.fingerprint));
    expect(new Set(a.lines.map((l) => l.fingerprint)).size).toBe(4);

    const edited = MT940.replace("MONTHLY ACCOUNT MAINTENANCE FEE", "QUARTERLY ACCOUNT MAINTENANCE FEE");
    const c = parseStatement({ text: edited });
    expect(c.lines[1].fingerprint).not.toBe(a.lines[1].fingerprint);
    expect(c.lines[0].fingerprint).toBe(a.lines[0].fingerprint); // the untouched line is unmoved

    // Spacing and case are not identity — the same line pasted twice is the same line.
    const spaced = MT940.replace(":86:INWARD TT ACME", ":86:inward   tt   acme");
    expect(parseStatement({ text: spaced }).lines[0].fingerprint).toBe(a.lines[0].fingerprint);
  });

  it("warns when two lines cannot be told apart, because only one of them can be imported", () => {
    const twins = [
      ":20:STMT260630",
      ":25:AE070331234567890123456",
      ":60F:C260531AED100000,00",
      ":61:2606010601D5000,00NMSCNONREF",
      ":86:CAFE PURCHASE",
      ":61:2606010601D5000,00NMSCNONREF",
      ":86:CAFE PURCHASE",
      ":62F:C260630AED90000,00",
    ].join("\n");
    const s = parseStatement({ text: twins });
    expect(s.lines[0].fingerprint).toBe(s.lines[1].fingerprint);
    expect(s.warnings.join(" ")).toMatch(/identical in every field the file supplied/);
    expect(s.proof.foots).toBe(true); // the file itself is sound; the identity is not
  });

  it("refuses an empty paste and something that is not a statement at all", () => {
    expect(() => parseStatement({ text: "   " })).toThrow(/nothing to read/i);
    expect(() => parseStatement({ text: "The quick brown fox\njumped over it" })).toThrow(/does not look like/i);
  });

  it("reads OFX 2.x, where every tag closes, the same way as the SGML it came from", () => {
    const xmlish = `<?xml version="1.0"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>AED</CURDEF>
<BANKACCTFROM><ACCTID>1234567890123456</ACCTID></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260603</DTPOSTED><TRNAMT>-500.00</TRNAMT>
<FITID>202606030007</FITID><NAME>EMIRATES NBD</NAME><MEMO>MONTHLY ACCOUNT MAINTENANCE FEE</MEMO></STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>12345.00</BALAMT><DTASOF>20260630</DTASOF></LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const s = parseStatement({ text: xmlish });
    expect(s.format).toBe("OFX");
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).toMatchObject({ postedOn: "2026-06-03", amountMinor: "-50000", reference: "202606030007" });
    expect(s.lines[0].description).toBe("EMIRATES NBD — MONTHLY ACCOUNT MAINTENANCE FEE");
    expect(s.closingMinor).toBe("1234500");
  });

  it("leaves an unbooked CAMT entry out, because it is not in the closing balance either", () => {
    const pending = CAMT053.replace(
      "</Stmt>",
      `<Ntry><Amt Ccy="AED">99.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>PDNG</Sts>
       <BookgDt><Dt>2026-06-29</Dt></BookgDt>
       <NtryDtls><TxDtls><RmtInf><Ustrd>CARD AUTHORISATION HELD</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry></Stmt>`,
    );
    const s = parseStatement({ text: pending });
    expect(s.lines).toHaveLength(3);
    expect(s.warnings.join(" ")).toMatch(/status PDNG is not booked yet/);
    expect(s.proof.foots).toBe(true); // and the footing still holds because of it
  });

  it("says a CSV without a balance column cannot be proved, rather than passing it", () => {
    const noBalance = [
      "Transaction Date,Narration,Amount",
      "01/06/2026,Inward TT ACME TRADING LLC,2500.00",
      "15/06/2026,Outward TT supplier payment,-1200.00",
    ].join("\n");
    const s = parseStatement({ text: noBalance });
    expect(s.lines).toHaveLength(2);
    expect(s.proof.provable).toBe(false);
    expect(s.proof.foots).toBe(false); // unproven, not proven wrong
    expect(s.proof.sumMinor).toBe("130000");
    expect(s.proof.note).toMatch(/no running balance column/);
    expect(s.openingMinor).toBeNull();
    expect(s.closingMinor).toBeNull();
  });

  it("brings every format to the same shape", () => {
    const all = [MT940, CAMT053, OFX, CSV_COMMA, CSV_SEMI, CSV_TAB].map((t) => parseStatement({ text: t }));
    for (const s of all) {
      expect(typeof s.format).toBe("string");
      expect(Array.isArray(s.lines)).toBe(true);
      expect(s.lines.length).toBeGreaterThan(0);
      for (const l of s.lines) {
        expect(l.postedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(l.amountMinor).toMatch(/^-?\d+$/);
        expect(BigInt(l.amountMinor)).not.toBe(0n); // importStatement refuses a zero line
        expect(typeof l.description).toBe("string");
        expect(l.description.length).toBeGreaterThan(0);
        expect(l.fingerprint).toMatch(/^[0-9a-f]{32}$/);
      }
      expect(typeof s.proof.sumMinor).toBe("string");
      expect(s.proof.lineCount).toBe(s.lines.length);
    }
  });
});

/* --------------------------------------------------- and into the ledger --- */

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-bf";
const ENT = "t-ent-bf";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "BankStatementLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLineDimension" WHERE "lineId" IN (SELECT id FROM "JournalLine" WHERE "orgId" = '${ORG}')`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountBalance" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Account" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountingPeriod" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "DocumentSequence" WHERE "orgId" = '${ORG}'`),
  ]);
}

d("parsed statements reaching the importer", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("lands MT940 lines as BankStatementLine rows exactly as a hand import does", async () => {
    const parsed = parseStatement({ text: MT940 });
    const r = await importStatement({
      orgId: ORG, entityId: ENT, accountCode: "1010", lines: parsed.lines, batch: "mt940-june",
    });
    expect(r).toMatchObject({ imported: 4, duplicates: 0, total: 4 });

    const rows = await db.bankStatementLine.findMany({
      where: { orgId: ORG, importBatch: "mt940-june" },
      orderBy: { postedOn: "asc" },
    });
    expect(rows).toHaveLength(4);
    expect(rows[0].postedOn.toISOString().slice(0, 10)).toBe("2026-06-01");
    expect(rows[0].amountMinor).toBe(2_500_000n);
    expect(rows[0].reference).toBe("INV2026118");
    expect(rows[0].description).toBe("INWARD TT ACME TRADING LLC INVOICE 2026-118");
    expect(rows[0].currency).toBe("AED");
    expect(rows[0].status).toBe("unmatched");
    expect(rows[3].amountMinor).toBe(-2_500_000n); // the RC reversal

    // The fingerprint the preview showed is the one the row carries; that is the
    // whole point of computing it with the importer's own function.
    expect(rows.map((x) => x.fingerprint).sort()).toEqual(parsed.lines.map((l) => l.fingerprint).sort());

    // The ledger agrees with the file's closing balance, arrived at independently.
    const sum = rows.reduce((a, x) => a + x.amountMinor, 0n);
    expect((BigInt(parsed.openingMinor as string) + sum).toString()).toBe(parsed.closingMinor);
  });

  it("re-importing the same file in another format adds nothing new for the lines it shares", async () => {
    const first = await importStatement({
      orgId: ORG, entityId: ENT, accountCode: "1010",
      lines: parseStatement({ text: CSV_COMMA }).lines, batch: "csv-june",
    });
    expect(first.imported).toBe(4);
    const again = await importStatement({
      orgId: ORG, entityId: ENT, accountCode: "1010",
      lines: parseStatement({ text: CSV_COMMA }).lines, batch: "csv-june-again",
    });
    expect(again).toMatchObject({ imported: 0, duplicates: 4, total: 4 });
  });

  it("carries the running balance through so identical same-day lines stay apart", async () => {
    const s = parseStatement({ text: CSV_TAB });
    await importStatement({ orgId: ORG, entityId: ENT, accountCode: "1010", lines: s.lines, batch: "tab-june" });
    const rows = await db.bankStatementLine.findMany({ where: { orgId: ORG, importBatch: "tab-june" }, orderBy: { postedOn: "asc" } });
    expect(rows.map((r) => r.balanceMinor?.toString())).toEqual(["1250000", "1200000", "1080000"]);
  });
});
