import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import '../../src/shared/zodV3Messages';

// Expected texts are zod 3's defaults, which API clients have always seen.
const msg = (schema: z.ZodType, input: unknown) => {
  const r = schema.safeParse(input);
  if (r.success) throw new Error('expected failure');
  return r.error.issues.map(i => i.message);
};

describe('zod 3 compatible messages', () => {
  it('type errors', () => {
    expect(msg(z.object({ a: z.string() }), {})).toEqual(['Required']);
    expect(msg(z.string(), 5)).toEqual(['Expected string, received number']);
    expect(msg(z.number(), NaN)).toEqual(['Expected number, received nan']);
    expect(msg(z.number().int(), 1.5)).toEqual([
      'Expected integer, received float',
    ]);
    expect(msg(z.array(z.string()), null)).toEqual([
      'Expected array, received null',
    ]);
  });

  it('enum, literal, strict', () => {
    expect(msg(z.enum(['a', 'b']), 'c')).toEqual([
      "Invalid enum value. Expected 'a' | 'b', received 'c'",
    ]);
    expect(msg(z.literal('x'), 'y')).toEqual([
      'Invalid literal value, expected "x"',
    ]);
    expect(msg(z.object({}).strict(), { k: 1, j: 2 })).toEqual([
      "Unrecognized key(s) in object: 'k', 'j'",
    ]);
  });

  it('sizes and formats', () => {
    expect(msg(z.string().min(2), 'a')).toEqual([
      'String must contain at least 2 character(s)',
    ]);
    expect(msg(z.string().max(1), 'ab')).toEqual([
      'String must contain at most 1 character(s)',
    ]);
    expect(msg(z.string().length(2), 'a')).toEqual([
      'String must contain exactly 2 character(s)',
    ]);
    expect(msg(z.number().min(1), 0)).toEqual([
      'Number must be greater than or equal to 1',
    ]);
    expect(msg(z.number().positive(), 0)).toEqual([
      'Number must be greater than 0',
    ]);
    expect(msg(z.number().max(100), 101)).toEqual([
      'Number must be less than or equal to 100',
    ]);
    expect(msg(z.array(z.number()).min(1), [])).toEqual([
      'Array must contain at least 1 element(s)',
    ]);
    expect(msg(z.string().email(), 'x')).toEqual(['Invalid email']);
    expect(msg(z.string().url(), 'x')).toEqual(['Invalid url']);
    expect(msg(z.string().regex(/^a$/), 'b')).toEqual(['Invalid']);
    expect(
      msg(
        z.string().refine(() => false),
        'b'
      )
    ).toEqual(['Invalid input']);
  });

  it('schema messages still win', () => {
    expect(msg(z.string().min(2, 'too short'), 'a')).toEqual(['too short']);
    expect(msg(z.enum(['a'], { error: 'pick a' }), 'b')).toEqual(['pick a']);
  });
});
