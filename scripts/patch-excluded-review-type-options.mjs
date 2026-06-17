import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTING_ID = 'review-cycle-excluded-review-types';
const OPTION_KEYS = ['code', 'db', 'security', 'refactor', 'api', 'test', 'performance', 'infra', 'dependency'];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const langDir = path.join(repoRoot, 'src', 'reports', 'ui', 'workflow-setting-text', 'lang');

/** @type {Record<string, { description: string; options: Record<string, { label: string; description: string }> }>} */
const PATCHES = {
    ar: {
        description: 'اختيار متعدد: أنواع المراجعة المحددة تُستثنى من احتساب حارس دورة المراجعة (review-cycle guard).',
        options: {
            code: {
                label: 'مراجعة الكود',
                description: 'عند التحديد، تُستثنى مراجعة الكود من احتساب حارس دورة المراجعة (review-cycle guard).'
            },
            db: {
                label: 'مراجعة قاعدة البيانات',
                description: 'عند التحديد، تُستثنى مراجعة قاعدة البيانات من احتساب حارس دورة المراجعة (review-cycle guard).'
            },
            security: {
                label: 'مراجعة الأمان',
                description: 'عند التحديد، تُستثنى مراجعة الأمان من احتساب حارس دورة المراجعة (review-cycle guard).'
            },
            refactor: {
                label: 'مراجعة إعادة الهيكلة',
                description: 'عند التحديد، تُستثنى مراجعة إعادة الهيكلة من احتساب حارس دورة المراجعة (review-cycle guard).'
            },
            api: {
                label: 'مراجعة API',
                description: 'عند التحديد، تُستثنى مراجعة API من احتساب حارس دورة المراجعة (review-cycle guard).'
            },
            test: {
                label: 'مراجعة الاختبارات',
                description: 'عند التحديد، تُستثنى مراجعة الاختبارات من احتساب حارس دورة المراجعة (review-cycle guard).'
            },
            performance: {
                label: 'مراجعة الأداء',
                description: 'عند التحديد، تُستثنى مراجعة الأداء من احتساب حارس دورة المراجعة (review-cycle guard).'
            },
            infra: {
                label: 'مراجعة البنية التحتية',
                description: 'عند التحديد، تُستثنى مراجعة البنية التحتية من احتساب حارس دورة المراجعة (review-cycle guard).'
            },
            dependency: {
                label: 'مراجعة التبعيات',
                description: 'عند التحديد، تُستثنى مراجعة التبعيات من احتساب حارس دورة المراجعة (review-cycle guard).'
            }
        }
    },
    bn: {
        description: 'একাধিক পছন্দ: চেক করা রিভিউ ধরনগুলো review-cycle guard গণনা থেকে বাদ দেওয়া হয়।',
        options: {
            code: {
                label: 'কোড রিভিউ',
                description: 'চেক করা হলে, কোড রিভিউ review-cycle guard গণনা থেকে বাদ দেওয়া হয়।'
            },
            db: {
                label: 'ডাটাবেস রিভিউ',
                description: 'চেক করা হলে, ডাটাবেস রিভিউ review-cycle guard গণনা থেকে বাদ দেওয়া হয়।'
            },
            security: {
                label: 'নিরাপত্তা রিভিউ',
                description: 'চেক করা হলে, নিরাপত্তা রিভিউ review-cycle guard গণনা থেকে বাদ দেওয়া হয়।'
            },
            refactor: {
                label: 'রিফ্যাক্টর রিভিউ',
                description: 'চেক করা হলে, রিফ্যাক্টর রিভিউ review-cycle guard গণনা থেকে বাদ দেওয়া হয়।'
            },
            api: {
                label: 'API রিভিউ',
                description: 'চেক করা হলে, API রিভিউ review-cycle guard গণনা থেকে বাদ দেওয়া হয়।'
            },
            test: {
                label: 'টেস্ট রিভিউ',
                description: 'চেক করা হলে, টেস্ট রিভিউ review-cycle guard গণনা থেকে বাদ দেওয়া হয়।'
            },
            performance: {
                label: 'পারফরম্যান্স রিভিউ',
                description: 'চেক করা হলে, পারফরম্যান্স রিভিউ review-cycle guard গণনা থেকে বাদ দেওয়া হয়।'
            },
            infra: {
                label: 'ইনফ্রাস্ট্রাকচার রিভিউ',
                description: 'চেক করা হলে, ইনফ্রাস্ট্রাকচার রিভিউ review-cycle guard গণনা থেকে বাদ দেওয়া হয়।'
            },
            dependency: {
                label: 'ডিপেন্ডেন্সি রিভিউ',
                description: 'চেক করা হলে, ডিপেন্ডেন্সি রিভিউ review-cycle guard গণনা থেকে বাদ দেওয়া হয়।'
            }
        }
    },
    de: {
        description: 'Mehrfachauswahl: markierte Review-Typen werden bei der Zählung des Review-Cycle-Schutzes ausgeschlossen.',
        options: {
            code: {
                label: 'Code-Review',
                description: 'Wenn markiert, wird das Code-Review bei der Zählung des Review-Cycle-Schutzes ausgeschlossen.'
            },
            db: {
                label: 'Datenbank-Review',
                description: 'Wenn markiert, wird das Datenbank-Review bei der Zählung des Review-Cycle-Schutzes ausgeschlossen.'
            },
            security: {
                label: 'Sicherheits-Review',
                description: 'Wenn markiert, wird das Sicherheits-Review bei der Zählung des Review-Cycle-Schutzes ausgeschlossen.'
            },
            refactor: {
                label: 'Refactoring-Review',
                description: 'Wenn markiert, wird das Refactoring-Review bei der Zählung des Review-Cycle-Schutzes ausgeschlossen.'
            },
            api: {
                label: 'API-Review',
                description: 'Wenn markiert, wird das API-Review bei der Zählung des Review-Cycle-Schutzes ausgeschlossen.'
            },
            test: {
                label: 'Test-Review',
                description: 'Wenn markiert, wird das Test-Review bei der Zählung des Review-Cycle-Schutzes ausgeschlossen.'
            },
            performance: {
                label: 'Performance-Review',
                description: 'Wenn markiert, wird das Performance-Review bei der Zählung des Review-Cycle-Schutzes ausgeschlossen.'
            },
            infra: {
                label: 'Infrastruktur-Review',
                description: 'Wenn markiert, wird das Infrastruktur-Review bei der Zählung des Review-Cycle-Schutzes ausgeschlossen.'
            },
            dependency: {
                label: 'Abhängigkeits-Review',
                description: 'Wenn markiert, wird das Abhängigkeits-Review bei der Zählung des Review-Cycle-Schutzes ausgeschlossen.'
            }
        }
    },
    es: {
        description: 'Selección múltiple: los tipos de review marcados quedan excluidos del conteo del guard review-cycle.',
        options: {
            code: {
                label: 'Revisión de código',
                description: 'Si está marcado, la revisión de código queda excluida del conteo del guard review-cycle.'
            },
            db: {
                label: 'Revisión de base de datos',
                description: 'Si está marcado, la revisión de base de datos queda excluida del conteo del guard review-cycle.'
            },
            security: {
                label: 'Revisión de seguridad',
                description: 'Si está marcado, la revisión de seguridad queda excluida del conteo del guard review-cycle.'
            },
            refactor: {
                label: 'Revisión de refactorización',
                description: 'Si está marcado, la revisión de refactorización queda excluida del conteo del guard review-cycle.'
            },
            api: {
                label: 'Revisión de API',
                description: 'Si está marcado, la revisión de API queda excluida del conteo del guard review-cycle.'
            },
            test: {
                label: 'Revisión de pruebas',
                description: 'Si está marcado, la revisión de pruebas queda excluida del conteo del guard review-cycle.'
            },
            performance: {
                label: 'Revisión de rendimiento',
                description: 'Si está marcado, la revisión de rendimiento queda excluida del conteo del guard review-cycle.'
            },
            infra: {
                label: 'Revisión de infraestructura',
                description: 'Si está marcado, la revisión de infraestructura queda excluida del conteo del guard review-cycle.'
            },
            dependency: {
                label: 'Revisión de dependencias',
                description: 'Si está marcado, la revisión de dependencias queda excluida del conteo del guard review-cycle.'
            }
        }
    },
    fr: {
        description: 'Choix multiple : les types de review cochés sont exclus du comptage du garde-fou review-cycle.',
        options: {
            code: {
                label: 'Revue de code',
                description: 'Lorsqu\'il est coché, la revue de code est exclue du comptage du garde-fou review-cycle.'
            },
            db: {
                label: 'Revue de base de données',
                description: 'Lorsqu\'elle est cochée, la revue de base de données est exclue du comptage du garde-fou review-cycle.'
            },
            security: {
                label: 'Revue de sécurité',
                description: 'Lorsqu\'elle est cochée, la revue de sécurité est exclue du comptage du garde-fou review-cycle.'
            },
            refactor: {
                label: 'Revue de refactorisation',
                description: 'Lorsqu\'elle est cochée, la revue de refactorisation est exclue du comptage du garde-fou review-cycle.'
            },
            api: {
                label: 'Revue API',
                description: 'Lorsqu\'elle est cochée, la revue API est exclue du comptage du garde-fou review-cycle.'
            },
            test: {
                label: 'Revue de tests',
                description: 'Lorsqu\'elle est cochée, la revue de tests est exclue du comptage du garde-fou review-cycle.'
            },
            performance: {
                label: 'Revue de performance',
                description: 'Lorsqu\'elle est cochée, la revue de performance est exclue du comptage du garde-fou review-cycle.'
            },
            infra: {
                label: 'Revue d\'infrastructure',
                description: 'Lorsqu\'elle est cochée, la revue d\'infrastructure est exclue du comptage du garde-fou review-cycle.'
            },
            dependency: {
                label: 'Revue des dépendances',
                description: 'Lorsqu\'elle est cochée, la revue des dépendances est exclue du comptage du garde-fou review-cycle.'
            }
        }
    },
    hi: {
        description: 'एकाधिक विकल्प: चयनित समीक्षा प्रकार review-cycle guard की गिनती से बाहर रखे जाते हैं।',
        options: {
            code: {
                label: 'कोड समीक्षा',
                description: 'चयन करने पर, कोड समीक्षा review-cycle guard की गिनती से बाहर रखी जाती है।'
            },
            db: {
                label: 'डेटाबेस समीक्षा',
                description: 'चयन करने पर, डेटाबेस समीक्षा review-cycle guard की गिनती से बाहर रखी जाती है।'
            },
            security: {
                label: 'सुरक्षा समीक्षा',
                description: 'चयन करने पर, सुरक्षा समीक्षा review-cycle guard की गिनती से बाहर रखी जाती है।'
            },
            refactor: {
                label: 'रिफैक्टर समीक्षा',
                description: 'चयन करने पर, रिफैक्टर समीक्षा review-cycle guard की गिनती से बाहर रखी जाती है।'
            },
            api: {
                label: 'API समीक्षा',
                description: 'चयन करने पर, API समीक्षा review-cycle guard की गिनती से बाहर रखी जाती है।'
            },
            test: {
                label: 'टेस्ट समीक्षा',
                description: 'चयन करने पर, टेस्ट समीक्षा review-cycle guard की गिनती से बाहर रखी जाती है।'
            },
            performance: {
                label: 'प्रदर्शन समीक्षा',
                description: 'चयन करने पर, प्रदर्शन समीक्षा review-cycle guard की गिनती से बाहर रखी जाती है।'
            },
            infra: {
                label: 'इन्फ्रास्ट्रक्चर समीक्षा',
                description: 'चयन करने पर, इन्फ्रास्ट्रक्चर समीक्षा review-cycle guard की गिनती से बाहर रखी जाती है।'
            },
            dependency: {
                label: 'निर्भरता समीक्षा',
                description: 'चयन करने पर, निर्भरता समीक्षा review-cycle guard की गिनती से बाहर रखी जाती है।'
            }
        }
    },
    id: {
        description: 'Pilihan ganda: jenis review yang dicentang dikecualikan dari penghitungan penjaga siklus review (review-cycle guard).',
        options: {
            code: {
                label: 'Review kode',
                description: 'Jika dicentang, review kode dikecualikan dari penghitungan penjaga siklus review (review-cycle guard).'
            },
            db: {
                label: 'Review basis data',
                description: 'Jika dicentang, review basis data dikecualikan dari penghitungan penjaga siklus review (review-cycle guard).'
            },
            security: {
                label: 'Review keamanan',
                description: 'Jika dicentang, review keamanan dikecualikan dari penghitungan penjaga siklus review (review-cycle guard).'
            },
            refactor: {
                label: 'Review refactor',
                description: 'Jika dicentang, review refactor dikecualikan dari penghitungan penjaga siklus review (review-cycle guard).'
            },
            api: {
                label: 'Review API',
                description: 'Jika dicentang, review API dikecualikan dari penghitungan penjaga siklus review (review-cycle guard).'
            },
            test: {
                label: 'Review pengujian',
                description: 'Jika dicentang, review pengujian dikecualikan dari penghitungan penjaga siklus review (review-cycle guard).'
            },
            performance: {
                label: 'Review performa',
                description: 'Jika dicentang, review performa dikecualikan dari penghitungan penjaga siklus review (review-cycle guard).'
            },
            infra: {
                label: 'Review infrastruktur',
                description: 'Jika dicentang, review infrastruktur dikecualikan dari penghitungan penjaga siklus review (review-cycle guard).'
            },
            dependency: {
                label: 'Review dependensi',
                description: 'Jika dicentang, review dependensi dikecualikan dari penghitungan penjaga siklus review (review-cycle guard).'
            }
        }
    },
    it: {
        description: 'Scelta multipla: i tipi di review selezionati sono esclusi dal conteggio del controllo review-cycle.',
        options: {
            code: {
                label: 'Revisione del codice',
                description: 'Se selezionata, la revisione del codice è esclusa dal conteggio del controllo review-cycle.'
            },
            db: {
                label: 'Revisione del database',
                description: 'Se selezionata, la revisione del database è esclusa dal conteggio del controllo review-cycle.'
            },
            security: {
                label: 'Revisione di sicurezza',
                description: 'Se selezionata, la revisione di sicurezza è esclusa dal conteggio del controllo review-cycle.'
            },
            refactor: {
                label: 'Revisione del refactoring',
                description: 'Se selezionata, la revisione del refactoring è esclusa dal conteggio del controllo review-cycle.'
            },
            api: {
                label: 'Revisione API',
                description: 'Se selezionata, la revisione API è esclusa dal conteggio del controllo review-cycle.'
            },
            test: {
                label: 'Revisione dei test',
                description: 'Se selezionata, la revisione dei test è esclusa dal conteggio del controllo review-cycle.'
            },
            performance: {
                label: 'Revisione delle prestazioni',
                description: 'Se selezionata, la revisione delle prestazioni è esclusa dal conteggio del controllo review-cycle.'
            },
            infra: {
                label: 'Revisione dell\'infrastruttura',
                description: 'Se selezionata, la revisione dell\'infrastruttura è esclusa dal conteggio del controllo review-cycle.'
            },
            dependency: {
                label: 'Revisione delle dipendenze',
                description: 'Se selezionata, la revisione delle dipendenze è esclusa dal conteggio del controllo review-cycle.'
            }
        }
    },
    ja: {
        description: '複数選択：チェックされたレビュータイプは、レビューサイクルガード（review-cycle guard）のカウントから除外されます。',
        options: {
            code: {
                label: 'コードレビュー',
                description: 'チェックすると、コードレビューはレビューサイクルガード（review-cycle guard）のカウントから除外されます。'
            },
            db: {
                label: 'データベースレビュー',
                description: 'チェックすると、データベースレビューはレビューサイクルガード（review-cycle guard）のカウントから除外されます。'
            },
            security: {
                label: 'セキュリティレビュー',
                description: 'チェックすると、セキュリティレビューはレビューサイクルガード（review-cycle guard）のカウントから除外されます。'
            },
            refactor: {
                label: 'リファクタリングレビュー',
                description: 'チェックすると、リファクタリングレビューはレビューサイクルガード（review-cycle guard）のカウントから除外されます。'
            },
            api: {
                label: 'APIレビュー',
                description: 'チェックすると、APIレビューはレビューサイクルガード（review-cycle guard）のカウントから除外されます。'
            },
            test: {
                label: 'テストレビュー',
                description: 'チェックすると、テストレビューはレビューサイクルガード（review-cycle guard）のカウントから除外されます。'
            },
            performance: {
                label: 'パフォーマンスレビュー',
                description: 'チェックすると、パフォーマンスレビューはレビューサイクルガード（review-cycle guard）のカウントから除外されます。'
            },
            infra: {
                label: 'インフラレビュー',
                description: 'チェックすると、インフラレビューはレビューサイクルガード（review-cycle guard）のカウントから除外されます。'
            },
            dependency: {
                label: '依存関係レビュー',
                description: 'チェックすると、依存関係レビューはレビューサイクルガード（review-cycle guard）のカウントから除外されます。'
            }
        }
    },
    ko: {
        description: '다중 선택: 선택한 리뷰 유형은 review-cycle guard 집계에서 제외됩니다.',
        options: {
            code: {
                label: '코드 리뷰',
                description: '선택하면 코드 리뷰는 review-cycle guard 집계에서 제외됩니다.'
            },
            db: {
                label: '데이터베이스 리뷰',
                description: '선택하면 데이터베이스 리뷰는 review-cycle guard 집계에서 제외됩니다.'
            },
            security: {
                label: '보안 리뷰',
                description: '선택하면 보안 리뷰는 review-cycle guard 집계에서 제외됩니다.'
            },
            refactor: {
                label: '리팩터링 리뷰',
                description: '선택하면 리팩터링 리뷰는 review-cycle guard 집계에서 제외됩니다.'
            },
            api: {
                label: 'API 리뷰',
                description: '선택하면 API 리뷰는 review-cycle guard 집계에서 제외됩니다.'
            },
            test: {
                label: '테스트 리뷰',
                description: '선택하면 테스트 리뷰는 review-cycle guard 집계에서 제외됩니다.'
            },
            performance: {
                label: '성능 리뷰',
                description: '선택하면 성능 리뷰는 review-cycle guard 집계에서 제외됩니다.'
            },
            infra: {
                label: '인프라 리뷰',
                description: '선택하면 인프라 리뷰는 review-cycle guard 집계에서 제외됩니다.'
            },
            dependency: {
                label: '의존성 리뷰',
                description: '선택하면 의존성 리뷰는 review-cycle guard 집계에서 제외됩니다.'
            }
        }
    },
    nl: {
        description: 'Meervoudige keuze: aangevinkte reviewtypes worden uitgesloten van de telling van de review-cycle guard.',
        options: {
            code: {
                label: 'Codereview',
                description: 'Indien aangevinkt, wordt codereview uitgesloten van de telling van de review-cycle guard.'
            },
            db: {
                label: 'Database-review',
                description: 'Indien aangevinkt, wordt database-review uitgesloten van de telling van de review-cycle guard.'
            },
            security: {
                label: 'Beveiligingsreview',
                description: 'Indien aangevinkt, wordt beveiligingsreview uitgesloten van de telling van de review-cycle guard.'
            },
            refactor: {
                label: 'Refactor-review',
                description: 'Indien aangevinkt, wordt refactor-review uitgesloten van de telling van de review-cycle guard.'
            },
            api: {
                label: 'API-review',
                description: 'Indien aangevinkt, wordt API-review uitgesloten van de telling van de review-cycle guard.'
            },
            test: {
                label: 'Testreview',
                description: 'Indien aangevinkt, wordt testreview uitgesloten van de telling van de review-cycle guard.'
            },
            performance: {
                label: 'Performancereview',
                description: 'Indien aangevinkt, wordt performancereview uitgesloten van de telling van de review-cycle guard.'
            },
            infra: {
                label: 'Infrastructuurreview',
                description: 'Indien aangevinkt, wordt infrastructuurreview uitgesloten van de telling van de review-cycle guard.'
            },
            dependency: {
                label: 'Afhankelijkheidsreview',
                description: 'Indien aangevinkt, wordt afhankelijkheidsreview uitgesloten van de telling van de review-cycle guard.'
            }
        }
    },
    pl: {
        description: 'Wielokrotny wybór: zaznaczone typy review są wykluczane z liczenia przez kontrolę review-cycle guard.',
        options: {
            code: {
                label: 'Przegląd kodu',
                description: 'Po zaznaczeniu przegląd kodu jest wykluczany z liczenia przez kontrolę review-cycle guard.'
            },
            db: {
                label: 'Przegląd bazy danych',
                description: 'Po zaznaczeniu przegląd bazy danych jest wykluczany z liczenia przez kontrolę review-cycle guard.'
            },
            security: {
                label: 'Przegląd bezpieczeństwa',
                description: 'Po zaznaczeniu przegląd bezpieczeństwa jest wykluczany z liczenia przez kontrolę review-cycle guard.'
            },
            refactor: {
                label: 'Przegląd refaktoryzacji',
                description: 'Po zaznaczeniu przegląd refaktoryzacji jest wykluczany z liczenia przez kontrolę review-cycle guard.'
            },
            api: {
                label: 'Przegląd API',
                description: 'Po zaznaczeniu przegląd API jest wykluczany z liczenia przez kontrolę review-cycle guard.'
            },
            test: {
                label: 'Przegląd testów',
                description: 'Po zaznaczeniu przegląd testów jest wykluczany z liczenia przez kontrolę review-cycle guard.'
            },
            performance: {
                label: 'Przegląd wydajności',
                description: 'Po zaznaczeniu przegląd wydajności jest wykluczany z liczenia przez kontrolę review-cycle guard.'
            },
            infra: {
                label: 'Przegląd infrastruktury',
                description: 'Po zaznaczeniu przegląd infrastruktury jest wykluczany z liczenia przez kontrolę review-cycle guard.'
            },
            dependency: {
                label: 'Przegląd zależności',
                description: 'Po zaznaczeniu przegląd zależności jest wykluczany z liczenia przez kontrolę review-cycle guard.'
            }
        }
    },
    pt: {
        description: 'Escolha múltipla: os tipos de review selecionados ficam excluídos da contagem da guarda review-cycle.',
        options: {
            code: {
                label: 'Revisão de código',
                description: 'Quando selecionada, a revisão de código fica excluída da contagem da guarda review-cycle.'
            },
            db: {
                label: 'Revisão de base de dados',
                description: 'Quando selecionada, a revisão de base de dados fica excluída da contagem da guarda review-cycle.'
            },
            security: {
                label: 'Revisão de segurança',
                description: 'Quando selecionada, a revisão de segurança fica excluída da contagem da guarda review-cycle.'
            },
            refactor: {
                label: 'Revisão de refatoração',
                description: 'Quando selecionada, a revisão de refatoração fica excluída da contagem da guarda review-cycle.'
            },
            api: {
                label: 'Revisão de API',
                description: 'Quando selecionada, a revisão de API fica excluída da contagem da guarda review-cycle.'
            },
            test: {
                label: 'Revisão de testes',
                description: 'Quando selecionada, a revisão de testes fica excluída da contagem da guarda review-cycle.'
            },
            performance: {
                label: 'Revisão de desempenho',
                description: 'Quando selecionada, a revisão de desempenho fica excluída da contagem da guarda review-cycle.'
            },
            infra: {
                label: 'Revisão de infraestrutura',
                description: 'Quando selecionada, a revisão de infraestrutura fica excluída da contagem da guarda review-cycle.'
            },
            dependency: {
                label: 'Revisão de dependências',
                description: 'Quando selecionada, a revisão de dependências fica excluída da contagem da guarda review-cycle.'
            }
        }
    },
    'pt-BR': {
        description: 'Múltipla escolha: os tipos de review marcados ficam excluídos da contagem da guarda review-cycle.',
        options: {
            code: {
                label: 'Revisão de código',
                description: 'Quando marcada, a revisão de código fica excluída da contagem da guarda review-cycle.'
            },
            db: {
                label: 'Revisão de banco de dados',
                description: 'Quando marcada, a revisão de banco de dados fica excluída da contagem da guarda review-cycle.'
            },
            security: {
                label: 'Revisão de segurança',
                description: 'Quando marcada, a revisão de segurança fica excluída da contagem da guarda review-cycle.'
            },
            refactor: {
                label: 'Revisão de refatoração',
                description: 'Quando marcada, a revisão de refatoração fica excluída da contagem da guarda review-cycle.'
            },
            api: {
                label: 'Revisão de API',
                description: 'Quando marcada, a revisão de API fica excluída da contagem da guarda review-cycle.'
            },
            test: {
                label: 'Revisão de testes',
                description: 'Quando marcada, a revisão de testes fica excluída da contagem da guarda review-cycle.'
            },
            performance: {
                label: 'Revisão de desempenho',
                description: 'Quando marcada, a revisão de desempenho fica excluída da contagem da guarda review-cycle.'
            },
            infra: {
                label: 'Revisão de infraestrutura',
                description: 'Quando marcada, a revisão de infraestrutura fica excluída da contagem da guarda review-cycle.'
            },
            dependency: {
                label: 'Revisão de dependências',
                description: 'Quando marcada, a revisão de dependências fica excluída da contagem da guarda review-cycle.'
            }
        }
    },
    ru: {
        description: 'Множественный выбор: отмеченные типы ревью не учитываются в подсчёте лимитов review-cycle guard.',
        options: {
            code: {
                label: 'Ревью кода',
                description: 'Если отмечено, ревью кода не учитывается в лимитах review-cycle guard.'
            },
            db: {
                label: 'Ревью базы данных',
                description: 'Если отмечено, ревью базы данных не учитывается в лимитах review-cycle guard.'
            },
            security: {
                label: 'Security-ревью',
                description: 'Если отмечено, security-ревью не учитывается в лимитах review-cycle guard.'
            },
            refactor: {
                label: 'Refactor-ревью',
                description: 'Если отмечено, refactor-ревью не учитывается в лимитах review-cycle guard.'
            },
            api: {
                label: 'API-ревью',
                description: 'Если отмечено, API-ревью не учитывается в лимитах review-cycle guard.'
            },
            test: {
                label: 'Test-ревью',
                description: 'Если отмечено, test-ревью не учитывается в лимитах review-cycle guard.'
            },
            performance: {
                label: 'Performance-ревью',
                description: 'Если отмечено, performance-ревью не учитывается в лимитах review-cycle guard.'
            },
            infra: {
                label: 'Infrastructure-ревью',
                description: 'Если отмечено, infrastructure-ревью не учитывается в лимитах review-cycle guard.'
            },
            dependency: {
                label: 'Dependency-ревью',
                description: 'Если отмечено, dependency-ревью не учитывается в лимитах review-cycle guard.'
            }
        }
    },
    sv: {
        description: 'Flerval: ikryssade review-typer exkluderas från räkningen i review-cykelvakten (review-cycle guard).',
        options: {
            code: {
                label: 'Kodgranskning',
                description: 'När den är ikryssad exkluderas kodgranskningen från räkningen i review-cykelvakten (review-cycle guard).'
            },
            db: {
                label: 'Databasgranskning',
                description: 'När den är ikryssad exkluderas databasgranskningen från räkningen i review-cykelvakten (review-cycle guard).'
            },
            security: {
                label: 'Säkerhetsgranskning',
                description: 'När den är ikryssad exkluderas säkerhetsgranskningen från räkningen i review-cykelvakten (review-cycle guard).'
            },
            refactor: {
                label: 'Refaktoriseringsgranskning',
                description: 'När den är ikryssad exkluderas refaktoriseringsgranskningen från räkningen i review-cykelvakten (review-cycle guard).'
            },
            api: {
                label: 'API-granskning',
                description: 'När den är ikryssad exkluderas API-granskningen från räkningen i review-cykelvakten (review-cycle guard).'
            },
            test: {
                label: 'Testgranskning',
                description: 'När den är ikryssad exkluderas testgranskningen från räkningen i review-cykelvakten (review-cycle guard).'
            },
            performance: {
                label: 'Prestandagranskning',
                description: 'När den är ikryssad exkluderas prestandagranskningen från räkningen i review-cykelvakten (review-cycle guard).'
            },
            infra: {
                label: 'Infrastrukturgranskning',
                description: 'När den är ikryssad exkluderas infrastrukturgranskningen från räkningen i review-cykelvakten (review-cycle guard).'
            },
            dependency: {
                label: 'Beroendegranskning',
                description: 'När den är ikryssad exkluderas beroendegranskningen från räkningen i review-cykelvakten (review-cycle guard).'
            }
        }
    },
    tr: {
        description: 'Çoklu seçim: işaretlenen inceleme türleri review-cycle guard sayımından hariç tutulur.',
        options: {
            code: {
                label: 'Kod incelemesi',
                description: 'İşaretlendiğinde, kod incelemesi review-cycle guard sayımından hariç tutulur.'
            },
            db: {
                label: 'Veritabanı incelemesi',
                description: 'İşaretlendiğinde, veritabanı incelemesi review-cycle guard sayımından hariç tutulur.'
            },
            security: {
                label: 'Güvenlik incelemesi',
                description: 'İşaretlendiğinde, güvenlik incelemesi review-cycle guard sayımından hariç tutulur.'
            },
            refactor: {
                label: 'Refaktör incelemesi',
                description: 'İşaretlendiğinde, refaktör incelemesi review-cycle guard sayımından hariç tutulur.'
            },
            api: {
                label: 'API incelemesi',
                description: 'İşaretlendiğinde, API incelemesi review-cycle guard sayımından hariç tutulur.'
            },
            test: {
                label: 'Test incelemesi',
                description: 'İşaretlendiğinde, test incelemesi review-cycle guard sayımından hariç tutulur.'
            },
            performance: {
                label: 'Performans incelemesi',
                description: 'İşaretlendiğinde, performans incelemesi review-cycle guard sayımından hariç tutulur.'
            },
            infra: {
                label: 'Altyapı incelemesi',
                description: 'İşaretlendiğinde, altyapı incelemesi review-cycle guard sayımından hariç tutulur.'
            },
            dependency: {
                label: 'Bağımlılık incelemesi',
                description: 'İşaretlendiğinde, bağımlılık incelemesi review-cycle guard sayımından hariç tutulur.'
            }
        }
    },
    uk: {
        description: 'Множинний вибір: позначені типи рев\'ю не враховуються в підрахунку лімітів review-cycle guard.',
        options: {
            code: {
                label: 'Рев\'ю коду',
                description: 'Якщо позначено, рев\'ю коду не враховується в лімітах review-cycle guard.'
            },
            db: {
                label: 'Рев\'ю бази даних',
                description: 'Якщо позначено, рев\'ю бази даних не враховується в лімітах review-cycle guard.'
            },
            security: {
                label: 'Security-рев\'ю',
                description: 'Якщо позначено, security-рев\'ю не враховується в лімітах review-cycle guard.'
            },
            refactor: {
                label: 'Refactor-рев\'ю',
                description: 'Якщо позначено, refactor-рев\'ю не враховується в лімітах review-cycle guard.'
            },
            api: {
                label: 'API-рев\'ю',
                description: 'Якщо позначено, API-рев\'ю не враховується в лімітах review-cycle guard.'
            },
            test: {
                label: 'Test-рев\'ю',
                description: 'Якщо позначено, test-рев\'ю не враховується в лімітах review-cycle guard.'
            },
            performance: {
                label: 'Performance-рев\'ю',
                description: 'Якщо позначено, performance-рев\'ю не враховується в лімітах review-cycle guard.'
            },
            infra: {
                label: 'Infrastructure-рев\'ю',
                description: 'Якщо позначено, infrastructure-рев\'ю не враховується в лімітах review-cycle guard.'
            },
            dependency: {
                label: 'Dependency-рев\'ю',
                description: 'Якщо позначено, dependency-рев\'ю не враховується в лімітах review-cycle guard.'
            }
        }
    },
    vi: {
        description: 'Chọn nhiều: các loại review được chọn sẽ bị loại khỏi việc tính giới hạn của review-cycle guard.',
        options: {
            code: {
                label: 'Review mã nguồn',
                description: 'Khi được chọn, review mã nguồn sẽ bị loại khỏi việc tính giới hạn của review-cycle guard.'
            },
            db: {
                label: 'Review cơ sở dữ liệu',
                description: 'Khi được chọn, review cơ sở dữ liệu sẽ bị loại khỏi việc tính giới hạn của review-cycle guard.'
            },
            security: {
                label: 'Review bảo mật',
                description: 'Khi được chọn, review bảo mật sẽ bị loại khỏi việc tính giới hạn của review-cycle guard.'
            },
            refactor: {
                label: 'Review refactor',
                description: 'Khi được chọn, review refactor sẽ bị loại khỏi việc tính giới hạn của review-cycle guard.'
            },
            api: {
                label: 'Review API',
                description: 'Khi được chọn, review API sẽ bị loại khỏi việc tính giới hạn của review-cycle guard.'
            },
            test: {
                label: 'Review kiểm thử',
                description: 'Khi được chọn, review kiểm thử sẽ bị loại khỏi việc tính giới hạn của review-cycle guard.'
            },
            performance: {
                label: 'Review hiệu năng',
                description: 'Khi được chọn, review hiệu năng sẽ bị loại khỏi việc tính giới hạn của review-cycle guard.'
            },
            infra: {
                label: 'Review hạ tầng',
                description: 'Khi được chọn, review hạ tầng sẽ bị loại khỏi việc tính giới hạn của review-cycle guard.'
            },
            dependency: {
                label: 'Review phụ thuộc',
                description: 'Khi được chọn, review phụ thuộc sẽ bị loại khỏi việc tính giới hạn của review-cycle guard.'
            }
        }
    },
    'zh-CN': {
        description: '多选：勾选的评审类型不计入 review-cycle guard 的限额统计。',
        options: {
            code: {
                label: '代码评审',
                description: '勾选后，代码评审不计入 review-cycle guard 的限额统计。'
            },
            db: {
                label: '数据库评审',
                description: '勾选后，数据库评审不计入 review-cycle guard 的限额统计。'
            },
            security: {
                label: '安全评审',
                description: '勾选后，安全评审不计入 review-cycle guard 的限额统计。'
            },
            refactor: {
                label: '重构评审',
                description: '勾选后，重构评审不计入 review-cycle guard 的限额统计。'
            },
            api: {
                label: 'API 评审',
                description: '勾选后，API 评审不计入 review-cycle guard 的限额统计。'
            },
            test: {
                label: '测试评审',
                description: '勾选后，测试评审不计入 review-cycle guard 的限额统计。'
            },
            performance: {
                label: '性能评审',
                description: '勾选后，性能评审不计入 review-cycle guard 的限额统计。'
            },
            infra: {
                label: '基础设施评审',
                description: '勾选后，基础设施评审不计入 review-cycle guard 的限额统计。'
            },
            dependency: {
                label: '依赖评审',
                description: '勾选后，依赖评审不计入 review-cycle guard 的限额统计。'
            }
        }
    }
};

