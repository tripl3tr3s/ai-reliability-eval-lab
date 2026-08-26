import { describe, expect, it } from 'vitest';
import { deterministicHash, scheduledFault } from '../src/faults.js';

describe('fault schedules', () => {
  it('is deterministic', () => expect(deterministicHash(['case', 7, 'tool', 1])).toBe(deterministicHash(['case', 7, 'tool', 1])));
  it('targets exact invocation', () => expect(scheduledFault('c', 1, 'get_document', 2, [{ tool: 'get_document', invocation: 2, kind: 'timeout' }])).toBe('timeout'));
});
