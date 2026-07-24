const test = require('node:test');
const assert = require('node:assert/strict');

process.env.RESET_HOUR = '5';

const { cleanEnabled, cleanExtraReminders, cleanLastReminded, operationalDayKey, operationalMinute } = require('./server');
const routines = [{ id: 'morning' }, { id: 'before-bed' }, { id: 'as-needed' }];

test('routine day changes at 5 AM rather than midnight', () => {
  assert.equal(operationalDayKey({ year: 2026, month: 7, day: 24, hour: 1, minute: 0 }), '2026-07-23');
  assert.equal(operationalDayKey({ year: 2026, month: 7, day: 24, hour: 4, minute: 59 }), '2026-07-23');
  assert.equal(operationalDayKey({ year: 2026, month: 7, day: 24, hour: 5, minute: 0 }), '2026-07-24');
});

test('reminder times follow the 5 AM routine day', () => {
  assert.equal(operationalMinute(5, 0), 0);
  assert.equal(operationalMinute(20, 0), 900);
  assert.equal(operationalMinute(1, 0), 1200);
  assert.ok(operationalMinute(1, 0) > operationalMinute(20, 0));
});

test('routine reminder flags remain independent', () => {
  assert.deepEqual(cleanEnabled(false, routines), { morning: false, 'before-bed': false, 'as-needed': false });
  assert.deepEqual(cleanEnabled(true, routines), { morning: true, 'before-bed': true, 'as-needed': true });
  assert.deepEqual(cleanEnabled({ morning: false, 'before-bed': true, 'as-needed': false }, routines), {
    morning: false,
    'before-bed': true,
    'as-needed': false,
  });
});

test('extra reminders toggle only accepts an explicit boolean', () => {
  assert.equal(cleanExtraReminders(true), true);
  assert.equal(cleanExtraReminders(false), false);
  assert.equal(cleanExtraReminders(undefined), false);
  assert.equal(cleanExtraReminders('true'), false);
  assert.equal(cleanExtraReminders(1), false);
});

test('last-reminded values are limited to the category routines', () => {
  assert.deepEqual(cleanLastReminded({ morning: '2026-07-23' }, routines), {
    morning: { day: '2026-07-23', at: null, firstAt: null },
  });
  assert.deepEqual(cleanLastReminded({
    morning: { day: '2026-07-23', at: '2026-07-23T14:00:00.000Z', firstAt: '2026-07-23T14:00:00.000Z' },
  }, routines), {
    morning: { day: '2026-07-23', at: '2026-07-23T14:00:00.000Z', firstAt: '2026-07-23T14:00:00.000Z' },
  });
  assert.deepEqual(cleanLastReminded({ morning: null, 'before-bed': {}, 'as-needed': 'x', unknown: 'y' }, routines), {
    'as-needed': { day: 'x', at: null, firstAt: null },
  });
  assert.deepEqual(cleanLastReminded(undefined, routines), {});
});
