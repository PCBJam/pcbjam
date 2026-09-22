import { describe, expect, it } from 'vitest';
import { getActiveEditor, setActiveEditor } from './active-editor';

describe('active editor registry', () => {
  it('holds exactly what the boot effect set, and nothing after teardown', () => {
    expect(getActiveEditor()).toBeNull();
    const editor = { source: null, tool: 'eeschema', scope: 'team', projectId: 'p1' };
    setActiveEditor(editor);
    expect(getActiveEditor()).toBe(editor);
    setActiveEditor(null);
    expect(getActiveEditor()).toBeNull();
  });
});
