/**
 * Minimal i18n for the AI Assistant (Arabic, English, French). The rest of the app is not
 * translated yet; this module is the single place assistant strings live so they can be
 * extended to other pages later. `ar` is rendered right-to-left.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

export const LOCALES = ['en', 'ar', 'fr'] as const
export type Locale = (typeof LOCALES)[number]

const RTL_LOCALES: ReadonlySet<Locale> = new Set(['ar'])
const STORAGE_KEY = '9drive.locale'

export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', ar: 'العربية', fr: 'Français' }

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

export function directionOf(locale: Locale): 'rtl' | 'ltr' {
  return RTL_LOCALES.has(locale) ? 'rtl' : 'ltr'
}

export function detectLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (isLocale(stored)) return stored
  } catch {
    /* storage unavailable */
  }
  const preferred = typeof navigator !== 'undefined' ? navigator.language?.slice(0, 2).toLowerCase() : ''
  return isLocale(preferred) ? preferred : 'en'
}

const en = {
  title: 'AI Assistant',
  subtitle: 'Ask about your storage in plain language. Sensitive actions always need your approval.',
  newChat: 'New chat',
  conversations: 'Conversations',
  noConversations: 'No conversations yet.',
  untitled: 'New conversation',
  deleteChat: 'Delete conversation',
  deleteChatConfirm: 'Delete this conversation and its history?',
  openMenu: 'Show conversations',
  closeMenu: 'Hide conversations',
  language: 'Language',
  placeholder: 'Ask something, e.g. "Which accounts have the most free space?"',
  send: 'Send',
  cancel: 'Cancel',
  retry: 'Retry',
  copy: 'Copy',
  copied: 'Copied',
  you: 'You',
  assistant: '9Drive Assistant',
  emptyHint: 'Try one of these:',
  example1: 'Show me my connected storage accounts and which need attention.',
  example2: 'Find files larger than 500 MB.',
  example3: 'Find duplicate files and prepare a cleanup plan.',
  loading: 'Loading…',
  disabledTitle: 'The AI assistant is not available',
  disabledBody: 'The administrator has not configured an AI model yet.',
  reasonLabel: 'Reason',
  degradedTitle: 'Quick actions (no AI model needed)',
  degradedHint: 'These read-only actions run directly against your data.',
  qaAccounts: 'My storage accounts',
  qaUsage: 'Storage usage report',
  qaHealth: 'Provider health',
  qaAttention: 'Accounts needing attention',
  qaRunning: 'Running…',
  statusReceived: 'Request received',
  statusAnalyzing: 'Thinking…',
  statusExecuting: 'Running actions…',
  statusVerifying: 'Verifying the result…',
  statusAwaitingConfirmation: 'Waiting for your approval',
  statusAwaitingClarification: 'Waiting for your answer',
  statusCompleted: 'Done',
  statusPartiallyCompleted: 'Partly done',
  statusFailed: 'Failed',
  statusCancelled: 'Cancelled',
  stepRunning: 'Running',
  stepSucceeded: 'Done',
  stepFailed: 'Failed',
  stepRejected: 'Not executed',
  stepPending: 'Waiting for approval',
  stepSkipped: 'Skipped',
  verified: 'Verified',
  confirmTitle: 'Approve this action?',
  confirmRiskLow: 'Low risk',
  confirmRiskMedium: 'Medium risk',
  confirmRiskHigh: 'High risk',
  confirmAffected: 'Affected items: {n}',
  confirmSample: 'Examples',
  confirmWarnings: 'Please note',
  confirmExpires: 'Expires in {time}',
  confirmExpired: 'This request expired. Ask the assistant to propose it again.',
  confirmUnderstand: 'I understand this cannot be undone or has wide effects.',
  approve: 'Approve',
  reject: 'Decline',
  approving: 'Approving…',
  cancelTask: 'Stop',
  userOnlyOutput: 'Shown to you only (the assistant cannot see it)',
  errorGeneric: 'Something went wrong. Please try again.',
  errorBusy: 'Another request in this conversation is still running or waiting for your approval.',
  errorRateLimited: 'Too many requests. Please wait a moment.',
  errorNotConfigured: 'The AI assistant is not configured.',
  errorLimit: 'The daily AI usage limit has been reached.',
  errorMismatch: 'The action changed after it was shown. Review it again.',
  errorConfirmationUsed: 'This approval was already used or has expired.',
  noTokenStreaming: 'Answers appear when complete.',
} as const

export type MessageKey = keyof typeof en
type Dictionary = Record<MessageKey, string>

