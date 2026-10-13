/**
 * Languages the statement notes can be written in. English and Spanish have hand-written
 * templates (and page text); the others are written by the model and fall back to English.
 */
export interface NoteLanguage {
  code: string;
  /** For the model's prompt ("Haitian Creole"). */
  name: string;
  /** For the picker, in the language itself ("Kreyòl"). */
  native: string;
}

export const NOTE_LANGUAGES: readonly NoteLanguage[] = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'es', name: 'Spanish', native: 'Español' },
  { code: 'ht', name: 'Haitian Creole', native: 'Kreyòl' },
  { code: 'zh', name: 'Chinese (Simplified)', native: '中文' },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'ko', name: 'Korean', native: '한국어' },
  { code: 'ru', name: 'Russian', native: 'Русский' },
  { code: 'tl', name: 'Tagalog', native: 'Tagalog' },
  { code: 'fr', name: 'French', native: 'Français' },
  { code: 'pt', name: 'Portuguese', native: 'Português' },
];

export function noteLanguage(code: string | undefined | null): NoteLanguage | null {
  return NOTE_LANGUAGES.find((l) => l.code === code) ?? null;
}
