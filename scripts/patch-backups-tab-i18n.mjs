import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packsDir = path.join(repoRoot, 'src', 'reports', 'ui', 'lang-packs');

const BACKUPS_I18N = {
    ar: {
        backupsInventoryTitle: 'قائمة النسخ الاحتياطية',
        backupsEmpty: 'لا توجد نسخ احتياطية في القائمة.',
        backupsAutoBackupTitle: 'النسخ الاحتياطي التلقائي',
        backupsAutoBackupHelp: 'تستخدم النسخ الاحتياطية المجدولة إعدادات workflow المدققة. الحفظ يتطلب تأكيدًا.',
        backupHealthAvailable: 'متاحة',
        backupHealthMissingRecords: 'سجلات مفقودة',
        backupHealthInvalidRecords: 'سجلات غير صالحة'
    },
    bn: {
        backupsInventoryTitle: 'ব্যাকআপ তালিকা',
        backupsEmpty: 'তালিকায় কোনো ব্যাকআপ নেই।',
        backupsAutoBackupTitle: 'স্বয়ংক্রিয় ব্যাকআপ',
        backupsAutoBackupHelp: 'নির্ধারিত স্বয়ংক্রিয় ব্যাকআপ অডিট করা workflow সেটিংস ব্যবহার করে। সংরক্ষণের জন্য নিশ্চিতকরণ প্রয়োজন।',
        backupHealthAvailable: 'উপলব্ধ',
        backupHealthMissingRecords: 'রেকর্ড অনুপস্থিত',
        backupHealthInvalidRecords: 'অবৈধ রেকর্ড'
    },
    de: {
        backupsInventoryTitle: 'Backup-Liste',
        backupsEmpty: 'Keine Backups in der Liste.',
        backupsAutoBackupTitle: 'Auto-Backup',
        backupsAutoBackupHelp: 'Geplante Auto-Backups nutzen geprüfte Workflow-Einstellungen. Speichern erfordert eine Bestätigung.',
        backupHealthAvailable: 'Verfügbar',
        backupHealthMissingRecords: 'Datensätze fehlen',
        backupHealthInvalidRecords: 'Ungültige Datensätze'
    },
    es: {
        backupsInventoryTitle: 'Lista de copias',
        backupsEmpty: 'No hay copias en la lista.',
        backupsAutoBackupTitle: 'Copia automática',
        backupsAutoBackupHelp: 'Las copias automáticas programadas usan ajustes de workflow auditados. Guardar requiere confirmación.',
        backupHealthAvailable: 'Disponible',
        backupHealthMissingRecords: 'Registros ausentes',
        backupHealthInvalidRecords: 'Registros no válidos'
    },
    fr: {
        backupsInventoryTitle: 'Liste des sauvegardes',
        backupsEmpty: 'Aucune sauvegarde dans la liste.',
        backupsAutoBackupTitle: 'Sauvegarde automatique',
        backupsAutoBackupHelp: 'Les sauvegardes automatiques planifiées utilisent des paramètres workflow audités. L’enregistrement exige une confirmation.',
        backupHealthAvailable: 'Disponible',
        backupHealthMissingRecords: 'Enregistrements manquants',
        backupHealthInvalidRecords: 'Enregistrements invalides'
    },
    hi: {
        backupsInventoryTitle: 'बैकअप सूची',
        backupsEmpty: 'सूची में कोई बैकअप नहीं है।',
        backupsAutoBackupTitle: 'स्वचालित बैकअप',
        backupsAutoBackupHelp: 'निर्धारित स्वचालित बैकअप ऑडिट किए गए workflow सेटिंग्स का उपयोग करते हैं। सहेजने के लिए पुष्टि आवश्यक है।',
        backupHealthAvailable: 'उपलब्ध',
        backupHealthMissingRecords: 'रिकॉर्ड गायब',
        backupHealthInvalidRecords: 'अमान्य रिकॉर्ड'
    },
    id: {
        backupsInventoryTitle: 'Daftar cadangan',
        backupsEmpty: 'Tidak ada cadangan dalam daftar.',
        backupsAutoBackupTitle: 'Cadangan otomatis',
        backupsAutoBackupHelp: 'Cadangan otomatis terjadwal memakai pengaturan workflow yang diaudit. Menyimpan memerlukan konfirmasi.',
        backupHealthAvailable: 'Tersedia',
        backupHealthMissingRecords: 'Catatan hilang',
        backupHealthInvalidRecords: 'Catatan tidak valid'
    },
    it: {
        backupsInventoryTitle: 'Elenco backup',
        backupsEmpty: 'Nessun backup nell’elenco.',
        backupsAutoBackupTitle: 'Backup automatico',
        backupsAutoBackupHelp: 'I backup automatici pianificati usano impostazioni workflow verificate. Il salvataggio richiede conferma.',
        backupHealthAvailable: 'Disponibile',
        backupHealthMissingRecords: 'Record mancanti',
        backupHealthInvalidRecords: 'Record non validi'
    },
    ja: {
        backupsInventoryTitle: 'バックアップ一覧',
        backupsEmpty: '一覧にバックアップがありません。',
        backupsAutoBackupTitle: '自動バックアップ',
        backupsAutoBackupHelp: 'スケジュールされた自動バックアップは監査済みの workflow 設定を使用します。保存には確認が必要です。',
        backupHealthAvailable: '利用可能',
        backupHealthMissingRecords: 'レコード欠落',
        backupHealthInvalidRecords: '無効なレコード'
    },
    ko: {
        backupsInventoryTitle: '백업 목록',
        backupsEmpty: '목록에 백업이 없습니다.',
        backupsAutoBackupTitle: '자동 백업',
        backupsAutoBackupHelp: '예약된 자동 백업은 감사된 workflow 설정을 사용합니다. 저장하려면 확인이 필요합니다.',
        backupHealthAvailable: '사용 가능',
        backupHealthMissingRecords: '레코드 누락',
        backupHealthInvalidRecords: '잘못된 레코드'
    },
    nl: {
        backupsInventoryTitle: 'Back-uplijst',
        backupsEmpty: 'Geen back-ups in de lijst.',
        backupsAutoBackupTitle: 'Automatische back-up',
        backupsAutoBackupHelp: 'Geplande automatische back-ups gebruiken gecontroleerde workflow-instellingen. Opslaan vereist bevestiging.',
        backupHealthAvailable: 'Beschikbaar',
        backupHealthMissingRecords: 'Records ontbreken',
        backupHealthInvalidRecords: 'Ongeldige records'
    },
    pl: {
        backupsInventoryTitle: 'Lista kopii',
        backupsEmpty: 'Brak kopii na liście.',
        backupsAutoBackupTitle: 'Automatyczna kopia zapasowa',
        backupsAutoBackupHelp: 'Zaplanowane automatyczne kopie używają sprawdzonych ustawień workflow. Zapisanie wymaga potwierdzenia.',
        backupHealthAvailable: 'Dostępna',
        backupHealthMissingRecords: 'Brak rekordów',
        backupHealthInvalidRecords: 'Nieprawidłowe rekordy'
    },
    pt: {
        backupsInventoryTitle: 'Lista de cópias',
        backupsEmpty: 'Não há cópias na lista.',
        backupsAutoBackupTitle: 'Cópia automática',
        backupsAutoBackupHelp: 'As cópias automáticas agendadas usam definições de workflow auditadas. Guardar requer confirmação.',
        backupHealthAvailable: 'Disponível',
        backupHealthMissingRecords: 'Registos em falta',
        backupHealthInvalidRecords: 'Registos inválidos'
    },
    'pt-BR': {
        backupsInventoryTitle: 'Lista de backups',
        backupsEmpty: 'Não há backups na lista.',
        backupsAutoBackupTitle: 'Backup automático',
        backupsAutoBackupHelp: 'Backups automáticos agendados usam configurações de workflow auditadas. Salvar exige confirmação.',
        backupHealthAvailable: 'Disponível',
        backupHealthMissingRecords: 'Registros ausentes',
        backupHealthInvalidRecords: 'Registros inválidos'
    },
    ru: {
        backupsInventoryTitle: 'Список резервных копий',
        backupsEmpty: 'В списке нет резервных копий.',
        backupsAutoBackupTitle: 'Автоматическое резервное копирование',
        backupsAutoBackupHelp: 'Плановые автоматические резервные копии используют проверенные настройки workflow. Сохранение требует подтверждения.',
        backupHealthAvailable: 'Доступна',
        backupHealthMissingRecords: 'Записи отсутствуют',
        backupHealthInvalidRecords: 'Некорректные записи'
    },
    sv: {
        backupsInventoryTitle: 'Säkerhetskopielista',
        backupsEmpty: 'Inga säkerhetskopior i listan.',
        backupsAutoBackupTitle: 'Automatisk säkerhetskopiering',
        backupsAutoBackupHelp: 'Schemalagda automatiska säkerhetskopior använder granskade workflow-inställningar. Spara kräver bekräftelse.',
        backupHealthAvailable: 'Tillgänglig',
        backupHealthMissingRecords: 'Poster saknas',
        backupHealthInvalidRecords: 'Ogiltiga poster'
    },
    tr: {
        backupsInventoryTitle: 'Yedek listesi',
        backupsEmpty: 'Listede yedek yok.',
        backupsAutoBackupTitle: 'Otomatik yedekleme',
        backupsAutoBackupHelp: 'Zamanlanmış otomatik yedekler denetlenmiş workflow ayarlarını kullanır. Kaydetmek onay gerektirir.',
        backupHealthAvailable: 'Kullanılabilir',
        backupHealthMissingRecords: 'Kayıtlar eksik',
        backupHealthInvalidRecords: 'Geçersiz kayıtlar'
    },
    uk: {
        backupsInventoryTitle: 'Список резервних копій',
        backupsEmpty: 'У списку немає резервних копій.',
        backupsAutoBackupTitle: 'Автоматичне резервне копіювання',
        backupsAutoBackupHelp: 'Заплановані автоматичні резервні копії використовують перевірені налаштування workflow. Збереження вимагає підтвердження.',
        backupHealthAvailable: 'Доступна',
        backupHealthMissingRecords: 'Записи відсутні',
        backupHealthInvalidRecords: 'Некоректні записи'
    },
    vi: {
        backupsInventoryTitle: 'Danh sách sao lưu',
        backupsEmpty: 'Không có sao lưu trong danh sách.',
        backupsAutoBackupTitle: 'Sao lưu tự động',
        backupsAutoBackupHelp: 'Sao lưu tự động theo lịch dùng cài đặt workflow đã kiểm toán. Lưu yêu cầu xác nhận.',
        backupHealthAvailable: 'Khả dụng',
        backupHealthMissingRecords: 'Thiếu bản ghi',
        backupHealthInvalidRecords: 'Bản ghi không hợp lệ'
    },
    'zh-CN': {
        backupsInventoryTitle: '备份列表',
        backupsEmpty: '列表中没有备份。',
        backupsAutoBackupTitle: '自动备份',
        backupsAutoBackupHelp: '计划的自动备份使用已审计的 workflow 设置。保存需要确认。',
        backupHealthAvailable: '可用',
        backupHealthMissingRecords: '记录缺失',
        backupHealthInvalidRecords: '记录无效'
    }
};

const KEYS = [
    'backupsInventoryTitle',
    'backupsEmpty',
    'backupsAutoBackupTitle',
    'backupsAutoBackupHelp',
    'backupHealthAvailable',
    'backupHealthMissingRecords',
    'backupHealthInvalidRecords'
];

for (const fileName of fs.readdirSync(packsDir).filter((name) => name.startsWith('garda-ui-') && name.endsWith('.json'))) {
    const langId = fileName.slice('garda-ui-'.length, -'.json'.length);
    const patch = BACKUPS_I18N[langId];
    if (!patch) {
        console.warn(`skip ${fileName}`);
        continue;
    }
    const filePath = path.join(packsDir, fileName);
    const pack = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const key of KEYS) {
        pack.LOCAL_UI_TEXT[key] = patch[key];
    }
    fs.writeFileSync(filePath, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
    console.log(`patched ${fileName}`);
}

console.log('done');
