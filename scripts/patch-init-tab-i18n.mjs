import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packsDir = path.join(repoRoot, 'src', 'reports', 'ui', 'lang-packs');

const INIT_TAB_CHROME = {
    ar: {
        ordinaryDocsTitle: 'المستندات العادية',
        ordinaryDocsHelp: 'المستندات العادية هي مستندات تخطيط أو سجل تغييرات أو منتج يملكها المستخدم. تبقى تغييرات هذه المسارات قابلة للتدقيق لكنها لا تُفعّل مسارات مراجعة إضافية بمفردها.',
        ordinaryDocsPath: 'مسار المستند',
        ordinaryDocsEmpty: 'لم يتم تكوين مسارات مستندات عادية.',
        ordinaryDocsActionsDisabled: 'تعديل المستندات العادية معطّل. أعد التشغيل مع',
        addOrdinaryDoc: 'إضافة مستند',
        removeOrdinaryDoc: 'إزالة'
    },
    bn: {
        ordinaryDocsTitle: 'সাধারণ নথি',
        ordinaryDocsHelp: 'সাধারণ নথি হলো ব্যবহারকারী-মালিকানাধীন পরিকল্পনা, চেঞ্জলগ বা প্রোডাক্ট ডক। এই পাথে পরিবর্তন অডিটযোগ্য থাকে, কিন্তু নিজে থেকে অতিরিক্ত রিভিউ লেন ট্রিগার করে না।',
        ordinaryDocsPath: 'নথির পাথ',
        ordinaryDocsEmpty: 'কোনো সাধারণ নথির পাথ কনফিগার করা নেই।',
        ordinaryDocsActionsDisabled: 'সাধারণ নথি সম্পাদনা নিষ্ক্রিয়। পুনরায় চালু করুন',
        addOrdinaryDoc: 'নথি যোগ করুন',
        removeOrdinaryDoc: 'সরান'
    },
    de: {
        ordinaryDocsTitle: 'Gewöhnliche Dokumente',
        ordinaryDocsHelp: 'Gewöhnliche Dokumente sind benutzereigene Planungs-, Changelog- oder Produktdokumente. Änderungen an diesen Pfaden bleiben prüfbar, lösen aber für sich allein keine zusätzlichen Review-Lanes aus.',
        ordinaryDocsPath: 'Dokumentpfad',
        ordinaryDocsEmpty: 'Keine Pfade für gewöhnliche Dokumente konfiguriert.',
        ordinaryDocsActionsDisabled: 'Bearbeitung gewöhnlicher Dokumente ist deaktiviert. Neu starten mit',
        addOrdinaryDoc: 'Dokument hinzufügen',
        removeOrdinaryDoc: 'Entfernen'
    },
    es: {
        ordinaryDocsTitle: 'Documentos ordinarios',
        ordinaryDocsHelp: 'Los documentos ordinarios son documentos de planificación, changelog o producto del usuario. Los cambios en estas rutas siguen siendo auditables, pero no activan por sí solos carriles de revisión adicionales.',
        ordinaryDocsPath: 'Ruta del documento',
        ordinaryDocsEmpty: 'No hay rutas de documentos ordinarios configuradas.',
        ordinaryDocsActionsDisabled: 'La edición de documentos ordinarios está deshabilitada. Reinicie con',
        addOrdinaryDoc: 'Añadir documento',
        removeOrdinaryDoc: 'Eliminar'
    },
    fr: {
        ordinaryDocsTitle: 'Documents ordinaires',
        ordinaryDocsHelp: 'Les documents ordinaires sont des docs de planification, changelog ou produit appartenant à l’utilisateur. Les changements sur ces chemins restent auditables mais ne déclenchent pas à eux seuls des voies de revue supplémentaires.',
        ordinaryDocsPath: 'Chemin du document',
        ordinaryDocsEmpty: 'Aucun chemin de document ordinaire configuré.',
        ordinaryDocsActionsDisabled: 'La modification des documents ordinaires est désactivée. Redémarrez avec',
        addOrdinaryDoc: 'Ajouter un document',
        removeOrdinaryDoc: 'Supprimer'
    },
    hi: {
        ordinaryDocsTitle: 'साधारण दस्तावेज़',
        ordinaryDocsHelp: 'साधारण दस्तावेज़ उपयोगकर्ता के स्वामित्व वाले planning, changelog या product docs होते हैं। इन पथों में बदलाव ऑडिट योग्य रहते हैं, लेकिन अपने आप अतिरिक्त review lanes ट्रिगर नहीं करते।',
        ordinaryDocsPath: 'दस्तावेज़ पथ',
        ordinaryDocsEmpty: 'कोई साधारण दस्तावेज़ पथ कॉन्फ़िगर नहीं है।',
        ordinaryDocsActionsDisabled: 'साधारण दस्तावेज़ संपादन अक्षम है। पुनः प्रारंभ करें',
        addOrdinaryDoc: 'दस्तावेज़ जोड़ें',
        removeOrdinaryDoc: 'हटाएँ'
    },
    id: {
        ordinaryDocsTitle: 'Dokumen biasa',
        ordinaryDocsHelp: 'Dokumen biasa adalah dokumen perencanaan, changelog, atau produk milik pengguna. Perubahan pada path ini tetap dapat diaudit tetapi tidak memicu jalur review tambahan sendiri.',
        ordinaryDocsPath: 'Path dokumen',
        ordinaryDocsEmpty: 'Tidak ada path dokumen biasa yang dikonfigurasi.',
        ordinaryDocsActionsDisabled: 'Pengeditan dokumen biasa dinonaktifkan. Mulai ulang dengan',
        addOrdinaryDoc: 'Tambah dokumen',
        removeOrdinaryDoc: 'Hapus'
    },
    it: {
        ordinaryDocsTitle: 'Documenti ordinari',
        ordinaryDocsHelp: 'I documenti ordinari sono documenti di pianificazione, changelog o prodotto di proprietà dell’utente. Le modifiche a questi percorsi restano verificabili ma non attivano da sole ulteriori corsie di review.',
        ordinaryDocsPath: 'Percorso documento',
        ordinaryDocsEmpty: 'Nessun percorso di documento ordinario configurato.',
        ordinaryDocsActionsDisabled: 'La modifica dei documenti ordinari è disabilitata. Riavvia con',
        addOrdinaryDoc: 'Aggiungi documento',
        removeOrdinaryDoc: 'Rimuovi'
    },
    ja: {
        ordinaryDocsTitle: '通常ドキュメント',
        ordinaryDocsHelp: '通常ドキュメントはユーザー所有の計画・changelog・プロダクト文書です。これらのパスへの変更は監査可能ですが、それ自体では追加のレビューレーンをトリガーしません。',
        ordinaryDocsPath: 'ドキュメントパス',
        ordinaryDocsEmpty: '通常ドキュメントのパスが設定されていません。',
        ordinaryDocsActionsDisabled: '通常ドキュメントの編集は無効です。次で再起動してください',
        addOrdinaryDoc: 'ドキュメントを追加',
        removeOrdinaryDoc: '削除'
    },
    ko: {
        ordinaryDocsTitle: '일반 문서',
        ordinaryDocsHelp: '일반 문서는 사용자 소유의 계획, changelog 또는 제품 문서입니다. 이러한 경로의 변경은 감사 가능하지만 그 자체로 추가 검토 레인을 트리거하지 않습니다.',
        ordinaryDocsPath: '문서 경로',
        ordinaryDocsEmpty: '구성된 일반 문서 경로가 없습니다.',
        ordinaryDocsActionsDisabled: '일반 문서 편집이 비활성화되어 있습니다. 다음으로 다시 시작하세요',
        addOrdinaryDoc: '문서 추가',
        removeOrdinaryDoc: '제거'
    },
    nl: {
        ordinaryDocsTitle: 'Gewone documenten',
        ordinaryDocsHelp: 'Gewone documenten zijn door de gebruiker beheerde planning-, changelog- of productdocumenten. Wijzigingen aan deze paden blijven controleerbaar maar activeren op zichzelf geen extra reviewlanes.',
        ordinaryDocsPath: 'Documentpad',
        ordinaryDocsEmpty: 'Geen paden voor gewone documenten geconfigureerd.',
        ordinaryDocsActionsDisabled: 'Bewerken van gewone documenten is uitgeschakeld. Herstart met',
        addOrdinaryDoc: 'Document toevoegen',
        removeOrdinaryDoc: 'Verwijderen'
    },
    pl: {
        ordinaryDocsTitle: 'Zwykłe dokumenty',
        ordinaryDocsHelp: 'Zwykłe dokumenty to należące do użytkownika dokumenty planowania, changelog lub produktu. Zmiany tych ścieżek pozostają audytowalne, ale same w sobie nie uruchamiają dodatkowych ścieżek review.',
        ordinaryDocsPath: 'Ścieżka dokumentu',
        ordinaryDocsEmpty: 'Brak skonfigurowanych ścieżek zwykłych dokumentów.',
        ordinaryDocsActionsDisabled: 'Edycja zwykłych dokumentów jest wyłączona. Uruchom ponownie z',
        addOrdinaryDoc: 'Dodaj dokument',
        removeOrdinaryDoc: 'Usuń'
    },
    pt: {
        ordinaryDocsTitle: 'Documentos ordinários',
        ordinaryDocsHelp: 'Documentos ordinários são documentos de planeamento, changelog ou produto do utilizador. As alterações a estes caminhos permanecem auditáveis, mas não acionam por si só faixas de revisão adicionais.',
        ordinaryDocsPath: 'Caminho do documento',
        ordinaryDocsEmpty: 'Nenhum caminho de documento ordinário configurado.',
        ordinaryDocsActionsDisabled: 'A edição de documentos ordinários está desativada. Reinicie com',
        addOrdinaryDoc: 'Adicionar documento',
        removeOrdinaryDoc: 'Remover'
    },
    'pt-BR': {
        ordinaryDocsTitle: 'Documentos ordinários',
        ordinaryDocsHelp: 'Documentos ordinários são documentos de planejamento, changelog ou produto do usuário. Alterações nesses caminhos permanecem auditáveis, mas não disparam sozinhas faixas de revisão adicionais.',
        ordinaryDocsPath: 'Caminho do documento',
        ordinaryDocsEmpty: 'Nenhum caminho de documento ordinário configurado.',
        ordinaryDocsActionsDisabled: 'A edição de documentos ordinários está desativada. Reinicie com',
        addOrdinaryDoc: 'Adicionar documento',
        removeOrdinaryDoc: 'Remover'
    },
    ru: {
        ordinaryDocsTitle: 'Обычные документы',
        ordinaryDocsHelp: 'Обычные документы — это пользовательские planning, changelog или product docs. Изменения этих путей остаются проверяемыми, но сами по себе не триггерят лишние виды ревью.',
        ordinaryDocsPath: 'Путь к документу',
        ordinaryDocsEmpty: 'Обычные документы не настроены.',
        ordinaryDocsActionsDisabled: 'Редактирование обычных документов отключено. Перезапустите с',
        addOrdinaryDoc: 'Добавить документ',
        removeOrdinaryDoc: 'Удалить'
    },
    sv: {
        ordinaryDocsTitle: 'Vanliga dokument',
        ordinaryDocsHelp: 'Vanliga dokument är användarägda planerings-, changelog- eller produktdokument. Ändringar av dessa sökvägar förblir granskningsbara men utlöser inte extra review-lanes av sig själva.',
        ordinaryDocsPath: 'Dokumentsökväg',
        ordinaryDocsEmpty: 'Inga sökvägar för vanliga dokument är konfigurerade.',
        ordinaryDocsActionsDisabled: 'Redigering av vanliga dokument är inaktiverad. Starta om med',
        addOrdinaryDoc: 'Lägg till dokument',
        removeOrdinaryDoc: 'Ta bort'
    },
    tr: {
        ordinaryDocsTitle: 'Sıradan belgeler',
        ordinaryDocsHelp: 'Sıradan belgeler kullanıcıya ait planlama, changelog veya ürün belgeleridir. Bu yollardaki değişiklikler denetlenebilir kalır ancak tek başlarına ek inceleme hatlarını tetiklemez.',
        ordinaryDocsPath: 'Belge yolu',
        ordinaryDocsEmpty: 'Yapılandırılmış sıradan belge yolu yok.',
        ordinaryDocsActionsDisabled: 'Sıradan belge düzenleme devre dışı. Şununla yeniden başlatın',
        addOrdinaryDoc: 'Belge ekle',
        removeOrdinaryDoc: 'Kaldır'
    },
    uk: {
        ordinaryDocsTitle: 'Звичайні документи',
        ordinaryDocsHelp: 'Звичайні документи — це користувацькі planning, changelog або product docs. Зміни цих шляхів залишаються перевірюваними, але самі по собі не запускають зайві види ревʼю.',
        ordinaryDocsPath: 'Шлях до документа',
        ordinaryDocsEmpty: 'Звичайні документи не налаштовані.',
        ordinaryDocsActionsDisabled: 'Редагування звичайних документів вимкнено. Перезапустіть з',
        addOrdinaryDoc: 'Додати документ',
        removeOrdinaryDoc: 'Видалити'
    },
    vi: {
        ordinaryDocsTitle: 'Tài liệu thường',
        ordinaryDocsHelp: 'Tài liệu thường là tài liệu lập kế hoạch, changelog hoặc sản phẩm do người dùng sở hữu. Thay đổi các đường dẫn này vẫn có thể kiểm toán nhưng không tự kích hoạt làn review bổ sung.',
        ordinaryDocsPath: 'Đường dẫn tài liệu',
        ordinaryDocsEmpty: 'Chưa cấu hình đường dẫn tài liệu thường.',
        ordinaryDocsActionsDisabled: 'Chỉnh sửa tài liệu thường bị tắt. Khởi động lại với',
        addOrdinaryDoc: 'Thêm tài liệu',
        removeOrdinaryDoc: 'Xóa'
    },
    'zh-CN': {
        ordinaryDocsTitle: '普通文档',
        ordinaryDocsHelp: '普通文档是用户拥有的规划、changelog 或产品文档。这些路径的更改仍可审计，但不会自行触发额外的审查通道。',
        ordinaryDocsPath: '文档路径',
        ordinaryDocsEmpty: '未配置普通文档路径。',
        ordinaryDocsActionsDisabled: '普通文档编辑已禁用。请使用以下方式重启',
        addOrdinaryDoc: '添加文档',
        removeOrdinaryDoc: '移除'
    }
};

