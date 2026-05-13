const DIACRITICS_REGEX = /[ً-ْٰـ]/g;
const ARABIC_RANGE = /[؀-ۿݐ-ݿ]/;

export function stripDiacritics(s: string): string {
  return s.replace(DIACRITICS_REGEX, '');
}

export function hasArabic(s: string): boolean {
  return ARABIC_RANGE.test(s);
}

export function detectLang(s: string): 'ar' | 'en' | 'mixed' {
  const ar = (s.match(/[؀-ۿ]/g) ?? []).length;
  const en = (s.match(/[A-Za-z]/g) ?? []).length;
  if (ar === 0 && en > 0) return 'en';
  if (en === 0 && ar > 0) return 'ar';
  if (ar > 0 && en > 0) return 'mixed';
  return 'en';
}
