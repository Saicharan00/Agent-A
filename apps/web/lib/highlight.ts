// Code highlighting for chat (F13): shiki, loaded on first use so pages without code never download it.
// Output carries both themes as CSS variables (--shiki-light / --shiki-dark); globals.css picks one per theme.

type Shiki = typeof import('shiki');
let shiki: Promise<Shiki> | null = null;

/** Normalises a fence's language (`language-ts` → `ts`); unknown or missing languages render as plain text. */
export function codeLanguage(className: string | undefined, known: (lang: string) => boolean): string {
  const lang = /(?:^|\s)language-([\w+#.-]+)/.exec(className ?? '')?.[1]?.toLowerCase();
  return lang && known(lang) ? lang : 'text';
}

/** Highlighted HTML for a code block (shiki escapes the code). */
export async function highlight(code: string, className: string | undefined): Promise<string> {
  shiki ??= import('shiki');
  const { codeToHtml, bundledLanguages, bundledLanguagesAlias } = await shiki;
  const lang = codeLanguage(className, (l) => l in bundledLanguages || l in bundledLanguagesAlias);
  return codeToHtml(code, {
    lang,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  });
}

/** The fence's language for the code block header ('' when none). */
export function languageLabel(className: string | undefined): string {
  return /(?:^|\s)language-([\w+#.-]+)/.exec(className ?? '')?.[1] ?? '';
}
