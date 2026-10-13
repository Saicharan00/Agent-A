'use client';

import Editor, { loader, type OnMount } from '@monaco-editor/react';
import { useEffect, useRef } from 'react';

// Monaco loads from the app itself (app/monaco/vs), never from a CDN.
loader.config({ paths: { vs: '/monaco/vs' } });

/** Monaco, read-only unless `onChange` is given. Ctrl/Cmd+S calls `onSave`. Loaded lazily (client only). */
export default function CodeEditor({
  value,
  language,
  theme,
  readOnly,
  onChange,
  onSave,
  path,
}: {
  value: string;
  language: string;
  theme: 'light' | 'dark';
  readOnly: boolean;
  onChange?: (value: string) => void;
  onSave?: () => void;
  /** Model URI, so switching files keeps undo history and view state apart. */
  path: string;
}) {
  const saveRef = useRef(onSave);
  useEffect(() => {
    saveRef.current = onSave;
  });

  const onMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current?.());
  };

  return (
    <div className="h-full min-h-0" data-testid="code-editor" data-readonly={readOnly ? 'true' : 'false'}>
      <Editor
        value={value}
        language={language}
        path={path}
        theme={theme === 'dark' ? 'vs-dark' : 'light'}
        onChange={(v) => onChange?.(v ?? '')}
        onMount={onMount}
        loading={<p className="p-4 text-sm text-muted-foreground">Loading editor…</p>}
        options={{
          readOnly,
          domReadOnly: readOnly,
          minimap: { enabled: false },
          fontSize: 12,
          wordWrap: 'on',
          scrollBeyondLastLine: false,
          automaticLayout: true,
          lineNumbersMinChars: 3,
          renderWhitespace: 'selection',
        }}
      />
    </div>
  );
}
