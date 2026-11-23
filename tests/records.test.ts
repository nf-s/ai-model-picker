import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { z } from 'zod';
import { peopleSchema, recordSchema } from '../src/lib/records.ts';
import recordFixtures from './fixtures/records.json' with { type: 'json' };
import peopleFixtures from './fixtures/people.json' with { type: 'json' };

const object = z.record(z.string(), z.unknown());
const fixtureSchema = z.object({
  valid: z.array(object),
  invalid: z.array(
    z.object({
      why: z.string(),
      base: z.number().int().nullable(),
      person: z.number().int().optional(),
      patch: object.optional(),
      omit: z.array(z.string()).optional(),
      value: z.unknown().optional(),
    }),
  ),
});

type Case = { why: string; value: unknown; valid: boolean };

function cases(raw: unknown, nested: 'people' | null): Case[] {
  const fixtures = fixtureSchema.parse(raw);
  const out: Case[] = fixtures.valid.map((value, index) => ({
    why: `valid ${index}`,
    value,
    valid: true,
  }));
  for (const item of fixtures.invalid) {
    if (item.base === null) {
      out.push({ why: item.why, value: item.value, valid: false });
      continue;
    }
    const base = fixtures.valid[item.base];
    assert.ok(base, item.why);
    let value: Record<string, unknown>;
    if (nested && item.person !== undefined) {
      const people = z.array(object).parse(base[nested]);
      const person = people[item.person];
      assert.ok(person, item.why);
      const changed = { ...person, ...item.patch };
      value = {
        ...base,
        [nested]: people.map((entry, index) =>
          index === item.person ? changed : entry,
        ),
      };
    } else {
      value = { ...base, ...item.patch };
    }
    for (const field of item.omit ?? []) delete value[field];
    out.push({ why: item.why, value, valid: false });
  }
  return out;
}

const records = cases(recordFixtures, null);
const people = cases(peopleFixtures, 'people');

test('the Zod schemas accept the valid fixtures and reject the invalid ones', () => {
  for (const item of records)
    assert.equal(
      recordSchema.safeParse(item.value).success,
      item.valid,
      item.why,
    );
  for (const item of people)
    assert.equal(
      peopleSchema.safeParse(item.value).success,
      item.valid,
      item.why,
    );
});

test('the Python validator gives the same verdict as the Zod schema on every fixture', () => {
  const run = spawnSync('python3', ['-B', 'scripts/records_schema.py'], {
    input: JSON.stringify({
      records: records.map((item) => item.value),
      people: people.map((item) => item.value),
    }),
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const verdicts = z
    .object({ records: z.array(z.boolean()), people: z.array(z.boolean()) })
    .parse(JSON.parse(run.stdout));
  assert.deepEqual(
    verdicts.records.map((valid, index) => [records[index]?.why, valid]),
    records.map((item) => [item.why, item.valid]),
  );
  assert.deepEqual(
    verdicts.people.map((valid, index) => [people[index]?.why, valid]),
    people.map((item) => [item.why, item.valid]),
  );
});
