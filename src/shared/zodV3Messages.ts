import { z } from 'zod';

// zod 4 changed its default error texts ("Required" → "Invalid input: expected string, received
// undefined", …). API clients show these texts, so the zod 3 wording is kept here. Messages set on a
// schema (`.min(1, '…')`, `{ error }`) still win over this map. Imported for its side effect, before
// any schema is parsed (config/index.ts).

const parsedType = (input: unknown): string => {
  switch (typeof input) {
    case 'undefined':
      return 'undefined';
    case 'string':
      return 'string';
    case 'number':
      return Number.isNaN(input) ? 'nan' : 'number';
    case 'boolean':
      return 'boolean';
    case 'function':
      return 'function';
    case 'bigint':
      return 'bigint';
    case 'symbol':
      return 'symbol';
    case 'object':
      if (Array.isArray(input)) return 'array';
      if (input === null) return 'null';
      if (input instanceof Promise) return 'promise';
      if (input instanceof Map) return 'map';
      if (input instanceof Set) return 'set';
      if (input instanceof Date) return 'date';
      return 'object';
    default:
      return 'unknown';
  }
};

const joinValues = (values: readonly unknown[]) =>
  values.map(v => (typeof v === 'string' ? `'${v}'` : String(v))).join(' | ');

type TIssue = Parameters<NonNullable<z.core.$ZodConfig['customError']>>[0];

export const zodV3Message = (iss: TIssue): string | undefined => {
  switch (iss.code) {
    case 'invalid_type': {
      const received = parsedType(iss.input);
      if (received === 'undefined') return 'Required';
      if (iss.expected === 'int') {
        return received === 'number'
          ? 'Expected integer, received float'
          : `Expected number, received ${received}`;
      }
      if (iss.expected === 'date' && received === 'date') return 'Invalid date';
      return `Expected ${iss.expected}, received ${received}`;
    }
    case 'invalid_value': {
      const isLiteral =
        (iss.inst?._zod.def as { type?: string } | undefined)?.type ===
        'literal';
      if (isLiteral && iss.values.length === 1) {
        return `Invalid literal value, expected ${JSON.stringify(
          iss.values[0]
        )}`;
      }
      return `Invalid enum value. Expected ${joinValues(
        iss.values
      )}, received '${String(iss.input)}'`;
    }
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${iss.keys
        .map(k => `'${k}'`)
        .join(', ')}`;
    case 'invalid_union':
      return 'Invalid input';
    case 'invalid_format': {
      if (iss.format === 'starts_with')
        return `Invalid input: must start with "${iss.prefix}"`;
      if (iss.format === 'ends_with')
        return `Invalid input: must end with "${iss.suffix}"`;
      if (iss.format === 'includes')
        return `Invalid input: must include "${iss.includes}"`;
      if (iss.format === 'regex') return 'Invalid';
      return `Invalid ${iss.format}`;
    }
    case 'too_small': {
      const { minimum, inclusive, origin } = iss;
      const exact = 'exact' in iss && iss.exact;
      if (origin === 'array' || origin === 'set') {
        return `Array must contain ${
          exact ? 'exactly' : inclusive ? 'at least' : 'more than'
        } ${minimum} element(s)`;
      }
      if (origin === 'string') {
        return `String must contain ${
          exact ? 'exactly' : inclusive ? 'at least' : 'over'
        } ${minimum} character(s)`;
      }
      if (origin === 'number' || origin === 'int' || origin === 'bigint') {
        return `Number must be ${
          exact
            ? 'exactly equal to '
            : inclusive
            ? 'greater than or equal to '
            : 'greater than '
        }${minimum}`;
      }
      if (origin === 'date') {
        return `Date must be ${
          exact
            ? 'exactly equal to '
            : inclusive
            ? 'greater than or equal to '
            : 'greater than '
        }${new Date(Number(minimum))}`;
      }
      return 'Invalid input';
    }
    case 'too_big': {
      const { maximum, inclusive, origin } = iss;
      const exact = 'exact' in iss && iss.exact;
      if (origin === 'array' || origin === 'set') {
        return `Array must contain ${
          exact ? 'exactly' : inclusive ? 'at most' : 'less than'
        } ${maximum} element(s)`;
      }
      if (origin === 'string') {
        return `String must contain ${
          exact ? 'exactly' : inclusive ? 'at most' : 'under'
        } ${maximum} character(s)`;
      }
      if (origin === 'number' || origin === 'int') {
        return `Number must be ${
          exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'
        } ${maximum}`;
      }
      if (origin === 'bigint') {
        return `BigInt must be ${
          exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'
        } ${maximum}`;
      }
      if (origin === 'date') {
        return `Date must be ${
          exact
            ? 'exactly'
            : inclusive
            ? 'smaller than or equal to'
            : 'smaller than'
        } ${new Date(Number(maximum))}`;
      }
      return 'Invalid input';
    }
    case 'not_multiple_of':
      return `Number must be a multiple of ${iss.divisor}`;
    case 'custom':
      return 'Invalid input';
    default:
      return undefined;
  }
};

z.config({ customError: zodV3Message });
