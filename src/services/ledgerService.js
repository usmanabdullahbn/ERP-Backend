const JournalEntry = require('../models/JournalEntry');
const { nextNumber } = require('./numberSequence');

/*
  Central posting function for the entire ERP. Every module (sales, purchases,
  banking) calls this instead of writing to JournalEntry directly, so that the
  fundamental accounting rule — total debits == total credits — is enforced
  in exactly one place.
*/
async function postJournal({ date, sourceType, sourceId, reference, narration, lines, createdBy, session }) {
  const totalDebit = round2(lines.reduce((s, l) => s + (l.debit || 0), 0));
  const totalCredit = round2(lines.reduce((s, l) => s + (l.credit || 0), 0));

  if (totalDebit !== totalCredit) {
    const err = new Error(
      `Journal entry is not balanced. Debits (${totalDebit}) must equal credits (${totalCredit}).`
    );
    err.statusCode = 400;
    throw err;
  }
  if (totalDebit === 0) {
    const err = new Error('Journal entry has zero value.');
    err.statusCode = 400;
    throw err;
  }

  const entryNumber = await nextNumber('journalEntry', 'JE');

  const [entry] = await JournalEntry.create(
    [
      {
        entryNumber,
        date: date || new Date(),
        sourceType,
        sourceId,
        reference,
        narration,
        lines,
        totalDebit,
        totalCredit,
        createdBy
      }
    ],
    session ? { session } : {}
  );

  return entry;
}

/* Creates the mirror-image entry to void/undo a previously posted transaction. */
async function reverseJournal(originalEntryId, { narration, createdBy, session } = {}) {
  const original = await JournalEntry.findById(originalEntryId);
  if (!original) throw new Error('Original journal entry not found.');
  if (original.isReversed) throw new Error('Journal entry has already been reversed.');

  const reversedLines = original.lines.map((l) => ({
    account: l.account,
    debit: l.credit,
    credit: l.debit,
    memo: l.memo
  }));

  const entry = await postJournal({
    date: new Date(),
    sourceType: original.sourceType,
    sourceId: original.sourceId,
    reference: original.reference,
    narration: narration || `Reversal of ${original.entryNumber}`,
    lines: reversedLines,
    createdBy,
    session
  });

  entry.reversalOf = original._id;
  await entry.save({ session });

  original.isReversed = true;
  await original.save({ session });

  return entry;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

module.exports = { postJournal, reverseJournal, round2 };
