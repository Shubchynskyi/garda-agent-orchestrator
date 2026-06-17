import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTING_ID = 'review-cycle-excluded-review-types';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const langDir = path.join(repoRoot, 'src', 'reports', 'ui', 'workflow-setting-text', 'lang');

const RU_LABELS = {
    code: 'Ревью кода',
    db: 'Ревью БД',
    security: 'Ревью безопасности',
    refactor: 'Ревью рефакторинга',
    api: 'Ревью API',
    test: 'Тестовое ревью',
    performance: 'Ревью производительности',
    infra: 'Ревью инфраструктуры',
    dependency: 'Ревью зависимостей'
};

for (const fileName of fs.readdirSync(langDir).sort()) {
    if (!fileName.endsWith('.json')) {
        continue;
    }
    const filePath = path.join(langDir, fileName);
    const pack = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const setting = pack[SETTING_ID];
    if (!setting?.options) {
        continue;
    }

    for (const [optionKey, optionValue] of Object.entries(setting.options)) {
        if (optionValue && typeof optionValue === 'object') {
            delete optionValue.description;
            if (fileName === 'ru.json' && RU_LABELS[optionKey]) {
                optionValue.label = RU_LABELS[optionKey];
            }
        }
    }

    fs.writeFileSync(filePath, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
    console.log(`stripped option descriptions: ${fileName}`);
}