const ar: Dictionary = {
  title: 'مساعد 9Drive الذكي',
  subtitle: 'اسأل عن تخزينك بلغة بسيطة. الإجراءات الحساسة تحتاج دائماً إلى موافقتك.',
  newChat: 'محادثة جديدة',
  conversations: 'المحادثات',
  noConversations: 'لا توجد محادثات بعد.',
  untitled: 'محادثة جديدة',
  deleteChat: 'حذف المحادثة',
  deleteChatConfirm: 'هل تريد حذف هذه المحادثة وسجلّها؟',
  openMenu: 'إظهار المحادثات',
  closeMenu: 'إخفاء المحادثات',
  language: 'اللغة',
  placeholder: 'اكتب سؤالك، مثلاً: «أي الحسابات لديها أكبر مساحة فارغة؟»',
  send: 'إرسال',
  cancel: 'إلغاء',
  retry: 'إعادة المحاولة',
  copy: 'نسخ',
  copied: 'تم النسخ',
  you: 'أنت',
  assistant: 'مساعد 9Drive',
  emptyHint: 'جرّب أحد هذه الأسئلة:',
  example1: 'اعرض حسابات التخزين المتصلة وأيّها يحتاج إلى انتباه.',
  example2: 'ابحث عن الملفات الأكبر من 500 ميغابايت.',
  example3: 'ابحث عن الملفات المكررة وجهّز خطة تنظيف.',
  loading: 'جارٍ التحميل…',
  disabledTitle: 'المساعد الذكي غير متاح',
  disabledBody: 'لم يقم المسؤول بإعداد نموذج ذكاء اصطناعي بعد.',
  reasonLabel: 'السبب',
  degradedTitle: 'إجراءات سريعة (لا تحتاج إلى نموذج)',
  degradedHint: 'هذه الإجراءات للقراءة فقط وتعمل مباشرة على بياناتك.',
  qaAccounts: 'حسابات التخزين',
  qaUsage: 'تقرير استخدام التخزين',
  qaHealth: 'حالة المزوّدين',
  qaAttention: 'الحسابات التي تحتاج انتباهاً',
  qaRunning: 'جارٍ التنفيذ…',
  statusReceived: 'تم استلام الطلب',
  statusAnalyzing: 'جارٍ التفكير…',
  statusExecuting: 'جارٍ تنفيذ الإجراءات…',
  statusVerifying: 'جارٍ التحقق من النتيجة…',
  statusAwaitingConfirmation: 'بانتظار موافقتك',
  statusAwaitingClarification: 'بانتظار ردّك',
  statusCompleted: 'اكتمل',
  statusPartiallyCompleted: 'اكتمل جزئياً',
  statusFailed: 'فشل',
  statusCancelled: 'أُلغي',
  stepRunning: 'قيد التنفيذ',
  stepSucceeded: 'تم',
  stepFailed: 'فشل',
  stepRejected: 'لم يُنفَّذ',
  stepPending: 'بانتظار الموافقة',
  stepSkipped: 'تم تخطّيه',
  verified: 'تم التحقق',
  confirmTitle: 'هل توافق على هذا الإجراء؟',
  confirmRiskLow: 'خطورة منخفضة',
  confirmRiskMedium: 'خطورة متوسطة',
  confirmRiskHigh: 'خطورة عالية',
  confirmAffected: 'العناصر المتأثرة: {n}',
  confirmSample: 'أمثلة',
  confirmWarnings: 'يرجى الانتباه',
  confirmExpires: 'تنتهي الصلاحية خلال {time}',
  confirmExpired: 'انتهت صلاحية هذا الطلب. اطلب من المساعد اقتراحه مرة أخرى.',
  confirmUnderstand: 'أدرك أنه لا يمكن التراجع عن هذا الإجراء أو أن أثره واسع.',
  approve: 'موافقة',
  reject: 'رفض',
  approving: 'جارٍ الموافقة…',
  cancelTask: 'إيقاف',
  userOnlyOutput: 'يظهر لك أنت فقط (لا يستطيع المساعد رؤيته)',
  errorGeneric: 'حدث خطأ ما. يرجى المحاولة مرة أخرى.',
  errorBusy: 'هناك طلب آخر في هذه المحادثة ما زال قيد التنفيذ أو بانتظار موافقتك.',
  errorRateLimited: 'طلبات كثيرة جداً. يرجى الانتظار قليلاً.',
  errorNotConfigured: 'المساعد الذكي غير مُهيّأ.',
  errorLimit: 'تم بلوغ الحد اليومي لاستخدام الذكاء الاصطناعي.',
  errorMismatch: 'تغيّر الإجراء بعد عرضه. راجعه مرة أخرى.',
  errorConfirmationUsed: 'تم استخدام هذه الموافقة من قبل أو انتهت صلاحيتها.',
  noTokenStreaming: 'تظهر الإجابات عند اكتمالها.',
}