const INIT_INSTRUCTION = {
    ar: { title: 'إعدادات التهيئة', body: 'تعرض علامة تبويب إعدادات التهيئة الإجابات الحالية ونقاط تفتيش تهيئة الوكيل الإلزامية وإدارة المستندات العادية ومطالبة handoff لإكمال onboarding.' },
    bn: { title: 'ইনিশিয়ালাইজেশন সেটিংস', body: 'ইনিশিয়ালাইজেশন সেটিংস ট্যাবে বর্তমান উত্তর, বাধ্যতামূলক এজেন্ট init checkpoint, সাধারণ নথি ব্যবস্থাপনা এবং onboarding সম্পন্ন করার handoff prompt দেখায়।' },
    de: { title: 'Initialisierungseinstellungen', body: 'Die Registerkarte Initialisierungseinstellungen zeigt aktuelle Antworten, erforderliche Agent-Init-Checkpoints, Verwaltung gewöhnlicher Dokumente und den Handoff-Prompt zum Abschluss des Onboardings.' },
    es: { title: 'Configuración de inicio', body: 'La pestaña de configuración de inicio muestra las respuestas actuales, los checkpoints obligatorios de inicio del agente, la gestión de documentos ordinarios y el prompt de handoff para completar el onboarding.' },
    fr: { title: 'Paramètres d’initialisation', body: 'L’onglet des paramètres d’initialisation affiche les réponses actuelles, les checkpoints d’initialisation agent obligatoires, la gestion des documents ordinaires et le prompt de handoff pour terminer l’onboarding.' },
    hi: { title: 'इनिट सेटिंग्स', body: 'इनिट सेटिंग्स टैब वर्तमान उत्तर, अनिवार्य एजेंट init checkpoint, साधारण दस्तावेज़ प्रबंधन और onboarding पूरा करने के लिए handoff prompt दिखाता है।' },
    id: { title: 'Pengaturan awal', body: 'Tab pengaturan awal menampilkan jawaban saat ini, checkpoint init agen wajib, pengelolaan dokumen biasa, dan prompt handoff untuk menyelesaikan onboarding.' },
    it: { title: 'Impostazioni di inizializzazione', body: 'La scheda impostazioni di inizializzazione mostra le risposte correnti, i checkpoint obbligatori di init agente, la gestione dei documenti ordinari e il prompt di handoff per completare l’onboarding.' },
    ja: { title: '初期設定', body: '初期設定タブには現在の回答、必須のエージェント init チェックポイント、通常ドキュメント管理、オンボーディング完了用の handoff プロンプトが表示されます。' },
    ko: { title: '초기화 설정', body: '초기화 설정 탭에는 현재 응답, 필수 에이전트 init 체크포인트, 일반 문서 관리, 온보딩 완료용 handoff 프롬프트가 표시됩니다.' },
    nl: { title: 'Instellingen starten', body: 'Het tabblad init-instellingen toont huidige antwoorden, verplichte agent-init-checkpoints, beheer van gewone documenten en de handoff-prompt om onboarding af te ronden.' },
    pl: { title: 'Ustawienia początkowe', body: 'Karta ustawień początkowych pokazuje bieżące odpowiedzi, wymagane checkpointy init agenta, zarządzanie zwykłymi dokumentami oraz prompt handoff do zakończenia onboardingu.' },
    pt: { title: 'Configurações de inicialização', body: 'O separador de configurações de inicialização mostra as respostas atuais, checkpoints obrigatórios de init do agente, gestão de documentos ordinários e o prompt de handoff para concluir o onboarding.' },
    'pt-BR': { title: 'Configurações de inicialização', body: 'A aba de configurações de inicialização mostra as respostas atuais, checkpoints obrigatórios de init do agente, gerenciamento de documentos ordinários e o prompt de handoff para concluir o onboarding.' },
    ru: { title: 'Настройки инициализации', body: 'Вкладка настроек инициализации показывает текущие ответы, обязательные checkpoints агентской инициализации, управление обычными документами и handoff prompt для завершения onboarding.' },
    sv: { title: 'Initiera inställningar', body: 'Fliken init-inställningar visar aktuella svar, obligatoriska agent-init-checkpoints, hantering av vanliga dokument och handoff-prompten för att slutföra onboarding.' },
    tr: { title: 'Başlatma ayarları', body: 'Başlatma ayarları sekmesi güncel yanıtları, zorunlu agent init kontrol noktalarını, sıradan belge yönetimini ve onboarding’i tamamlamak için handoff istemini gösterir.' },
    uk: { title: 'Параметри ініціалізації', body: 'Вкладка параметрів ініціалізації показує поточні відповіді, обовʼязкові checkpoint-и agent init, керування звичайними документами та handoff prompt для завершення onboarding.' },
    vi: { title: 'Cài đặt ban đầu', body: 'Tab cài đặt ban đầu hiển thị câu trả lời hiện tại, các checkpoint init agent bắt buộc, quản lý tài liệu thường và prompt handoff để hoàn tất onboarding.' },
    'zh-CN': { title: '初始化设置', body: '初始化设置选项卡显示当前答案、必需的代理 init 检查点、普通文档管理以及用于完成 onboarding 的 handoff 提示。' }
};

const CHROME_KEYS = Object.keys(INIT_TAB_CHROME.ar);

for (const fileName of fs.readdirSync(packsDir).filter((name) => name.startsWith('garda-ui-') && name.endsWith('.json'))) {
    const langId = fileName.slice('garda-ui-'.length, -'.json'.length);
    const chrome = INIT_TAB_CHROME[langId];
    const instruction = INIT_INSTRUCTION[langId];
    if (!chrome || !instruction) {
        console.warn(`skip ${fileName}: no chrome map`);
        continue;
    }

    const filePath = path.join(packsDir, fileName);
    const pack = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    for (const key of CHROME_KEYS) {
        pack.LOCAL_UI_TEXT[key] = chrome[key];
    }

    pack.LOCAL_UI_INIT_SETTING_TEXT = {};

    if (!pack.LOCAL_UI_INSTRUCTION_TEXT || typeof pack.LOCAL_UI_INSTRUCTION_TEXT !== 'object') {
        pack.LOCAL_UI_INSTRUCTION_TEXT = {};
    }
    pack.LOCAL_UI_INSTRUCTION_TEXT['init-settings'] = instruction;

    fs.writeFileSync(filePath, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
    console.log(`patched ${fileName}`);
}

console.log('done');
