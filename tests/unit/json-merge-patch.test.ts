import { describe, expect, it } from 'vitest';
import { applyMergePatch, isMergePatchObject } from '../../src/dashboard/model/json-merge-patch.js';

describe('isMergePatchObject', () => {
  it('accepts only plain objects', () => {
    expect(isMergePatchObject({})).toBe(true);
    expect(isMergePatchObject({ a: 1 })).toBe(true);
    expect(isMergePatchObject([])).toBe(false);
    expect(isMergePatchObject(null)).toBe(false);
    expect(isMergePatchObject('s')).toBe(false);
    expect(isMergePatchObject(3)).toBe(false);
  });
});

describe('applyMergePatch — RFC 7396', () => {
  it('merges object members recursively', () => {
    const target = { a: { x: 1, y: 2 }, b: 1 };
    const result = applyMergePatch(target, { a: { y: 9, z: 3 }, c: 4 });
    expect(result).toEqual({ a: { x: 1, y: 9, z: 3 }, b: 1, c: 4 });
  });

  it('deletes a member whose patch value is null', () => {
    expect(applyMergePatch({ a: 1, b: 2 }, { a: null })).toEqual({ b: 2 });
    // Deleting an absent member is a no-op.
    expect(applyMergePatch({ b: 2 }, { a: null })).toEqual({ b: 2 });
  });

  it('replaces arrays wholesale — never index-merges or concatenates', () => {
    expect(applyMergePatch({ y: [1, 2, 3] }, { y: [9] })).toEqual({ y: [9] });
  });

  it('replaces the whole value when the patch is not an object', () => {
    expect(applyMergePatch({ a: 1 }, [1, 2])).toEqual([1, 2]);
    expect(applyMergePatch({ a: 1 }, 'x')).toBe('x');
    expect(applyMergePatch({ a: 1 }, null)).toBe(null);
  });

  it('treats a non-object target as an empty object when the patch is an object', () => {
    expect(applyMergePatch(5, { a: 1 })).toEqual({ a: 1 });
    expect(applyMergePatch(null, { a: { b: 2 } })).toEqual({ a: { b: 2 } });
  });

  it('shares no structure with either input', () => {
    const target = { a: { x: [1] } };
    const patch = { a: { y: { z: 2 } } };
    const result = applyMergePatch(target, patch) as { a: { x: number[]; y: { z: number } } };
    result.a.x.push(99);
    result.a.y.z = 100;
    expect(target.a.x).toEqual([1]);
    expect(patch.a.y.z).toBe(2);
  });
});