const fr: Dictionary = {
  title: 'Assistant IA 9Drive',
  subtitle: 'Posez vos questions sur votre stockage en langage simple. Les actions sensibles exigent toujours votre accord.',
  newChat: 'Nouvelle discussion',
  conversations: 'Discussions',
  noConversations: 'Aucune discussion pour le moment.',
  untitled: 'Nouvelle discussion',
  deleteChat: 'Supprimer la discussion',
  deleteChatConfirm: 'Supprimer cette discussion et son historique ?',
  openMenu: 'Afficher les discussions',
  closeMenu: 'Masquer les discussions',
  language: 'Langue',
  placeholder: 'Posez une question, par ex. « Quels comptes ont le plus d’espace libre ? »',
  send: 'Envoyer',
  cancel: 'Annuler',
  retry: 'Réessayer',
  copy: 'Copier',
  copied: 'Copié',
  you: 'Vous',
  assistant: 'Assistant 9Drive',
  emptyHint: 'Essayez l’une de ces demandes :',
  example1: 'Affiche mes comptes de stockage connectés et ceux qui demandent de l’attention.',
  example2: 'Trouve les fichiers de plus de 500 Mo.',
  example3: 'Trouve les fichiers en double et prépare un plan de nettoyage.',
  loading: 'Chargement…',
  disabledTitle: 'L’assistant IA n’est pas disponible',
  disabledBody: 'L’administrateur n’a pas encore configuré de modèle d’IA.',
  reasonLabel: 'Raison',
  degradedTitle: 'Actions rapides (sans modèle d’IA)',
  degradedHint: 'Ces actions en lecture seule s’exécutent directement sur vos données.',
  qaAccounts: 'Mes comptes de stockage',
  qaUsage: 'Rapport d’utilisation',
  qaHealth: 'État des fournisseurs',
  qaAttention: 'Comptes à surveiller',
  qaRunning: 'Exécution…',
  statusReceived: 'Demande reçue',
  statusAnalyzing: 'Réflexion…',
  statusExecuting: 'Exécution des actions…',
  statusVerifying: 'Vérification du résultat…',
  statusAwaitingConfirmation: 'En attente de votre accord',
  statusAwaitingClarification: 'En attente de votre réponse',
  statusCompleted: 'Terminé',
  statusPartiallyCompleted: 'Partiellement terminé',
  statusFailed: 'Échec',
  statusCancelled: 'Annulé',
  stepRunning: 'En cours',
  stepSucceeded: 'Terminé',
  stepFailed: 'Échec',
  stepRejected: 'Non exécuté',
  stepPending: 'En attente d’accord',
  stepSkipped: 'Ignoré',
  verified: 'Vérifié',
  confirmTitle: 'Approuver cette action ?',
  confirmRiskLow: 'Risque faible',
  confirmRiskMedium: 'Risque moyen',
  confirmRiskHigh: 'Risque élevé',
  confirmAffected: 'Éléments concernés : {n}',
  confirmSample: 'Exemples',
  confirmWarnings: 'À noter',
  confirmExpires: 'Expire dans {time}',
  confirmExpired: 'Cette demande a expiré. Demandez à l’assistant de la proposer à nouveau.',
  confirmUnderstand: 'Je comprends que cette action est irréversible ou a de larges effets.',
  approve: 'Approuver',
  reject: 'Refuser',
  approving: 'Approbation…',
  cancelTask: 'Arrêter',
  userOnlyOutput: 'Visible par vous uniquement (l’assistant ne peut pas le voir)',
  errorGeneric: 'Une erreur s’est produite. Veuillez réessayer.',
  errorBusy: 'Une autre demande de cette discussion est en cours ou attend votre accord.',
  errorRateLimited: 'Trop de requêtes. Patientez un instant.',
  errorNotConfigured: 'L’assistant IA n’est pas configuré.',
  errorLimit: 'La limite quotidienne d’utilisation de l’IA est atteinte.',
  errorMismatch: 'L’action a changé après son affichage. Vérifiez-la à nouveau.',
  errorConfirmationUsed: 'Cet accord a déjà été utilisé ou a expiré.',
  noTokenStreaming: 'Les réponses s’affichent une fois terminées.',
}

export const DICTIONARIES: Record<Locale, Dictionary> = { en, ar, fr }

export function translate(locale: Locale, key: MessageKey, params?: Record<string, string | number>): string {
  let text = DICTIONARIES[locale][key] ?? DICTIONARIES.en[key]
  if (params) for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value))
  return text
}

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

export function useLocale() {
  const [locale, setLocaleState] = useState<Locale>(() => detectLocale())
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* storage unavailable */
    }
  }, [])
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  const t = useMemo<Translate>(() => (key, params) => translate(locale, key, params), [locale])
  return { locale, setLocale, t, dir: directionOf(locale) }
}
