/**
 * Message catalogue. English is the source of truth: `MessageKey` is derived from it, and the
 * Arabic and French dictionaries are typed `Record<MessageKey, string>`, so a missing translation is a
 * compile error (and a unit test also checks parity and placeholder consistency).
 *
 * Placeholders use `{name}`. Never concatenate translated fragments — word order differs per language.
 */

const en = {
  appName: '9Drive',

  tabFiles: 'Files',
  tabStorage: 'Storage',
  tabAssistant: 'Assistant',
  tabSettings: 'Settings',

  retry: 'Try again',
  cancel: 'Cancel',
  ok: 'OK',
  save: 'Save',
  close: 'Close',
  loading: 'Loading…',
  showPassword: 'Show',
  hidePassword: 'Hide',
  emptyTitle: 'Nothing here yet',
  notAvailableYet: 'This section is being built and is not available yet.',

  settingsTitle: 'Settings',
  language: 'Language',
  theme: 'Appearance',
  themeSystem: 'Follow system',
  themeLight: 'Light',
  themeDark: 'Dark',
  server: 'Server',
  serverInsecure: 'Debug build: this connection is not encrypted.',
  restartForDirection: 'Restart the app to apply the new text direction.',
  version: 'Version',

  errOffline: 'You appear to be offline, or the server cannot be reached.',
  errTimeout: 'The server took too long to respond. Try again.',
  errCancelled: 'Cancelled.',
  errUnauthorized: 'Your session has ended. Please sign in again.',
  errDisabled: 'This account is not active. Contact the administrator.',
  errForbidden: 'You do not have permission to do this.',
  errNotFound: 'This item no longer exists.',
  errConflict: 'This conflicts with a recent change. Refresh and try again.',
  errValidation: 'Some of the information is not valid. Please check it.',
  errRateLimited: 'Too many requests. Please wait a moment and try again.',
  errQuota: 'There is not enough storage space for this.',
  errServer: 'Something went wrong on the server. Try again later.',
  errUnavailable: 'The service is temporarily unavailable. Try again shortly.',
  errInvalidResponse: 'The server sent an unexpected answer. Update the app or contact support.',
  errUnknown: 'Something went wrong. Try again.',

  configMissingTitle: 'Server address not configured',
  configMissingBody: 'This build has no API address. Set EXPO_PUBLIC_API_URL when building the app.',
  configInvalidTitle: 'Invalid server address',
  configInvalidBody: 'The configured API address is not valid. Check EXPO_PUBLIC_API_URL.',
  configInsecureTitle: 'Secure connection required',
  configInsecureBody: 'Release builds only connect over HTTPS. Use an https:// API address.',
} as const;

export type MessageKey = keyof typeof en;
type Dictionary = Record<MessageKey, string>;

const ar: Dictionary = {
  appName: '9Drive',

  tabFiles: 'الملفات',
  tabStorage: 'التخزين',
  tabAssistant: 'المساعد',
  tabSettings: 'الإعدادات',

  retry: 'أعد المحاولة',
  cancel: 'إلغاء',
  ok: 'حسنًا',
  save: 'حفظ',
  close: 'إغلاق',
  loading: 'جارٍ التحميل…',
  showPassword: 'إظهار',
  hidePassword: 'إخفاء',
  emptyTitle: 'لا يوجد شيء هنا بعد',
  notAvailableYet: 'هذا القسم قيد الإنشاء وغير متاح بعد.',

  settingsTitle: 'الإعدادات',
  language: 'اللغة',
  theme: 'المظهر',
  themeSystem: 'حسب النظام',
  themeLight: 'فاتح',
  themeDark: 'داكن',
  server: 'الخادم',
  serverInsecure: 'نسخة تطوير: هذا الاتصال غير مشفّر.',
  restartForDirection: 'أعد تشغيل التطبيق لتطبيق اتجاه النص الجديد.',
  version: 'الإصدار',

  errOffline: 'يبدو أنك غير متصل، أو أنه لا يمكن الوصول إلى الخادم.',
  errTimeout: 'استغرق الخادم وقتًا طويلًا للرد. أعد المحاولة.',
  errCancelled: 'تم الإلغاء.',
  errUnauthorized: 'انتهت جلستك. يرجى تسجيل الدخول مجددًا.',
  errDisabled: 'هذا الحساب غير نشط. تواصل مع المسؤول.',
  errForbidden: 'ليست لديك صلاحية لتنفيذ هذا الإجراء.',
  errNotFound: 'لم يعد هذا العنصر موجودًا.',
  errConflict: 'يتعارض هذا مع تغيير حديث. حدّث الصفحة وأعد المحاولة.',
  errValidation: 'بعض المعلومات غير صالحة. يرجى التحقق منها.',
  errRateLimited: 'طلبات كثيرة جدًا. انتظر قليلًا ثم أعد المحاولة.',
  errQuota: 'لا توجد مساحة تخزين كافية لهذا الإجراء.',
  errServer: 'حدث خطأ في الخادم. حاول لاحقًا.',
  errUnavailable: 'الخدمة غير متاحة مؤقتًا. حاول بعد قليل.',
  errInvalidResponse: 'أرسل الخادم ردًا غير متوقع. حدّث التطبيق أو تواصل مع الدعم.',
  errUnknown: 'حدث خطأ ما. أعد المحاولة.',

  configMissingTitle: 'عنوان الخادم غير مضبوط',
  configMissingBody: 'لا يحتوي هذا الإصدار على عنوان API. اضبط EXPO_PUBLIC_API_URL عند بناء التطبيق.',
  configInvalidTitle: 'عنوان الخادم غير صالح',
  configInvalidBody: 'عنوان API المضبوط غير صالح. تحقق من EXPO_PUBLIC_API_URL.',
  configInsecureTitle: 'الاتصال الآمن مطلوب',
  configInsecureBody: 'إصدارات الإنتاج تتصل عبر HTTPS فقط. استخدم عنوان API يبدأ بـ https://.',
};

