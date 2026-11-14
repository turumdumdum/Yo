import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, createUser, pool, resetDatabase } from './db';

// Self-host: one company per installation (CLAUDE.md §3).

const createOrg = (userId: string, name: string) =>
  asUser(userId, (c) => c.query('select public.create_organization($1)', [name]));

let first: string;
let second: string;

beforeAll(async () => {
  await resetDatabase();
  first = await createUser('first@a.example');
  second = await createUser('second@b.example');
});

afterAll(async () => {
  await pool.end();
});

describe('single-organization installation', () => {
  it('is the default and allows the first organization', async () => {
    await createOrg(first, 'Org A');
    const { rows } = await pool.query('select count(*)::int as n from public.organizations');
    expect(rows[0].n).toBe(1);
  });

  it('refuses a second organization, also for the first admin', async () => {
    await expect(createOrg(second, 'Org B')).rejects.toThrow(/only one organization/);
    await expect(createOrg(first, 'Org A2')).rejects.toThrow(/only one organization/);
    const { rows } = await pool.query('select count(*)::int as n from public.organizations');
    expect(rows[0].n).toBe(1);
  });

  it('cannot be read or switched off from the browser', async () => {
    await expect(asUser(first, (c) => c.query('select * from private.installation_settings'))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      asUser(first, (c) => c.query('update private.installation_settings set single_organization = false')),
    ).rejects.toThrow(/permission denied/);
  });

  it('allows more organizations once the hosted deployment turns the limit off', async () => {
    await pool.query('update private.installation_settings set single_organization = false');
    await createOrg(second, 'Org B');
    const { rows } = await pool.query('select count(*)::int as n from public.organizations');
    expect(rows[0].n).toBe(2);
  });
});
