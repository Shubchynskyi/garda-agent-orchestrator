import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packsDir = path.join(repoRoot, 'src', 'reports', 'ui', 'lang-packs');

const EN_PATCH = {
    cleanupSettingsIntro: 'Runtime retention policy in runtime-retention.json: scheduled maintenance thresholds, compaction rules, and guarded manual cleanup actions.',
    cleanupDailyEnabled: 'Daily maintenance',
    cleanupDailyEnabledDesc: 'Turns scheduled daily maintenance on or off. When enabled, the orchestrator can process a limited batch of eligible tasks on a schedule without manual intervention.',
    cleanupDailyDryRun: 'Daily maintenance dry-run',
    cleanupDailyDryRunDesc: 'When true, scheduled daily maintenance only lists candidates and writes audit output; it does not delete or compress artifacts. Use true while tuning thresholds, then switch to false to apply.',
    cleanupOlderThanDays: 'Minimum task age (days)',
    cleanupOlderThanDaysDesc: 'A task must be at least this many days old before maintenance or manual cleanup may touch its runtime artifacts. Active tasks and newer tasks stay protected.',
    cleanupKeepLatestTasks: 'Keep newest tasks (count)',
    cleanupKeepLatestTasksDesc: 'Always preserve at least this many most-recent tasks even if they are older than the age threshold. Set 0 to rely only on age and active-task protection.',
    cleanupPurgeRequireConfirm: 'Purge confirmation required',
    cleanupPurgeRequireConfirmDesc: 'When true, destructive purge and cleanup commands require an explicit typed confirmation phrase before the server executes them.',
    cleanupHealthyDoneCompactDays: 'Compact healthy DONE after (days)',
    cleanupHealthyDoneCompactDaysDesc: 'After this many days, successfully completed (DONE) tasks may be compacted to ledger-only history once ledger evidence is verified.',
    cleanupProblemCompressDays: 'Compress problem tasks after (days)',
    cleanupProblemCompressDaysDesc: 'After this many days, failed or stuck tasks may have heavy forensic artifacts compressed while keeping recovery-readable evidence.',
    cleanupEditSettingsHelp: 'Each row saves one field to runtime-retention.json. Saving requires typed confirmation.',
    cleanupMaxTasksPerRun: 'Max tasks per maintenance run',
    cleanupMaxTasksPerRunDesc: 'Upper bound on how many eligible tasks daily maintenance processes in a single run. Limits blast radius if thresholds are misconfigured.',
    cleanupRunTitle: 'Manual runtime cleanup',
    cleanupRunHelp: 'Runs garda cleanup once with the age and keep-latest values from the rows above. Preview (dry-run) shows candidates only; Apply deletes or compresses according to policy and requires confirmation.',
    cleanupRunPreview: 'Preview',
    cleanupTaskPurgeTitle: 'Task purge',
    cleanupTaskPurgeHelp: 'Deletes runtime artifacts owned by one task ID and repairs shared indexes. Does not remove whole shared files; active-task protection still applies on the server.',
    cleanupValueTrue: 'true — enabled',
    cleanupValueFalse: 'false — disabled'
};

const RU_PATCH = {
    cleanupSettingsIntro: 'Политика хранения runtime в runtime-retention.json: пороги планового обслуживания, правила сжатия и защищённые ручные действия очистки.',
    cleanupDailyEnabled: 'Ежедневное обслуживание',
    cleanupDailyEnabledDesc: 'Включает или отключает плановое ежедневное обслуживание. Если включено, оркестратор по расписанию обрабатывает ограниченную партию подходящих задач без ручного запуска.',
    cleanupDailyDryRun: 'Dry-run при ежедневном обслуживании',
    cleanupDailyDryRunDesc: 'Если true, плановое обслуживание только показывает кандидатов и пишет аудит, но ничего не удаляет и не сжимает. Пока настраиваете пороги — оставляйте true, затем переключите на false для применения.',
    cleanupOlderThanDays: 'Минимальный возраст задачи (дней)',
    cleanupOlderThanDaysDesc: 'Задача должна быть не моложе указанного числа дней, прежде чем обслуживание или ручная очистка смогут трогать её runtime-артефакты. Активные и новые задачи остаются под защитой.',
    cleanupKeepLatestTasks: 'Резерв новых задач (шт.)',
    cleanupKeepLatestTasksDesc: 'Всегда сохранять не меньше указанного числа самых новых задач, даже если они старше порога по возрасту. 0 — полагаться только на возраст и защиту активных задач.',
    cleanupPurgeRequireConfirm: 'Подтверждение перед purge',
    cleanupPurgeRequireConfirmDesc: 'Если true, разрушительные команды purge и cleanup требуют явной текстовой фразы подтверждения перед выполнением на сервере.',
    cleanupHealthyDoneCompactDays: 'Сжатие успешных DONE через (дней)',
    cleanupHealthyDoneCompactDaysDesc: 'Через столько дней успешно завершённые (DONE) задачи могут быть сжаты до ledger-only истории после проверки ledger-доказательств.',
    cleanupProblemCompressDays: 'Сжатие problem tasks через (дней)',
    cleanupProblemCompressDaysDesc: 'Через столько дней у упавших или зависших задач тяжёлые forensic-артефакты могут быть сжаты, сохраняя данные для восстановления.',
    cleanupEditSettingsHelp: 'Каждая строка сохраняет одно поле в runtime-retention.json. Сохранение требует текстовое подтверждение.',
    cleanupMaxTasksPerRun: 'Максимум задач за запуск',
    cleanupMaxTasksPerRunDesc: 'Верхняя граница числа подходящих задач, которые ежедневное обслуживание обрабатывает за один проход. Ограничивает ущерб при ошибочных порогах.',
    cleanupRunTitle: 'Ручная очистка runtime',
    cleanupRunHelp: 'Однократно запускает garda cleanup с порогами возраста и резерва из строк выше. Просмотр (dry-run) только показывает кандидатов; Применить удаляет или сжимает по политике и требует подтверждения.',
    cleanupRunPreview: 'Просмотр',
    cleanupTaskPurgeTitle: 'Очистка задачи',
    cleanupTaskPurgeHelp: 'Удаляет runtime-артефакты, принадлежащие одному ID задачи, и чинит общие индексы. Не удаляет целиком общие файлы; защита активной задачи остаётся на сервере.',
    cleanupValueTrue: 'true — включено',
    cleanupValueFalse: 'false — выключено'
};

const KEYS = Object.keys(EN_PATCH);

for (const fileName of fs.readdirSync(packsDir).filter((name) => name.startsWith('garda-ui-') && name.endsWith('.json'))) {
    const langId = fileName.slice('garda-ui-'.length, -'.json'.length);
    const patch = langId === 'ru' ? RU_PATCH : EN_PATCH;
    const filePath = path.join(packsDir, fileName);
    const pack = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const key of KEYS) {
        pack.LOCAL_UI_TEXT[key] = patch[key];
    }
    fs.writeFileSync(filePath, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
    console.log(`patched ${fileName}`);
}

console.log('done');