const fr: Dictionary = {
  appName: '9Drive',

  tabFiles: 'Fichiers',
  tabStorage: 'Stockage',
  tabAssistant: 'Assistant',
  tabSettings: 'Réglages',

  retry: 'Réessayer',
  cancel: 'Annuler',
  ok: 'OK',
  save: 'Enregistrer',
  close: 'Fermer',
  loading: 'Chargement…',
  showPassword: 'Afficher',
  hidePassword: 'Masquer',
  emptyTitle: 'Rien ici pour le moment',
  notAvailableYet: 'Cette section est en cours de création et n’est pas encore disponible.',

  settingsTitle: 'Réglages',
  language: 'Langue',
  theme: 'Apparence',
  themeSystem: 'Suivre le système',
  themeLight: 'Clair',
  themeDark: 'Sombre',
  server: 'Serveur',
  serverInsecure: 'Version de débogage : cette connexion n’est pas chiffrée.',
  restartForDirection: 'Redémarrez l’application pour appliquer le nouveau sens du texte.',
  version: 'Version',

  errOffline: 'Vous semblez hors ligne, ou le serveur est injoignable.',
  errTimeout: 'Le serveur met trop de temps à répondre. Réessayez.',
  errCancelled: 'Annulé.',
  errUnauthorized: 'Votre session est terminée. Veuillez vous reconnecter.',
  errDisabled: 'Ce compte n’est pas actif. Contactez l’administrateur.',
  errForbidden: 'Vous n’avez pas la permission d’effectuer cette action.',
  errNotFound: 'Cet élément n’existe plus.',
  errConflict: 'Cela entre en conflit avec une modification récente. Actualisez puis réessayez.',
  errValidation: 'Certaines informations ne sont pas valides. Vérifiez-les.',
  errRateLimited: 'Trop de requêtes. Patientez un instant puis réessayez.',
  errQuota: 'L’espace de stockage est insuffisant pour cette opération.',
  errServer: 'Une erreur est survenue côté serveur. Réessayez plus tard.',
  errUnavailable: 'Le service est temporairement indisponible. Réessayez dans un instant.',
  errInvalidResponse: 'Le serveur a envoyé une réponse inattendue. Mettez à jour l’application ou contactez le support.',
  errUnknown: 'Une erreur est survenue. Réessayez.',

  configMissingTitle: 'Adresse du serveur non configurée',
  configMissingBody: 'Cette version n’a pas d’adresse d’API. Définissez EXPO_PUBLIC_API_URL lors de la compilation.',
  configInvalidTitle: 'Adresse du serveur invalide',
  configInvalidBody: 'L’adresse d’API configurée n’est pas valide. Vérifiez EXPO_PUBLIC_API_URL.',
  configInsecureTitle: 'Connexion sécurisée requise',
  configInsecureBody: 'Les versions de production se connectent uniquement en HTTPS. Utilisez une adresse https://.',
};

export const LOCALES = ['en', 'ar', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];

export const MESSAGES: Record<Locale, Dictionary> = { en, ar, fr };

export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', ar: 'العربية', fr: 'Français' };

const RTL: ReadonlySet<Locale> = new Set<Locale>(['ar']);
export const isRtl = (locale: Locale): boolean => RTL.has(locale);

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Picks the best supported locale from a device language code such as "ar", "fr-CA" or "en-US". */
export function matchLocale(languageCode: string | null | undefined): Locale {
  const base = languageCode?.toLowerCase().split(/[-_]/)[0];
  return isLocale(base) ? base : 'en';
}

export function translate(locale: Locale, key: MessageKey, params?: Record<string, string | number>): string {
  let text = MESSAGES[locale][key] ?? MESSAGES.en[key];
  if (params) {
    for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
  }
  return text;
}
