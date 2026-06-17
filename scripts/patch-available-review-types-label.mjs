import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY = 'availableReviewTypes';
const TRANSLATIONS = {
    ar: 'أنواع المراجعة المتاحة',
    bn: 'উপলব্ধ রিভিউ ধরন',
    de: 'Verfügbare Review-Typen',
    es: 'Tipos de revisión disponibles',
    fr: 'Types de review disponibles',
    hi: 'उपलब्ध रिव्यू प्रकार',
    id: 'Jenis review yang tersedia',
    it: 'Tipi di review disponibili',
    ja: '利用可能なレビュータイプ',
    ko: '사용 가능한 리뷰 유형',
    nl: 'Beschikbare reviewtypen',
    pl: 'Dostępne typy review',
    pt: 'Tipos de review disponíveis',
    'pt-BR': 'Tipos de review disponíveis',
    ru: 'Доступные типы ревью',
    sv: 'Tillgängliga review-typer',
    tr: 'Kullanılabilir inceleme türleri',
    uk: 'Доступні типи ревʼю',
    vi: 'Các loại review khả dụng',
    'zh-CN': '可用的审查类型'
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const langDir = path.join(repoRoot, 'src', 'reports', 'ui', 'lang-packs');

for (const [languageId, value] of Object.entries(TRANSLATIONS)) {
    const filePath = path.join(langDir, `garda-ui-${languageId}.json`);
    const pack = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    pack.LOCAL_UI_TEXT[KEY] = value;
    fs.writeFileSync(filePath, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
    console.log(`patched ${languageId}`);
}