function assertPatchShape(languageId, patch) {
    if (!patch?.description?.trim()) {
        throw new Error(`Missing description patch for ${languageId}`);
    }
    for (const optionKey of OPTION_KEYS) {
        const option = patch.options?.[optionKey];
        if (!option?.label?.trim() || !option?.description?.trim()) {
            throw new Error(`Missing option patch for ${languageId}.${optionKey}`);
        }
    }
}

function patchLanguageFile(languageId) {
    const patch = PATCHES[languageId];
    if (!patch) {
        throw new Error(`No patch defined for language '${languageId}'`);
    }
    assertPatchShape(languageId, patch);

    const filePath = path.join(langDir, `${languageId}.json`);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Language file not found: ${filePath}`);
    }

    const pack = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const existing = pack[SETTING_ID];
    if (!existing) {
        throw new Error(`${languageId}.json is missing setting '${SETTING_ID}'`);
    }

    pack[SETTING_ID] = {
        ...existing,
        description: patch.description,
        options: {
            ...(existing.options || {}),
            ...patch.options
        }
    };

    fs.writeFileSync(filePath, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
    return filePath;
}

const languageIds = Object.keys(PATCHES).sort((a, b) => a.localeCompare(b));
const patchedFiles = [];

for (const languageId of languageIds) {
    patchedFiles.push(patchLanguageFile(languageId));
}

console.log(`Patched ${patchedFiles.length} language file(s) for '${SETTING_ID}':`);
for (const filePath of patchedFiles) {
    console.log(`  - ${path.relative(repoRoot, filePath)}`);
}
